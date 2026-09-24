"use strict";

// Job-level gates on both review lanes: bot actors, draft PRs and fork PRs
// skip, and privileged triggers still reach the tripwire because the draft
// and fork tests are scoped to pull_request.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsDir = path.join(__dirname, "..", "workflows");

for (const { file, job } of [
  { file: "claude-review.yml", job: "review" },
  { file: "claude-security-review.yml", job: "security-review" },
]) {
  const workflow = parseWorkflow(
    fs.readFileSync(path.join(workflowsDir, file), "utf8"),
  );
  const reviewJob = workflow.jobs[job];

  test(`${file}: ${job} skips every bot actor`, () => {
    assert.match(
      reviewJob.if,
      /^\$\{\{ !endsWith\(github\.actor, '\[bot\]'\)/u,
    );
    assert.doesNotMatch(reviewJob.if, /author_association|skip-actors/u);
    assert.equal(workflow.on.workflow_call.inputs["skip-actors"], undefined);
    assert.equal(workflow.on.workflow_call.inputs["allowed-bots"], undefined);
  });

  test(`${file}: ${job} skips draft and fork PRs, scoped to pull_request`, () => {
    assert.match(
      reviewJob.if,
      /\(github\.event_name != 'pull_request'\s+\|\| github\.event\.pull_request\.draft == false\)/u,
    );
    assert.match(
      reviewJob.if,
      /\(github\.event_name != 'pull_request'\s+\|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository\)/u,
    );
  });

  test(`${file}: the privileged-trigger tripwire is the first step`, () => {
    const [reject] = reviewJob.steps;
    assert.equal(reject.name, "Reject privileged triggers");
    assert.equal(
      reject.if,
      "github.event_name == 'pull_request_target' || github.event_name == 'workflow_run'",
    );
    assert.match(reject.run, /exit 1/u);
  });
}
