"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const githubRoot = path.join(__dirname, "..");
const workflowsRoot = path.join(githubRoot, "workflows");
const prerequisiteGateContracts = [
  {
    fileName: "semantic-pr.yml",
    jobId: "pr-title",
    validationStep: "Validate PR title against Conventional Commits",
  },
  {
    fileName: "do-not-merge-gate.yml",
    jobId: "do-not-merge",
    validationStep: "Reject a blocking label",
  },
  {
    fileName: "pr-issue-linkage.yml",
    jobId: "pr-issue-linkage",
    validationStep:
      "Validate PR body against the closing-keyword + Related convention",
  },
];

function yamlFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return yamlFiles(entryPath);
      }
      return /\.ya?ml$/u.test(entry.name) ? [entryPath] : [];
    })
    .sort();
}

test("hosted workflow contracts use explicit GA operating-system labels", () => {
  const movingLabels = /\b(?:ubuntu|windows)-latest\b/u;
  for (const file of yamlFiles(githubRoot)) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      movingLabels,
      `${path.relative(githubRoot, file)} uses a moving hosted image label`,
    );
  }
});

test("Windows Pester remains on its fixed hosted runner", () => {
  const source = fs.readFileSync(
    path.join(workflowsRoot, "pester.yml"),
    "utf8",
  );
  assert.match(source, /^ {4}runs-on: windows-2025$/mu);
  assert.doesNotMatch(source, /\brunner-os\b/u);
  assert.doesNotMatch(source, /runs-on: \$\{\{/u);
});

test("prerequisite-gated reusables preserve caller routing and fail closed", () => {
  const runnerFor = (_result, selectedRunner = "ubuntu-24.04") =>
    selectedRunner;
  const mustReject = (result) => result !== "success";

  for (const contract of prerequisiteGateContracts) {
    const source = fs.readFileSync(
      path.join(workflowsRoot, contract.fileName),
      "utf8",
    );
    const runnerInput = source.match(
      / {6}runner:\n([\s\S]*?)(?= {6}prerequisite-result:\n)/u,
    );
    assert.ok(runnerInput, `${contract.fileName} runner input is missing`);
    assert.match(runnerInput[1], /^ {8}type: string$/mu);
    assert.match(runnerInput[1], /^ {8}default: ubuntu-24\.04$/mu);

    const jobStart = source.indexOf(`  ${contract.jobId}:\n`);
    assert.ok(jobStart >= 0, `${contract.fileName} required job is missing`);
    const requiredJob = source.slice(jobStart);
    assert.match(requiredJob, /^ {4}runs-on: \$\{\{ inputs\.runner \}\}$/mu);
    assert.doesNotMatch(requiredJob, /runs-on:[^\n]*prerequisite-result/u);

    const rejectIndex = requiredJob.indexOf(
      "- name: Reject failed prerequisite",
    );
    const validationIndex = requiredJob.indexOf(
      `- name: ${contract.validationStep}`,
    );
    assert.ok(
      rejectIndex >= 0 && validationIndex > rejectIndex,
      `${contract.fileName} must reject the prerequisite before validation`,
    );
    const rejectStep = requiredJob.slice(rejectIndex, validationIndex);
    assert.match(
      rejectStep,
      /if: \$\{\{ inputs\.prerequisite-result != 'success' \}\}/u,
    );
    assert.match(
      rejectStep,
      /PREREQUISITE_RESULT: \$\{\{ inputs\.prerequisite-result \}\}/u,
    );
    assert.match(rejectStep, /exit 1/u);

    for (const result of ["failure", "cancelled", "skipped", ""]) {
      assert.equal(
        runnerFor(result, "melodic-ubuntu-24.04-x64"),
        "melodic-ubuntu-24.04-x64",
        `${contract.fileName} rewrote the runner for '${result}'`,
      );
      assert.equal(
        mustReject(result),
        true,
        `${contract.fileName} accepted prerequisite '${result}'`,
      );
    }
    assert.equal(runnerFor("failure"), "ubuntu-24.04");
    assert.equal(mustReject("success"), false);
  }
});

test("reusable workflows never recommend broad secret inheritance", () => {
  for (const file of yamlFiles(workflowsRoot)) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /\bsecrets:\s*inherit\b/u,
      `${path.relative(workflowsRoot, file)} recommends broad secret inheritance`,
    );
  }
});
