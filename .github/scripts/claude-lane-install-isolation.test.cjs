"use strict";

// Both Claude lanes install bubblewrap with their own copy of the same step.
// The copies must not drift: a fix to one that misses the other leaves one
// lane without the isolation the other has.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsDir = path.join(__dirname, "..", "workflows");
const stepName = "Install subprocess isolation";

const installStep = (file) => {
  const workflow = parseWorkflow(
    fs.readFileSync(path.join(workflowsDir, file), "utf8"),
  );
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const matches = steps.filter((step) => step.name === stepName);
  assert.equal(matches.length, 1, `${file} has one "${stepName}" step`);
  assert.equal(typeof matches[0].run, "string", file);
  return matches[0];
};

test("both lanes run the same subprocess isolation install script", () => {
  assert.equal(
    installStep("pr-review.yml").run,
    installStep("pr-review-security.yml").run,
  );
});

// A slow mirror once held one unbounded apt-get attempt past the step limit,
// so the lane timed out instead of failing with a named cause.
test("every apt-get call ends before its step limit", () => {
  const steps = [
    "pr-review.yml",
    "pr-review-security.yml",
    "intake-triage.yml",
  ].flatMap((file) => {
    const workflow = parseWorkflow(
      fs.readFileSync(path.join(workflowsDir, file), "utf8"),
    );
    return Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => /\bapt-get\b/.test(step.run ?? ""))
      .map((step) => ({ file, step }));
  });
  assert.equal(steps.length, 5, "two lane steps and three intake-triage steps");
  for (const { file, step } of steps) {
    const label = `${file}: ${step.name}`;
    const unbounded = step.run
      .split("\n")
      .filter((line) => /\bsudo\b.*\bapt-get\b/.test(line))
      .filter((line) => !/\bsudo timeout -k \d+ "\$left" apt-get\b/.test(line));
    assert.deepEqual(
      unbounded,
      [],
      `${label} runs apt-get only under the deadline`,
    );
    const deadline = Number(
      /deadline=\$\(\(SECONDS \+ (\d+)\)\)/.exec(step.run)?.[1],
    );
    const kill = Number(/timeout -k (\d+)/.exec(step.run)?.[1]);
    assert.ok(
      deadline + kill < step["timeout-minutes"] * 60,
      `${label} deadline fits`,
    );
    // The skip needs both tools, so the final check must too.
    assert.match(
      step.run,
      /if ! \{ command -v bwrap && command -v socat; \} >\/dev\/null; then\n\s*echo "::error::[^\n]*"\n\s*exit 1/,
      `${label} fails without bwrap or socat`,
    );
  }
});

// Without the helper, bubblewrap gets --disable-userns and dies on a
// read-only /proc/sys. sandbox-runtime looks for it only under these static
// global npm roots and `npm root -g` (src/sandbox/generate-seccomp-filter.ts,
// buildGlobalNpmPaths, v0.0.81), so a helper anywhere else is never used.
const helperRoots = [
  "/usr/lib/node_modules",
  "/usr/local/lib/node_modules",
  "/opt/homebrew/lib/node_modules",
];
const helperSuffix =
  "@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp";

const runHelperInstall = (tarballSha256) => {
  const run = installStep("pr-review.yml").run;
  const fragment = run.slice(run.indexOf('case "$RUNNER_ARCH" in'));
  assert.ok(fragment.startsWith("case"), "the step installs the helper");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seccomp-helper-"));
  const root = path.join(dir, "root");
  const stubs = path.join(dir, "stubs");
  const packageDir = path.join(
    dir,
    "pkg",
    "package",
    "vendor",
    "seccomp",
    "x64",
  );
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(packageDir, "apply-seccomp"), "helper-bytes\n");
  const tarball = path.join(dir, "package.tgz");
  spawnSync("tar", ["-czf", tarball, "-C", path.join(dir, "pkg"), "package"]);
  const sha256 =
    tarballSha256 ??
    crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  fs.writeFileSync(
    path.join(stubs, "curl"),
    '#!/bin/bash\nwhile [ $# -gt 1 ]; do [ "$1" = --output ] && out="$2"; shift; done\necho "$1" >> "$STUB_LOG"\ncp "$FAKE_TARBALL" "$out"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(stubs, "sudo"),
    '#!/bin/bash\necho "sudo $*" >> "$STUB_LOG"\nfor arg; do src="$dest"; dest="$arg"; done\nmkdir -p "$(dirname "$FAKE_ROOT$dest")"\ncp "$src" "$FAKE_ROOT$dest"\n',
    { mode: 0o755 },
  );
  const log = path.join(dir, "stub.log");
  const result = spawnSync("bash", ["-eo", "pipefail", "-c", fragment], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH}`,
      RUNNER_ARCH: "X64",
      RUNNER_TEMP: dir,
      SANDBOX_RUNTIME_VERSION: "0.0.81",
      SANDBOX_RUNTIME_SHA256: sha256,
      FAKE_TARBALL: tarball,
      FAKE_ROOT: root,
      STUB_LOG: log,
    },
  });
  const stubLog = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  return { result, root, stubLog, dir };
};

test("the helper lands root-owned where sandbox-runtime looks for it", (t) => {
  const { result, root, stubLog, dir } = runHelperInstall();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(result.status, 0, result.stderr);
  const installed = helperRoots
    .map((base) => path.join(base, helperSuffix))
    .filter((target) => fs.existsSync(path.join(root, target)));
  assert.equal(installed.length, 1, "one helper under a searched root");
  assert.equal(
    fs.readFileSync(path.join(root, installed[0]), "utf8"),
    "helper-bytes\n",
  );
  assert.match(stubLog, /^sudo install -D -o root -g root -m 0755 -- /mu);
  assert.match(
    stubLog,
    /^https:\/\/registry\.npmjs\.org\/@anthropic-ai\/sandbox-runtime\/-\/sandbox-runtime-0\.0\.81\.tgz$/mu,
  );
});

test("a tarball that does not match the pinned SHA-256 installs nothing", (t) => {
  const { result, root, stubLog, dir } = runHelperInstall("0".repeat(64));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error::.*does not match its pinned SHA-256/u);
  assert.equal(fs.existsSync(root), false, "nothing installed");
  assert.doesNotMatch(stubLog, /^sudo /mu);
});
