"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const verifySyncCommits = require("./sync-commits.cjs");

const { dependabotMode } = verifySyncCommits;
const HEAD_SHA = "c".repeat(40);

function httpError(status, message, headers = {}) {
  return Object.assign(new Error(message), {
    status,
    response: { status, headers },
  });
}

// A commit that passes the Dependabot identity check: Dependabot's and
// web-flow's account ids, as sync-commits.cjs documents them.
const DEPENDABOT_COMMIT = {
  sha: HEAD_SHA,
  author: { id: 49699333 },
  committer: { id: 19864447 },
  commit: { verification: { verified: true, reason: "valid" } },
};

function setup(...answers) {
  const sleeps = [];
  const core = {
    errors: [],
    warnings: [],
    failed: undefined,
    info() {},
    warning(message) {
      this.warnings.push(message);
    },
    error(message) {
      this.errors.push(message);
    },
    setFailed(message) {
      this.failed = message;
    },
  };
  let calls = 0;
  const github = {
    rest: { pulls: { listCommits: "pulls.listCommits" } },
    paginate: async () => {
      const answer = answers[Math.min(calls++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const args = {
    github,
    core,
    owner: "melodic-software",
    repo: "target",
    pullNumber: 7,
    headSha: HEAD_SHA,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { args, core, sleeps, calls: () => calls };
}

const unavailable = () => httpError(503, "Service Unavailable");

test("listCommits: one 503 then success reads the commits after 2 calls", async () => {
  const run = setup(unavailable(), [DEPENDABOT_COMMIT]);
  assert.equal(await dependabotMode(run.args), "skip");
  assert.equal(run.calls(), 2);
  assert.deepEqual(run.sleeps, [2000]);
});

test("listCommits: three 503s fail closed and name the 3 attempts", async () => {
  const run = setup(unavailable());
  assert.equal(await verifySyncCommits(run.args), false);
  assert.equal(run.calls(), 3);
  assert.deepEqual(run.sleeps, [2000, 5000]);
  assert.ok(
    run.core.errors.includes(
      "could not list the PR's commits: Service Unavailable (3 attempts)",
    ),
    run.core.errors.join("\n"),
  );
  assert.match(run.core.failed, /Sync PR commits are not all/u);
});

test("listCommits: three 503s never skip a Dependabot PR", async () => {
  const run = setup(unavailable());
  assert.equal(await dependabotMode(run.args), "hand-edit");
  assert.equal(run.calls(), 3);
});

for (const [name, error] of [
  [
    "a 403 rate-limit answer",
    httpError(403, "API rate limit exceeded", {
      "x-ratelimit-remaining": "0",
    }),
  ],
  ["a 429", httpError(429, "Too Many Requests", { "retry-after": "3" })],
]) {
  test(`listCommits: ${name} fails at once after 1 call`, async () => {
    const run = setup(error, [DEPENDABOT_COMMIT]);
    assert.equal(await verifySyncCommits(run.args), false);
    assert.equal(run.calls(), 1);
    assert.deepEqual(run.sleeps, []);
    assert.ok(
      run.core.errors.includes(
        `could not list the PR's commits: ${error.message} (1 attempt)`,
      ),
      run.core.errors.join("\n"),
    );
  });
}
