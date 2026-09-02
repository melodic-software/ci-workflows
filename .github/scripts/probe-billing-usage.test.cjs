"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.join(__dirname, "probe-billing-usage.cjs");
const source = fs.readFileSync(scriptPath, "utf8");
const { resolveVisibility } = require("./probe-billing-usage.cjs");

// Builds a directory holding a stub `gh`, prepended to PATH so the probe's
// spawnSync("gh", …) resolves to it. The real binary is never available in
// CI's node lane, and a probe that shelled out to a live billing API from a
// test would not be a unit test.
function stubGhDirectory(body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "probe-gh-"));
  const stub = path.join(directory, "gh");
  fs.writeFileSync(stub, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return directory;
}

function runProbe(stubDirectory, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [scriptPath, "--org", "testorg", ...extraArgs],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDirectory}:${process.env.PATH}` },
    },
  );
}

// Runs `fn` with a stub `gh` first on PATH for in-process spawnSync calls.
async function withStubGh(body, fn) {
  const directory = stubGhDirectory(body);
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// A stub `gh` that answers the usage endpoint with `usageItems` (via the
// header-emitting `gh api -i` form the probe uses), the repo endpoint with
// `repoBody`, and every other call with an empty 200.
function stubGhForProbe({ usageItems, repoBody }) {
  const usage = JSON.stringify({ usageItems });
  return stubGhDirectory(
    `case "$*" in
  *"/repos/"*) printf '%s' '${repoBody}' ;;
  *"/settings/billing/usage?"*) printf 'HTTP/2.0 200 OK\\n\\n%s' '${usage}' ;;
  *) printf 'HTTP/2.0 200 OK\\n\\n{}' ;;
esac
exit 0`,
  );
}

function usageItem(overrides = {}) {
  return {
    date: "2026-08-01T00:00:00Z",
    product: "actions",
    sku: "Actions Linux",
    quantity: 2600,
    unitType: "Minutes",
    pricePerUnit: 0.006,
    grossAmount: 15.6,
    discountAmount: 15.6,
    netAmount: 0,
    organizationName: "testorg",
    repositoryName: "private-repo",
    ...overrides,
  };
}

// Regression guard. The entry point used `main().then((code) =>
// process.exit(code))`. process.exit() abandons pending stdout writes, and
// piped stdout is asynchronous, so a report larger than the pipe buffer is cut
// mid-write — measured on this runtime at 131072 bytes of a 400011-byte
// payload. Assigning process.exitCode lets the process drain and exit
// naturally.
//
// This is asserted against the source rather than by reproducing a truncated
// report, and that is deliberate: today's report embeds only endpoint paths,
// HTTP statuses and fixed strings, so it stays around a kilobyte and cannot
// reach the pipe buffer. The hazard is latent — it arrives the moment anything
// variable-length (a probe body, a gh stderr detail, a budget list) is added to
// the report. A test that could only fail after that change would not guard the
// fix; this one fails the moment the exit form regresses.
test("the entry point drains stdout instead of calling process.exit", () => {
  const start = source.indexOf("if (require.main === module)");
  assert.notEqual(start, -1, "entry-point block must exist");
  // Strip line comments before asserting: the block's own comment explains the
  // hazard by naming process.exit(), and matching that would make this test
  // pass or fail on prose rather than on code.
  const entryPoint = source
    .slice(start)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  assert.match(
    entryPoint,
    /process\.exitCode = code;/u,
    "the resolve handler must assign process.exitCode",
  );
  assert.doesNotMatch(
    entryPoint,
    /process\.exit\(/u,
    "process.exit() abandons pending stdout writes and truncates the report",
  );
});

// Grounds the assertion above in the runtime's actual behavior, so the source
// check is not an arbitrary style rule. Asserts only the property the fix
// depends on: the exitCode form delivers a payload far larger than the pipe
// buffer intact. It deliberately does not assert that process.exit() truncates
// — that is the bug, and pinning a bug's exact byte count would be brittle
// across platforms and buffer sizes.
test("assigning process.exitCode delivers a payload past the pipe buffer", () => {
  const payloadSize = 400_000;
  const program =
    `const p = JSON.stringify({ pad: "x".repeat(${payloadSize}) });` +
    'process.stdout.write(p + "\\n");' +
    "process.exitCode = 0;";

  const result = spawnSync(process.execPath, ["-e", program], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.pad.length, payloadSize);
});

// End-to-end smoke over the real script: whatever the probe decides, stdout
// must be one complete, parseable JSON report rather than a partial write.
test("the probe emits a complete JSON report when every endpoint fails", () => {
  const directory = stubGhDirectory("exit 1");
  try {
    const result = runProbe(directory);

    assert.notEqual(result.stdout.trim(), "", "the probe must print a report");
    const report = JSON.parse(result.stdout);
    assert.equal(report.org, "testorg");
    assert.equal(report.state, "unknown");
    // Every endpoint is recorded even when the probe could not reach one, so a
    // reader can tell "asked and failed" from "never asked".
    assert.deepEqual(Object.keys(report.endpoints).sort(), [
      "budgets",
      "summary",
      "usage",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ci-workflows#519 D1. `ghApi` returns the parsed body, or null when `gh`
// exits 0 with empty stdout. Only an explicit boolean `private` may name a
// visibility; the old `data?.private ? "private" : "public"` turned null and
// `private`-less bodies into "public", which billing-headroom then excluded
// from the pool — the fail-open direction.
const VISIBILITY_TABLE = [
  { name: "private:true", stdout: '{"private":true}', expected: "private" },
  { name: "private:false", stdout: '{"private":false}', expected: "public" },
  { name: "empty body", stdout: "", expected: "unknown" },
  { name: "empty object", stdout: "{}", expected: "unknown" },
  { name: "JSON null", stdout: "null", expected: "unknown" },
  { name: "string private", stdout: '{"private":"true"}', expected: "unknown" },
  { name: "numeric private", stdout: '{"private":1}', expected: "unknown" },
  { name: "array body", stdout: "[]", expected: "unknown" },
  { name: "scalar body", stdout: "true", expected: "unknown" },
];

for (const row of VISIBILITY_TABLE) {
  test(`resolveVisibility: ${row.name} → ${row.expected}`, async () => {
    await withStubGh(`printf '%s' '${row.stdout}'\nexit 0`, async () => {
      assert.equal(await resolveVisibility("testorg", "repo"), row.expected);
    });
  });
}

test("resolveVisibility: non-zero gh exit → unknown", async () => {
  await withStubGh("echo 'gh: Not Found (HTTP 404)' >&2\nexit 1", async () => {
    assert.equal(await resolveVisibility("testorg", "repo"), "unknown");
  });
});

test("resolveVisibility: unparseable body → unknown", async () => {
  await withStubGh("printf 'not json'\nexit 0", async () => {
    assert.equal(await resolveVisibility("testorg", "repo"), "unknown");
  });
});

// End-to-end regression for D1: a repo lookup that returns an empty 200 must
// leave those minutes counted. 2 600 / 3 000 is over the 85 % threshold, so
// the honest answer is `exhausted`; the fail-open path read them as public
// and reported `free`.
test("the probe reports exhausted, not free, when repo visibility is unresolvable", () => {
  const directory = stubGhForProbe({
    usageItems: [usageItem()],
    repoBody: "",
  });
  try {
    const result = runProbe(directory, ["--json"]);
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.endpoints.usage.status, 200);
    assert.equal(report.state, "exhausted");
    assert.equal(report.headroom.privateMinutes, 2600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the probe reports free when the repo is confirmed public", () => {
  const directory = stubGhForProbe({
    usageItems: [usageItem()],
    repoBody: '{"private":false}',
  });
  try {
    const result = runProbe(directory, ["--json"]);
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.state, "free");
    assert.equal(report.headroom.privateMinutes, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// End-to-end regression for D2: an Actions minute SKU the math does not know
// must surface as `unknown` with exit 1, never as `free`.
test("the probe reports unknown when the usage report carries an unrecognized SKU", () => {
  const directory = stubGhForProbe({
    usageItems: [
      usageItem({ quantity: 1 }),
      usageItem({ sku: "Actions Quantum 2-qubit", quantity: 1 }),
    ],
    repoBody: '{"private":true}',
  });
  try {
    const result = runProbe(directory, ["--json"]);
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(report.state, "unknown");
    assert.match(report.error, /unrecognized Actions minute SKU/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
