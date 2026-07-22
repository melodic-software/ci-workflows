"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
// link-check.yml runs on a caller-selected runner and was ported to
// actions/github-script, so it is no longer a consumer of this generated
// bash block; the other two still run on a fixed hosted runner and keep it.
const consumers = [
  "queue-monitor-liveness.yml",
  "tool-version-drift-check.yml",
];

test("every consumer embeds the tracking-issue core generated from one source", () => {
  const renderer = path.join(__dirname, "render-find-tracking-issue.cjs");
  const result = spawnSync(process.execPath, [renderer, "--check"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  for (const name of consumers) {
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, ".github", "workflows", name),
      "utf8",
    );
    assert.equal(
      workflow.match(/Source: \.github\/scripts\/find-tracking-issue\.sh/gu)
        ?.length,
      1,
      `${name} must embed the generated block exactly once`,
    );
    assert.match(
      workflow,
      /issue-number=" \+ \(\.\[0\] \| tostring\)/u,
      `${name} must resolve issue-number from the generated core`,
    );
  }
});
