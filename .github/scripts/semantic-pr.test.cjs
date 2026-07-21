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

test("semantic PR documents the validator-required fail-closed caller shape", () => {
  const prerequisiteInput = workflow.match(
    / {6}prerequisite-result:\n([\s\S]*?)(?= {6}[a-z][a-z-]+:\n|\npermissions:)/u,
  );
  assert.ok(prerequisiteInput, "prerequisite-result input is missing");
  assert.match(
    prerequisiteInput[1],
    /Callers with `needs` must pass\s+its exact result and use `if: always\(\)`; any value other than success,\s+including an unverified cancelled result, fails this required check\s+before title validation\./u,
  );
  assert.doesNotMatch(prerequisiteInput[1], /!cancelled\(\)/u);

  const jobStart = workflow.indexOf("  pr-title:\n");
  const runsOn = workflow.indexOf("    runs-on:", jobStart);
  assert.ok(
    jobStart >= 0 && runsOn > jobStart,
    "pr-title job preamble is missing",
  );
  const jobContract = workflow.slice(jobStart, runsOn);
  assert.match(
    jobContract,
    /Always honor the caller-selected runner,[\s\S]*?failed, skipped,[\s\S]*?cancelled, or empty prerequisite result[\s\S]*?caller owns any recovery[\s\S]*?public `ubuntu-24\.04` default[\s\S]*?caller's `if: always\(\)`[\s\S]*?after every prerequisite outcome[\s\S]*?required context[\s\S]*?fails closed before title validation/u,
  );
  assert.doesNotMatch(jobContract, /!cancelled\(\)/u);
});

test("semantic PR preserves caller routing and fails closed after every delivered prerequisite outcome", () => {
  const prerequisiteInput = workflow.match(
    / {6}prerequisite-result:\n([\s\S]*?)(?= {6}[a-z][a-z-]+:\n|\npermissions:)/u,
  );
  assert.ok(prerequisiteInput, "prerequisite-result input is missing");
  assert.match(prerequisiteInput[1], / {8}type: string\n/u);
  assert.match(prerequisiteInput[1], / {8}default: success\n/u);

  const requiredJob = workflow.slice(workflow.indexOf("  pr-title:\n"));
  assert.match(requiredJob, /^ {4}runs-on: \$\{\{ inputs\.runner \}\}$/mu);
  assert.doesNotMatch(requiredJob, /runs-on:[^\n]*prerequisite-result/u);
  assert.doesNotMatch(requiredJob, /Note cancelled prerequisite/u);
  assert.match(
    requiredJob,
    /- name: Reject failed prerequisite\n\s+if: \$\{\{ inputs\.prerequisite-result != 'success' \}\}[\s\S]*?PREREQUISITE_RESULT: \$\{\{ inputs\.prerequisite-result \}\}[\s\S]*?exit 1/u,
  );
  assert.match(
    requiredJob,
    /- name: Validate PR title against Conventional Commits[\s\S]*?if: >-\n\s+inputs\.prerequisite-result == 'success' &&\n\s+\(github\.event_name == 'pull_request' \|\|\n\s+github\.event_name == 'pull_request_target'\)/u,
  );

  const rejectIndex = requiredJob.indexOf("- name: Reject failed prerequisite");
  const validationIndex = requiredJob.indexOf(
    "- name: Validate PR title against Conventional Commits",
  );
  assert.ok(
    rejectIndex < validationIndex,
    "prerequisite rejection must precede title validation",
  );

  const runnerFor = (_result, selectedRunner = "ubuntu-24.04") =>
    selectedRunner;
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    assert.equal(
      runnerFor(result, "melodic-ubuntu-24.04-x64"),
      "melodic-ubuntu-24.04-x64",
    );
  }
  assert.equal(runnerFor("failure"), "ubuntu-24.04");

  // A delivered cancellation is not proof of a successor run, so every
  // non-success value remains fail-closed.
  const dispatch = (result) => {
    if (result !== "success") return "fail";
    return "validate";
  };
  assert.equal(dispatch("success"), "validate");
  assert.equal(dispatch("cancelled"), "fail");
  assert.equal(dispatch("failure"), "fail");
  assert.equal(dispatch("skipped"), "fail");
  assert.equal(dispatch(""), "fail");
});

test("documented selector composition preserves the one required check context", () => {
  assert.match(
    readme,
    /pr-title:\n\s+needs: select-runner\n\s+if: \$\{\{ always\(\) \}\}[\s\S]*?uses: melodic-software\/ci-workflows\/\.github\/workflows\/semantic-pr\.yml@<sha>[\s\S]*?runner: \$\{\{ needs\.select-runner\.outputs\.runner \|\| 'ubuntu-24\.04' \}\}\n\s+prerequisite-result: \$\{\{ needs\.select-runner\.result \}\}/u,
  );
  assert.match(
    readme,
    /uses the caller's resolved\s+`runner` value unchanged for `success`, `failure`, `cancelled`, `skipped`, and\s+empty prerequisite results/u,
  );
  assert.match(
    readme,
    /public fallback shown above and the reusable's omitted-input default both\s+preserve `ubuntu-24\.04`[\s\S]*?private self-hosted-only caller can instead supply\s+its allowlisted managed label/u,
  );
  assert.match(
    readme,
    /recommends `!cancelled\(\)` instead of `always\(\)`[\s\S]*?deliberately trades that for fail-closed reporting/u,
  );
});
