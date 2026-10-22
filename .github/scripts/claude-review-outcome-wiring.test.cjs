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

const { evaluate } = require("./actions-expression.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

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

// The review lanes name their credential: the caller supplies the secret
// name per slot, and the report names the slot that ran, never the
// lower-case slot itself.
// Every discovered lane with the review fallback slot is a review lane; its
// lane id is its file name.
const REVIEW_LANES = LANES.filter(
  (lane) =>
    parseWorkflow(laneSource(lane)).on.workflow_call.secrets?.[
      "fallback-claude-code-oauth-token"
    ] !== undefined,
);

test("review-lane discovery finds both review lanes", () => {
  assert.deepEqual(REVIEW_LANES, ["pr-review-security.yml", "pr-review.yml"]);
});

for (const lane of REVIEW_LANES) {
  const laneId = lane.replace(/\.yml$/u, "");
  const workflow = parseWorkflow(laneSource(lane));
  const inputs = workflow.on.workflow_call.inputs;
  const steps = workflow.jobs.claude.steps;
  const byId = (id) => steps.find((step) => step.id === id);

  test(`${lane}: the caller names the primary and fallback secrets; the primary defaults to the one callers map`, () => {
    assert.equal(inputs["credential-name"].type, "string");
    assert.equal(inputs["credential-name"].default, "CLAUDE_CODE_OAUTH_TOKEN");
    assert.equal(inputs["fallback-credential-name"].type, "string");
    assert.equal(inputs["fallback-credential-name"].default, "");
  });

  test(`${lane}: the outcome report names the secret of the attempt that counts, and its lane id`, () => {
    const outcome = byId("review-outcome");
    assert.equal(outcome.with["lane-id"], laneId);
    const credential = (account, names) =>
      evaluate(outcome.with.credential, {
        steps: { attempt: { outputs: { account } } },
        inputs: names,
      }) || "";
    const names = {
      "credential-name": "CLAUDE_CODE_OAUTH_TOKEN",
      "fallback-credential-name": "REVIEW_FALLBACK_CLAUDE_CODE_OAUTH_TOKEN",
    };
    assert.equal(credential("primary", names), "CLAUDE_CODE_OAUTH_TOKEN");
    assert.equal(
      credential("fallback", names),
      "REVIEW_FALLBACK_CLAUDE_CODE_OAUTH_TOKEN",
    );
    // A fallback with no name is never reported as the primary's secret.
    assert.equal(
      credential("fallback", { ...names, "fallback-credential-name": "" }),
      "",
    );
    assert.equal(
      credential("primary", { ...names, "credential-name": "" }),
      "",
    );
    assert.doesNotMatch(
      outcome.with.credential,
      /fallback-claude-code-oauth-token/u,
    );
  });

  test(`${lane}: when the fallback ran, the first attempt writes its own usage-limit record as a handoff`, () => {
    const first = byId("first-attempt-outcome");
    assert.equal(first.uses, "$/.github/actions/report-lane-outcome");
    const runs = (rateLimit, run) =>
      Boolean(
        evaluate(first.if, {
          steps: {
            "first-outcome": { outputs: { "rate-limit": rateLimit } },
            fallback: { outputs: { run } },
          },
        }),
      );
    assert.equal(runs("true", "true"), true);
    // No fallback attempt: the outcome report covers the first attempt.
    assert.equal(runs("true", ""), false);
    assert.equal(runs("false", ""), false);
    assert.equal(first.with.outcome, `\${{ steps.claude-review.outcome }}`);
    assert.equal(
      first.with["execution-file"],
      `\${{ steps.claude-review.outputs.execution_file }}`,
    );
    assert.equal(first.with["lane-id"], laneId);
    assert.equal(first.with.credential, `\${{ inputs.credential-name }}`);
    assert.equal(first.with.handoff, "true");
    assert.equal(first.with["known-failure-class"], "rate-limit");
    assert.equal(first.with.lane, byId("review-outcome").with.lane);
    assert.ok(steps.indexOf(first) < steps.indexOf(byId("review-outcome")));
  });
}
