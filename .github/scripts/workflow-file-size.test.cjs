"use strict";

// GitHub Actions enforces a 500 KB maximum per workflow file under
// .github/workflows/ (https://docs.github.com/en/actions/reference/limits).
// Files past that ceiling fail silently on push with a 0-job run.
// Hold every workflow file well below it (400,000 bytes, leaving 100 KB of
// headroom) so growth triggers extraction into composite actions under
// .github/actions/ before a push breaks.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");

const MAX_WORKFLOW_BYTES = 400_000;
const WORKFLOWS_DIR = path.join(__dirname, "..", "workflows");

function checkWorkflowSizes(dir, maxBytes = MAX_WORKFLOW_BYTES) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const oversized = [];
  for (const entry of entries) {
    const size = fs.statSync(path.join(dir, entry.name)).size;
    if (size > maxBytes) {
      oversized.push({ name: entry.name, size });
    }
  }
  return { count: entries.length, oversized };
}

test("every workflow file stays under the 400,000-byte ceiling", () => {
  const { count, oversized } = checkWorkflowSizes(WORKFLOWS_DIR);
  assert.ok(count > 0, "expected at least one workflow file");
  assert.deepEqual(
    oversized,
    [],
    oversized
      .map(
        ({ name, size }) =>
          `.github/workflows/${name} is ${size} bytes, over the ${MAX_WORKFLOW_BYTES}-byte limit ` +
          "(GitHub caps workflow files at 500 KB); move inline step scripts into .github/actions/",
      )
      .join("\n"),
  );
});

test("checkWorkflowSizes accepts a workflow at the ceiling and rejects one byte over", () => {
  const dir = makeTemporaryDirectory("workflow-file-size-");
  fs.writeFileSync(path.join(dir, "at-limit.yml"), "a".repeat(100));
  fs.writeFileSync(path.join(dir, "over-limit.yaml"), "b".repeat(101));
  fs.writeFileSync(path.join(dir, "ignored.txt"), "c".repeat(500));

  const { count, oversized } = checkWorkflowSizes(dir, 100);
  assert.equal(count, 2);
  assert.deepEqual(oversized, [{ name: "over-limit.yaml", size: 101 }]);
});
