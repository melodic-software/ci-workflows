"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const workflowPath = path.join(
  __dirname,
  "..",
  "workflows",
  "standards-sync-stuck-automerge-alert.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");

// Same inline-script extraction technique standards-sync-app-attestation.test.cjs
// and standards-sync-automerge-arm.test.cjs use: pull the actions/github-script
// body out of the YAML by name and run it directly.
function extractScanScript() {
  const lines = workflow.split(/\r?\n/u);
  const stepIndex = lines.findIndex((line) =>
    line.includes(
      "- name: Scan targets for stuck or never-armed pull requests",
    ),
  );
  assert.notEqual(stepIndex, -1, "scan step must exist");
  const scriptIndex = lines.findIndex(
    (line, index) => index > stepIndex && /^ {10}script: \|$/u.test(line),
  );
  assert.notEqual(scriptIndex, -1, "scan script block must exist");
  const body = [];
  for (let index = scriptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return body.join("\n");
}

const scanScript = extractScanScript();

const HOURS_AGO = (hours) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

function pullRequest({
  number = 1,
  login = "melodic-standards-sync",
  typename = "Bot",
  enabledAt = null,
  mergeStateStatus = "CLEAN",
  // Default well inside the threshold so an existing armed-PR fixture is never
  // incidentally old enough to also trip the never-armed detector.
  createdAt = HOURS_AGO(1),
} = {}) {
  return {
    number,
    url: `https://github.com/melodic-software/dotfiles/pull/${number}`,
    createdAt,
    author: { login, __typename: typename },
    autoMergeRequest: enabledAt ? { enabledAt } : null,
    mergeStateStatus,
  };
}

async function runScan({
  repoNames = ["dotfiles"],
  automergeRepoNames = null,
  wasEverArmed = {},
  armingHistoryFailures = {},
  thresholdHours = 4,
  nodesByRepo = {},
  pagesByRepo = null,
  infinitePagesFor = null,
  retryAttempts = 4,
  listFailures = {},
  mergeStateFailures = {},
  probeOverrides = {},
  workspace,
  // Test-mode wiring: undefined leaves the env var UNSET (the state every
  // pre-existing case runs in, and the off-on-undefined contract); a string
  // sets it verbatim, mirroring the workflow's `${{ inputs.test-mode }}`.
  testMode,
  testSyntheticCandidates,
  markerEnv = MARKER,
} = {}) {
  const keys = [
    "BOT_LOGIN",
    "REPO_NAMES",
    "AUTOMERGE_REPO_NAMES",
    "THRESHOLD_HOURS",
    "GITHUB_WORKSPACE",
    "GRAPHQL_RETRY_ATTEMPTS",
    "GRAPHQL_RETRY_BASE_MS",
    "TEST_MODE",
    "TEST_SYNTHETIC_CANDIDATES",
    "ALERT_MARKER",
  ];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  const effectiveWorkspace =
    workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "stuck-alert-"));
  // TEST_MODE / TEST_SYNTHETIC_CANDIDATES must stay genuinely ABSENT unless a
  // case opts in — Object.assign would coerce an undefined value to the string
  // "undefined", which is not the same contract.
  delete process.env.TEST_MODE;
  delete process.env.TEST_SYNTHETIC_CANDIDATES;
  Object.assign(process.env, {
    BOT_LOGIN: "melodic-standards-sync",
    REPO_NAMES: repoNames.join(","),
    // Absent override: every scanned repo is manifest-armed, the common case.
    AUTOMERGE_REPO_NAMES: (automergeRepoNames ?? repoNames).join(","),
    THRESHOLD_HOURS: String(thresholdHours),
    GITHUB_WORKSPACE: effectiveWorkspace,
    GRAPHQL_RETRY_ATTEMPTS: String(retryAttempts),
    // Zero backoff so the retry-path tests never actually sleep.
    GRAPHQL_RETRY_BASE_MS: "0",
    ALERT_MARKER: markerEnv,
  });
  if (testMode !== undefined) process.env.TEST_MODE = testMode;
  if (testSyntheticCandidates !== undefined) {
    process.env.TEST_SYNTHETIC_CANDIDATES = testSyntheticCandidates;
  }
  // Every node the mock knows for a repo, flattened across pages; the phase-2
  // per-PR probe looks its mergeStateStatus up here by number.
  const allNodesFor = (repo) =>
    (pagesByRepo?.[repo] ?? [nodesByRepo[repo] ?? []]).flat();
  const remainingListFailures = { ...listFailures };
  const remainingMergeFailures = { ...mergeStateFailures };
  const remainingArmingHistoryFailures = { ...armingHistoryFailures };
  const graphqlCalls = [];
  const outputs = {};
  const infos = [];
  let failedWith = null;
  let threw = null;
  try {
    const github = {
      // Two query shapes now share this mock. A phase-2 probe carries a
      // `number` variable and returns the PR's current autoMergeRequest and
      // mergeStateStatus. A phase-1 page fetch carries an `after` cursor (null
      // on the first page, then the previous endCursor). Pages come from one
      // flat array (nodesByRepo) or an explicit array-of-pages (pagesByRepo);
      // a repo in infinitePagesFor never terminates, exercising MAX_PAGES.
      // A positive listFailures/mergeStateFailures budget throws first,
      // simulating the opaque server-side error the retry path must absorb
      // (Infinity == a permanent failure). probeOverrides[number] supplies the
      // fresh armed state (enabledAt), state, and/or mergeStateStatus the probe
      // should report, distinct from the page value, to exercise the
      // disarm/re-arm and close/merge races; absent an override the probe
      // echoes the page node and reports the PR still OPEN.
      graphql: async (query, variables) => {
        graphqlCalls.push({ query, variables });
        if (variables.number != null && /timelineItems/u.test(query)) {
          const historyBudget =
            remainingArmingHistoryFailures[variables.number] ?? 0;
          if (historyBudget > 0) {
            remainingArmingHistoryFailures[variables.number] =
              historyBudget - 1;
            throw new Error(
              `simulated server error probing arming history for #${variables.number}`,
            );
          }
          const node = allNodesFor(variables.repo).find(
            (pr) => pr.number === variables.number,
          );
          const override = probeOverrides[variables.number];
          const enabledAt =
            override && "enabledAt" in override
              ? override.enabledAt
              : (node?.autoMergeRequest?.enabledAt ?? null);
          return {
            repository: {
              pullRequest: {
                state: override?.state ?? "OPEN",
                autoMergeRequest: enabledAt ? { enabledAt } : null,
                // Mirrors real GitHub: `nodes` is filtered by itemTypes, and a
                // SQUASH arm records AutoSquashEnabledEvent. `totalCount` is
                // deliberately a non-zero decoy the production code must not
                // read, because GitHub reports the WHOLE timeline there.
                timelineItems: {
                  totalCount: 4,
                  nodes: wasEverArmed[variables.number]
                    ? [{ __typename: "AutoSquashEnabledEvent" }]
                    : [],
                },
              },
            },
          };
        }
        if (variables.number != null) {
          const budget = remainingMergeFailures[variables.number] ?? 0;
          if (budget > 0) {
            remainingMergeFailures[variables.number] = budget - 1;
            throw new Error(
              `simulated server error probing #${variables.number}`,
            );
          }
          const node = allNodesFor(variables.repo).find(
            (pr) => pr.number === variables.number,
          );
          const override = probeOverrides[variables.number];
          if (!node && !override) {
            return { repository: { pullRequest: null } };
          }
          const enabledAt =
            override && "enabledAt" in override
              ? override.enabledAt
              : (node?.autoMergeRequest?.enabledAt ?? null);
          const mergeStateStatus =
            override && "mergeStateStatus" in override
              ? override.mergeStateStatus
              : node?.mergeStateStatus;
          return {
            repository: {
              pullRequest: {
                autoMergeRequest: enabledAt ? { enabledAt } : null,
                mergeStateStatus,
              },
            },
          };
        }
        const listBudget = remainingListFailures[variables.repo] ?? 0;
        if (listBudget > 0) {
          remainingListFailures[variables.repo] = listBudget - 1;
          throw new Error(`simulated server error listing ${variables.repo}`);
        }
        const pageIndex = variables.after == null ? 0 : Number(variables.after);
        if (infinitePagesFor?.includes(variables.repo)) {
          return {
            repository: {
              pullRequests: {
                nodes: [],
                pageInfo: {
                  hasNextPage: true,
                  endCursor: String(pageIndex + 1),
                },
              },
            },
          };
        }
        const pages = pagesByRepo?.[variables.repo] ?? [
          nodesByRepo[variables.repo] ?? [],
        ];
        const nodes = pages[pageIndex] ?? [];
        const hasNextPage = pageIndex + 1 < pages.length;
        return {
          repository: {
            pullRequests: {
              nodes,
              pageInfo: {
                hasNextPage,
                endCursor: hasNextPage ? String(pageIndex + 1) : null,
              },
            },
          },
        };
      },
    };
    const core = {
      setOutput: (key, value) => (outputs[key] = value),
      setFailed: (message) => (failedWith = message),
      info: (message) => infos.push(message),
    };
    const execute = new AsyncFunction(
      "github",
      "core",
      "require",
      "process",
      "context",
      scanScript,
    );
    // Only the test-mode branch reads `context` (for the run URL in synthetic
    // rows); production-path cases never touch it.
    const context = {
      serverUrl: "https://github.com",
      repo: { owner: "melodic-software", repo: "standards" },
      runId: 12345,
    };
    try {
      await execute(github, core, require, process, context);
    } catch (error) {
      // Captured, not rethrown, so a persistent-failure test can assert both
      // that the run threw and that stuck-count was never set (no false clear).
      threw = error;
    }
    const reportPath = path.join(
      effectiveWorkspace,
      ".stuck-automerge-report.md",
    );
    const report = fs.existsSync(reportPath)
      ? fs.readFileSync(reportPath, "utf8")
      : null;
    return { graphqlCalls, outputs, infos, failedWith, report, threw };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

test("queries every manifest-derived target repository, not a hardcoded subset", async () => {
  const { graphqlCalls } = await runScan({
    repoNames: ["dotfiles", "medley", "ci-runner"],
  });
  assert.deepEqual(graphqlCalls.map((call) => call.variables.repo).sort(), [
    "ci-runner",
    "dotfiles",
    "medley",
  ]);
  assert.ok(
    graphqlCalls.every((call) => call.variables.owner === "melodic-software"),
  );
});

test("a PR with no auto-merge armed is not reported, regardless of merge state", async () => {
  const { outputs, report } = await runScan({
    nodesByRepo: {
      dotfiles: [pullRequest({ enabledAt: null, mergeStateStatus: "BLOCKED" })],
    },
  });
  assert.equal(outputs["stuck-count"], "0");
  assert.equal(report, null);
});

test("an armed PR that is CLEAN (not BLOCKED) is not reported", async () => {
  const { outputs } = await runScan({
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          enabledAt: "2020-01-01T00:00:00Z",
          mergeStateStatus: "CLEAN",
        }),
      ],
    },
  });
  assert.equal(outputs["stuck-count"], "0");
});

test("an armed, BLOCKED PR younger than the threshold is not reported", async () => {
  const recentlyArmed = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  const { outputs } = await runScan({
    thresholdHours: 4,
    nodesByRepo: {
      dotfiles: [
        pullRequest({ enabledAt: recentlyArmed, mergeStateStatus: "BLOCKED" }),
      ],
    },
  });
  assert.equal(outputs["stuck-count"], "0");
});

test("an armed, BLOCKED PR past the threshold is reported with a marker and a recovery section", async () => {
  const staleArmed = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5h ago
  const { outputs, report } = await runScan({
    repoNames: ["dotfiles"],
    thresholdHours: 4,
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 7,
          enabledAt: staleArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
  });
  assert.equal(outputs["stuck-count"], "1");
  assert.match(
    report,
    /<!-- ci-workflows:standards-sync-stuck-automerge-alert:v1:active -->/u,
  );
  assert.match(report, /#7/u);
  assert.match(report, /### Recover/u);
});

test("a bot-shaped author with an unrelated login is ignored (exact-login match, not a [bot]-suffix pattern)", async () => {
  const staleArmed = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const { outputs } = await runScan({
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          login: "some-other-app",
          enabledAt: staleArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
  });
  assert.equal(outputs["stuck-count"], "0");
});

test("a human author impersonating the bot's login string is ignored (__typename must also be Bot)", async () => {
  const staleArmed = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const { outputs } = await runScan({
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          login: "melodic-standards-sync",
          typename: "User",
          enabledAt: staleArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
  });
  assert.equal(outputs["stuck-count"], "0");
});

// Same structural check ci-workflows#212 added for link-check.yml's
// equivalent tracking-issue steps: this reusable also runs on whatever
// runner the caller selected, so its issue lookup/close steps must not
// assume the gh CLI is on PATH (a self-hosted image is not guaranteed to
// ship it) — they run on actions/github-script instead.
function stepText(name) {
  const stepIndex = workflow.indexOf(`- name: ${name}`);
  assert.ok(stepIndex >= 0, `step '${name}' is missing`);
  const nextStepOffset = workflow
    .slice(stepIndex + 1)
    .search(/\n\s*(?:#[^\n]*\n\s*)*- name:/u);
  return nextStepOffset >= 0
    ? workflow.slice(stepIndex, stepIndex + 1 + nextStepOffset)
    : workflow.slice(stepIndex);
}

test("the tracking-issue lookup and close steps run on github-script, not the gh CLI", () => {
  for (const name of [
    "Find existing tracking issue",
    "Close recovered tracking issue",
  ]) {
    const step = stepText(name);
    assert.match(
      step,
      /uses: actions\/github-script@/u,
      `'${name}' must run on github-script, not shell out to the gh CLI`,
    );
    // Scoped to the executable script, not the whole step: surrounding
    // explanatory comments may name the gh CLI in prose without invoking it.
    const scriptBody = step.slice(step.indexOf("script: |"));
    assert.doesNotMatch(
      scriptBody,
      /\bgh (api|issue|pr)\b/u,
      `'${name}' must not shell out to the gh CLI`,
    );
  }
});

test("multiple stuck PRs across repos are all reported", async () => {
  const staleArmed = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
  const { outputs, report } = await runScan({
    repoNames: ["dotfiles", "medley"],
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 3,
          enabledAt: staleArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
      medley: [
        pullRequest({
          number: 9,
          enabledAt: staleArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
  });
  assert.equal(outputs["stuck-count"], "2");
  assert.match(report, /#3/u);
  assert.match(report, /#9/u);
});

test("a stuck PR sorted onto a later GraphQL page is still found (manual cursor pagination)", async () => {
  const staleArmed = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { graphqlCalls, outputs, report } = await runScan({
    repoNames: ["dotfiles"],
    thresholdHours: 4,
    pagesByRepo: {
      dotfiles: [
        [pullRequest({ number: 1, mergeStateStatus: "CLEAN" })],
        [
          pullRequest({
            number: 99,
            enabledAt: staleArmed,
            mergeStateStatus: "BLOCKED",
          }),
        ],
      ],
    },
  });
  const pageCalls = graphqlCalls.filter(
    (call) => call.variables.number == null,
  );
  assert.equal(
    pageCalls.length,
    2,
    "both pages must be fetched, and no more than that",
  );
  assert.equal(pageCalls[0].variables.after, null);
  assert.equal(pageCalls[1].variables.after, "1");
  assert.equal(outputs["stuck-count"], "1");
  assert.match(report, /#99/u);
});

test("an all-clear result that never fetched every page is not trusted (pagination must terminate at hasNextPage: false, not an assumed single page)", async () => {
  const { graphqlCalls, outputs } = await runScan({
    repoNames: ["dotfiles"],
    pagesByRepo: {
      dotfiles: [
        [pullRequest({ number: 1, mergeStateStatus: "CLEAN" })],
        [pullRequest({ number: 2, mergeStateStatus: "CLEAN" })],
        [pullRequest({ number: 3, mergeStateStatus: "CLEAN" })],
      ],
    },
  });
  const pageCalls = graphqlCalls.filter(
    (call) => call.variables.number == null,
  );
  assert.equal(pageCalls.length, 3);
  assert.equal(outputs["stuck-count"], "0");
});

test("a repository stuck on an unterminated page sequence fails closed via MAX_PAGES rather than hanging or falsely clearing", async () => {
  const { failedWith, outputs } = await runScan({
    repoNames: ["dotfiles"],
    infinitePagesFor: ["dotfiles"],
  });
  assert.ok(failedWith, "expected core.setFailed to be called");
  assert.match(failedWith, /more than/u);
  assert.equal(
    outputs["stuck-count"],
    undefined,
    "must not report a false all-clear after aborting mid-scan",
  );
});

test("the page query never selects mergeStateStatus; a dedicated per-PR query fetches it", async () => {
  const staleArmed = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { graphqlCalls } = await runScan({
    repoNames: ["dotfiles"],
    thresholdHours: 4,
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 4,
          enabledAt: staleArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
  });
  const pageCall = graphqlCalls.find((call) => call.variables.number == null);
  const probeCall = graphqlCalls.find((call) => call.variables.number != null);
  assert.doesNotMatch(
    pageCall.query,
    /mergeStateStatus/u,
    "the paginated page query must not fan mergeStateStatus out across the page",
  );
  assert.match(probeCall.query, /pullRequest\(number:/u);
  assert.match(probeCall.query, /mergeStateStatus/u);
});

test("only armed, past-threshold bot PRs are probed for merge state — no bulk fan-out across the page", async () => {
  const staleArmed = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const recentlyArmed = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const { graphqlCalls, outputs, report } = await runScan({
    repoNames: ["dotfiles"],
    thresholdHours: 4,
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 1,
          enabledAt: null,
          mergeStateStatus: "BLOCKED",
        }),
        pullRequest({
          number: 2,
          login: "some-human",
          typename: "User",
          enabledAt: staleArmed,
          mergeStateStatus: "BLOCKED",
        }),
        pullRequest({
          number: 3,
          enabledAt: recentlyArmed,
          mergeStateStatus: "BLOCKED",
        }),
        pullRequest({
          number: 4,
          enabledAt: staleArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
  });
  const probeCalls = graphqlCalls.filter(
    (call) => call.variables.number != null,
  );
  assert.equal(
    probeCalls.length,
    1,
    "exactly one merge-state probe — for the single armed, past-threshold bot PR",
  );
  assert.equal(probeCalls[0].variables.number, 4);
  assert.equal(outputs["stuck-count"], "1");
  assert.match(report, /#4/u);
});

test("a transient server error on a page fetch is retried, then the page is processed", async () => {
  const staleArmed = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { graphqlCalls, outputs } = await runScan({
    repoNames: ["dotfiles"],
    thresholdHours: 4,
    retryAttempts: 3,
    listFailures: { dotfiles: 1 },
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 5,
          enabledAt: staleArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
  });
  const pageCalls = graphqlCalls.filter(
    (call) => call.variables.number == null,
  );
  assert.equal(
    pageCalls.length,
    2,
    "one failure then a success on the page fetch",
  );
  assert.equal(outputs["stuck-count"], "1");
});

test("a transient server error on the per-PR merge-state probe is retried, and the PR is still reported", async () => {
  const staleArmed = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { graphqlCalls, outputs, report, threw } = await runScan({
    repoNames: ["dotfiles"],
    thresholdHours: 4,
    retryAttempts: 4,
    mergeStateFailures: { 7: 2 },
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 7,
          enabledAt: staleArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
  });
  const probeCalls = graphqlCalls.filter((call) => call.variables.number === 7);
  assert.equal(
    probeCalls.length,
    3,
    "two failures then a success on the probe",
  );
  assert.equal(threw, null);
  assert.equal(outputs["stuck-count"], "1");
  assert.match(report, /#7/u);
});

test("a persistent server error on the merge-state probe fails the run loudly and never reports a false all-clear", async () => {
  const staleArmed = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { threw, outputs } = await runScan({
    repoNames: ["dotfiles"],
    thresholdHours: 4,
    retryAttempts: 3,
    mergeStateFailures: { 7: Infinity },
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 7,
          enabledAt: staleArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
  });
  assert.ok(threw, "a persistent server error must propagate and fail the run");
  assert.match(threw.message, /simulated server error/u);
  assert.equal(
    outputs["stuck-count"],
    undefined,
    "must not report a false all-clear after aborting mid-scan",
  );
});

test("a candidate disarmed between the page fetch and the probe is not reported (armed state re-validated against fresh probe data)", async () => {
  const pageArmed = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { outputs, report } = await runScan({
    repoNames: ["dotfiles"],
    thresholdHours: 4,
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 8,
          enabledAt: pageArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
    probeOverrides: { 8: { enabledAt: null } },
  });
  assert.equal(outputs["stuck-count"], "0");
  assert.equal(report, null);
});

test("the reported armed duration is computed from the probe-fresh enabledAt, not the stale page value", async () => {
  const pageArmed = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const freshArmed = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { outputs, report } = await runScan({
    repoNames: ["dotfiles"],
    thresholdHours: 4,
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 8,
          enabledAt: pageArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
    probeOverrides: { 8: { enabledAt: freshArmed } },
  });
  assert.equal(outputs["stuck-count"], "1");
  assert.match(report, /\| 6h \|/u);
  assert.doesNotMatch(report, /20h/u);
});

test("a candidate re-armed under the threshold between page and probe is not reported (threshold re-checked against fresh enabledAt)", async () => {
  const pageArmed = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const freshArmed = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const { outputs, report } = await runScan({
    repoNames: ["dotfiles"],
    thresholdHours: 4,
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 8,
          enabledAt: pageArmed,
          mergeStateStatus: "BLOCKED",
        }),
      ],
    },
    probeOverrides: { 8: { enabledAt: freshArmed } },
  });
  assert.equal(outputs["stuck-count"], "0");
  assert.equal(report, null);
});

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

function issue({
  number,
  login = "github-actions[bot]",
  type = "Bot",
  body = "",
  title = "[Alert] standards-sync auto-merge PR(s) needing attention",
  pull_request = null,
} = {}) {
  return { number, user: { login, type }, body, title, pull_request };
}

const MARKER =
  "<!-- ci-workflows:standards-sync-stuck-automerge-alert:v1:active -->";
const ISSUE_TITLE = "[Alert] standards-sync auto-merge PR(s) needing attention";

// The caller repository and the tracking-issue repository are deliberately
// different fixtures everywhere below: the defect these steps were changed for
// is that they addressed the CALLER, which the App is not installed on.
// Identical values would let a regression to `context.repo.repo` keep every
// assertion green.
const CALLER_REPO = "standards";
const TRACKING_ISSUE_REPOSITORY = "medley";

async function runLookup({ openIssues = [], envOverrides = {} } = {}) {
  const script = extractStepScript("Find existing tracking issue");
  const keys = [
    "MARKER",
    "ISSUE_TITLE",
    "ISSUE_AUTHOR_LOGIN",
    "TRACKING_ISSUE_REPOSITORY",
  ];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    MARKER,
    ISSUE_TITLE,
    ISSUE_AUTHOR_LOGIN: "github-actions[bot]",
    TRACKING_ISSUE_REPOSITORY,
    ...envOverrides,
  });
  const outputs = {};
  const listParams = [];
  let failedWith = null;
  try {
    const github = {
      paginate: async (_fn, params) => {
        listParams.push(params);
        return openIssues;
      },
      rest: { issues: { listForRepo: () => {} } },
    };
    const core = {
      setOutput: (key, value) => (outputs[key] = value),
      setFailed: (message) => (failedWith = message),
    };
    const context = {
      repo: { owner: "melodic-software", repo: CALLER_REPO },
    };
    const execute = new AsyncFunction(
      "github",
      "core",
      "context",
      "process",
      script,
    );
    await execute(github, core, context, process);
    return { outputs, failedWith, listParams };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

async function runClose({ openIssues = [] } = {}) {
  const script = extractStepScript("Close recovered tracking issue");
  const keys = ["MARKER", "ISSUE_AUTHOR_LOGIN", "TRACKING_ISSUE_REPOSITORY"];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    MARKER,
    ISSUE_AUTHOR_LOGIN: "github-actions[bot]",
    TRACKING_ISSUE_REPOSITORY,
  });
  const comments = [];
  const updates = [];
  const listParams = [];
  try {
    const github = {
      paginate: async (_fn, params) => {
        listParams.push(params);
        return openIssues;
      },
      rest: {
        issues: {
          listForRepo: () => {},
          createComment: async (params) => comments.push(params),
          update: async (params) => updates.push(params),
        },
      },
    };
    const core = {};
    const context = {
      repo: { owner: "melodic-software", repo: CALLER_REPO },
    };
    const execute = new AsyncFunction(
      "github",
      "core",
      "context",
      "process",
      script,
    );
    await execute(github, core, context, process);
    return { comments, updates, listParams };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

test("the lookup adopts an open issue this workflow's own identity authored and marked", async () => {
  const { outputs } = await runLookup({
    openIssues: [issue({ number: 5, body: `${MARKER}\nreport` })],
  });
  assert.equal(outputs["issue-number"], "5");
});

test("the lookup ignores a decoy issue that carries the marker but was not authored by github-actions[bot]", async () => {
  const { outputs } = await runLookup({
    openIssues: [
      issue({
        number: 5,
        login: "some-random-user",
        type: "User",
        body: `${MARKER}\nreport`,
      }),
    ],
  });
  assert.equal(
    outputs["issue-number"],
    "",
    "an attacker-authored decoy carrying the public marker string must never be adopted",
  );
});

test("the lookup ignores a decoy issue that carries the exact title but was not authored by github-actions[bot]", async () => {
  const { outputs } = await runLookup({
    openIssues: [
      issue({
        number: 5,
        login: "some-random-user",
        type: "User",
        body: "unrelated",
        title: ISSUE_TITLE,
      }),
    ],
  });
  assert.equal(outputs["issue-number"], "");
});

test("two decoy issues carrying the marker cannot fail the lookup closed and block a real alert (they are filtered out before the ambiguity check)", async () => {
  const { outputs, failedWith } = await runLookup({
    openIssues: [
      issue({
        number: 5,
        login: "attacker-one",
        type: "User",
        body: `${MARKER}\ndecoy`,
      }),
      issue({
        number: 6,
        login: "attacker-two",
        type: "User",
        body: `${MARKER}\ndecoy`,
      }),
      issue({ number: 7, body: `${MARKER}\nreal report` }),
    ],
  });
  assert.equal(failedWith, null);
  assert.equal(outputs["issue-number"], "7");
});

test("the lookup still fails closed on a genuine ambiguity between two bot-authored issues", async () => {
  const { failedWith } = await runLookup({
    openIssues: [
      issue({ number: 5, body: `${MARKER}\nreport a` }),
      issue({ number: 6, body: `${MARKER}\nreport b` }),
    ],
  });
  assert.match(failedWith, /found 2 issues carrying marker/u);
});

test("close ignores a decoy issue and takes no action when none of the candidates are bot-authored", async () => {
  const { comments, updates } = await runClose({
    openIssues: [
      issue({
        number: 5,
        login: "some-random-user",
        type: "User",
        body: `${MARKER}\ndecoy`,
      }),
    ],
  });
  assert.equal(comments.length, 0);
  assert.equal(updates.length, 0);
});

test("close comments on and closes the genuine bot-authored tracking issue", async () => {
  const { comments, updates } = await runClose({
    openIssues: [issue({ number: 5, body: `${MARKER}\nreport` })],
  });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issue_number, 5);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    owner: "melodic-software",
    repo: TRACKING_ISSUE_REPOSITORY,
    issue_number: 5,
    state: "closed",
    state_reason: "completed",
  });
});

// --- the tracking issue's destination repository ---------------------------
// The App that authors the issue is installed on the sync TARGETS, and the
// caller (melodic-software/standards) is the sync SOURCE, deliberately not one
// of them. Addressing the caller made the token mint 404 on every scheduled
// run, so every step that touches the issue must address
// `tracking-issue-repository`, never `context.repo.repo`.

test("the lookup reads issues from the tracking-issue repository, not the caller", async () => {
  const { listParams } = await runLookup({
    openIssues: [issue({ number: 5, body: `${MARKER}\nreport` })],
  });
  assert.equal(listParams.length, 1);
  assert.equal(listParams[0].owner, "melodic-software");
  assert.equal(listParams[0].repo, TRACKING_ISSUE_REPOSITORY);
  assert.notEqual(listParams[0].repo, CALLER_REPO);
});

test("close reads and writes the tracking-issue repository, not the caller", async () => {
  const { listParams, comments } = await runClose({
    openIssues: [issue({ number: 5, body: `${MARKER}\nreport` })],
  });
  assert.equal(listParams[0].repo, TRACKING_ISSUE_REPOSITORY);
  assert.equal(comments[0].owner, "melodic-software");
  assert.equal(comments[0].repo, TRACKING_ISSUE_REPOSITORY);
});

test("the tracking-issue repository is a required workflow_call input, never defaulted", () => {
  const inputBlock =
    /\n {6}tracking-issue-repository:\n((?: {8}.*\n|\n)+)/u.exec(workflow);
  assert.ok(inputBlock, "tracking-issue-repository input must be declared");
  assert.match(inputBlock[1], /^ {8}required: true$/mu);
  // A default would restore the defect's shape: a caller that says nothing
  // gets a destination the App may not be installed on, and finds out only
  // when the alert first has something to report.
  assert.doesNotMatch(inputBlock[1], /^ {8}default:/mu);
});

// Executed rather than pattern-matched, the way
// claude-security-review-fail-closed.test.cjs runs its own `run:` blocks: the
// guard's whole value is what bash does with a given value.
function runRepositoryGuard(value) {
  const step = stepText("Reject a malformed tracking-issue repository");
  const marker = "        run: |\n";
  const start = step.indexOf(marker);
  assert.notEqual(start, -1, "the guard step has no literal run block");
  const lines = step.slice(start + marker.length).split("\n");
  const end = lines.findIndex(
    (line) => line !== "" && !line.startsWith("          "),
  );
  const body = (end === -1 ? lines : lines.slice(0, end))
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
  assert.doesNotMatch(
    body,
    /\$\{\{/u,
    "the guard interpolates a github expression, so running it here would not match CI",
  );
  return spawnSync("bash", ["-c", body], {
    encoding: "utf8",
    env: { ...process.env, TRACKING_ISSUE_REPOSITORY: value },
  });
}

test("the repository guard is the job's first step, so a bad value fails before the scan", () => {
  const firstStep =
    /\n {4}steps:\n {6}(?:#[^\n]*\n {6})*- name: ([^\n]+)\n/u.exec(workflow);
  assert.equal(firstStep?.[1], "Reject a malformed tracking-issue repository");
});

test("the repository guard accepts a bare repository name", () => {
  assert.equal(runRepositoryGuard("medley").status, 0);
  assert.equal(runRepositoryGuard("ci-workflows").status, 0);
  assert.equal(runRepositoryGuard(".github").status, 0);
});

// An `owner/repo` value is the trap worth failing fast on: the mint ACCEPTS it
// (create-github-app-token parses an owner-qualified entry), so the run gets
// past the credential and dies later and less legibly — `listForRepo` 404s on
// a name containing a slash, and the issue write concatenates a second owner.
test("the repository guard rejects owner/repo, a URL, an empty value, stray whitespace, and a relative path segment", () => {
  for (const value of [
    "melodic-software/medley",
    "https://github.com/melodic-software/medley",
    "",
    "medley ",
    // GitHub forbids both as repository names, and both are inside the
    // character class, so they would reach the REST client as a path segment.
    ".",
    "..",
  ]) {
    const result = runRepositoryGuard(value);
    assert.equal(result.status, 1, `'${value}' must be rejected`);
    assert.match(result.stdout + result.stderr, /::error::/u);
  }
});

test("the issue token is scoped to the named repository and the issue write targets it", () => {
  const mintStep = stepText("Mint App token for the tracking-issue repository");
  assert.match(
    mintStep,
    /repositories: \$\{\{ inputs\.tracking-issue-repository \}\}/u,
    "leaving owner AND repositories unset is what scoped the token to the caller",
  );
  // The ABSENCE of `owner` is load-bearing, and it is the one property of this
  // step nothing else would catch. With `owner` unset the action resolves a
  // repository entry's owner to the calling repository's owner, which is what
  // makes a bare name legal and what keeps the destination inside the caller's
  // own installation. The sibling every-target mint two hundred lines up does
  // the opposite deliberately, so both halves are pinned here: harmonizing
  // them in EITHER direction fails, rather than silently undoing one of them.
  assert.doesNotMatch(
    mintStep,
    /^\s*owner:/mu,
    "`owner` must stay unset so a bare repository name resolves under the caller's own owner",
  );
  assert.match(
    stepText("Mint read-only App token scoped to every target"),
    /^\s*owner: melodic-software$/mu,
    "the every-target mint pins its owner explicitly; the asymmetry with the tracking mint is the design",
  );
  const writeStep = stepText("Open or update tracking issue");
  assert.match(
    writeStep,
    /repository: \$\{\{ github\.repository_owner \}\}\/\$\{\{ inputs\.tracking-issue-repository \}\}/u,
    "create-issue-from-file defaults `repository` to the caller",
  );
});

// The three consumers of the issue token partition the outcome space: the
// lookup and the open/update run when a count is non-zero, and the recovery
// close runs when BOTH are zero. So the mint cannot carry the non-zero
// condition — that would leave the close branch tokenless on exactly the runs
// it exists for — and it cannot be dropped on a clean run either.
test("the issue-token mint is unconditional, because the close branch is the complement of the other two", () => {
  const mintStep = stepText("Mint App token for the tracking-issue repository");
  assert.doesNotMatch(
    mintStep,
    /^ {8}if:/mu,
    "guarding the mint on the alert condition strands the recovery-close branch",
  );
  const alerting =
    "if: steps.scan.outputs.stuck-count != '0' || steps.scan.outputs.unarmed-count != '0'";
  const recovering =
    "if: steps.scan.outputs.stuck-count == '0' && steps.scan.outputs.unarmed-count == '0'";
  for (const name of [
    "Find existing tracking issue",
    "Open or update tracking issue",
  ]) {
    assert.ok(
      stepText(name).includes(alerting),
      `'${name}' must run only when there is something to report`,
    );
  }
  assert.ok(
    stepText("Close recovered tracking issue").includes(recovering),
    "the close branch must be the exact complement of the alerting condition",
  );
});

// --- never-armed detection -------------------------------------------------
// standards-sync.yml swallows every arming rejection into a core.warning, so a
// failed arm is indistinguishable from the pre-arming status quo. These cover
// the detector that makes that state observable, and — equally important — the
// states that must NOT alarm, since a watchdog that cries wolf gets muted.

// Two GraphQL semantics no mock can enforce, both verified against live
// GitHub and both silently wrong in an earlier revision of this scan:
// `totalCount` reports the WHOLE timeline and ignores `itemTypes`, and a
// `mergeMethod: SQUASH` arm records AutoSquashEnabledEvent — so reading
// totalCount, or naming only AUTO_MERGE_ENABLED_EVENT, makes the exoneration
// answer the opposite of the truth on every PR.
test("the arming history is read from filtered nodes, never totalCount", () => {
  assert.match(scanScript, /timelineItems\(first: 1, itemTypes: \[/u);
  assert.match(scanScript, /timelineItems\.nodes\.length/u);
  assert.doesNotMatch(
    scanScript,
    /timelineItems\([^)]*\)\s*\{\s*totalCount|timelineItems\.totalCount/u,
  );
});

test("the arming history covers every merge method's enabled event", () => {
  for (const eventType of [
    "AUTO_MERGE_ENABLED_EVENT",
    "AUTO_SQUASH_ENABLED_EVENT",
    "AUTO_REBASE_ENABLED_EVENT",
  ]) {
    assert.ok(
      scanScript.includes(eventType),
      `${eventType} must be probed; the merge method decides which one GitHub records`,
    );
  }
});

test("a sync PR past the threshold that was never armed is reported", async () => {
  const { outputs, report } = await runScan({
    nodesByRepo: {
      dotfiles: [pullRequest({ number: 7, createdAt: HOURS_AGO(9) })],
    },
  });
  assert.equal(outputs["unarmed-count"], "1");
  assert.equal(outputs["stuck-count"], "0");
  assert.match(report, /never armed/u);
  assert.match(report, /\| `dotfiles` \| \[#7\]\([^)]+\) \| 9h \|/u);
});

test("a never-armed PR still inside the threshold is not reported", async () => {
  const { outputs } = await runScan({
    nodesByRepo: {
      dotfiles: [pullRequest({ number: 7, createdAt: HOURS_AGO(1) })],
    },
  });
  assert.equal(outputs["unarmed-count"], "0");
});

test("a PR that was armed and later disarmed is not reported as an arming failure", async () => {
  // Covers every way a PR stops being armed after arming succeeded: a reviewer
  // disarming it to hold it back, and GitHub disarming it itself on a push from
  // someone without write access or a base-branch switch. Only arming that
  // never took is a failure, so the probe asks whether it ever took.
  const { outputs, graphqlCalls } = await runScan({
    nodesByRepo: {
      dotfiles: [pullRequest({ number: 7, createdAt: HOURS_AGO(9) })],
    },
    wasEverArmed: { 7: true },
  });
  assert.equal(outputs["unarmed-count"], "0");
  // The exoneration must come from the timeline probe actually running.
  assert.ok(
    graphqlCalls.some(
      (call) =>
        call.variables.number === 7 && /timelineItems/u.test(call.query),
    ),
  );
});

test("a target the manifest opts out of auto-merge is never reported unarmed", async () => {
  const { outputs, graphqlCalls } = await runScan({
    repoNames: ["dotfiles"],
    automergeRepoNames: [],
    nodesByRepo: {
      dotfiles: [pullRequest({ number: 7, createdAt: HOURS_AGO(9) })],
    },
  });
  assert.equal(outputs["unarmed-count"], "0");
  // Opting out must skip the probe entirely, not probe and then discard: the
  // Phase 3d rollout window sets automerge:false on every target at once.
  assert.equal(
    graphqlCalls.filter((call) => /timelineItems/u.test(call.query)).length,
    0,
  );
});

test("a PR armed between the page fetch and the arming-history probe is not reported", async () => {
  const { outputs } = await runScan({
    nodesByRepo: {
      dotfiles: [pullRequest({ number: 7, createdAt: HOURS_AGO(9) })],
    },
    probeOverrides: { 7: { enabledAt: HOURS_AGO(0.1) } },
  });
  assert.equal(outputs["unarmed-count"], "0");
});

test("a PR merged between the page fetch and the arming-history probe is not reported", async () => {
  // A merged sync PR is the happy path, and it reports neither an
  // autoMergeRequest nor a disarm event — the two exonerating signals. Without
  // a state guard the successful outcome itself raises the alarm.
  const { outputs } = await runScan({
    nodesByRepo: {
      dotfiles: [pullRequest({ number: 7, createdAt: HOURS_AGO(9) })],
    },
    probeOverrides: { 7: { state: "MERGED" } },
  });
  assert.equal(outputs["unarmed-count"], "0");
});

test("a PR closed between the page fetch and the arming-history probe is not reported", async () => {
  const { outputs } = await runScan({
    nodesByRepo: {
      dotfiles: [pullRequest({ number: 7, createdAt: HOURS_AGO(9) })],
    },
    probeOverrides: { 7: { state: "CLOSED" } },
  });
  assert.equal(outputs["unarmed-count"], "0");
});

test("a non-sync-authored unarmed PR is ignored", async () => {
  const { outputs } = await runScan({
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 7,
          login: "dependabot",
          typename: "Bot",
          createdAt: HOURS_AGO(9),
        }),
        pullRequest({
          number: 8,
          login: "kyle-sexton",
          typename: "User",
          createdAt: HOURS_AGO(9),
        }),
      ],
    },
  });
  assert.equal(outputs["unarmed-count"], "0");
});

test("a persistent server error on the arming-history probe fails the run loudly and never reports a false all-clear", async () => {
  const { outputs, threw } = await runScan({
    nodesByRepo: {
      dotfiles: [pullRequest({ number: 7, createdAt: HOURS_AGO(9) })],
    },
    armingHistoryFailures: { 7: Number.POSITIVE_INFINITY },
  });
  assert.ok(threw, "a persistent probe failure must propagate");
  assert.equal(outputs["unarmed-count"], undefined);
  assert.equal(outputs["stuck-count"], undefined);
});

test("both categories are reported together, each in its own section", async () => {
  const { outputs, report } = await runScan({
    nodesByRepo: {
      dotfiles: [
        pullRequest({
          number: 7,
          enabledAt: HOURS_AGO(9),
          mergeStateStatus: "BLOCKED",
        }),
        pullRequest({ number: 8, createdAt: HOURS_AGO(9) }),
      ],
    },
  });
  assert.equal(outputs["stuck-count"], "1");
  assert.equal(outputs["unarmed-count"], "1");
  assert.match(report, /## standards-sync stuck auto-merge pull request\(s\)/u);
  assert.match(
    report,
    /## standards-sync pull request\(s\) that were never armed/u,
  );
});

test("the all-clear path requires both categories empty", async () => {
  const { outputs, report } = await runScan({
    nodesByRepo: { dotfiles: [pullRequest({ number: 7 })] },
  });
  assert.equal(outputs["stuck-count"], "0");
  assert.equal(outputs["unarmed-count"], "0");
  assert.equal(report, null);
});

// --- Test mode (synthetic candidates; proof path for the issue lifecycle) ---

const TEST_MARKER =
  "<!-- ci-workflows:standards-sync-stuck-automerge-alert:v1:test -->";

test("test-mode with two synthetic candidates fabricates both rows and never probes a live target", async () => {
  const { graphqlCalls, outputs, report } = await runScan({
    testMode: "true",
    testSyntheticCandidates: "2",
    markerEnv: TEST_MARKER,
    // A real node the scan would have reported, proving the live path was
    // genuinely skipped rather than coincidentally empty.
    nodesByRepo: {
      dotfiles: [
        pullRequest({ enabledAt: HOURS_AGO(9), mergeStateStatus: "BLOCKED" }),
      ],
    },
  });
  assert.equal(graphqlCalls.length, 0);
  assert.equal(outputs["stuck-count"], "1");
  assert.equal(outputs["unarmed-count"], "1");
  assert.ok(report.startsWith(TEST_MARKER));
  assert.match(report, /SYNTHETIC-test-candidate/u);
  assert.match(report, /actions\/runs\/12345/u);
});

test("test-mode with one synthetic candidate fabricates only the armed-stuck row", async () => {
  const { graphqlCalls, outputs, report } = await runScan({
    testMode: "true",
    testSyntheticCandidates: "1",
    markerEnv: TEST_MARKER,
  });
  assert.equal(graphqlCalls.length, 0);
  assert.equal(outputs["stuck-count"], "1");
  assert.equal(outputs["unarmed-count"], "0");
  assert.match(report, /stuck auto-merge pull request/u);
  assert.doesNotMatch(report, /never armed/u);
});

test("test-mode with zero synthetic candidates takes the all-clear path that closes the issue", async () => {
  const { graphqlCalls, outputs, report, infos } = await runScan({
    testMode: "true",
    testSyntheticCandidates: "0",
    markerEnv: TEST_MARKER,
  });
  assert.equal(graphqlCalls.length, 0);
  assert.equal(outputs["stuck-count"], "0");
  assert.equal(outputs["unarmed-count"], "0");
  assert.equal(report, null);
  assert.ok(infos.some((line) => /No stuck armed/u.test(line)));
});

test("test-mode rejects a candidate count outside the legal set instead of taking the all-clear path", async () => {
  for (const bad of ["", "3", "-1", "two", "1.5"]) {
    const { failedWith, outputs, report } = await runScan({
      testMode: "true",
      testSyntheticCandidates: bad,
      markerEnv: TEST_MARKER,
    });
    assert.match(
      failedWith ?? "",
      /must be '0', '1', or '2'/u,
      `count '${bad}' must fail validation`,
    );
    assert.equal(outputs["stuck-count"], undefined);
    assert.equal(report, null);
  }
});

test("an invalid candidate count outside test mode is ignored (production path unaffected)", async () => {
  const { failedWith, outputs } = await runScan({
    testSyntheticCandidates: "garbage",
    nodesByRepo: { dotfiles: [] },
  });
  assert.equal(failedWith, null);
  assert.equal(outputs["stuck-count"], "0");
});

test("test-mode is off when TEST_MODE is the string 'false'", async () => {
  const { graphqlCalls, outputs } = await runScan({
    testMode: "false",
    testSyntheticCandidates: "2",
    nodesByRepo: { dotfiles: [] },
  });
  assert.ok(graphqlCalls.length > 0);
  assert.equal(outputs["stuck-count"], "0");
  assert.equal(outputs["unarmed-count"], "0");
});

test("test-mode is off when TEST_MODE is absent, even with a candidate count set", async () => {
  const { graphqlCalls, outputs } = await runScan({
    testSyntheticCandidates: "2",
    nodesByRepo: { dotfiles: [] },
  });
  assert.ok(graphqlCalls.length > 0);
  assert.equal(outputs["stuck-count"], "0");
  assert.equal(outputs["unarmed-count"], "0");
});

// --- Marker/title single-source pins (YAML text, not extracted scripts) ---
// The script harness cannot see YAML `env:`/`with:` expressions, so these pin
// the raw workflow text: exactly one definition of each marker/title literal
// (the workflow-level ALERT_* env), with every consumer reading the env.

test("production and test markers are each defined exactly once, in the ALERT_MARKER expression", () => {
  const prod = workflow.match(
    /<!-- ci-workflows:standards-sync-stuck-automerge-alert:v1:active -->/gu,
  );
  const testM = workflow.match(
    /<!-- ci-workflows:standards-sync-stuck-automerge-alert:v1:test -->/gu,
  );
  assert.equal(prod?.length, 1);
  assert.equal(testM?.length, 1);
  const alertMarkerLine = workflow
    .split(/\r?\n/u)
    .find((line) => line.startsWith("  ALERT_MARKER:"));
  assert.ok(alertMarkerLine.includes("v1:test"));
  assert.ok(alertMarkerLine.includes("v1:active"));
  assert.ok(alertMarkerLine.includes("inputs.test-mode"));
});

test("production and test titles are each defined exactly once, in the ALERT_ISSUE_TITLE expression", () => {
  const prod = workflow.match(
    /\[Alert\] standards-sync auto-merge PR\(s\) needing attention/gu,
  );
  const testT = workflow.match(
    /\[Test\] standards-sync auto-merge PR\(s\) needing attention/gu,
  );
  assert.equal(prod?.length, 1);
  assert.equal(testT?.length, 1);
  const titleLine = workflow
    .split(/\r?\n/u)
    .find((line) => line.startsWith("  ALERT_ISSUE_TITLE:"));
  assert.ok(titleLine.includes("[Test]"));
  assert.ok(titleLine.includes("[Alert]"));
  assert.ok(titleLine.includes("inputs.test-mode"));
});

test("all marker/title consumers read the ALERT_* env, never a local literal", () => {
  assert.equal(
    workflow.match(/MARKER: \$\{\{ env\.ALERT_MARKER \}\}/gu)?.length,
    2,
    "lookup and close each map MARKER from ALERT_MARKER",
  );
  assert.equal(
    workflow.match(/ISSUE_TITLE: \$\{\{ env\.ALERT_ISSUE_TITLE \}\}/gu)?.length,
    1,
    "lookup maps ISSUE_TITLE from ALERT_ISSUE_TITLE",
  );
  assert.equal(
    workflow.match(/title: \$\{\{ env\.ALERT_ISSUE_TITLE \}\}/gu)?.length,
    1,
    "the create step's title reads ALERT_ISSUE_TITLE",
  );
  assert.match(scanScript, /const marker = process\.env\.ALERT_MARKER;/u);
});

test("test-synthetic-candidates is a string input so '0' survives the caller's empty-string fallback", () => {
  const lines = workflow.split(/\r?\n/u);
  const inputIndex = lines.findIndex((line) =>
    line.includes("test-synthetic-candidates:"),
  );
  assert.notEqual(inputIndex, -1);
  const typeLine = lines
    .slice(inputIndex, inputIndex + 12)
    .find((line) => /^\s+type:/u.test(line));
  assert.match(typeLine, /type: string/u);
});
