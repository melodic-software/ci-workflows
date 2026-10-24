"use strict";

// The apply-review-hold action: pr-review-cli's add-only hold step. A fake
// GitHub records every call and throws on any label removal or replacement;
// a stand-in publish gate flags an Anthropic-key shape.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  globToRegExp,
  namesPull,
  run,
} = require("../actions/apply-review-hold/hold.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const root = makeTemporaryDirectory("apply-review-hold-");
const gate = path.join(root, "publish-gate.mjs");
fs.writeFileSync(
  gate,
  `export const findSecret = (text) =>
  /sk-ant-[A-Za-z0-9_-]{20,}/.test(text)
    ? ["Anthropic key", 1]
    : /password\\s*=\\s*"[^"]{8,}"/.test(text)
      ? ["password or secret assignment", 1]
      : null;
`,
);
// Key-shaped, built at run time so no scanner reads a key in this file.
const FAKE_KEY = ["sk", "ant", "api03", "x".repeat(26)].join("-");
const HEAD = "a".repeat(40);
const OPENED = "2026-10-23T10:00:00Z";
const OWNER_ID = 153232337;
const TRUST_PATHS = [
  ".github/standards/trusted-actors/**",
  ".github/actions/check-trusted-trigger/**",
  "**/CODEOWNERS",
  "**/.gitmodules",
].join("\n");

// `comments` are the pull request's (#7); `issueComments` maps another
// issue number to its comments; `pull` is the GraphQL pull request;
// `edited` holds the node ids of edited comments; `failEdited` those whose
// edit read fails; `pullNumbers` the numbers
// that are pull requests, not issues; `misnumbered` the numbers whose read
// answers another number; `compares` maps a basehead to its compare
// response data; `deletions` the created_at of each COMMENT_DELETED_EVENT
// on the pull request, `deletedItems` a raw timelineItems answer in their
// place, and `failDeleted` fails that read.
function fakeGithub({
  files = [],
  changedFiles,
  comments = [],
  fail = {},
  issueComments = {},
  pull = {
    createdAt: OPENED,
    body: "",
    closingIssuesReferences: { totalCount: 0, nodes: [] },
  },
  edited = new Set(),
  failEdited = new Set(),
  pullNumbers = new Set([7]),
  misnumbered = new Set(),
  compares = {},
  deletions = [],
  deletedItems,
  failDeleted = false,
}) {
  const calls = [];
  const refuse = (name) => () => {
    throw new Error(`${name} must never be called`);
  };
  const github = {
    calls,
    graphql: async (query, variables) => {
      calls.push(["graphql", variables]);
      if (/lastEditedAt/u.test(query) && failEdited.has(variables.id))
        throw new Error("HTTP 502");
      if (/COMMENT_DELETED_EVENT/u.test(query)) {
        if (failDeleted) throw new Error("HTTP 502");
        return {
          repository: {
            pullRequest: {
              timelineItems:
                deletedItems !== undefined
                  ? deletedItems
                  : {
                      filteredCount: deletions.length,
                      nodes: deletions.map((createdAt) => ({ createdAt })),
                    },
            },
          },
        };
      }
      if (/lastEditedAt/u.test(query))
        return {
          node: {
            lastEditedAt: edited.has(variables.id)
              ? "2026-10-24T00:00:00Z"
              : null,
          },
        };
      return { repository: { pullRequest: pull } };
    },
    paginate: async (method, params) => method(params),
    rest: {
      repos: {
        compareCommitsWithBasehead: async (params) => {
          calls.push(["compare", params]);
          if (fail.compare) throw new Error("HTTP 404");
          if (!(params.basehead in compares))
            throw new Error(`unexpected compare ${params.basehead}`);
          return { data: compares[params.basehead] };
        },
      },
      pulls: {
        listFiles: (params) => {
          calls.push(["listFiles", params]);
          if (fail.listFiles) throw new Error("HTTP 502");
          return files.map((f) =>
            typeof f === "string" ? { filename: f } : f,
          );
        },
        get: async (params) => {
          calls.push(["get", params]);
          return { data: { changed_files: changedFiles ?? files.length } };
        },
      },
      issues: {
        addLabels: async (params) => {
          calls.push(["addLabels", params]);
          if (fail.addLabels)
            throw new Error("HTTP 403 Resource not accessible");
          return { data: [] };
        },
        listComments: (params) => {
          calls.push(["listComments", params]);
          return params.issue_number === 7
            ? comments
            : (issueComments[params.issue_number] ?? []);
        },
        get: async (params) => {
          calls.push(["issues.get", params]);
          if (misnumbered.has(params.issue_number))
            return { data: { number: params.issue_number + 1 } };
          return {
            data: pullNumbers.has(params.issue_number)
              ? { number: params.issue_number, pull_request: {} }
              : { number: params.issue_number },
          };
        },
        createComment: async (params) => {
          calls.push(["createComment", params]);
          if (fail.createComment) throw new Error("HTTP 500");
          return { data: {} };
        },
        removeLabel: refuse("removeLabel"),
        removeAllLabels: refuse("removeAllLabels"),
        setLabels: refuse("setLabels"),
        deleteLabel: refuse("deleteLabel"),
        updateLabel: refuse("updateLabel"),
      },
    },
  };
  return github;
}

function fakeCore() {
  const core = { outputs: {}, warnings: [], notices: [], infos: [] };
  core.setOutput = (k, v) => {
    core.outputs[k] = v;
  };
  core.warning = (m) => core.warnings.push(m);
  core.notice = (m) => core.notices.push(m);
  core.info = (m) => core.infos.push(m);
  return core;
}

const review = (extra = {}) =>
  JSON.stringify({ findings: 0, summary: "S", comments: [], ...extra });

const baseEnv = (extra = {}) => ({
  HOLD_LABEL: "needs-human",
  HOLD_PATHS: TRUST_PATHS,
  LANE_ID: "claude-review",
  PR_NUMBER: "7",
  HEAD_SHA: HEAD,
  BASE_REF: "main",
  PUBLISH_GATE: gate,
  SUB_RESULT: "skipped",
  KEY_PRESENT: "true",
  KEY_FAILED: "false",
  KEY_CLASS: "",
  KEY_VERDICT: "complete",
  KEY_REVIEW: review(),
  ...extra,
});

async function apply(env, options = {}) {
  const github = fakeGithub(options);
  const core = fakeCore();
  let error;
  try {
    await run({
      github,
      context: { repo: { owner: "o", repo: "r" } },
      core,
      env,
    });
  } catch (e) {
    error = e;
  }
  const writes = github.calls.filter(([name]) =>
    ["addLabels", "createComment"].includes(name),
  );
  return { github, core, error, writes };
}

test("an empty hold-label does nothing: no read, no write, hold false", async () => {
  const { github, core, error } = await apply(
    baseEnv({
      HOLD_LABEL: "",
      KEY_REVIEW: review({ hold: { criteria: ["cost"], reason: "R" } }),
    }),
    { files: ["CODEOWNERS"] },
  );
  assert.equal(error, undefined);
  assert.deepEqual(github.calls, []);
  assert.deepEqual(core.outputs, { hold: "false", criteria: "" });
});

test("no hold from the review and no matching path writes nothing", async () => {
  const { core, error, writes } = await apply(baseEnv(), {
    files: ["src/a.js", "docs/CODEOWNERS.md"],
  });
  assert.equal(error, undefined);
  assert.deepEqual(writes, []);
  assert.deepEqual(core.outputs, { hold: "false", criteria: "" });
});

test("the review's hold adds the label and one marker comment with the reason", async () => {
  const { core, error, writes } = await apply(
    baseEnv({
      KEY_REVIEW: review({
        hold: {
          criteria: ["critical-security", "cost"],
          reason: "Spends<!-- hidden --> money.",
        },
      }),
    }),
    { files: ["src/a.js"] },
  );
  assert.equal(error, undefined);
  assert.deepEqual(core.outputs, {
    hold: "true",
    criteria: "cost,critical-security",
  });
  assert.deepEqual(writes[0], [
    "addLabels",
    { owner: "o", repo: "r", issue_number: 7, labels: ["needs-human"] },
  ]);
  const body = writes[1][1].body;
  assert.equal(
    body.split("\n")[0],
    `<!-- claude-lane-hold lane=claude-review sha=${HEAD} criteria=cost,critical-security -->`,
  );
  assert.match(body, /Spends money\./u);
  assert.doesNotMatch(body, /hidden/u);
  assert.match(body, /\nclaude-lane: claude-review$/u);
  assert.equal(writes.length, 2);
});

test("a changed file matching hold-paths adds trust-gate whatever the review says", async () => {
  for (const [file, failed] of [
    ["CODEOWNERS", false],
    [".github/CODEOWNERS", false],
    ["vendor/x/.gitmodules", false],
    [".github/standards/trusted-actors/trusted-actors.json", false],
    [{ filename: "moved.txt", previous_filename: ".gitmodules" }, false],
    // A failed or incomplete review still holds by path.
    [".github/actions/check-trusted-trigger/action.yml", true],
  ]) {
    const env = failed
      ? baseEnv({ KEY_FAILED: "true", KEY_CLASS: "timeout", KEY_REVIEW: "" })
      : baseEnv({ KEY_REVIEW: review({ hold: undefined }) });
    const { core, error, writes } = await apply(env, {
      files: ["src/a.js", file],
    });
    assert.equal(error, undefined, JSON.stringify(file));
    assert.deepEqual(core.outputs, { hold: "true", criteria: "trust-gate" });
    assert.equal(writes[0][0], "addLabels");
    assert.match(writes[1][1].body, /criteria=trust-gate -->/u);
    assert.match(writes[1][1].body, /Changed files match hold-paths/u);
  }
  // File names cannot break out of their code span or mention anyone.
  const { writes } = await apply(baseEnv(), {
    files: ["a`b@team/CODEOWNERS"],
  });
  assert.match(writes[1][1].body, /`a\?b@\u200bteam\/CODEOWNERS`/u);
});

test("a model hold and a path match combine their criteria", async () => {
  const { core } = await apply(
    baseEnv({
      KEY_REVIEW: review({ hold: { criteria: ["cost"], reason: "R" } }),
    }),
    { files: ["CODEOWNERS"] },
  );
  assert.equal(core.outputs.criteria, "cost,trust-gate");
});

test("a file list shorter than the pull request's changed files holds", async () => {
  const { core } = await apply(baseEnv(), {
    files: ["src/a.js"],
    changedFiles: 3001,
  });
  assert.equal(core.outputs.criteria, "trust-gate");
});

test("the subscription leg's review counts when it ran", async () => {
  const { core } = await apply(
    baseEnv({
      SUB_RESULT: "success",
      SUB_PRESENT: "true",
      SUB_FAILED: "false",
      SUB_CLASS: "",
      SUB_VERDICT: "complete",
      SUB_REVIEW: review({ hold: { criteria: ["cost"], reason: "R" } }),
    }),
    { files: ["src/a.js"] },
  );
  assert.equal(core.outputs.criteria, "cost");
});

test("a failed label write fails the step and the marker is still tried", async () => {
  const { error, github } = await apply(baseEnv(), {
    files: ["CODEOWNERS"],
    fail: { addLabels: true },
  });
  assert.match(error.message, /could not add the needs-human label/u);
  assert.ok(github.calls.some(([name]) => name === "createComment"));
});

test("a failed comment or file listing fails the step", async () => {
  const comment = await apply(baseEnv(), {
    files: ["CODEOWNERS"],
    fail: { createComment: true },
  });
  assert.match(comment.error.message, /could not post the hold comment/u);
  // A failed listing still holds with trust-gate, then fails the step.
  const listing = await apply(
    baseEnv({
      KEY_REVIEW: review({ hold: { criteria: ["cost"], reason: "R" } }),
    }),
    { fail: { listFiles: true } },
  );
  assert.match(
    listing.error.message,
    /could not list the changed files: HTTP 502/u,
  );
  assert.equal(listing.core.outputs.criteria, "cost,trust-gate");
  assert.deepEqual(
    listing.writes.map(([name]) => name),
    ["addLabels", "createComment"],
  );
});

test("a rerun posts no second marker for the same head and criteria", async () => {
  const marker = `<!-- claude-lane-hold lane=claude-review sha=${HEAD} criteria=trust-gate -->`;
  const { writes } = await apply(baseEnv(), {
    files: ["CODEOWNERS"],
    comments: [
      { user: { login: "someone" }, body: "x" },
      { user: { login: "github-actions[bot]" }, body: `${marker}\nwhy` },
    ],
  });
  assert.deepEqual(
    writes.map(([name]) => name),
    ["addLabels"],
  );
});

test("a credential-shaped reason is withheld but the hold still applies", async () => {
  const { writes, core } = await apply(
    baseEnv({
      KEY_REVIEW: review({ hold: { criteria: ["cost"], reason: FAKE_KEY } }),
    }),
    { files: [] },
  );
  assert.equal(writes[0][0], "addLabels");
  assert.doesNotMatch(writes[1][1].body, /sk-ant/u);
  assert.match(writes[1][1].body, /withheld: Anthropic key/u);
  assert.equal(core.warnings.length, 1);
});

test("the hold step never names a label removal or replacement API", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "actions", "apply-review-hold", "hold.cjs"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /removeLabel|removeAllLabels|setLabels|deleteLabel|updateLabel|\bDELETE\b|\bPUT\b/u,
  );
});

test("hold.cjs converts globs exactly as the scope step does", () => {
  const workflow = parseWorkflow(
    fs.readFileSync(
      path.join(__dirname, "..", "workflows", "pr-review-cli.yml"),
      "utf8",
    ),
  );
  const scope = workflow.jobs["review-key"].steps.find((s) => s.id === "scope")
    .with.script;
  const body = (text) =>
    /const globToRegExp = \(glob\) => \{[\s\S]*?\n\s*return new RegExp\(`\^\$\{out\}\$`, "u"\);\n\s*\};/u
      .exec(text)[0]
      .replace(/^\s+/gmu, "");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "actions", "apply-review-hold", "hold.cjs"),
    "utf8",
  );
  assert.equal(body(source), body(scope));
  assert.ok(globToRegExp("**/CODEOWNERS").test("CODEOWNERS"));
  assert.ok(!globToRegExp("**/CODEOWNERS").test("CODEOWNERS.md"));
});

test("a warn-only hit in the reason posts it with a warning", async () => {
  const { writes, core } = await apply(
    baseEnv({
      KEY_REVIEW: review({
        hold: { criteria: ["cost"], reason: 'password = "hunter2hunter2"' },
      }),
    }),
    { files: [] },
  );
  assert.match(writes[1][1].body, /hunter2hunter2/u);
  assert.deepEqual(core.warnings, [
    "claude-review: password or secret assignment in the hold reason; published anyway.",
  ]);
});

// A cost decision binds to the pull request and covers the net diff it was
// made at: the head of this lane's newest cost hold marker before it.
const decision = ({
  id = 1,
  userId = OWNER_ID,
  body = "**Decision recorded.** Cost: approve the larger runner.",
  createdAt = "2026-10-23T12:00:00Z",
  type = "User",
  app = null,
} = {}) => ({
  id,
  node_id: `IC_${id}`,
  user: { login: userId === OWNER_ID ? "owner" : "someone", id: userId, type },
  performed_via_github_app: app,
  created_at: createdAt,
  body,
});
const costEnv = (criteria = ["cost"], extra = {}) =>
  baseEnv({
    TRUSTED_AUTHOR_IDS: String(OWNER_ID),
    KEY_REVIEW: review({ hold: { criteria, reason: "It adds a schedule." } }),
    ...extra,
  });
// This lane's hold marker, posted by github-actions[bot] before the decision.
const marker = ({
  id = 100,
  sha = HEAD,
  criteria = "cost",
  lane = "claude-review",
  createdAt = "2026-10-23T11:00:00Z",
  login = "github-actions[bot]",
} = {}) => ({
  id,
  node_id: `IC_${id}`,
  user: { login, type: "Bot" },
  created_at: createdAt,
  body: `<!-- claude-lane-hold lane=${lane} sha=${sha} criteria=${criteria} -->\n**${lane}** holds this pull request.`,
});
const refsPull = (body) => ({
  createdAt: OPENED,
  body,
  closingIssuesReferences: { totalCount: 0, nodes: [] },
});

test("a cost decision on the pull request keeps the cost hold from coming back", async () => {
  const { core, error, writes, github } = await apply(costEnv(), {
    comments: [marker(), decision()],
  });
  assert.equal(error, undefined);
  assert.equal(core.outputs.hold, "false");
  assert.deepEqual(writes, []);
  // The lookup's reads, the pull request's comments and the decision's edit
  // check, then the marker's edit check and the deletion read, then
  // hold-paths' own file list: the head is the decided head, so no compare.
  assert.deepEqual(
    github.calls.map(([name]) => name),
    ["listComments", "graphql", "graphql", "graphql", "listFiles", "get"],
  );
  assert.deepEqual(github.calls[3][1], { owner: "o", name: "r", number: 7 });
  assert.deepEqual(
    github.calls
      .filter(([name, v]) => name === "graphql" && "id" in v)
      .map(([, v]) => v.id),
    ["IC_1", "IC_100"],
  );
});

test("a cost decision on the Refs issue that names the pull request keeps the cost hold off", async () => {
  const { core, writes, github } = await apply(costEnv(), {
    comments: [marker()],
    pull: refsPull("Refs: #9436\n\n## Summary"),
    issueComments: {
      9436: [
        decision({ body: "**Decision recorded.** Cost: approved for #7." }),
      ],
    },
  });
  assert.equal(core.outputs.hold, "false");
  assert.deepEqual(writes, []);
  assert.deepEqual(
    github.calls.map(([name]) => name),
    [
      "listComments",
      "graphql",
      "issues.get",
      "listComments",
      "graphql",
      "graphql",
      "graphql",
      "listFiles",
      "get",
    ],
  );
});

test("a cost decision on the closing issue that names the pull request keeps the cost hold off", async () => {
  const { core } = await apply(costEnv(), {
    comments: [marker()],
    pull: {
      createdAt: OPENED,
      body: "Closes #9436",
      closingIssuesReferences: {
        totalCount: 1,
        nodes: [{ number: 9436, repository: { nameWithOwner: "O/R" } }],
      },
    },
    issueComments: {
      9436: [decision({ body: "**Decision recorded.** Cost: yes, #7." })],
    },
  });
  assert.equal(core.outputs.hold, "false");
});

test("a cost decision on the Refs issue that names another pull request still holds", async () => {
  const { core, writes } = await apply(costEnv(), {
    pull: refsPull("Refs: #9436"),
    issueComments: {
      9436: [
        decision({ body: "**Decision recorded.** Cost: approved for #70." }),
      ],
    },
  });
  assert.equal(core.outputs.hold, "true");
  assert.equal(core.outputs.criteria, "cost");
  assert.equal(writes.length, 2);
});

test("a cost decision by anyone but a trusted person still holds", async () => {
  for (const comment of [
    decision({ userId: 42 }),
    decision({ type: "Bot" }),
    decision({ app: { slug: "lanes" } }),
  ]) {
    const { core } = await apply(costEnv(), { comments: [comment] });
    assert.equal(core.outputs.hold, "true", JSON.stringify(comment.user));
  }
  // With no trusted ids nobody's decision counts.
  const { core } = await apply(costEnv(["cost"], { TRUSTED_AUTHOR_IDS: "" }), {
    comments: [decision()],
  });
  assert.equal(core.outputs.hold, "true");
});

test("an edited, quoted, older or non-cost decision still holds", async () => {
  for (const [name, options] of [
    ["edited", { comments: [decision()], edited: new Set(["IC_1"]) }],
    [
      "quoted",
      { comments: [decision({ body: "> **Decision recorded.** Cost: yes" })] },
    ],
    [
      "not a cost decision",
      { comments: [decision({ body: "**Decision recorded.** Option 2." })] },
    ],
    [
      "older than the pull request",
      {
        pull: refsPull("Refs: #9436"),
        issueComments: {
          9436: [
            decision({
              body: "**Decision recorded.** Cost: #7",
              createdAt: "2026-10-22T00:00:00Z",
            }),
          ],
        },
      },
    ],
    [
      "a Refs line naming a pull request",
      {
        pull: refsPull("Refs: #9436"),
        pullNumbers: new Set([7, 9436]),
        issueComments: {
          9436: [decision({ body: "**Decision recorded.** Cost: #7" })],
        },
      },
    ],
    [
      "a Refs read that answers another number",
      {
        pull: refsPull("Refs: #9436"),
        misnumbered: new Set([9436]),
        issueComments: {
          9436: [decision({ body: "**Decision recorded.** Cost: #7" })],
        },
      },
    ],
    [
      "two Refs issues",
      {
        pull: refsPull("Refs: #9436\nRefs: #9437"),
        issueComments: {
          9436: [decision({ body: "**Decision recorded.** Cost: #7" })],
        },
      },
    ],
  ]) {
    const { core } = await apply(costEnv(), options);
    assert.equal(core.outputs.hold, "true", name);
  }
});

test("a trust-gate hold still holds when a cost decision exists", async () => {
  const both = await apply(costEnv(["cost", "trust-gate"]), {
    comments: [marker(), decision()],
  });
  assert.equal(both.core.outputs.hold, "true");
  assert.equal(both.core.outputs.criteria, "trust-gate");
  const byPath = await apply(costEnv(), {
    comments: [marker(), decision()],
    files: ["CODEOWNERS"],
  });
  assert.equal(byPath.core.outputs.criteria, "trust-gate");
  assert.equal(byPath.writes.length, 2);
  const security = await apply(costEnv(["cost", "critical-security"]), {
    comments: [marker(), decision()],
  });
  assert.equal(security.core.outputs.criteria, "critical-security");
});

test("a hold with no cost criterion reads no cost decision", async () => {
  const { github } = await apply(costEnv(["trust-gate"]), {
    comments: [decision()],
  });
  assert.ok(!github.calls.some(([name]) => name === "graphql"));
  assert.equal(
    github.calls.filter(([name]) => name === "listComments").length,
    1,
  );
});

// The same cases merge-holds.mjs namesPull reads, so both halves agree.
test("a decision names the pull request as #<number> the way merge-holds reads it", () => {
  for (const [text, named] of [
    ["approved for #7.", true],
    ["#7", true],
    ["(#7)", true],
    ["##7", false],
    ["&#7;", false],
    ["#70", false],
    ["#77", false],
    ["o/r#7", false],
    ["x.#7", false],
    ["x-#7", false],
    ["a#7", false],
    ["_#7", false],
  ])
    assert.equal(namesPull(text, 7), named, text);
});

// #9436, option d: the owner lifted the cost hold at head A (the decided
// head, from this lane's cost marker before the decision); at head B the
// review holds for cost again. The decision carries only when compare
// main...A and main...B list the same files with the same status,
// previous_filename and patch. The fixtures are hand-written compare
// responses in GitHub's shape (docs.github.com/en/rest/commits/commits
// #compare-two-commits: files[].filename, status, previous_filename, patch).
const LATER = "b".repeat(40);
const APP_PATCH =
  "@@ -10,3 +10,4 @@ function main() {\n   start();\n+  log();\n   stop();";
const WORKFLOW_PATCH =
  "@@ -3,3 +3,3 @@ on:\n concurrency:\n-  group: old\n+  group: new";
const prFile = (extra = {}) => ({
  filename: "src/app.js",
  status: "modified",
  sha: "1".repeat(40),
  patch: APP_PATCH,
  ...extra,
});
const workflowFile = (extra = {}) => ({
  filename: ".github/workflows/ci.yml",
  status: "modified",
  sha: "2".repeat(40),
  patch: WORKFLOW_PATCH,
  ...extra,
});
const atDecided = [prFile(), workflowFile()];
const carryCase = (laterFiles, options = {}) =>
  apply(costEnv(["cost"], { HEAD_SHA: LATER }), {
    comments: [marker(), decision()],
    compares: {
      [`main...${HEAD}`]: { status: "ahead", files: atDecided },
      [`main...${LATER}`]: { status: "ahead", files: laterFiles },
    },
    ...options,
  });
const compares = (github) =>
  github.calls
    .filter(([name]) => name === "compare")
    .map(([, p]) => p.basehead);

test("a base-only merge that leaves the pull request's patches alone carries the decision", async () => {
  // The base changed src/app.js below the hunk, so the blob sha moved and
  // the patch did not.
  const { core, writes, github } = await carryCase([
    prFile({ sha: "3".repeat(40) }),
    workflowFile(),
  ]);
  assert.equal(core.outputs.hold, "false");
  assert.deepEqual(writes, []);
  assert.deepEqual(compares(github), [`main...${HEAD}`, `main...${LATER}`]);
  assert.match(
    core.infos.join("\n"),
    /the recorded cost decision carries \(the net diff against main is the same/u,
  );
});

test("a rebase onto a newer base with the same patches carries the decision", async () => {
  const renamedThen = {
    filename: "lib/b.js",
    previous_filename: "lib/a.js",
    status: "renamed",
    patch: "@@ -1 +1 @@\n-a\n+b",
  };
  const { core } = await apply(costEnv(["cost"], { HEAD_SHA: LATER }), {
    comments: [marker(), decision()],
    compares: {
      [`main...${HEAD}`]: { status: "ahead", files: [renamedThen, prFile()] },
      // Listed in another order, with new blob shas: still the same diff.
      [`main...${LATER}`]: {
        status: "ahead",
        files: [
          prFile({ sha: "4".repeat(40) }),
          { ...renamedThen, sha: "5".repeat(40) },
        ],
      },
    },
  });
  assert.equal(core.outputs.hold, "false");
});

test("the #9509 shape, a later cancel-in-progress edit, keeps the cost hold", async () => {
  const { core, writes } = await carryCase([
    prFile(),
    workflowFile({
      patch: `${WORKFLOW_PATCH}\n@@ -5,1 +5,1 @@\n-  cancel-in-progress: false\n+  cancel-in-progress: true`,
    }),
  ]);
  assert.equal(core.outputs.hold, "true");
  assert.equal(core.outputs.criteria, "cost");
  assert.equal(writes.length, 2);
  assert.match(
    core.infos.join("\n"),
    /no recorded cost decision carries \(the net diff against main differs/u,
  );
});

test("a merge that hand-edits the pull request's own lines keeps the cost hold", async () => {
  const { core } = await carryCase([
    prFile({ patch: APP_PATCH.replace("+  log();", "+  log(resolved);") }),
    workflowFile(),
  ]);
  assert.equal(core.outputs.hold, "true");
  assert.match(core.infos.join("\n"), /differs from the decided head/u);
});

test("a base change that shifts a patch's context keeps the cost hold", async () => {
  const { core } = await carryCase([
    prFile({
      patch: APP_PATCH.replace("@@ -10,3 +10,4 @@", "@@ -12,3 +12,4 @@"),
    }),
    workflowFile(),
  ]);
  assert.equal(core.outputs.hold, "true");
  assert.match(core.infos.join("\n"), /differs from the decided head/u);
});

test("an added or dropped file keeps the cost hold", async () => {
  for (const files of [
    [prFile()],
    [...atDecided, prFile({ filename: "src/extra.js" })],
    [prFile({ status: "added" }), workflowFile()],
  ]) {
    const { core } = await carryCase(files);
    assert.equal(
      core.outputs.hold,
      "true",
      JSON.stringify(files.map((f) => f.filename)),
    );
  }
});

test("a file with no patch, or a list of 300 or more files, keeps the cost hold", async () => {
  const binary = {
    filename: "logo.png",
    status: "modified",
    sha: "6".repeat(40),
  };
  const many = Array.from({ length: 300 }, (_, i) =>
    prFile({ filename: `f${i}.js` }),
  );
  for (const [name, then, later] of [
    ["no patch at either head", [...atDecided, binary], [...atDecided, binary]],
    ["300 files", many, many],
  ]) {
    const { core } = await apply(costEnv(["cost"], { HEAD_SHA: LATER }), {
      comments: [marker(), decision()],
      compares: {
        [`main...${HEAD}`]: { status: "ahead", files: then },
        [`main...${LATER}`]: { status: "ahead", files: later },
      },
    });
    assert.equal(core.outputs.hold, "true", name);
    assert.match(
      core.infos.join("\n"),
      /300 or more files, or a file without a patch/u,
      name,
    );
  }
});

test("a failed compare keeps the cost hold", async () => {
  const { core, error, github } = await carryCase(atDecided, {
    fail: { compare: true },
  });
  assert.equal(error, undefined);
  assert.equal(core.outputs.hold, "true");
  assert.equal(compares(github).length, 1);
  assert.match(core.infos.join("\n"), /a compare read failed/u);
});

test("a decision with no cost marker of this lane before it keeps the cost hold, even at the same head", async () => {
  for (const [name, comments] of [
    ["no marker", [decision()]],
    [
      "a marker after the decision",
      [marker({ createdAt: "2026-10-23T13:00:00Z" }), decision()],
    ],
    [
      "another lane's marker",
      [marker({ lane: "claude-security-review" }), decision()],
    ],
    ["a marker without cost", [marker({ criteria: "trust-gate" }), decision()]],
    ["a marker by someone else", [marker({ login: "someone" }), decision()]],
  ]) {
    const { core, github } = await apply(costEnv(), { comments });
    assert.equal(core.outputs.hold, "true", name);
    assert.equal(compares(github).length, 0, name);
    assert.match(
      core.infos.join("\n"),
      /no cost hold marker of this lane precedes the decision/u,
      name,
    );
  }
});

test("the decided head is the newest cost marker before the newest decision", async () => {
  const older = "c".repeat(40);
  const { github } = await carryCase(atDecided, {
    comments: [
      marker({ id: 101, sha: older, createdAt: "2026-10-23T10:30:00Z" }),
      marker({ id: 102, sha: HEAD, criteria: "cost,trust-gate" }),
      marker({
        id: 103,
        sha: older,
        criteria: "trust-gate",
        createdAt: "2026-10-23T11:30:00Z",
      }),
      decision({ id: 1, createdAt: "2026-10-23T10:45:00Z" }),
      decision({ id: 2 }),
    ],
  });
  assert.deepEqual(compares(github), [`main...${HEAD}`, `main...${LATER}`]);
});

test("an unusable base branch name reads no compare and keeps the cost hold", async () => {
  const { core, github } = await apply(
    costEnv(["cost"], { HEAD_SHA: LATER, BASE_REF: "main..x" }),
    { comments: [marker(), decision()] },
  );
  assert.equal(core.outputs.hold, "true");
  assert.equal(compares(github).length, 0);
});

test("the carry check reads one deletion list, at most two compares and nothing else", async () => {
  const { github } = await carryCase(atDecided);
  const names = github.calls.map(([name]) => name);
  // The pull request's comments, the decision's and the marker's edit
  // checks, the deletion read, two compares, then hold-paths' own file list.
  assert.deepEqual(names, [
    "listComments",
    "graphql",
    "graphql",
    "graphql",
    "compare",
    "compare",
    "listFiles",
    "get",
  ]);
});

// The decided head comes from a marker comment, which a writer can edit:
// an edited marker is not trusted.
test("an edited marker at the head's sha keeps the cost hold, though the decision exists", async () => {
  const { core, writes, github } = await apply(costEnv(), {
    comments: [marker(), decision()],
    edited: new Set(["IC_100"]),
  });
  assert.equal(core.outputs.hold, "true");
  assert.equal(core.outputs.criteria, "cost");
  // The label comes back; the marker for this head and criteria exists.
  assert.deepEqual(
    writes.map(([name]) => name),
    ["addLabels"],
  );
  assert.equal(compares(github).length, 0);
  assert.match(
    core.infos.join("\n"),
    /no recorded cost decision carries \(the decided-head marker was edited\)/u,
  );
});

test("an edited newest marker keeps the cost hold, with no fallback to an older unedited one", async () => {
  const { core, github } = await carryCase(atDecided, {
    comments: [
      // Would carry: at the head, unedited, before the decision.
      marker({ id: 101, sha: LATER, createdAt: "2026-10-23T10:30:00Z" }),
      marker({ id: 102 }),
      decision(),
    ],
    edited: new Set(["IC_102"]),
  });
  assert.equal(core.outputs.hold, "true");
  assert.equal(compares(github).length, 0);
  assert.deepEqual(
    github.calls.filter(([name]) => name === "graphql").map(([, v]) => v.id),
    ["IC_1", "IC_102"],
  );
  assert.match(core.infos.join("\n"), /the decided-head marker was edited/u);
});

test("a failed marker edit check keeps the cost hold", async () => {
  const { core, error, github } = await apply(costEnv(), {
    comments: [marker(), decision()],
    failEdited: new Set(["IC_100"]),
  });
  assert.equal(error, undefined);
  assert.equal(core.outputs.hold, "true");
  assert.equal(compares(github).length, 0);
  assert.match(
    core.infos.join("\n"),
    /no recorded cost decision carries \(could not confirm the marker is unedited\)/u,
  );
});

// A deleted comment can remove the newest marker, which would make an older
// one the decided head (as merge-holds.mjs deletedSince reads it): any
// comment deleted at or after the decided-head marker was posted carries
// nothing. The pull request timeline's COMMENT_DELETED_EVENT
// items give the deletion times.
test("a comment deleted after the decided-head marker keeps the cost hold, with no older marker standing in", async () => {
  // The newer marker, at 11:00, was deleted; the one left, at 10:30, holds
  // the head's sha and would carry with no compare.
  const { core, writes, github } = await carryCase(atDecided, {
    comments: [
      marker({ id: 101, sha: LATER, createdAt: "2026-10-23T10:30:00Z" }),
      decision(),
    ],
    deletions: ["2026-10-23T11:05:00Z"],
  });
  assert.equal(core.outputs.hold, "true");
  assert.equal(core.outputs.criteria, "cost");
  // The label comes back; the remaining marker already names this head.
  assert.deepEqual(
    writes.map(([name]) => name),
    ["addLabels"],
  );
  assert.equal(compares(github).length, 0);
  assert.match(
    core.infos.join("\n"),
    /no recorded cost decision carries \(a comment was deleted since the decided-head marker was posted\)/u,
  );
});

test("a deletion at the marker's own time keeps the cost hold, and one before it does not", async () => {
  const at = await apply(costEnv(), {
    comments: [marker(), decision()],
    deletions: ["2026-10-23T10:00:00Z", "2026-10-23T11:00:00Z"],
  });
  assert.equal(at.core.outputs.hold, "true");
  const before = await apply(costEnv(), {
    comments: [marker(), decision()],
    deletions: ["2026-10-23T10:59:59Z"],
  });
  assert.equal(before.core.outputs.hold, "false");
  assert.match(
    before.core.infos.join("\n"),
    /the recorded cost decision carries \(the head is the decided head/u,
  );
});

test("a deletion list that cannot show no comment was deleted keeps the cost hold", async () => {
  const listed = (filteredCount, nodes) => ({ filteredCount, nodes });
  for (const [name, options] of [
    ["a failed read", { failDeleted: true }],
    ["no timeline", { deletedItems: null }],
    ["no node list", { deletedItems: { filteredCount: 0 } }],
    ["no count", { deletedItems: { nodes: [] } }],
    ["a count that is not a number", { deletedItems: listed("0", []) }],
    [
      "more deletions than listed",
      {
        deletedItems: listed(
          101,
          Array.from({ length: 100 }, () => ({
            createdAt: "2026-10-23T09:00:00Z",
          })),
        ),
      },
    ],
    [
      "a time that does not parse",
      { deletedItems: listed(1, [{ createdAt: "yesterday" }]) },
    ],
    ["an event with no time", { deletedItems: listed(1, [{}]) }],
  ]) {
    const { core, error, github } = await apply(costEnv(), {
      comments: [marker(), decision()],
      ...options,
    });
    assert.equal(error, undefined, name);
    assert.equal(core.outputs.hold, "true", name);
    assert.equal(compares(github).length, 0, name);
    assert.match(
      core.infos.join("\n"),
      /no recorded cost decision carries \(could not confirm no comment was deleted since the decided-head marker was posted\)/u,
      name,
    );
  }
});

test("an edited marker reads no deletion list", async () => {
  const { github } = await apply(costEnv(), {
    comments: [marker(), decision()],
    edited: new Set(["IC_100"]),
    failDeleted: true,
  });
  assert.equal(github.calls.filter(([name]) => name === "graphql").length, 2);
});
