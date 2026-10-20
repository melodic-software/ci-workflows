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

const installScript = (file) => {
  const workflow = parseWorkflow(
    fs.readFileSync(path.join(workflowsDir, file), "utf8"),
  );
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const matches = steps.filter((step) => step.name === stepName);
  assert.equal(matches.length, 1, `${file} has one "${stepName}" step`);
  assert.equal(typeof matches[0].run, "string", file);
  return matches[0].run;
};

test("both lanes run the same subprocess isolation install script", () => {
  assert.equal(
    installScript("pr-review.yml"),
    installScript("pr-review-security.yml"),
  );
});
