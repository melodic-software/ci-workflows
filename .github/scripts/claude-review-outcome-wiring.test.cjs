"use strict";

// The review lane consumes the claude-lane-outcome composite through a
// SHA-pinned `uses:`, so the composite's checked-in source and the version
// the lane actually runs can diverge — exactly the window in which a gate
// reading a not-yet-pinned output evaluates false on every run and silently
// skips the step it guards (the review-count upsert stopped writing for one
// PR window this way). These tests pin the wiring from both ends: the gate
// conditions the lane must carry, and the rule that every consumed output of
// the composite is one its source declares — checked against the pinned
// revision when the object is reachable, and against the working tree always.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const workflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "claude-review.yml"),
  "utf8",
);

const COMPOSITE_PATH = ".github/actions/claude-lane-outcome/action.yml";

function stepSource(stepName) {
  const start = workflow.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(start, -1, `step not found: ${stepName}`);
  const rest = workflow.slice(start + 1);
  const next = rest.indexOf("\n      - name: ");
  return next === -1 ? rest : rest.slice(0, next);
}

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

const consumedOutputs = new Set(
  [...workflow.matchAll(/steps\.review-outcome\.outputs\.([\w-]+)/gu)].map(
    (match) => match[1],
  ),
);

test("the count upsert and stale-comment clear gate on a review that RAN", () => {
  // review-failed == 'false' is also true of a validation skip, which
  // reviewed nothing; only review-ran distinguishes a review that happened.
  for (const stepName of [
    "Update the review-count status comment",
    "Clear stale failure comment after successful review",
  ]) {
    assert.match(
      stepSource(stepName),
      /^ {8}if: "!cancelled\(\) && steps\.review-outcome\.outputs\.review-ran == 'true'"$/mu,
      `'${stepName}' must gate on review-ran, not on not-failed`,
    );
  }
});

test("every consumed outcome output is declared by the composite's source", () => {
  assert.ok(consumedOutputs.size > 0, "the lane must consume outcome outputs");
  const declared = declaredOutputs(
    fs.readFileSync(path.join(repositoryRoot, COMPOSITE_PATH), "utf8"),
  );
  for (const name of consumedOutputs) {
    assert.ok(
      declared.has(name),
      `the lane reads steps.review-outcome.outputs.${name}, which ${COMPOSITE_PATH} does not declare`,
    );
  }
});

test("every consumed outcome output is declared at the pinned revision, when reachable", (t) => {
  // The tree check above cannot see the one divergence that matters: a tree
  // that declares an output the PINNED revision predates. Reading the
  // composite at the pin closes that hole — but only where the pinned object
  // exists locally (a shallow CI checkout does not carry history), so an
  // unreachable pin skips rather than fails: this half is a local/deep-clone
  // guard, and the tree check above is the floor that always runs.
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
  for (const name of consumedOutputs) {
    assert.ok(
      declared.has(name),
      `the lane reads steps.review-outcome.outputs.${name}, which the composite at pinned ${pin[1]} does not declare — repoint the pin and the gates in the same commit`,
    );
  }
});
