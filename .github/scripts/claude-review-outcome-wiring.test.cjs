"use strict";

// The review lanes consume the claude-lane-outcome composite through a
// SHA-pinned `uses:`, so the composite's checked-in source and the version a
// lane actually runs can diverge, and a lane reading a not-yet-pinned output
// gets an empty value on every run. These tests pin the rule that every
// consumed output of the composite is one its source declares, checked
// against each lane's own pinned revision when the object is reachable, and
// against the working tree always.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");

const COMPOSITE_PATH = ".github/actions/claude-lane-outcome/action.yml";

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
        .includes("/.github/actions/claude-lane-outcome@"),
  )
  .sort();

test("lane discovery finds the outcome composite's consumers", () => {
  assert.ok(
    LANES.length >= 2,
    `expected at least the review and security lanes, found: ${LANES.join(", ")}`,
  );
  assert.ok(
    LANES.includes("claude-review.yml") &&
      LANES.includes("claude-security-review.yml"),
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

  test(`${lane}: every consumed outcome output is declared at the pinned revision, when reachable`, (t) => {
    // The tree check above cannot see the one divergence that matters: a tree
    // that declares an output the PINNED revision predates. Reading the
    // composite at the pin closes that hole — but only where the pinned
    // object exists locally (a shallow CI checkout does not carry history),
    // so an unreachable pin skips rather than fails: this half is a
    // local/deep-clone guard, and the tree check above is the floor that
    // always runs.
    const pin = workflow.match(
      /uses: melodic-software\/ci-workflows\/\.github\/actions\/claude-lane-outcome@([0-9a-f]{40})/u,
    );
    assert.ok(pin, "the outcome composite must be SHA-pinned");
    let pinnedYaml;
    try {
      pinnedYaml = execFileSync(
        "git",
        ["-C", repositoryRoot, "show", `${pin[1]}:${COMPOSITE_PATH}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      t.skip(`pinned revision ${pin[1]} is not reachable in this clone`);
      return;
    }
    const declared = declaredOutputs(pinnedYaml);
    for (const name of consumed) {
      assert.ok(
        declared.has(name),
        `${lane} reads steps.review-outcome.outputs.${name}, which the composite at pinned ${pin[1]} does not declare — repoint the pin and the gates in the same commit`,
      );
    }
  });
}
