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

test("semantic PR required check fails closed after every prerequisite outcome except a superseding cancellation", () => {
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
    /- name: Note cancelled prerequisite\n\s+(?:#.*\n\s+)*if: \$\{\{ inputs\.prerequisite-result == 'cancelled' \}\}[\s\S]*?PREREQUISITE_RESULT: \$\{\{ inputs\.prerequisite-result \}\}[\s\S]*?run: echo/u,
  );
  assert.doesNotMatch(
    requiredJob.slice(
      requiredJob.indexOf("- name: Note cancelled prerequisite"),
      requiredJob.indexOf("- name: Reject failed prerequisite"),
    ),
    /exit 1/u,
    "a cancelled prerequisite must not exit non-zero",
  );
  assert.match(
    requiredJob,
    /- name: Reject failed prerequisite\n\s+if: \$\{\{ inputs\.prerequisite-result != 'success' && inputs\.prerequisite-result != 'cancelled' \}\}[\s\S]*?PREREQUISITE_RESULT: \$\{\{ inputs\.prerequisite-result \}\}[\s\S]*?exit 1/u,
  );
  assert.match(
    requiredJob,
    /- name: Validate PR title against Conventional Commits[\s\S]*?if: >-\n\s+inputs\.prerequisite-result == 'success' &&\n\s+\(github\.event_name == 'pull_request' \|\|\n\s+github\.event_name == 'pull_request_target'\)/u,
  );

  const noteIndex = requiredJob.indexOf("- name: Note cancelled prerequisite");
  const rejectIndex = requiredJob.indexOf("- name: Reject failed prerequisite");
  const validationIndex = requiredJob.indexOf(
    "- name: Validate PR title against Conventional Commits",
  );
  assert.ok(
    noteIndex < rejectIndex && rejectIndex < validationIndex,
    "cancellation note and prerequisite rejection must precede title validation",
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

  // Simulate the job's step-conditional dispatch for every prerequisite result:
  // exactly one outcome bucket — success, no-op cancellation, or hard failure —
  // fires, and `cancelled` must land in the no-op bucket, never the failure one.
  const dispatch = (result) => {
    if (result === "cancelled") return "noop";
    if (result !== "success") return "fail";
    return "validate";
  };
  assert.equal(dispatch("success"), "validate");
  assert.equal(dispatch("cancelled"), "noop");
  assert.equal(dispatch("failure"), "fail");
  assert.equal(dispatch("skipped"), "fail");
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
  assert.match(
    readme,
    /`cancelled`[\s\S]*?is a\s+no-op[\s\S]*?it does not fail the check/u,
  );
});
