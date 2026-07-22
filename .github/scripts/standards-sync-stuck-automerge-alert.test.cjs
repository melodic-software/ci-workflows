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
    line.includes("- name: Scan targets for stuck armed pull requests"),
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

function pullRequest({
  number = 1,
  login = "melodic-standards-sync",
  typename = "Bot",
  enabledAt = null,
  mergeStateStatus = "CLEAN",
} = {}) {
  return {
    number,
    url: `https://github.com/melodic-software/dotfiles/pull/${number}`,
    author: { login, __typename: typename },
    autoMergeRequest: enabledAt ? { enabledAt } : null,
    mergeStateStatus,
  };
}

async function runScan({
  repoNames = ["dotfiles"],
  thresholdHours = 4,
  nodesByRepo = {},
  pagesByRepo = null,
  infinitePagesFor = null,
  workspace,
} = {}) {
  const keys = [
    "BOT_LOGIN",
    "REPO_NAMES",
    "THRESHOLD_HOURS",
    "GITHUB_WORKSPACE",
  ];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  const effectiveWorkspace =
    workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "stuck-alert-"));
  Object.assign(process.env, {
    BOT_LOGIN: "melodic-standards-sync",
    REPO_NAMES: repoNames.join(","),
    THRESHOLD_HOURS: String(thresholdHours),
    GITHUB_WORKSPACE: effectiveWorkspace,
  });
  const graphqlCalls = [];
  const outputs = {};
  const infos = [];
  let failedWith = null;
  try {
    const github = {
      // Mirrors the real cursor contract: `after` is null on the first page,
      // then the previous response's endCursor. Pages are supplied either as
      // one flat array (nodesByRepo, wrapped as a single page) or as an
      // explicit array-of-pages (pagesByRepo) for multi-page tests. A repo
      // named in infinitePagesFor never terminates, exercising the MAX_PAGES
      // guard.
      graphql: async (query, variables) => {
        graphqlCalls.push({ query, variables });
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
    await execute(github, core, require, process);
    const reportPath = path.join(
      effectiveWorkspace,
      ".stuck-automerge-report.md",
    );
    const report = fs.existsSync(reportPath)
      ? fs.readFileSync(reportPath, "utf8")
      : null;
    return { graphqlCalls, outputs, infos, failedWith, report };
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
  assert.equal(
    graphqlCalls.length,
    2,
    "both pages must be fetched, and no more than that",
  );
  assert.equal(graphqlCalls[0].variables.after, null);
  assert.equal(graphqlCalls[1].variables.after, "1");
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
  assert.equal(graphqlCalls.length, 3);
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

async function runClose({ openIssues = [] } = {}) {
  const script = extractStepScript("Close recovered tracking issue");
  const keys = ["MARKER", "ISSUE_AUTHOR_LOGIN"];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    MARKER,
    ISSUE_AUTHOR_LOGIN: "github-actions[bot]",
  });
  const comments = [];
  const updates = [];
  try {
    const github = {
      paginate: async (_fn, _params) => openIssues,
      rest: {
        issues: {
          listForRepo: () => {},
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
    repo: "dotfiles",
    issue_number: 5,
    state: "closed",
    state_reason: "completed",
  });
});
