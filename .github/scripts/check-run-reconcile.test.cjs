"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  UsageError,
  pickLatestByName,
  extractRequiredContextsFromRulesets,
  matchRefPattern,
  classifyContext,
  reconcileRequiredChecks,
  formatReconcileReport,
  main,
} = require("./check-run-reconcile.cjs");

const REQUIRED = Object.freeze([
  "pr-title / pr-title",
  "do-not-merge / do-not-merge",
  "ci-status",
]);

function job(
  name,
  {
    conclusion = "success",
    status = "completed",
    at = "2026-08-10T02:00:00Z",
    id = 1,
  } = {},
) {
  return {
    id,
    name,
    status,
    conclusion,
    started_at: at,
    completed_at: at,
  };
}

function check(
  name,
  {
    conclusion = "success",
    status = "completed",
    at = "2026-08-10T02:00:00Z",
    id = 1,
    appId = null,
  } = {},
) {
  const run = {
    id,
    name,
    status,
    conclusion,
    started_at: at,
    completed_at: at,
  };
  if (appId !== null) {
    run.app = { id: appId };
  }
  return run;
}

test("pickLatestByName keeps the newest same-named record", () => {
  const map = pickLatestByName([
    check("ci-status", { id: 1, at: "2026-08-10T01:00:00Z" }),
    check("ci-status", { id: 2, at: "2026-08-10T03:00:00Z" }),
    check("pr-title / pr-title", { id: 3, at: "2026-08-10T02:00:00Z" }),
  ]);
  assert.equal(map.get("ci-status").id, 2);
  assert.equal(map.get("pr-title / pr-title").id, 3);
});

test("extractRequiredContextsFromRulesets reads active required_status_checks", () => {
  const contexts = extractRequiredContextsFromRulesets([
    {
      name: "ci-gate",
      enforcement: "active",
      target: "branch",
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "pr-title / pr-title" },
              { context: "do-not-merge / do-not-merge" },
              { context: "ci-status" },
              { context: "ci-status" },
            ],
          },
        },
      ],
    },
    {
      name: "disabled-gate",
      enforcement: "disabled",
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "should-ignore" }],
          },
        },
      ],
    },
    {
      name: "evaluate-gate",
      enforcement: "evaluate",
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "evaluate-only" }],
          },
        },
      ],
    },
  ]);
  assert.deepEqual(
    contexts.map((entry) => entry.context),
    [...REQUIRED],
  );
  assert.equal(
    contexts.every((entry) => entry.integrationId === null),
    true,
  );
});

test("extractRequiredContextsFromRulesets preserves integration_id", () => {
  const contexts = extractRequiredContextsFromRulesets([
    {
      enforcement: "active",
      target: "branch",
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "ci-status", integration_id: 15368 },
              { context: "external / scan", integration_id: 42 },
            ],
          },
        },
      ],
    },
  ]);
  assert.deepEqual(contexts, [
    { context: "ci-status", integrationId: 15368 },
    { context: "external / scan", integrationId: 42 },
  ]);
});

test("extractRequiredContextsFromRulesets filters by target ref", () => {
  const rulesets = [
    {
      name: "main-gate",
      enforcement: "active",
      target: "branch",
      conditions: {
        ref_name: {
          include: ["refs/heads/main", "~DEFAULT_BRANCH"],
          exclude: [],
        },
      },
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "ci-status" }],
          },
        },
      ],
    },
    {
      name: "release-gate",
      enforcement: "active",
      target: "branch",
      conditions: {
        ref_name: {
          include: ["refs/heads/release/*"],
          exclude: [],
        },
      },
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "release-check" }],
          },
        },
      ],
    },
  ];
  assert.deepEqual(
    extractRequiredContextsFromRulesets(rulesets, {
      targetRef: "main",
      defaultBranch: "main",
    }).map((entry) => entry.context),
    ["ci-status"],
  );
  assert.deepEqual(
    extractRequiredContextsFromRulesets(rulesets, {
      targetRef: "release/1.0",
      defaultBranch: "main",
    }).map((entry) => entry.context),
    ["release-check"],
  );
});

test("matchRefPattern handles ~ALL, globs, and excludes pathname *", () => {
  assert.equal(matchRefPattern("~ALL", "refs/heads/main", "main"), true);
  assert.equal(
    matchRefPattern("~DEFAULT_BRANCH", "refs/heads/main", "main"),
    true,
  );
  assert.equal(
    matchRefPattern("refs/heads/release/*", "refs/heads/release/1.0", "main"),
    true,
  );
  assert.equal(
    matchRefPattern("refs/heads/release/*", "refs/heads/release/a/b", "main"),
    false,
  );
});

test("aligned: every required context has matching job and check-run", () => {
  const report = reconcileRequiredChecks({
    requiredContexts: REQUIRED,
    workflowJobs: REQUIRED.map((name, index) => job(name, { id: index + 1 })),
    checkRuns: REQUIRED.map((name, index) => check(name, { id: index + 1 })),
  });
  assert.equal(report.ok, true);
  assert.equal(report.problems.length, 0);
  assert.equal(report.divergences.length, 0);
  assert.deepEqual(
    report.results.map((row) => row.verdict),
    ["aligned", "aligned", "aligned"],
  );
});

test("#399 divergence: workflow job succeeded but check-run never attached", () => {
  // Head 2895890c shape from the issue: ci-status + pr-title attached,
  // do-not-merge ran as a job but is ABSENT from commit check-runs.
  const report = reconcileRequiredChecks({
    requiredContexts: REQUIRED,
    workflowJobs: [
      job("pr-title / pr-title", { id: 10 }),
      job("do-not-merge / do-not-merge", { id: 11 }),
      job("ci-status", { id: 12 }),
    ],
    checkRuns: [
      check("pr-title / pr-title", { id: 20 }),
      check("ci-status", { id: 21 }),
      // do-not-merge deliberately absent
    ],
  });
  assert.equal(report.ok, false);
  assert.equal(report.divergences.length, 1);
  assert.equal(report.divergences[0].context, "do-not-merge / do-not-merge");
  assert.equal(report.divergences[0].verdict, "divergence");
  assert.match(report.divergences[0].detail, /ci-workflows#399/);
  assert.equal(report.absentCheckRuns.length, 1);
  assert.equal(
    report.absentCheckRuns[0].context,
    "do-not-merge / do-not-merge",
  );
});

test("missing: required context has neither job nor check-run", () => {
  const report = reconcileRequiredChecks({
    requiredContexts: REQUIRED,
    workflowJobs: [job("pr-title / pr-title"), job("ci-status")],
    checkRuns: [check("pr-title / pr-title"), check("ci-status")],
  });
  assert.equal(report.ok, false);
  const row = report.results.find(
    (entry) => entry.context === "do-not-merge / do-not-merge",
  );
  assert.equal(row.verdict, "missing");
});

test("pending: in-flight check-run is not treated as attached success", () => {
  const report = reconcileRequiredChecks({
    requiredContexts: ["review / review"],
    workflowJobs: [
      job("review / review", {
        status: "in_progress",
        conclusion: null,
      }),
    ],
    checkRuns: [
      check("review / review", {
        status: "in_progress",
        conclusion: null,
      }),
    ],
  });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].verdict, "pending");
});

test("mismatch: job and check-run conclusions disagree", () => {
  const report = reconcileRequiredChecks({
    requiredContexts: ["ci-status"],
    workflowJobs: [job("ci-status", { conclusion: "success" })],
    checkRuns: [check("ci-status", { conclusion: "failure" })],
  });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].verdict, "mismatch");
});

test("failed: completed check with failure/cancelled/timed_out is not ok", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out"]) {
    const alignedFail = reconcileRequiredChecks({
      requiredContexts: ["ci-status"],
      workflowJobs: [job("ci-status", { conclusion })],
      checkRuns: [check("ci-status", { conclusion })],
    });
    assert.equal(alignedFail.ok, false, conclusion);
    assert.equal(alignedFail.results[0].verdict, "failed", conclusion);

    const checkOnlyFail = reconcileRequiredChecks({
      requiredContexts: ["external / gate"],
      workflowJobs: [],
      checkRuns: [check("external / gate", { conclusion })],
    });
    assert.equal(checkOnlyFail.ok, false, conclusion);
    assert.equal(checkOnlyFail.results[0].verdict, "failed", conclusion);
  }
});

test("integration_id: wrong app check-run does not satisfy the requirement", () => {
  const report = reconcileRequiredChecks({
    requiredContexts: [{ context: "ci-status", integrationId: 15368 }],
    workflowJobs: [job("ci-status")],
    checkRuns: [check("ci-status", { appId: 999 })],
  });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].verdict, "divergence");
});

test("integration_id: matching app.id satisfies the requirement", () => {
  const report = reconcileRequiredChecks({
    requiredContexts: [{ context: "ci-status", integrationId: 15368 }],
    workflowJobs: [job("ci-status")],
    checkRuns: [check("ci-status", { appId: 15368 })],
  });
  assert.equal(report.ok, true);
  assert.equal(report.results[0].verdict, "aligned");
});

test("check_only: attached successful check-run without a workflow job is ok", () => {
  const report = reconcileRequiredChecks({
    requiredContexts: ["ci-status"],
    workflowJobs: [],
    checkRuns: [check("ci-status", { conclusion: "success" })],
  });
  assert.equal(report.ok, true);
  assert.equal(report.results[0].verdict, "check_only");
});

test("formatReconcileReport names the #399 divergence for operators", () => {
  const report = reconcileRequiredChecks({
    requiredContexts: ["do-not-merge / do-not-merge"],
    workflowJobs: [job("do-not-merge / do-not-merge")],
    checkRuns: [],
  });
  const text = formatReconcileReport(report, {
    repo: "melodic-software/claude-code-plugins",
    sha: "2895890c",
  });
  assert.match(text, /divergence/);
  assert.match(text, /check=ABSENT/);
  assert.match(text, /ci-workflows#399/);
  assert.match(text, /::error::/);
});

test("classifyContext exposes the #399 wording on job-without-check", () => {
  const row = classifyContext(
    "pr-title / pr-title",
    job("pr-title / pr-title"),
    null,
  );
  assert.equal(row.verdict, "divergence");
  assert.match(row.detail, /no matching check-run is attached/);
});

test("reconcileRequiredChecks rejects empty context lists", () => {
  assert.throws(
    () =>
      reconcileRequiredChecks({
        requiredContexts: [],
        workflowJobs: [],
        checkRuns: [],
      }),
    (error) => error instanceof UsageError,
  );
});

test("CLI fixture mode detects divergence and exits 1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-reconcile-"));
  const checksPath = path.join(dir, "checks.json");
  const jobsPath = path.join(dir, "jobs.json");
  fs.writeFileSync(
    checksPath,
    JSON.stringify({
      check_runs: [check("pr-title / pr-title"), check("ci-status")],
    }),
  );
  fs.writeFileSync(
    jobsPath,
    JSON.stringify({
      jobs: [
        job("pr-title / pr-title"),
        job("do-not-merge / do-not-merge"),
        job("ci-status"),
      ],
    }),
  );

  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdout += chunk;
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += chunk;
    return true;
  };
  let code;
  try {
    code = main([
      "--check-runs-json",
      checksPath,
      "--jobs-json",
      jobsPath,
      "--context",
      "pr-title / pr-title",
      "--context",
      "do-not-merge / do-not-merge",
      "--context",
      "ci-status",
    ]);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  assert.equal(code, 1);
  assert.match(stdout, /do-not-merge \/ do-not-merge: divergence/);
  assert.equal(stderr, "");
});

test("CLI fixture mode exits 0 when surfaces align", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-reconcile-"));
  const checksPath = path.join(dir, "checks.json");
  const jobsPath = path.join(dir, "jobs.json");
  fs.writeFileSync(
    checksPath,
    JSON.stringify({
      check_runs: REQUIRED.map((name) => check(name)),
    }),
  );
  fs.writeFileSync(
    jobsPath,
    JSON.stringify({
      jobs: REQUIRED.map((name) => job(name)),
    }),
  );
  let stdout = "";
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    stdout += chunk;
    return true;
  };
  let code;
  try {
    code = main([
      "--check-runs-json",
      checksPath,
      "--jobs-json",
      jobsPath,
      "--context",
      "pr-title / pr-title",
      "--context",
      "do-not-merge / do-not-merge",
      "--context",
      "ci-status",
    ]);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  assert.equal(code, 0);
  assert.match(stdout, /ok: every required context is present/);
});

test("CLI fixture: explicit --context wins over --rulesets-json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-reconcile-"));
  const checksPath = path.join(dir, "checks.json");
  const jobsPath = path.join(dir, "jobs.json");
  const rulesetsPath = path.join(dir, "rulesets.json");
  fs.writeFileSync(
    checksPath,
    JSON.stringify({ check_runs: [check("ci-status")] }),
  );
  fs.writeFileSync(jobsPath, JSON.stringify({ jobs: [job("ci-status")] }));
  fs.writeFileSync(
    rulesetsPath,
    JSON.stringify([
      {
        enforcement: "active",
        target: "branch",
        rules: [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "from-ruleset" }],
            },
          },
        ],
      },
    ]),
  );
  let stdout = "";
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    stdout += chunk;
    return true;
  };
  let code;
  try {
    code = main([
      "--check-runs-json",
      checksPath,
      "--jobs-json",
      jobsPath,
      "--rulesets-json",
      rulesetsPath,
      "--context",
      "ci-status",
    ]);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  assert.equal(code, 0);
  assert.match(stdout, /ci-status: aligned/);
  assert.doesNotMatch(stdout, /from-ruleset/);
});
