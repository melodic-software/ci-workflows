"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveMergeGroup } = require("./merge-group.cjs");

const QUEUE_REF =
  "refs/heads/gh-readonly-queue/main/pr-7-0123456789abcdef0123456789abcdef01234567";

// A repository whose head commit adds `files` on top of its base commit.
function workspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-group-retry-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  for (const file of files) fs.writeFileSync(path.join(dir, file), `${file}\n`);
  git("add", ".");
  git("commit", "-qm", "head");
  return { dir, baseSha, headSha: git("rev-parse", "HEAD") };
}

// The shape of an Octokit RequestError: a numeric status and the response
// headers under lowercase names.
function httpError(status, message, headers = {}) {
  return Object.assign(new Error(message), {
    status,
    response: { status, headers },
  });
}

const PR = {
  number: 7,
  user: { login: "some-contributor", id: 1 },
  head: { ref: "feature/7", sha: "f".repeat(40) },
  base: { ref: "main" },
};

// Each read answers from its queue in order: an Error is thrown, anything
// else is the answer. The last entry repeats once the queue runs out.
function fakeGithub({ get = [PR], pages = [["a.txt"]], list = [[]] } = {}) {
  const calls = { get: 0, paginate: 0, list: 0 };
  const next = (queue, n) => queue[Math.min(n, queue.length - 1)];
  return {
    calls,
    rest: {
      pulls: {
        get: async () => {
          const answer = next(get, calls.get++);
          if (answer instanceof Error) throw answer;
          return { data: answer };
        },
        list: async () => {
          const answer = next(list, calls.list++);
          if (answer instanceof Error) throw answer;
          return { data: answer };
        },
        listFiles: "pulls.listFiles",
      },
    },
    paginate: async () => {
      const answer = next(pages, calls.paginate++);
      if (answer instanceof Error) throw answer;
      return answer.map((filename) => ({ filename }));
    },
  };
}

async function run(github, files = ["a.txt"]) {
  const ws = workspace(files);
  const pathsDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-group-paths-"));
  const sleeps = [];
  const core = {
    errors: [],
    failed: undefined,
    info() {},
    warning() {},
    error(message) {
      this.errors.push(message);
    },
    setFailed(message) {
      this.failed = message;
    },
  };
  try {
    const mode = await resolveMergeGroup({
      github,
      core,
      owner: "melodic-software",
      repo: "target",
      headRef: QUEUE_REF,
      baseRef: "refs/heads/main",
      baseSha: ws.baseSha,
      headSha: ws.headSha,
      workspace: ws.dir,
      pathsDir,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const listed = path.join(pathsDir, "pr-7");
    return {
      mode,
      sleeps,
      errors: core.errors.join("\n"),
      failed: core.failed,
      paths: fs.existsSync(listed)
        ? fs.readFileSync(listed, "utf8").split("\0").filter(Boolean)
        : [],
    };
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
    fs.rmSync(pathsDir, { recursive: true, force: true });
  }
}

const unavailable = () => httpError(503, "Service Unavailable");

test("pulls.get: one 503 then success passes after 2 calls and a 2 s wait", async () => {
  const github = fakeGithub({ get: [unavailable(), PR] });
  const result = await run(github);
  assert.equal(result.mode, "hand-edit", result.errors);
  assert.equal(github.calls.get, 2);
  assert.deepEqual(result.sleeps, [2000]);
});

test("pulls.get: three 503s fail closed and name the 3 attempts", async () => {
  const github = fakeGithub({ get: [unavailable()] });
  const result = await run(github);
  assert.equal(result.mode, null);
  assert.equal(github.calls.get, 3);
  assert.deepEqual(result.sleeps, [2000, 5000]);
  assert.match(
    result.errors,
    /could not read pull request #7: Service Unavailable \(3 attempts\)/u,
  );
  assert.match(result.failed, /Cannot verify the merge group/u);
});

test("pulls.get: a network error (Octokit status 500) is retried", async () => {
  const github = fakeGithub({ get: [httpError(500, "fetch failed"), PR] });
  const result = await run(github);
  assert.equal(result.mode, "hand-edit", result.errors);
  assert.equal(github.calls.get, 2);
});

test("pulls.get: 502 and 504 are retried", async () => {
  const github = fakeGithub({
    get: [httpError(502, "Bad Gateway"), httpError(504, "Gateway Timeout"), PR],
  });
  const result = await run(github);
  assert.equal(result.mode, "hand-edit", result.errors);
  assert.equal(github.calls.get, 3);
});

for (const [name, error] of [
  ["a 404", httpError(404, "Not Found")],
  [
    "a 403 rate-limit answer",
    httpError(403, "API rate limit exceeded for installation", {
      "x-ratelimit-remaining": "0",
      "retry-after": "3",
    }),
  ],
  [
    "a 429",
    httpError(429, "Too Many Requests", { "retry-after": "3" }),
  ],
  ["a 422", httpError(422, "Unprocessable Entity")],
  ["an error without a status", new Error("Resource not accessible")],
]) {
  test(`pulls.get: ${name} fails at once after 1 call`, async () => {
    const github = fakeGithub({ get: [error, PR] });
    const result = await run(github);
    assert.equal(result.mode, null);
    assert.equal(github.calls.get, 1);
    assert.deepEqual(result.sleeps, []);
    assert.ok(
      result.errors.includes(
        `could not read pull request #7: ${error.message} (1 attempt)`,
      ),
      result.errors,
    );
  });
}

test("pulls.get: a 503 with Retry-After 3 waits 3 s, not the backoff", async () => {
  const github = fakeGithub({
    get: [httpError(503, "Service Unavailable", { "retry-after": "3" }), PR],
  });
  const result = await run(github);
  assert.equal(result.mode, "hand-edit", result.errors);
  assert.deepEqual(result.sleeps, [3000]);
});

test("pulls.get: a 503 with Retry-After 120 fails without a retry", async () => {
  const github = fakeGithub({
    get: [httpError(503, "Service Unavailable", { "retry-after": "120" }), PR],
  });
  const result = await run(github);
  assert.equal(result.mode, null);
  assert.equal(github.calls.get, 1);
  assert.deepEqual(result.sleeps, []);
  assert.match(
    result.errors,
    /could not read pull request #7: Service Unavailable \(1 attempt; Retry-After 120 s exceeds the 30 s cap\)/u,
  );
});

test("pulls.get: two Retry-After 30 answers stop before a minute of waiting", async () => {
  const wait30 = () =>
    httpError(503, "Service Unavailable", { "retry-after": "30" });
  const github = fakeGithub({ get: [wait30(), wait30(), PR] });
  const result = await run(github);
  assert.equal(result.mode, null);
  assert.equal(github.calls.get, 2);
  assert.deepEqual(result.sleeps, [30000]);
  assert.ok(
    result.sleeps.reduce((a, b) => a + b, 0) < 60000,
    `total wait ${result.sleeps}`,
  );
  assert.match(result.errors, /\(2 attempts/u);
});

test("listFiles: one 503 then success passes after 2 calls", async () => {
  const github = fakeGithub({ pages: [unavailable(), ["a.txt"]] });
  const result = await run(github);
  assert.equal(result.mode, "hand-edit", result.errors);
  assert.equal(github.calls.paginate, 2);
  assert.deepEqual(result.paths, ["a.txt"]);
});

test("listFiles: three 503s fail closed and name the 3 attempts", async () => {
  const github = fakeGithub({ pages: [unavailable()] });
  const result = await run(github);
  assert.equal(result.mode, null);
  assert.equal(github.calls.paginate, 3);
  assert.match(
    result.errors,
    /could not list the files of pull request #7: Service Unavailable \(3 attempts\)/u,
  );
});

test("listFiles: a 404, 403 or 429 fails at once after 1 call", async () => {
  for (const error of [
    httpError(404, "Not Found"),
    httpError(403, "API rate limit exceeded", { "x-ratelimit-remaining": "0" }),
    httpError(429, "Too Many Requests", { "retry-after": "3" }),
  ]) {
    const github = fakeGithub({ pages: [error, ["a.txt"]] });
    const result = await run(github);
    assert.equal(result.mode, null, error.message);
    assert.equal(github.calls.paginate, 1, error.message);
    assert.deepEqual(result.sleeps, [], error.message);
  }
});

test("listFiles: a 503 on page 2 retries the listing and keeps both pages", async () => {
  const pageCalls = [];
  let failed = false;
  const github = fakeGithub();
  github.paginate = async () => {
    github.calls.paginate++;
    const files = [];
    for (const page of [["a.txt"], ["b.txt"]]) {
      pageCalls.push(page[0]);
      if (page[0] === "b.txt" && !failed) {
        failed = true;
        throw unavailable();
      }
      files.push(...page.map((filename) => ({ filename })));
    }
    return files;
  };
  const result = await run(github, ["a.txt", "b.txt"]);
  assert.equal(result.mode, "hand-edit", result.errors);
  assert.equal(github.calls.paginate, 2);
  assert.deepEqual(pageCalls, ["a.txt", "b.txt", "a.txt", "b.txt"]);
  assert.deepEqual(result.paths, ["a.txt", "b.txt"]);
});

// A two-pull-request stack: #7 targets #6's branch, #6 targets main, so the
// walk reads the pull request below #7 with pulls.list.
const UPPER = { ...PR, base: { ref: "feature/6" } };
const LOWER = {
  number: 6,
  user: { login: "some-contributor", id: 1 },
  head: { ref: "feature/6", sha: "e".repeat(40) },
  base: { ref: "main" },
};
const stack = (list) => fakeGithub({ get: [UPPER, LOWER], list });

test("pulls.list: one 503 then success walks the stack after 2 calls", async () => {
  const github = stack([unavailable(), [LOWER]]);
  const result = await run(github);
  assert.equal(result.mode, "hand-edit", result.errors);
  assert.equal(github.calls.list, 2);
  assert.deepEqual(result.sleeps, [2000]);
});

test("pulls.list: three 503s fail closed and name the 3 attempts", async () => {
  const github = stack([unavailable()]);
  const result = await run(github);
  assert.equal(result.mode, null);
  assert.equal(github.calls.list, 3);
  assert.match(
    result.errors,
    /could not find the pull request below #7: Service Unavailable \(3 attempts\)/u,
  );
});

for (const [name, error] of [
  [
    "a 403 rate-limit answer",
    httpError(403, "API rate limit exceeded", { "x-ratelimit-remaining": "0" }),
  ],
  ["a 429", httpError(429, "Too Many Requests", { "retry-after": "3" })],
]) {
  test(`pulls.list: ${name} fails at once after 1 call`, async () => {
    const github = stack([error, [LOWER]]);
    const result = await run(github);
    assert.equal(result.mode, null);
    assert.equal(github.calls.list, 1);
    assert.deepEqual(result.sleeps, []);
    assert.ok(
      result.errors.includes(
        `could not find the pull request below #7: ${error.message} (1 attempt)`,
      ),
      result.errors,
    );
  });
}
