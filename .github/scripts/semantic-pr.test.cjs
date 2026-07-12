"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const workflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "semantic-pr.yml"),
  "utf8",
);
const readme = fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8");

test("semantic PR required check fails closed after every prerequisite outcome", () => {
  const prerequisiteInput = workflow.match(
    / {6}prerequisite-result:\n([\s\S]*?)(?= {6}[a-z][a-z-]+:\n|\npermissions:)/u,
  );
  assert.ok(prerequisiteInput, "prerequisite-result input is missing");
  assert.match(prerequisiteInput[1], / {8}type: string\n/u);
  assert.match(prerequisiteInput[1], / {8}default: success\n/u);

  const requiredJob = workflow.slice(workflow.indexOf("  pr-title:\n"));
  assert.match(
    requiredJob,
    /runs-on: \$\{\{ inputs\.prerequisite-result == 'success' && inputs\.runner \|\| 'ubuntu-slim' \}\}/u,
  );
  assert.match(
    requiredJob,
    /- name: Reject failed prerequisite\n\s+if: \$\{\{ inputs\.prerequisite-result != 'success' \}\}[\s\S]*?PREREQUISITE_RESULT: \$\{\{ inputs\.prerequisite-result \}\}[\s\S]*?exit 1/u,
  );
  assert.match(
    requiredJob,
    /- name: Validate PR title against Conventional Commits[\s\S]*?if: >-\n\s+inputs\.prerequisite-result == 'success' &&\n\s+\(github\.event_name == 'pull_request' \|\|\n\s+github\.event_name == 'pull_request_target'\)/u,
  );

  const validationIndex = requiredJob.indexOf(
    "- name: Validate PR title against Conventional Commits",
  );
  assert.ok(
    requiredJob.indexOf("- name: Reject failed prerequisite") < validationIndex,
    "prerequisite rejection must precede title validation",
  );

  const runnerFor = (result, selectedRunner) =>
    result === "success" && selectedRunner ? selectedRunner : "ubuntu-slim";
  assert.equal(
    runnerFor("success", "melodic-ubuntu-24.04-x64"),
    "melodic-ubuntu-24.04-x64",
  );
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    assert.equal(
      runnerFor(result, "ci-runner-selection-failed"),
      "ubuntu-slim",
    );
  }
});

test("documented selector composition preserves the one required check context", () => {
  assert.match(
    readme,
    /pr-title:\n\s+needs: select-runner\n\s+if: \$\{\{ always\(\) \}\}[\s\S]*?uses: melodic-software\/ci-workflows\/\.github\/workflows\/semantic-pr\.yml@<sha>[\s\S]*?runner: \$\{\{ needs\.select-runner\.outputs\.runner \|\| 'ubuntu-24\.04' \}\}\n\s+prerequisite-result: \$\{\{ needs\.select-runner\.result \}\}/u,
  );
  assert.match(
    readme,
    /The normal\s+success path still runs the existing `pr-title \/ pr-title` job\s+only on the\s+selector-returned runner/u,
  );
});
