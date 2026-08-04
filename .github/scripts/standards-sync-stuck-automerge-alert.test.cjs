"use strict";

const assert = require("node:assert/strict");
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
} = {}) {
  const keys = [
    "BOT_LOGIN",
    "REPO_NAMES",
    "AUTOMERGE_REPO_NAMES",
    "THRESHOLD_HOURS",
    "GITHUB_WORKSPACE",
    "GRAPHQL_RETRY_ATTEMPTS",
    "GRAPHQL_RETRY_BASE_MS",
  ];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  const effectiveWorkspace =
    workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "stuck-alert-"));
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
  });
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
      scanScript,
    );
    try {
      await execute(github, core, require, process);
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
test("the tracking-issue lookup and close steps run on github-script, not the gh CLI", () => {
  for (const name of [
    "Find existing tracking issue",
    "Close recovered tracking issue",
  ]) {
    const stepIndex = workflow.indexOf(`- name: ${name}`);
    assert.ok(stepIndex >= 0, `step '${name}' is missing`);
    const nextStepOffset = workflow
      .slice(stepIndex + 1)
      .search(/\n\s*(?:#[^\n]*\n\s*)*- name:/u);
    const step =
      nextStepOffset >= 0
        ? workflow.slice(stepIndex, stepIndex + 1 + nextStepOffset)
        : workflow.slice(stepIndex);
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
  title = "[Alert] standards-sync stuck auto-merge PR(s)",
  pull_request = null,
} = {}) {
  return { number, user: { login, type }, body, title, pull_request };
}

const MARKER =
  "<!-- ci-workflows:standards-sync-stuck-automerge-alert:v1:active -->";
const ISSUE_TITLE = "[Alert] standards-sync stuck auto-merge PR(s)";

async function runLookup({ openIssues = [], envOverrides = {} } = {}) {
  const script = extractStepScript("Find existing tracking issue");
  const keys = ["MARKER", "ISSUE_TITLE", "ISSUE_AUTHOR_LOGIN"];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    MARKER,
    ISSUE_TITLE,
    ISSUE_AUTHOR_LOGIN: "github-actions[bot]",
    ...envOverrides,
  });
  const outputs = {};
  let failedWith = null;
  try {
    const github = {
      paginate: async (_fn, _params) => openIssues,
      rest: { issues: { listForRepo: () => {} } },
    };
    const core = {
      setOutput: (key, value) => (outputs[key] = value),
      setFailed: (message) => (failedWith = message),
    };
    const context = { repo: { owner: "melodic-software", repo: "dotfiles" } };
    const execute = new AsyncFunction(
      "github",
      "core",
      "context",
      "process",
      script,
    );
    await execute(github, core, context, process);
    return { outputs, failedWith };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

async function runClose({ issueNumber } = {}) {
  const script = extractStepScript("Close recovered tracking issue");
  const keys = ["ISSUE_NUMBER"];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, { ISSUE_NUMBER: String(issueNumber) });
  const comments = [];
  const updates = [];
  try {
    const github = {
      rest: {
        issues: {
          createComment: async (params) => comments.push(params),
          update: async (params) => updates.push(params),
        },
      },
    };
    const core = {};
    const context = { repo: { owner: "melodic-software", repo: "dotfiles" } };
    const execute = new AsyncFunction(
      "github",
      "core",
      "context",
      "process",
      script,
    );
    await execute(github, core, context, process);
    return { comments, updates };
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

// The close step resolves no issue of its own — it acts on the number the
// lookup above already author-filtered. That makes its `if:` the whole of its
// decoy protection: without the `issue-number != ''` conjunct it would run
// with an empty number on every healthy run, and without the lookup running
// unconditionally the number would always be empty on exactly those runs. The
// two halves are only correct together, so both are asserted structurally —
// no mock can reach an `if:` expression.
test("the close step acts only on the author-filtered lookup result, and only when there is one", () => {
  const closeStep = workflow.slice(
    workflow.indexOf("- name: Close recovered tracking issue"),
  );
  const closeCondition = /\n\s+if: ([^\n]*)/u.exec(closeStep)[1];
  assert.match(closeCondition, /steps\.scan\.outputs\.stuck-count == '0'/u);
  assert.match(closeCondition, /steps\.scan\.outputs\.unarmed-count == '0'/u);
  assert.match(
    closeCondition,
    /steps\.tracking\.outputs\.issue-number != ''/u,
    "the close step must be guarded on the lookup having resolved an issue",
  );

  const lookupStep = workflow.slice(
    workflow.indexOf("- name: Find existing tracking issue"),
  );
  const lookupHeader = lookupStep.slice(0, lookupStep.indexOf("script: |"));
  assert.doesNotMatch(
    lookupHeader,
    /\n\s+if:/u,
    "the lookup must run unconditionally, or the close step is starved on every healthy run",
  );
});

test("close comments on and closes the tracking issue the lookup resolved", async () => {
  const { comments, updates } = await runClose({ issueNumber: 5 });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issue_number, 5);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    owner: "melodic-software",
    repo: "dotfiles",
    issue_number: 5,
    state: "closed",
    state_reason: "completed",
  });
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
