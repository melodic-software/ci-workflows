"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const installer = path.join(
  __dirname,
  "..",
  "actions",
  "_shared",
  "install-release.sh",
);

function bashPath(value) {
  if (process.platform !== "win32") return value;
  const normalized = path.resolve(value).replaceAll("\\", "/");
  return normalized.replace(
    /^([A-Za-z]):/u,
    (_, drive) => `/${drive.toLowerCase()}`,
  );
}

function bashExecutable() {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    path.join(
      process.env.ProgramFiles || "C:\\Program Files",
      "Git",
      "bin",
      "bash.exe",
    ),
    path.join(
      process.env.LOCALAPPDATA || "",
      "Programs",
      "Git",
      "bin",
      "bash.exe",
    ),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(found, "Git Bash is required to test install-release.sh");
  return found;
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-release-test-"));
  const runnerTemp = path.join(root, "runner-temp");
  const mocks = path.join(root, "mocks");
  const shadow = path.join(root, "shadow");
  fs.mkdirSync(runnerTemp);
  fs.mkdirSync(mocks);
  fs.mkdirSync(shadow);
  const githubPath = path.join(root, "github-path");
  const curlLog = path.join(root, "curl.log");
  const versionLog = path.join(root, "version.log");
  fs.writeFileSync(githubPath, "");
  writeExecutable(
    path.join(mocks, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" >>"$MOCK_CURL_LOG"
out=''
while (( $# )); do
  if [[ "$1" == '--output' ]]; then out="$2"; shift 2; else shift; fi
done
cp -- "$MOCK_CURL_SOURCE" "$out"
`,
  );
  writeExecutable(
    path.join(shadow, "fixture-tool"),
    "#!/usr/bin/env bash\nexit 91\n",
  );
  return { root, runnerTemp, mocks, shadow, githubPath, curlLog, versionLog };
}

function run(env) {
  return spawnSync(
    bashExecutable(),
    [
      "-c",
      'export PATH="$1:$2$' + '{3:+:$3}:$PATH"; exec bash "$4"',
      "--",
      env.TEST_MOCK_PATH,
      env.TEST_SHADOW_PATH,
      env.TEST_RUNTIME_PATH,
      bashPath(installer),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}

function baseEnv(state, source) {
  return {
    URL: "https://example.invalid/tool",
    SHA256: sha256(source),
    BIN: "fixture-tool",
    RUNNER_TEMP: bashPath(state.runnerTemp),
    GITHUB_PATH: bashPath(state.githubPath),
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    MOCK_CURL_SOURCE: bashPath(source),
    MOCK_CURL_LOG: bashPath(state.curlLog),
    VERSION_LOG: bashPath(state.versionLog),
    TEST_MOCK_PATH: bashPath(state.mocks),
    TEST_SHADOW_PATH: bashPath(state.shadow),
    TEST_RUNTIME_PATH: "",
  };
}

function toolSource(label) {
  return `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$0" >>"$VERSION_LOG"
printf '${label} %s\\n' "\${1:-}"
`;
}

// Each fixture() creates its own temp root; register its removal once so
// every test cleans up regardless of how it exits.
function fixtureWithCleanup(t) {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  return state;
}

test("raw installs are bounded, exact-path verified, and idempotent", (t) => {
  const state = fixtureWithCleanup(t);
  const source = path.join(state.root, "raw-tool");
  writeExecutable(source, toolSource("raw"));
  const env = baseEnv(state, source);

  const binDir = path.join(state.runnerTemp, "ci-workflows", "bin");
  const firstRun = run(env);
  assert.equal(firstRun.status, 0, firstRun.stderr);
  assert.match(firstRun.stdout, /raw --version/u);

  // Each GitHub Actions step gets a fresh GITHUB_PATH file. Entries written by
  // an earlier step instead appear in PATH, so model that on the second run.
  const nextGithubPath = path.join(state.root, "next-github-path");
  fs.writeFileSync(nextGithubPath, "");
  const secondRun = run({
    ...env,
    GITHUB_PATH: bashPath(nextGithubPath),
    TEST_RUNTIME_PATH: bashPath(binDir),
  });
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.match(secondRun.stdout, /raw --version/u);

  assert.equal(
    fs.readFileSync(state.githubPath, "utf8"),
    `${bashPath(binDir)}\n`,
  );
  assert.equal(fs.readFileSync(nextGithubPath, "utf8"), "");
  assert.ok(fs.existsSync(path.join(binDir, "fixture-tool")));
  const versionCalls = fs
    .readFileSync(state.versionLog, "utf8")
    .trim()
    .split(/\r?\n/u);
  assert.equal(versionCalls.length, 2);
  assert.ok(
    versionCalls.every((called) =>
      called.endsWith("/ci-workflows/bin/fixture-tool"),
    ),
  );
  assert.deepEqual(
    fs.readdirSync(path.join(state.runnerTemp, "ci-workflows")),
    ["bin"],
  );

  const calls = fs
    .readFileSync(state.curlLog, "utf8")
    .split("\0")
    .filter(Boolean);
  const first = calls.slice(0, calls.length / 2);
  assert.equal(first[0], "-q");
  assert.ok(!first.includes("--request"));
  for (const expected of [
    "--proto",
    "=https",
    "--proto-redir",
    "--connect-timeout",
    "--max-time",
    "--retry",
    "--retry-max-time",
  ])
    assert.ok(first.includes(expected), `missing curl argument ${expected}`);
  assert.ok(!first.includes("--retry-delay"));
  assert.ok(!first.includes("--retry-all-errors"));
});

test("checksummed tar members support stripping before installation", (t) => {
  const state = fixtureWithCleanup(t);
  const tree = path.join(state.root, "tree");
  fs.mkdirSync(path.join(tree, "package"), { recursive: true });
  writeExecutable(
    path.join(tree, "package", "fixture-tool"),
    toolSource("tar"),
  );
  const archive = path.join(state.root, "tool.tar.gz");
  const packed = spawnSync(
    bashExecutable(),
    [
      "-c",
      'tar -czf "$1" -C "$2" package/fixture-tool',
      "--",
      bashPath(archive),
      bashPath(tree),
    ],
    { encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr);

  const result = run({
    ...baseEnv(state, archive),
    ARCHIVE_MEMBER: "package/fixture-tool",
    STRIP_COMPONENTS: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tar --version/u);
  assert.deepEqual(
    fs.readdirSync(path.join(state.runnerTemp, "ci-workflows")),
    ["bin"],
  );
});

test("a checksum failure stops before extraction or installation", (t) => {
  const state = fixtureWithCleanup(t);
  const source = path.join(state.root, "not-an-archive");
  fs.writeFileSync(source, "corrupt");
  const result = run({
    ...baseEnv(state, source),
    SHA256: "0".repeat(64),
    ARCHIVE_MEMBER: "fixture-tool",
  });
  assert.notEqual(result.status, 0);
  assert.ok(
    !fs.existsSync(
      path.join(state.runnerTemp, "ci-workflows", "bin", "fixture-tool"),
    ),
  );
  assert.deepEqual(
    fs.readdirSync(path.join(state.runnerTemp, "ci-workflows")),
    ["bin"],
  );
});

test("unsupported runners fail before network access", (t) => {
  const state = fixtureWithCleanup(t);
  const source = path.join(state.root, "raw-tool");
  writeExecutable(source, toolSource("raw"));

  const result = run({
    ...baseEnv(state, source),
    RUNNER_OS: "Windows",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only GitHub Actions Linux X64 runners/u);
  assert.ok(!fs.existsSync(state.curlLog));
});
