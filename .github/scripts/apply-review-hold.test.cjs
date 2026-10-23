"use strict";

// The apply-review-hold action: pr-review-cli's add-only hold step. A fake
// GitHub records every call and throws on any label removal or replacement;
// a stand-in publish gate flags an Anthropic-key shape.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { globToRegExp, run } = require("../actions/apply-review-hold/hold.cjs");
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
const TRUST_PATHS = [
  ".github/standards/trusted-actors/**",
  ".github/actions/check-trusted-trigger/**",
  "**/CODEOWNERS",
  "**/.gitmodules",
].join("\n");

function fakeGithub({ files = [], changedFiles, comments = [], fail = {} }) {
  const calls = [];
  const refuse = (name) => () => {
    throw new Error(`${name} must never be called`);
  };
  const github = {
    calls,
    paginate: async (method, params) => method(params),
    rest: {
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
          return comments;
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
  const core = { outputs: {}, warnings: [], notices: [] };
  core.setOutput = (k, v) => {
    core.outputs[k] = v;
  };
  core.warning = (m) => core.warnings.push(m);
  core.notice = (m) => core.notices.push(m);
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
