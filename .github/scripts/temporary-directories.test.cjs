"use strict";

// The helper's whole job is removal when a test process ends, including when
// it is interrupted, so each case runs it in a child process and checks the
// directory after that child is gone.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const helper = path.join(__dirname, "temporary-directories.cjs");

// The child prints the directory it made and whether it exists, then either
// exits or waits for a signal.
function startChild(wait) {
  const script = `
    const fs = require("node:fs");
    const { makeTemporaryDirectory } = require(${JSON.stringify(helper)});
    const directory = makeTemporaryDirectory("temporary-directories-");
    console.log(JSON.stringify({ directory, exists: fs.existsSync(directory) }));
    if (${wait}) setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const created = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline !== -1) resolve(JSON.parse(output.slice(0, newline)));
    });
    child.on("error", reject);
  });
  const closed = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, created, closed };
}

test("a normal exit removes the directory", async () => {
  const { created, closed } = startChild(false);
  const { directory, exists } = await created;
  assert.equal(exists, true);
  assert.deepEqual(await closed, { code: 0, signal: null });
  assert.equal(fs.existsSync(directory), false);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} removes the directory and still ends the process by ${signal}`, {
    skip: process.platform === "win32" && "Windows has no POSIX signals",
    timeout: 10_000,
  }, async (t) => {
    const { child, created, closed } = startChild(true);
    // A child that swallowed the signal would otherwise outlive the timeout
    // and hold this test file open.
    t.after(() => child.kill("SIGKILL"));
    const { directory, exists } = await created;
    assert.equal(exists, true);
    child.kill(signal);
    assert.deepEqual(await closed, { code: null, signal });
    assert.equal(fs.existsSync(directory), false);
  });
}
