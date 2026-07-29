"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const repositoryRoot = path.join(__dirname, "..", "..");
const workflowPath = path.join(
  __dirname,
  "..",
  "workflows",
  "claude-lane-incident-aggregator.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");

// Same inline-script extraction technique standards-sync-stuck-automerge-alert
// .test.cjs uses: pull the actions/github-script body out of the YAML by step
// name and execute it directly against mocks, so the shipped text is the text
// under test rather than a copy that can drift.
function extractStepScript(stepName) {
  const lines = workflow.split(/\r?\n/u);
  const stepIndex = lines.findIndex((line) =>
    line.includes(`- name: ${stepName}`),
  );
  assert.notEqual(stepIndex, -1, `step '${stepName}' must exist`);
  const scriptIndex = lines.findIndex(
    (line, index) => index > stepIndex && /^ {10}script: \|$/u.test(line),
  );
  assert.notEqual(scriptIndex, -1, `'${stepName}' script block must exist`);
  const body = [];
  for (let index = scriptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return body.join("\n");
}

function stepSource(stepName) {
  const stepIndex = workflow.indexOf(`- name: ${stepName}`);
  assert.ok(stepIndex >= 0, `step '${stepName}' is missing`);
  const nextStepOffset = workflow
    .slice(stepIndex + 1)
    .search(/\n\s*(?:#[^\n]*\n\s*)*- name:/u);
  return nextStepOffset >= 0
    ? workflow.slice(stepIndex, stepIndex + 1 + nextStepOffset)
    : workflow.slice(stepIndex);
}

const laneAnnotation = (failureClass, status) =>
  `Claude review exited with: failure class=${failureClass} (infrastructure ` +
  `error, not a code-quality signal). Last SDK result: ` +
  `{"subtype":"success","is_error":true,"api_error_status":${status},` +
  `"class":"${failureClass}"}`;

function checkRun({
  id = 1,
  name = "review / review",
  annotationsCount = 0,
  conclusion = "success",
} = {}) {
  return {
    id,
    name,
    conclusion,
    output: { annotations_count: annotationsCount },
  };
}

/**
 * Execute the shipped poll script against a mock Octokit.
 *
 * `failFor` is a list of substrings; any read whose description contains one
 * throws, standing in for a 403 under a narrowed credential, a rate limit, or a
 * transient 5xx.
 */
async function runPoll({
  hasInstallation = false,
  installationRepositories = [],
  repositoriesOverride = "",
  pullsByRepo = {},
  checkRunsByPull = {},
  annotationsByCheckRun = {},
  failFor = [],
} = {}) {
  const keys = [
    "LOOKBACK_HOURS",
    "REPOSITORIES_OVERRIDE",
    "HAS_INSTALLATION",
    "GITHUB_WORKSPACE",
  ];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    LOOKBACK_HOURS: "24",
    REPOSITORIES_OVERRIDE: repositoriesOverride,
    HAS_INSTALLATION: String(hasInstallation),
    GITHUB_WORKSPACE: repositoryRoot,
  });

  const calls = [];
  const outputs = {};
  const warnings = [];
  try {
    const maybeFail = (label) => {
      if (failFor.some((fragment) => label.includes(fragment))) {
        throw new Error(`simulated read failure for ${label}`);
      }
    };
    const github = {
      paginate: async (_fn, _params) => {
        calls.push({ kind: "installation" });
        maybeFail("installation");
        return installationRepositories;
      },
      rest: {
        apps: { listReposAccessibleToInstallation: () => {} },
        pulls: {
          list: async ({ owner, repo, page }) => {
            const label = `pulls:${owner}/${repo}`;
            calls.push({ kind: "pulls", repo: `${owner}/${repo}`, page });
            maybeFail(label);
            const pages = pullsByRepo[`${owner}/${repo}`] ?? [];
            return { data: pages[page - 1] ?? [] };
          },
        },
        checks: {
          listForRef: async ({ owner, repo, ref }) => {
            const label = `checks:${owner}/${repo}`;
            calls.push({ kind: "checks", repo: `${owner}/${repo}`, ref });
            maybeFail(label);
            return { data: { check_runs: checkRunsByPull[ref] ?? [] } };
          },
          listAnnotations: async ({ check_run_id: checkRunId }) => {
            calls.push({ kind: "annotations", checkRunId });
            maybeFail(`annotations:${checkRunId}`);
            return { data: annotationsByCheckRun[checkRunId] ?? [] };
          },
        },
      },
    };
    const core = {
      setOutput: (key, value) => (outputs[key] = value),
      setFailed: (message) => assert.fail(`unexpected setFailed: ${message}`),
      warning: (message) => warnings.push(message),
      info: () => {},
    };
    const context = {
      repo: { owner: "melodic-software", repo: "ci-workflows" },
    };
    const execute = new AsyncFunction(
      "github",
      "core",
      "context",
      "require",
      "process",
      extractStepScript("Poll consumer repositories for lane failure signals"),
    );
    await execute(github, core, context, require, process);
    return { calls, outputs, warnings, tally: JSON.parse(outputs.tally) };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

const recentPull = (number, sha) => ({
  number,
  head: { sha },
  updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
});

// --- The dry-run guarantee -------------------------------------------------

test("the job grants no write permission of any kind, so the ambient token cannot mutate this repository", () => {
  const permissionsBlocks = [
    ...workflow.matchAll(/permissions:\n((?: {2,}[^\n]*\n)+)/gu),
  ];
  assert.ok(
    permissionsBlocks.length >= 2,
    "workflow and job permissions blocks must both be declared",
  );
  for (const [, block] of permissionsBlocks) {
    assert.doesNotMatch(
      block,
      /:\s*write\b/u,
      `a permissions block grants write scope:\n${block}`,
    );
  }
  assert.match(workflow, /^ {6}contents: read$/mu);
  assert.match(workflow, /^ {6}issues: read$/mu);
});

test("every issue-writing step is gated on the minted token existing, so the gate and the credential are one condition", () => {
  const writingSteps = [
    "Open or update the incident issue",
    "Close the recovered incident issue",
  ];
  for (const name of writingSteps) {
    const step = stepSource(name);
    assert.match(
      step,
      /if: steps\.credential\.outputs\.token != ''/u,
      `'${name}' is not gated on the minted token`,
    );
    assert.match(
      step,
      /token: \$\{\{ steps\.credential\.outputs\.token \}\}/u,
      `'${name}' does not author with the minted token`,
    );
    assert.doesNotMatch(
      step,
      /secrets\.GITHUB_TOKEN/u,
      `'${name}' must never fall back to the ambient token`,
    );
  }
});

test("no step outside the gated writers can write an issue", () => {
  const mutatingCall = /issues\.(?:create|update|createComment)\b/u;
  for (const name of [
    "Poll consumer repositories for lane failure signals",
    "Find the open incident issue",
    "Advance the incident state",
  ]) {
    assert.doesNotMatch(
      extractStepScript(name),
      mutatingCall,
      `'${name}' must be read-only`,
    );
  }
});

test("the credential is minted only when its secret exists and no dry run was requested", () => {
  const step = stepSource("Mint the aggregator App token");
  assert.match(
    step,
    /if: env\.HAS_APP_CREDENTIAL == 'true' && env\.FORCED_DRY_RUN != 'true'/u,
  );
  assert.match(step, /permission-checks: read/u);
  assert.match(step, /permission-pull-requests: read/u);
  assert.match(step, /permission-issues: write/u);
  assert.match(
    workflow,
    /HAS_APP_CREDENTIAL: \$\{\{ secrets\.CLAUDE_LANE_INCIDENT_APP_PRIVATE_KEY != '' \}\}/u,
  );
});

test("the dry-run report is published exactly when no token was minted", () => {
  assert.match(
    stepSource("Publish the dry-run report"),
    /if: steps\.credential\.outputs\.token == ''/u,
  );
});

test("the run logs the API-call count as an explicit deliverable line", () => {
  assert.match(
    workflow,
    /echo "claude-lane-incident: api-calls=\$\{API_CALLS\}[^"]*read-errors=\$\{READ_ERRORS\}/u,
  );
});

test("the issue lookup and close steps run on github-script, not the gh CLI", () => {
  for (const name of [
    "Find the open incident issue",
    "Close the recovered incident issue",
  ]) {
    const step = stepSource(name);
    assert.match(step, /uses: actions\/github-script@/u, name);
    assert.doesNotMatch(
      step.slice(step.indexOf("script: |")),
      /\bgh (api|issue|pr)\b/u,
      name,
    );
  }
});

test("the schedule and its serialization are declared", () => {
  assert.match(workflow, /- cron: '17 \* \* \* \*'/u);
  // Overlapping cycles would race on one issue body; queued-not-cancelled keeps
  // a long poll from being retired by the next hour's tick.
  assert.match(
    workflow,
    /group: claude-lane-incident-aggregator\n {2}cancel-in-progress: false/u,
  );
});

// --- Polling behavior ------------------------------------------------------

test("a dry run with no installation polls this repository alone", async () => {
  const { outputs, calls } = await runPoll({ hasInstallation: false });
  assert.equal(outputs.repositories, "1");
  assert.deepEqual(
    calls.filter((call) => call.kind === "pulls").map((call) => call.repo),
    ["melodic-software/ci-workflows"],
  );
  assert.equal(
    calls.some((call) => call.kind === "installation"),
    false,
    "a dry run must not attempt an installation read it cannot perform",
  );
});

test("a credentialed run polls exactly the installation's non-archived repositories", async () => {
  const { outputs, calls } = await runPoll({
    hasInstallation: true,
    installationRepositories: [
      { full_name: "melodic-software/medley", archived: false },
      { full_name: "melodic-software/dotfiles", archived: false },
      { full_name: "melodic-software/medley-archive", archived: true },
    ],
  });
  assert.equal(outputs.repositories, "2");
  assert.deepEqual(
    calls.filter((call) => call.kind === "pulls").map((call) => call.repo),
    ["melodic-software/medley", "melodic-software/dotfiles"],
  );
});

test("an explicit repository override wins over the installation", async () => {
  const { calls } = await runPoll({
    hasInstallation: true,
    installationRepositories: [{ full_name: "melodic-software/medley" }],
    repositoriesOverride:
      "melodic-software/dotfiles, melodic-software/github-iac",
  });
  assert.deepEqual(
    calls.filter((call) => call.kind === "pulls").map((call) => call.repo),
    ["melodic-software/dotfiles", "melodic-software/github-iac"],
  );
});

test("an escalating annotation on a green lane check run produces an incident cycle", async () => {
  const { outputs, tally } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: {
      "sha-a": [
        checkRun({ id: 90, annotationsCount: 1, conclusion: "success" }),
      ],
    },
    annotationsByCheckRun: { 90: [{ message: laneAnnotation("auth", 402) }] },
  });
  assert.equal(outputs.cycle, "incident");
  assert.deepEqual(tally.classCounts, { auth: 1 });
  assert.deepEqual(tally.statusCounts, { 402: 1 });
  assert.deepEqual(Object.keys(tally.repositories), [
    "melodic-software/medley",
  ]);
});

test("a transient class is counted but does not open an incident", async () => {
  const { outputs, tally } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: { "sha-a": [checkRun({ id: 90, annotationsCount: 1 })] },
    annotationsByCheckRun: {
      90: [{ message: laneAnnotation("rate-limit", 429) }],
    },
  });
  assert.equal(outputs.cycle, "clean");
  assert.deepEqual(tally.classCounts, { "rate-limit": 1 });
});

test("an unreadable repository is counted as a read error and never reported as clean", async () => {
  const { outputs, warnings } = await runPoll({
    repositoriesOverride: "melodic-software/medley,melodic-software/dotfiles",
    pullsByRepo: { "melodic-software/dotfiles": [[recentPull(3, "sha-b")]] },
    checkRunsByPull: { "sha-b": [checkRun({ id: 91 })] },
    failFor: ["pulls:melodic-software/medley"],
  });
  assert.equal(outputs["read-errors"], "1");
  assert.equal(
    outputs["lane-runs"],
    "1",
    "the readable repository was still scanned",
  );
  assert.equal(
    outputs.cycle,
    "indeterminate",
    "a partial poll must never advance the clean-cycle counter",
  );
  assert.equal(warnings.length, 1);
});

test("a read failure on one repository does not abort the scan of the others", async () => {
  const { calls } = await runPoll({
    repositoriesOverride: "melodic-software/medley,melodic-software/dotfiles",
    pullsByRepo: { "melodic-software/dotfiles": [[recentPull(3, "sha-b")]] },
    failFor: ["pulls:melodic-software/medley"],
  });
  assert.deepEqual(
    calls.filter((call) => call.kind === "pulls").map((call) => call.repo),
    ["melodic-software/medley", "melodic-software/dotfiles"],
  );
});

test("only lane check runs are counted, and only annotated ones cost an annotations call", async () => {
  const { outputs, calls } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: {
      "sha-a": [
        checkRun({ id: 90, name: "ci-status", annotationsCount: 4 }),
        checkRun({ id: 91, name: "review / review", annotationsCount: 0 }),
        checkRun({
          id: 92,
          name: "security-review / security-review",
          annotationsCount: 1,
        }),
      ],
    },
    annotationsByCheckRun: { 92: [{ message: laneAnnotation("auth", 401) }] },
  });
  assert.equal(outputs["lane-runs"], "2", "ci-status is not a lane check run");
  assert.deepEqual(
    calls
      .filter((call) => call.kind === "annotations")
      .map((call) => call.checkRunId),
    [92],
  );
  assert.equal(outputs.cycle, "incident");
});

test("a bound that truncates the scan is reported as a read error, never as a silent trim", async () => {
  const { outputs } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: {
      "sha-a": Array.from({ length: 13 }, (_unused, index) =>
        checkRun({ id: index + 1, name: "review / review" }),
      ),
    },
  });
  assert.equal(outputs["read-errors"], "1");
  assert.equal(outputs.cycle, "indeterminate");
});

test("pagination stops at the lookback edge rather than walking history", async () => {
  const stale = {
    number: 99,
    head: { sha: "sha-old" },
    updated_at: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
  };
  const { calls, outputs } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: {
      "melodic-software/medley": [
        Array.from({ length: 99 }, (_unused, index) =>
          recentPull(index + 1, "sha-a"),
        ).concat([stale]),
        [recentPull(500, "sha-c")],
      ],
    },
    checkRunsByPull: { "sha-a": [] },
  });
  assert.equal(
    calls.filter((call) => call.kind === "pulls").length,
    1,
    "the second page must never be fetched once the lookback edge is crossed",
  );
  assert.equal(outputs.pulls, "99");
  assert.equal(outputs["read-errors"], "0");
});

test("the API-call count reported to the log is the number of reads actually attempted", async () => {
  const { outputs, calls } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: { "sha-a": [checkRun({ id: 90, annotationsCount: 1 })] },
    annotationsByCheckRun: { 90: [{ message: laneAnnotation("auth", 401) }] },
  });
  assert.equal(Number(outputs["api-calls"]), calls.length);
});

// --- Issue selection -------------------------------------------------------

async function runLookup(openIssues) {
  const keys = ["GITHUB_WORKSPACE"];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  process.env.GITHUB_WORKSPACE = repositoryRoot;
  const outputs = {};
  let failedWith = null;
  try {
    const github = {
      paginate: async () => openIssues,
      rest: { issues: { listForRepo: () => {} } },
    };
    const core = {
      setOutput: (key, value) => (outputs[key] = value),
      setFailed: (message) => (failedWith = message),
    };
    const context = {
      repo: { owner: "melodic-software", repo: "ci-workflows" },
    };
    const execute = new AsyncFunction(
      "github",
      "core",
      "context",
      "require",
      "process",
      extractStepScript("Find the open incident issue"),
    );
    await execute(github, core, context, require, process);
    return { outputs, failedWith };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

const { SELECTOR_MARKER } = require("./claude-lane-incident.cjs");

test("the lookup adopts the bot-authored issue carrying the marker", async () => {
  const { outputs } = await runLookup([
    { number: 42, user: { type: "Bot" }, body: `${SELECTOR_MARKER}\nreport` },
  ]);
  assert.equal(outputs.number, "42");
  assert.match(outputs.body, /report/u);
});

test("a human-authored decoy carrying the public marker is never adopted", async () => {
  const { outputs, failedWith } = await runLookup([
    { number: 7, user: { type: "User" }, body: `${SELECTOR_MARKER}\ndecoy` },
    { number: 8, user: { type: "User" }, body: `${SELECTOR_MARKER}\ndecoy` },
  ]);
  assert.equal(failedWith, null, "decoys must not fail the lookup closed");
  assert.equal(outputs.number, "");
});

test("a pull request carrying the marker is not mistaken for the incident issue", async () => {
  const { outputs } = await runLookup([
    {
      number: 9,
      user: { type: "Bot" },
      pull_request: {},
      body: `${SELECTOR_MARKER}\nnot an issue`,
    },
  ]);
  assert.equal(outputs.number, "");
});

test("two genuine bot-authored incident issues fail the lookup closed", async () => {
  const { failedWith } = await runLookup([
    { number: 1, user: { type: "Bot" }, body: SELECTOR_MARKER },
    { number: 2, user: { type: "Bot" }, body: SELECTOR_MARKER },
  ]);
  assert.match(failedWith, /found 2 open issues carrying the incident marker/u);
});
