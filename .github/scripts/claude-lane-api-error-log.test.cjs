"use strict";

// Each Claude review lane's own GitHub API steps log a failed call's status
// and rate-limit headers, then rethrow it unchanged: the lanes stay advisory
// and add no retry. This runs each shipped step script far enough to capture
// the error hook it registers, then feeds that hook a rate-limited 403, and
// runs pr-review.yml's two shell API steps against a rate-limited `gh`.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const workflowsDir = path.join(__dirname, "..", "workflows");
const STEPS = [
  "Scope the review",
  "Verify the review completed",
  "Record the reviewed head",
];

async function captureHook(script) {
  const messages = [];
  const core = new Proxy(
    {
      info: (message) => messages.push(message),
      warning: (message) => messages.push(`warning: ${message}`),
    },
    { get: (target, key) => target[key] ?? (() => {}) },
  );
  let handler;
  const refuse = async () => {
    throw new Error("no API in this test");
  };
  const github = {
    hook: {
      error: (name, fn) => {
        assert.equal(name, "request");
        handler = fn;
      },
    },
    paginate: refuse,
    graphql: refuse,
    request: refuse,
    rest: new Proxy({}, { get: () => new Proxy({}, { get: () => refuse }) }),
  };
  try {
    await new AsyncFunction("require", "github", "context", "core", script)(
      require,
      github,
      { repo: { owner: "o", repo: "r" } },
      core,
    );
  } catch {
    // The script may stop on the refused call; only the hook matters here.
  }
  return { handler, messages };
}

for (const file of ["pr-review.yml", "pr-review-security.yml"]) {
  const job = parseWorkflow(
    fs.readFileSync(path.join(workflowsDir, file), "utf8"),
  ).jobs.claude;
  for (const name of STEPS) {
    test(`${file}: "${name}" logs a failed call's rate-limit headers and rethrows it`, async () => {
      const step = job.steps.find((candidate) => candidate.name === name);
      assert.ok(step, `${name} not found`);
      const { handler, messages } = await captureHook(step.with.script);
      assert.equal(
        typeof handler,
        "function",
        "no request error hook registered",
      );
      messages.length = 0;

      const limited = Object.assign(new Error("API rate limit exceeded"), {
        status: 403,
        response: {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1760000000",
            "retry-after": "60",
          },
        },
      });
      assert.throws(
        () =>
          handler(limited, {
            method: "GET",
            url: "/repos/{owner}/{repo}/pulls/{pull_number}",
          }),
        (error) => error === limited,
      );
      assert.deepEqual(messages, [
        "warning: GitHub API GET /repos/{owner}/{repo}/pulls/{pull_number} failed with HTTP 403: x-ratelimit-remaining=0 x-ratelimit-reset=1760000000 retry-after=60",
      ]);

      messages.length = 0;
      const missing = Object.assign(new Error("Not Found"), {
        status: 404,
        response: { headers: {} },
      });
      assert.throws(
        () => handler(missing, { method: "GET", url: "/x" }),
        (error) => error === missing,
      );
      assert.deepEqual(messages, ["GitHub API GET /x failed with HTTP 404"]);
    });
  }
}

// The shell API steps of pr-review.yml read headers through `gh api -i`.
const codeJob = parseWorkflow(
  fs.readFileSync(path.join(workflowsDir, "pr-review.yml"), "utf8"),
).jobs.claude;

for (const [name, expected] of [
  ["Write the full diff", "::warning::The compare call failed: "],
  [
    "Write the pull request description and closing issues",
    "The pull request context query failed: ",
  ],
]) {
  test(`pr-review.yml: "${name}" logs a failed call's rate-limit headers`, () => {
    const step = codeJob.steps.find((candidate) => candidate.name === name);
    assert.ok(step, `${name} not found`);
    const root = makeTemporaryDirectory("api-error-log-");
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        "printf 'HTTP/2.0 403 Forbidden\\r\\nX-Ratelimit-Remaining: 0\\r\\nX-Ratelimit-Reset: 1760000000\\r\\n\\r\\n'",
        `printf '{"message":"API rate limit exceeded"}\\n'`,
        "echo 'gh: API rate limit exceeded (HTTP 403)' >&2",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...step.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: path.join(root, "out"),
      },
    });
    assert.ok(
      result.stdout.includes(
        `${expected}HTTP/2.0 403 Forbidden X-Ratelimit-Remaining: 0 X-Ratelimit-Reset: 1760000000`,
      ),
      result.stdout + result.stderr,
    );
  });
}
