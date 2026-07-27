"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// GitHub orders a concurrency group by when jobs start waiting on it, not by
// event time, and callers gate the review job behind a runner-selector job
// with variable queue delay. A shared per-PR cancellable group therefore lets
// a delayed older run cancel a newer head's in-progress review. These tests
// pin the two halves of the defense: runs for different heads never share a
// group, and a superseded run retires itself against the live PR head instead
// of relying on being cancelled.

const workflowSource = fs.readFileSync(
  path.join(__dirname, "..", "workflows", "claude-review.yml"),
  "utf8",
);

test("the review concurrency group is keyed per head, not per PR", () => {
  assert.match(
    workflowSource,
    /^ {6}group: claude-review-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/mu,
  );
  assert.match(workflowSource, /^ {6}cancel-in-progress: true$/mu);
});

test("the superseded-head guard is the pinned freshness composite", () => {
  // The live-head comparison itself lives in the composite; what this
  // workflow owns is invoking it under the `freshness` id at a full-SHA
  // self-reference pin (a local ./ ref would resolve against the caller's
  // checkout in a reusable workflow).
  assert.match(
    workflowSource,
    /id: freshness\s+uses: melodic-software\/ci-workflows\/\.github\/actions\/claude-lane-freshness@[0-9a-f]{40}/u,
  );
});

test("every runner-consuming step gates on the guard's superseded output", () => {
  // The review-count gate, checkout, the three standards-mount steps,
  // argument composition, the review itself, the retry gate, the
  // attempt-resolve step, and outcome reporting (which transitively gates
  // both marker-comment steps and the count upsert). The backoff and retry
  // attempt key on the retry gate's output instead, so the gate carries the
  // guard for all three. A new runner-consuming or PR-writing step must join
  // this set deliberately.
  const gates = [
    ...workflowSource.matchAll(
      /steps\.freshness\.outputs\.superseded != 'true'/gu,
    ),
  ].length;
  assert.equal(gates, 10);
});

test("every review-producing step also gates on the review-count cap", () => {
  // Same set minus the review-count gate itself (the producer) — a capped
  // run must be a name-stable skip: no checkout, no mount, no review, no
  // retry, no outcome (which would misreport the deliberate skip as an
  // infra failure).
  const gates = [
    ...workflowSource.matchAll(
      /steps\.review-count\.outputs\.capped != 'true'/gu,
    ),
  ].length;
  assert.equal(gates, 9);
});
