"use strict";

// A consumer that must decide whether a security review actually happened has
// two places to look: what this lane DECLARES, or what its job log happened to
// print. Only one of those is a contract. claude-code-plugins#2517 is what the
// other one costs — its guard grepped the log for the phrases that name a
// validation skip, and matched the inline github-script SOURCE that mentions
// them, reddening every successful in-scope pull request it exists to approve.
//
// These tests pin the declared surface so it cannot quietly drift back out of
// existence: the `workflow_call.outputs` block, the job-level block that feeds
// it, and the agreement between both and the composite that owns the
// classification. The composite's own corpus lives in
// .github/actions/claude-lane-outcome/classify.test.cjs; what this file owns is
// the wiring that carries its verdict to the caller.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const workflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "claude-security-review.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");
const compositePath = path.join(
  repositoryRoot,
  ".github",
  "actions",
  "claude-lane-outcome",
  "action.yml",
);
const composite = fs.readFileSync(compositePath, "utf8");

// `on.workflow_call.outputs` and a job's `outputs` sit at the same indentation,
// so position is what tells them apart: everything before the top-level `jobs:`
// key is the call surface, everything after it is job bodies.
const jobsStart = workflow.indexOf("\njobs:\n");
assert.notEqual(jobsStart, -1, "the workflow has no top-level jobs: key");
const callSurface = workflow.slice(0, jobsStart);
const jobBodies = workflow.slice(jobsStart);

// Returns the body of a block introduced by `key` at `indent` spaces: every
// following line until one that is non-blank and indented no deeper.
function blockBody(source, indent, key) {
  const marker = `\n${" ".repeat(indent)}${key}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `block not found: ${key} at indent ${indent}`);
  const lines = source.slice(start + marker.length).split("\n");
  const end = lines.findIndex(
    (line) => line !== "" && !line.startsWith(" ".repeat(indent + 1)),
  );
  return (end === -1 ? lines : lines.slice(0, end)).join("\n");
}

function jobBody(jobId) {
  return blockBody(jobBodies, 2, jobId);
}

// Names declared at `indent`, ignoring comment lines at that same depth.
function declaredKeys(body, indent) {
  const pattern = new RegExp(`^${" ".repeat(indent)}([a-z][a-z0-9-]*):`, "gmu");
  return [...body.matchAll(pattern)].map((match) => match[1]);
}

const callOutputs = blockBody(callSurface, 4, "outputs");
const securityReviewJob = jobBody("security-review");
const jobOutputs = blockBody(securityReviewJob, 4, "outputs");

test("the caller can read the lane's verdict without reading its log", () => {
  assert.deepEqual(declaredKeys(callOutputs, 6), [
    "relevant",
    "review-ran",
    "review-failed",
    "failure-class",
  ]);
});

test("each declared output is wired to the job that computes it", () => {
  const wiring = Object.fromEntries(
    [...callOutputs.matchAll(/^ {6}([a-z-]+):$[\s\S]*?^ {8}value: (.+)$/gmu)].map(
      (match) => [match[1], match[2].trim()],
    ),
  );
  assert.equal(wiring.relevant, "${{ jobs.changes.outputs.relevant }}");
  for (const name of ["review-ran", "review-failed", "failure-class"]) {
    assert.equal(
      wiring[name],
      `\${{ jobs.security-review.outputs.${name} }}`,
      `${name} must read the security-review job, not a step or a literal`,
    );
  }
});

test("the security-review job forwards the composite's verdict verbatim", () => {
  const forwarded = Object.fromEntries(
    [...jobOutputs.matchAll(/^ {6}([a-z-]+): (.+)$/gmu)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
  assert.deepEqual(Object.keys(forwarded), [
    "review-ran",
    "review-failed",
    "failure-class",
  ]);
  for (const [name, value] of Object.entries(forwarded)) {
    assert.equal(
      value,
      `\${{ steps.review-outcome.outputs.${name} }}`,
      `${name} must come from the outcome composite, which owns the classification`,
    );
  }
});

test("the forwarded names are the composite's own, so a rename cannot silently empty them", () => {
  const compositeOutputs = declaredKeys(blockBody(`\n${composite}`, 0, "outputs"), 2);
  for (const name of ["review-ran", "review-failed", "failure-class"]) {
    assert.ok(
      compositeOutputs.includes(name),
      `claude-lane-outcome no longer declares ${name}; the workflow output would resolve to empty`,
    );
  }
});

test("review-detail stays unsurfaced", () => {
  // Free-text prose shaped for a human reading a marker comment. Surfacing it
  // invites a consumer to branch on it, which is the log-grepping this whole
  // surface exists to replace.
  assert.doesNotMatch(callOutputs, /review-detail/u);
  assert.doesNotMatch(jobOutputs, /review-detail/u);
});

test("the step the job forwards from is the outcome composite", () => {
  const step = securityReviewJob.slice(
    securityReviewJob.indexOf("      - name: Report review outcome\n"),
  );
  assert.match(step, /^ {8}id: review-outcome$/mu);
  assert.match(
    step,
    /^ {8}uses: melodic-software\/ci-workflows\/\.github\/actions\/claude-lane-outcome@[0-9a-f]{40} #/mu,
  );
});
