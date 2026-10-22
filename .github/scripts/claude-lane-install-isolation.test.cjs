"use strict";

// Both Claude lanes install bubblewrap with their own copy of the same step.
// The copies must not drift: a fix to one that misses the other leaves one
// lane without the isolation the other has.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsDir = path.join(__dirname, "..", "workflows");
const stepName = "Install subprocess isolation";

const installStep = (file) => {
  const workflow = parseWorkflow(
    fs.readFileSync(path.join(workflowsDir, file), "utf8"),
  );
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const matches = steps.filter((step) => step.name === stepName);
  assert.equal(matches.length, 1, `${file} has one "${stepName}" step`);
  assert.equal(typeof matches[0].run, "string", file);
  return matches[0];
};

test("both lanes run the same subprocess isolation install script", () => {
  assert.equal(
    installStep("pr-review.yml").run,
    installStep("pr-review-security.yml").run,
  );
});

// A slow mirror once held one unbounded apt-get attempt past the step limit,
// so the lane timed out instead of failing with a named cause.
test("every apt-get call ends before the step limit", () => {
  const step = installStep("pr-review-security.yml");
  const script = step.run;
  const unbounded = script
    .split("\n")
    .filter((line) => /\bsudo\b.*\bapt-get\b/.test(line))
    .filter((line) => !/\bsudo timeout -k \d+ "\$left" apt-get\b/.test(line));
  assert.deepEqual(unbounded, [], "apt-get runs only under the deadline");
  const deadline = Number(/deadline=\$\(\(SECONDS \+ (\d+)\)\)/.exec(script)?.[1]);
  const kill = Number(/timeout -k (\d+)/.exec(script)?.[1]);
  assert.ok(deadline + kill < step["timeout-minutes"] * 60, "deadline fits");
});
