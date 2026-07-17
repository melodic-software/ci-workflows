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

test("the superseded-head guard compares the event head to the live PR head", () => {
  assert.match(
    workflowSource,
    /id: freshness[\s\S]*?gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER" --jq \.head\.sha/u,
  );
});

test("every runner-consuming step gates on the guard's superseded output", () => {
  // Checkout, the three standards-mount steps, argument composition, the
  // review itself, and outcome reporting (which transitively gates both
  // marker-comment steps). A new runner-consuming or PR-writing step must
  // join this set deliberately.
  const gates = [
    ...workflowSource.matchAll(
      /steps\.freshness\.outputs\.superseded != 'true'/gu,
    ),
  ].length;
  assert.equal(gates, 7);
});
