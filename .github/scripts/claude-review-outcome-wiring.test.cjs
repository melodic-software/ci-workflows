"use strict";

// The review lanes reach the report-lane-outcome composite through `$/`, so a
// lane runs the composite from its own commit, and a lane reading an output
// the composite does not declare gets an empty value on every run. These
// tests pin the rule that every consumed output of the composite is one its
// source in the same tree declares.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");

const COMPOSITE_PATH = ".github/actions/report-lane-outcome/action.yml";

// Every lane workflow that invokes the outcome composite, discovered by
// scanning the workflows directory for its `uses:` reference — a new consumer
// is covered the moment it exists, rather than joining a hand-kept list.
const workflowsDir = path.join(repositoryRoot, ".github", "workflows");
const LANES = fs
  .readdirSync(workflowsDir)
  .filter(
    (name) =>
      name.endsWith(".yml") &&
      fs
        .readFileSync(path.join(workflowsDir, name), "utf8")
        .includes("uses: $/.github/actions/report-lane-outcome"),
  )
  .sort();

test("lane discovery finds the outcome composite's consumers", () => {
  assert.ok(
    LANES.length >= 2,
    `expected at least the review and security lanes, found: ${LANES.join(", ")}`,
  );
  assert.ok(
    LANES.includes("pr-review.yml") && LANES.includes("pr-review-security.yml"),
    `known consumers missing from discovery: ${LANES.join(", ")}`,
  );
});

// Reads through `workflowsDir`, the same directory discovery scanned, so a
// lane can never be discovered in one place and read from another.
const laneSource = (lane) =>
  fs.readFileSync(path.join(workflowsDir, lane), "utf8");

// Every output name the composite's action.yml declares. Indentation-anchored
// to the `outputs:` block's two-space keys so step ids and input names never
// leak into the set.
function declaredOutputs(actionYaml) {
  const block = actionYaml.slice(
    actionYaml.indexOf("\noutputs:") + 1,
    actionYaml.indexOf("\nruns:"),
  );
  return new Set(
    [...block.matchAll(/^ {2}([\w-]+):/gmu)].map((match) => match[1]),
  );
}

const consumedOutputs = (workflow) =>
  new Set(
    [...workflow.matchAll(/steps\.review-outcome\.outputs\.([\w-]+)/gu)].map(
      (match) => match[1],
    ),
  );

for (const lane of LANES) {
  const workflow = laneSource(lane);
  const consumed = consumedOutputs(workflow);

  test(`${lane}: every consumed outcome output is declared by the composite's source`, () => {
    assert.ok(consumed.size > 0, "the lane must consume outcome outputs");
    const declared = declaredOutputs(
      fs.readFileSync(path.join(repositoryRoot, COMPOSITE_PATH), "utf8"),
    );
    for (const name of consumed) {
      assert.ok(
        declared.has(name),
        `${lane} reads steps.review-outcome.outputs.${name}, which ${COMPOSITE_PATH} does not declare`,
      );
    }
  });
}
