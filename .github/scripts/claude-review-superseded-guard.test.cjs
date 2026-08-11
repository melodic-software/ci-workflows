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

function stepSource(stepName) {
	const start = workflowSource.indexOf(`      - name: ${stepName}\n`);
	assert.notEqual(start, -1, `step not found: ${stepName}`);
	const rest = workflowSource.slice(start + 1);
	const next = rest.indexOf("\n      - name: ");
	return next === -1 ? rest : rest.slice(0, next);
}

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

// Actions cannot loop a `uses:` step, so the retry is a verbatim copy of the
// first attempt. Divergence between the two would mean the retry reviews under
// different rules than the attempt it replaces — asserted, not trusted.
test("the review retry is configured identically to the first attempt", () => {
	// A step's source runs up to the next `- name:`, which drags in that step's
	// leading comment block — trailing blanks and comments are trimmed so the
	// comparison is over inputs only.
	const withBlock = (stepName) => {
		const step = stepSource(stepName);
		const start = step.indexOf("        with:\n");
		assert.notEqual(start, -1, `${stepName} has no with: block`);
		const lines = step.slice(start).split("\n");
		while (
			lines.length > 0 &&
			/^\s*(#.*)?$/u.test(lines[lines.length - 1] ?? "")
		) {
			lines.pop();
		}
		return lines.join("\n");
	};

	assert.equal(
		withBlock("Claude review (retry)"),
		withBlock("Claude review"),
		"the retry's inputs have drifted from the first attempt's",
	);

	const first = stepSource("Claude review");
	const retry = stepSource("Claude review (retry)");
	assert.match(
		retry,
		/^ {8}continue-on-error: true$/mu,
		"the retry must not conclude the job itself; the outcome step owns that",
	);
	assert.match(
		retry,
		/^ {8}if: steps\.retry-gate\.outputs\.retry == 'true'$/mu,
		"the retry must run only when the gate elected to retry",
	);

	// timeout-minutes sits beside `with:`, not inside it — compare explicitly so
	// a step-budget drift cannot slip past the with-block equality above.
	const timeout = /^ {8}timeout-minutes: (.+)$/mu;
	assert.equal(
		retry.match(timeout)?.[1],
		first.match(timeout)?.[1],
		"the retry's timeout-minutes has drifted from the first attempt's",
	);

	// Same pin, or the retry is a different action than the one that was reviewed.
	const pin = /uses: (anthropics\/claude-code-action@[0-9a-f]{40})/u;
	assert.equal(
		retry.match(pin)?.[1],
		first.match(pin)?.[1],
		"the retry must pin the same action SHA as the first attempt",
	);
});

test("track-progress=false is rejected (#343)", () => {
	assert.match(
		workflowSource,
		/^ {6}- name: Reject unsupported track-progress=false$/mu,
	);
	assert.match(workflowSource, /^ {8}if: inputs\.track-progress == false$/mu);
});
