"use strict";

// read-pull-request reads a workflow_run caller's pull request once and
// outputs the facts pr-review-cli's gates check from that read, never from
// the caller; proceed is `true` only when the head is still the caller's
// head-sha.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { run } = require("../actions/read-pull-request/read.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const HEAD = "a".repeat(40);
const MOVED = "e".repeat(40);
const BASE = "b".repeat(40);
// pulls.get's response shape (docs.github.com/en/rest/pulls/pulls#get-a-pull-request).
const PULL = {
  number: 7,
  state: "open",
  draft: false,
  user: { login: "kyle-sexton" },
  head: { sha: HEAD, ref: "feature", repo: { full_name: "o/r" } },
  base: { sha: BASE, ref: "main", repo: { full_name: "o/r" } },
};

async function read(env, pull = PULL) {
  const calls = [];
  const outputs = {};
  const notices = [];
  const github = {
    rest: {
      pulls: {
        get: async (args) => {
          calls.push(args);
          return { data: pull };
        },
      },
    },
  };
  const core = {
    setOutput: (k, v) => {
      outputs[k] = v;
    },
    notice: (m) => notices.push(m),
  };
  const context = { repo: { owner: "o", repo: "r" } };
  let error;
  try {
    await run({ github, context, core, env });
  } catch (e) {
    error = e;
  }
  return { calls, outputs, notices, error };
}

test("an unmoved head proceeds, with every fact taken from the read", async () => {
  const { calls, outputs, notices, error } = await read({
    PR_NUMBER: "7",
    HEAD_SHA: HEAD,
    BASE_SHA: BASE,
    EVENT_ACTION: "synchronize",
  });
  assert.equal(error, undefined);
  assert.deepEqual(calls, [{ owner: "o", repo: "r", pull_number: 7 }]);
  assert.deepEqual(outputs, {
    number: "7",
    state: "open",
    draft: "false",
    "head-repo": "o/r",
    author: "kyle-sexton",
    "head-sha": HEAD,
    "head-ref": "feature",
    "base-sha": BASE,
    "base-ref": "main",
    action: "synchronize",
    proceed: "true",
  });
  assert.deepEqual(notices, []);
});

test("a moved head does not proceed and says so once", async () => {
  const { outputs, notices, error } = await read({ PR_NUMBER: "7", HEAD_SHA: MOVED });
  assert.equal(error, undefined);
  assert.equal(outputs.proceed, "false");
  assert.equal(outputs["head-sha"], HEAD);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /head moved from e{40} to a{40}/u);
});

test("a draft, a fork head or a closed pull request is reported as read, for the gates to refuse", async () => {
  const pull = {
    ...PULL,
    state: "closed",
    draft: true,
    user: { login: "dependabot[bot]" },
    head: { ...PULL.head, repo: { full_name: "fork/r" } },
  };
  const { outputs } = await read({ PR_NUMBER: "7", HEAD_SHA: HEAD }, pull);
  assert.equal(outputs.state, "closed");
  assert.equal(outputs.draft, "true");
  assert.equal(outputs["head-repo"], "fork/r");
  assert.equal(outputs.author, "dependabot[bot]");
  // A deleted fork has no head repository: an empty name never matches.
  const gone = await read({ PR_NUMBER: "7", HEAD_SHA: HEAD }, { ...PULL, head: { ...PULL.head, repo: null } });
  assert.equal(gone.outputs["head-repo"], "");
});

test("a caller's base-sha that is not the pull request's only logs a notice; the read base is the output", async () => {
  const { outputs, notices } = await read({ PR_NUMBER: "7", HEAD_SHA: HEAD, BASE_SHA: "f".repeat(40) });
  assert.equal(outputs["base-sha"], BASE);
  assert.equal(outputs.proceed, "true");
  assert.equal(notices.length, 1);
  assert.match(notices[0], /is not pull request #7's base/u);
});

test("a malformed input throws before any request", async () => {
  const bad = [
    { PR_NUMBER: "", HEAD_SHA: HEAD },
    { PR_NUMBER: "0", HEAD_SHA: HEAD },
    { PR_NUMBER: "7 ", HEAD_SHA: HEAD },
    { PR_NUMBER: "7", HEAD_SHA: "" },
    { PR_NUMBER: "7", HEAD_SHA: HEAD.toUpperCase() },
    { PR_NUMBER: "7", HEAD_SHA: HEAD.slice(1) },
    { PR_NUMBER: "7", HEAD_SHA: HEAD, BASE_SHA: "main" },
    { PR_NUMBER: "7", HEAD_SHA: HEAD, EVENT_ACTION: "synchronize; rm" },
  ];
  for (const env of bad) {
    const { calls, outputs, error } = await read(env);
    assert.ok(error instanceof Error, JSON.stringify(env));
    assert.deepEqual(calls, [], JSON.stringify(env));
    assert.equal(outputs.proceed, undefined, JSON.stringify(env));
  }
});

test("a read that returns another pull request throws and sets no proceed", async () => {
  const { outputs, error } = await read({ PR_NUMBER: "7", HEAD_SHA: HEAD }, { ...PULL, number: 8 });
  assert.ok(error instanceof Error);
  assert.equal(outputs.proceed, undefined);
});

test("the action passes its inputs through env and records the read for the api-budget notice", () => {
  const action = parseWorkflow(
    fs.readFileSync(path.join(__dirname, "..", "actions", "read-pull-request", "action.yml"), "utf8"),
  );
  const [s] = action.runs.steps;
  assert.match(s.uses, /^actions\/github-script@[0-9a-f]{40} ?/u);
  assert.deepEqual(s.env, {
    ACTION_PATH: `\${{ github.action_path }}`,
    PR_NUMBER: `\${{ inputs.pr-number }}`,
    HEAD_SHA: `\${{ inputs.head-sha }}`,
    BASE_SHA: `\${{ inputs.base-sha }}`,
    EVENT_ACTION: `\${{ inputs.event-action }}`,
  });
  assert.doesNotMatch(s.with.script, /\$\{\{/u);
  assert.match(s.with.script, /api-budget\.cjs"\)\)\.watch\(github, "github-token"\)/u);
});
