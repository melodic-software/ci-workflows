"use strict";

// resolve-branch-tip: an authenticated `git ls-remote` of one branch, run
// against a git stand-in that records its arguments and environment.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const ACTION_DIR = path.join(__dirname, "..", "actions", "resolve-branch-tip");
const SCRIPT = path.join(ACTION_DIR, "resolve.sh");
const TOKEN = "ghs_test";
// HTTP basic credentials for x-access-token:ghs_test.
const HEADER = "eC1hY2Nlc3MtdG9rZW46Z2hzX3Rlc3Q=";
const TIP = "2".repeat(40);
const OTHER = "1".repeat(40);
const TAG = "3".repeat(40);
// Built by concatenation so no source line holds a literal placeholder.
const expr = (inner) => `$${"{{"} ${inner} }}`;

// Each entry of `answers` is one call's {status, stdout, stderr}; the last
// repeats once they run out. `git check-ref-format` is passed to the real git.
function run({ answers, env = {} }) {
  const root = makeTemporaryDirectory("resolve-branch-tip-");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const realGit = spawnSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).stdout.trim();
  fs.writeFileSync(path.join(root, "answers.json"), JSON.stringify(answers));
  fs.writeFileSync(
    path.join(bin, "git"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      "const args = process.argv.slice(2);",
      `if (args[0] === "check-ref-format") process.exit(spawnSync(${JSON.stringify(realGit)}, args).status);`,
      `const root = ${JSON.stringify(root)};`,
      'const calls = JSON.parse(fs.existsSync(root + "/calls.json") ? fs.readFileSync(root + "/calls.json", "utf8") : "[]");',
      "const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GIT_|^TIP_/.test(k)));",
      "calls.push({ args, env, cwd: process.cwd() });",
      'fs.writeFileSync(root + "/calls.json", JSON.stringify(calls));',
      'const answers = JSON.parse(fs.readFileSync(root + "/answers.json", "utf8"));',
      "const a = answers[Math.min(calls.length, answers.length) - 1];",
      'process.stdout.write(a.stdout ?? ""); process.stderr.write(a.stderr ?? ""); process.exit(a.status ?? 0);',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "sleep"),
    `#!/bin/sh\necho "$1" >>"${root}/sleeps"\n`,
    { mode: 0o755 },
  );
  const output = path.join(root, "output");
  fs.writeFileSync(output, "");
  const result = spawnSync("bash", [SCRIPT], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      GITHUB_OUTPUT: output,
      TIP_BRANCH: "main",
      TIP_REPOSITORY: "o/r",
      TIP_TOKEN: TOKEN,
      ...env,
    },
    encoding: "utf8",
  });
  const read = (name) =>
    fs.existsSync(path.join(root, name))
      ? fs.readFileSync(path.join(root, name), "utf8")
      : "";
  const outputs = Object.fromEntries(
    read("output")
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  return {
    root,
    status: result.status,
    stdout: result.stdout,
    calls: JSON.parse(read("calls.json") || "[]"),
    sleeps: read("sleeps").split("\n").filter(Boolean).map(Number),
    outputs,
  };
}

const listing = (...lines) => ({
  stdout: lines.map(([sha, ref]) => `${sha}\t${ref}\n`).join(""),
});
const refusal = (code) => ({
  status: 128,
  stderr: `fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: ${code}\n`,
});

test("outputs the exact branch ref's SHA, not a longer ref that ends in it", () => {
  const r = run({
    answers: [
      listing(
        [OTHER, "refs/heads/x/refs/heads/main"],
        [TIP, "refs/heads/main"],
        [TAG, "refs/tags/v1-main"],
      ),
    ],
  });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(
    r.outputs,
    { sha: TIP, "unambiguous-sha": TIP },
    "a tag only ending in main shadows nothing",
  );
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].args, [
    "-C",
    r.root,
    "ls-remote",
    "https://github.com/o/r.git",
    "refs/heads/main",
    "refs/tags/main",
  ]);
});

test("sends the token only as a masked extraheader in GIT_CONFIG_* variables", () => {
  const r = run({ answers: [listing([TIP, "refs/heads/main"])] });
  assert.equal(r.status, 0, r.stdout);
  const { args, env } = r.calls[0];
  assert.deepEqual(
    {
      count: env.GIT_CONFIG_COUNT,
      key: env.GIT_CONFIG_KEY_0,
      value: env.GIT_CONFIG_VALUE_0,
      prompt: env.GIT_TERMINAL_PROMPT,
    },
    {
      count: "1",
      key: "http.https://github.com/.extraheader",
      value: `AUTHORIZATION: basic ${HEADER}`,
      prompt: "0",
    },
  );
  assert.equal(
    env.TIP_TOKEN,
    undefined,
    "the raw token is not passed on to git",
  );
  assert.ok(
    !args.join(" ").includes(TOKEN) && !args.join(" ").includes(HEADER),
    "no credential in git's arguments",
  );
  assert.match(r.stdout, new RegExp(`^::add-mask::${HEADER}$`, "m"));
  assert.ok(
    r.stdout.indexOf("::add-mask::") < r.stdout.indexOf("Resolved"),
    "masked before the read",
  );
});

test("leaves unambiguous-sha empty while a tag shares the branch's name", () => {
  for (const ref of ["refs/tags/main", "refs/tags/main^{}"]) {
    const r = run({ answers: [listing([TIP, "refs/heads/main"], [TAG, ref])] });
    assert.equal(r.status, 0, ref);
    assert.deepEqual(r.outputs, { sha: TIP }, ref);
  }
});

test("a listing without the branch fails at once, with no output", () => {
  const r = run({
    answers: [listing([OTHER, "refs/heads/x/refs/heads/main"])],
  });
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 1, "a missing branch is not retried");
  assert.deepEqual(r.outputs, {});
  assert.match(
    r.stdout,
    /^::error::resolve-branch-tip: o\/r has no branch main$/m,
  );
});

test("an invalid token (401) or a 403 fails at once, naming the refused token", () => {
  // An invalid token: git's real stderr for GitHub's 401 to an extraheader,
  // recorded from git ls-remote of a public repository.
  const invalidToken = {
    status: 128,
    stderr:
      "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/o/r.git/'\n",
  };
  for (const [code, answer] of [
    [401, invalidToken],
    [403, refusal(403)],
  ]) {
    const r = run({ answers: [answer] });
    assert.equal(r.status, 1, `${code}`);
    assert.equal(r.calls.length, 1, `${code} is not retried`);
    assert.deepEqual(r.sleeps, [], `${code}`);
    assert.match(
      r.stdout,
      /^::error::resolve-branch-tip: GitHub refused the token for o\/r \(HTTP 401\/403\)/m,
      `${code}`,
    );
  }
});

test("a 429, a DNS failure or any other git error fails at once", () => {
  for (const answer of [
    refusal(429),
    {
      status: 128,
      stderr:
        "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com\n",
    },
  ]) {
    const r = run({ answers: [answer] });
    assert.equal(r.status, 1, answer.stderr);
    assert.equal(r.calls.length, 1, answer.stderr);
    assert.match(
      r.stdout,
      /^::error::resolve-branch-tip: git ls-remote of o\/r failed with exit 128$/m,
    );
  }
});

test("a timeout or 5xx is retried with full-jitter waits, and try 3 can resolve", () => {
  const r = run({
    answers: [refusal(502), { status: 124 }, listing([TIP, "refs/heads/main"])],
  });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.calls.length, 3);
  assert.equal(r.outputs.sha, TIP);
  assert.equal(r.sleeps.length, 2);
  assert.ok(
    r.sleeps[0] >= 0 && r.sleeps[0] <= 2,
    `first wait 0-2 s, got ${r.sleeps[0]}`,
  );
  assert.ok(
    r.sleeps[1] >= 0 && r.sleeps[1] <= 4,
    `second wait 0-4 s, got ${r.sleeps[1]}`,
  );
  assert.match(
    r.stdout,
    /^::warning::resolve-branch-tip: try 1 got a server error; retrying$/m,
  );
  assert.match(
    r.stdout,
    /^::warning::resolve-branch-tip: try 2 timed out after 60 s; retrying$/m,
  );
});

test("three retryable failures stop after try 3 and fail with no output", () => {
  for (const answer of [refusal(503), { status: 124 }]) {
    const r = run({ answers: [answer] });
    assert.equal(r.status, 1);
    assert.equal(r.calls.length, 3, "at most 3 tries");
    assert.equal(r.sleeps.length, 2, "waits only between tries");
    assert.deepEqual(r.outputs, {});
    assert.match(
      r.stdout,
      /^::error::resolve-branch-tip: the tip of main did not resolve: try 3 /m,
    );
  }
});

test("an empty token, a malformed repository or a bad branch name fails before any read", () => {
  for (const [env, why] of [
    [{ TIP_TOKEN: "" }, /the token input is empty/],
    [{ TIP_REPOSITORY: "o/r/x" }, /repository 'o\/r\/x' is not owner\/name/],
    [{ TIP_BRANCH: "" }, /branch '' is not a valid branch name/],
    [{ TIP_BRANCH: "a..b" }, /branch 'a\.\.b' is not a valid branch name/],
  ]) {
    const r = run({ answers: [listing([TIP, "refs/heads/main"])], env });
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.equal(r.calls.length, 0, JSON.stringify(env));
    assert.match(r.stdout, why);
  }
});

test("the action passes its inputs to the script through env only", () => {
  const action = parseWorkflow(
    fs.readFileSync(path.join(ACTION_DIR, "action.yml"), "utf8"),
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(action.inputs).map(([k, v]) => [k, v.default]),
    ),
    {
      branch: "main",
      repository: expr("github.repository"),
      token: expr("github.token"),
    },
  );
  const [step] = action.runs.steps;
  assert.doesNotMatch(step.run, /\$\{\{/, "no expression inside run");
  assert.deepEqual(step.env, {
    TIP_BRANCH: expr("inputs.branch"),
    TIP_REPOSITORY: expr("inputs.repository"),
    TIP_TOKEN: expr("inputs.token"),
  });
});
