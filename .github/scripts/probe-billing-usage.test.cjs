"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.join(__dirname, "probe-billing-usage.cjs");
const source = fs.readFileSync(scriptPath, "utf8");

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

function runProbe(stubDirectory) {
  return spawnSync(process.execPath, [scriptPath, "--org", "testorg"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubDirectory}:${process.env.PATH}` },
  });
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
