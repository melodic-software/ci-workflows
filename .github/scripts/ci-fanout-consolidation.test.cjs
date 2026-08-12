"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const ciWorkflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "ci.yml",
);
const selectorConformancePath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "selector-conformance.yml",
);
const adrPath = path.join(
  repositoryRoot,
  "docs",
  "topics",
  "ci-fanout-consolidation",
  "ADR.md",
);

const ciWorkflow = fs.readFileSync(ciWorkflowPath, "utf8");
const selectorConformance = fs.readFileSync(selectorConformancePath, "utf8");
const adr = fs.readFileSync(adrPath, "utf8");

test("ci.yml uses main-push burst collapse concurrency (#122)", () => {
  assert.match(
    ciWorkflow,
    /^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/mu,
  );
  assert.doesNotMatch(ciWorkflow, /pull_request\.number \|\| github\.run_id/u);
});

test("selector-conformance.yml matches the same concurrency pattern", () => {
  assert.match(
    selectorConformance,
    /^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/mu,
  );
});

test("ci.yml consolidates cheapest hygiene checks into one lane", () => {
  assert.match(ciWorkflow, /^ {2}hygiene:$/mu);
  assert.match(ciWorkflow, /^ {8}id: editorconfig$/mu);
  assert.match(ciWorkflow, /^ {8}id: exec_bit$/mu);
  assert.match(ciWorkflow, /^ {8}id: machine_specific_paths$/mu);
  assert.match(ciWorkflow, /^ {8}id: eol_renormalize$/mu);
  assert.match(ciWorkflow, /^ {8}id: comment_hygiene_superset$/mu);
  assert.match(ciWorkflow, /^ {8}id: comment_hygiene$/mu);
  assert.match(ciWorkflow, /^ {8}continue-on-error: true$/mu);
  assert.match(ciWorkflow, /^ {6}- name: Aggregate hygiene checks$/mu);
  assert.match(ciWorkflow, /\[\[ "\$outcome" == failure \]\]/u);

  for (const job of [
    "editorconfig",
    "exec-bit",
    "machine-specific-paths",
    "eol-renormalize",
    "comment-hygiene",
  ]) {
    assert.doesNotMatch(ciWorkflow, new RegExp(`^ {2}${job}:$`, "mu"));
  }

  assert.match(ciWorkflow, /^ {4}needs: \[[^\n]*\bhygiene\b[^\n]*\]$/mu);
  assert.match(
    ciWorkflow,
    /^ {10}results: [^\n]*\$\{\{ needs\.hygiene\.result \}\}[^\n]*$/mu,
  );
  assert.doesNotMatch(ciWorkflow, /needs\.editorconfig\.result/u);
  assert.doesNotMatch(ciWorkflow, /needs\.exec-bit\.result/u);
  assert.doesNotMatch(ciWorkflow, /needs\.comment-hygiene\.result/u);
});

test("ADR records #122 COMPLETED with Shape A done", () => {
  assert.match(adr, /Status: \*\*COMPLETED\*\*/u);
  assert.match(
    adr,
    /\| Shape A \(dotfiles single selector\) \| Done \(confirmed on `dotfiles` `main`\) \|/u,
  );
  assert.match(adr, /Main-push burst collapse wins/u);
  assert.match(adr, /Hygiene lane consolidation/u);
});
