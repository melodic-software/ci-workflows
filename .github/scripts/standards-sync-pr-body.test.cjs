"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const workflowPath = path.join(
  __dirname,
  "..",
  "workflows",
  "maintenance-sync-standards.yml",
);
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflowLines = workflowText.split(/\r?\n/u);

function stepIndex(name) {
  return workflowLines.findIndex((line) => line.includes(`- name: ${name}`));
}

function extractRunScript(name) {
  const start = stepIndex(name);
  assert.notEqual(start, -1, `step "${name}" must exist`);
  const runIndex = workflowLines.findIndex(
    (line, index) => index > start && /^ {8}run: \|$/u.test(line),
  );
  assert.notEqual(runIndex, -1, `run block for "${name}" must exist`);
  const body = [];
  for (let index = runIndex + 1; index < workflowLines.length; index += 1) {
    const line = workflowLines[index];
    if (line.length > 0 && !line.startsWith("          ")) break;
    body.push(line.startsWith("          ") ? line.slice(10) : "");
  }
  return body.join("\n");
}

const buildBodyScript = extractRunScript("Build reviewed sync PR body");

function runBuildBody({ refs = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-pr-body-"));
  const standardsDir = path.join(dir, ".standards-src", "distribution");
  fs.mkdirSync(standardsDir, { recursive: true });
  fs.writeFileSync(
    path.join(standardsDir, "sync-manifest.sh"),
    "#!/usr/bin/env bash\nprintf '%s\\n' '- `a` -> `b`'\n",
  );
  const prBody = path.join(dir, "body.md");
  try {
    execFileSync("bash", ["-c", buildBodyScript], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MANIFEST: "distribution/sync-manifest.yml",
        PR_BODY: prBody,
        REFS: refs,
        STANDARDS_REF: "main",
        STANDARDS_SHA: "a".repeat(40),
        TARGET: "melodic-software/claude-code-plugins",
      },
    });
    return fs.readFileSync(prBody, "utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("workflow_call declares an optional refs string input wired to the PR body step", () => {
  assert.match(
    workflowText,
    /^ {6}refs:\n(?: {8}.*\n)+? {8}type: string\n {8}default: ''$/mu,
  );
  const start = stepIndex("Build reviewed sync PR body");
  const stepBlock = workflowLines.slice(start, start + 12).join("\n");
  assert.match(stepBlock, /REFS: \$\{\{ inputs\.refs \}\}/u);
});

test("default sync PR body opens with a contract No related issue line before Summary", () => {
  const body = runBuildBody();
  const lines = body.split("\n");
  assert.equal(
    lines[0],
    "No related issue: recurring automated distribution, not tied to a tracked change.",
  );
  assert.equal(lines[1], "");
  assert.equal(lines[2], "## Summary");
  assert.doesNotMatch(body, /No linked issue —/u);
  for (const heading of [
    "## Summary",
    "## Fix",
    "## Verification",
    "## Related",
  ]) {
    assert.ok(body.includes(heading), `missing ${heading}`);
  }
});

test("refs input emits Refs: linkage lines on the top lines instead of No related issue", () => {
  for (const [input, expected] of [
    ["#18899", ["Refs: #18899"]],
    ["18899", ["Refs: #18899"]],
    [
      "melodic-software/claude-code-plugins#18899",
      ["Refs: melodic-software/claude-code-plugins#18899"],
    ],
    [
      " #18899, melodic-software/standards#42 \n 77 ",
      ["Refs: #18899", "Refs: melodic-software/standards#42", "Refs: #77"],
    ],
  ]) {
    const body = runBuildBody({ refs: input });
    const lines = body.split("\n");
    assert.deepEqual(lines.slice(0, expected.length), expected);
    assert.equal(lines[expected.length], "");
    assert.equal(lines[expected.length + 1], "## Summary");
    assert.doesNotMatch(body, /No related issue:/u);
  }
});

test("invalid refs input fails closed instead of writing a malformed linkage line", () => {
  for (const bad of ["Refs #18899", "#abc", "foo#123", "#18899 extra"]) {
    assert.throws(
      () => runBuildBody({ refs: bad }),
      (error) => error.status === 1 && /Invalid refs entry/u.test(error.stderr),
      `expected failure for ${bad}`,
    );
  }
});
