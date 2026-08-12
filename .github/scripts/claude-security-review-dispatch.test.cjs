"use strict";

// Contract for workflow_dispatch security-review re-entry (ci-workflows#227):
// the dogfood caller exposes a PR-number dispatch input, the reusable resolves
// PR/head via API when pull_request context is absent, and checkout / prompts /
// freshness / markers consume that resolved context. Privileged triggers stay
// rejected — dispatch is the mitigation path, not pull_request_target.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const repositoryRoot = path.join(__dirname, "..", "..");
const callerSource = fs.readFileSync(
	path.join(
		repositoryRoot,
		".github",
		"workflows",
		"claude-security-review-self.yml",
	),
	"utf8",
);
const reusableSource = fs.readFileSync(
	path.join(
		repositoryRoot,
		".github",
		"workflows",
		"claude-security-review.yml",
	),
	"utf8",
);
const mitigateSelfSource = fs.readFileSync(
	path.join(
		repositoryRoot,
		".github",
		"workflows",
		"security-review-absent-mitigate-self.yml",
	),
	"utf8",
);
const mitigateReusableSource = fs.readFileSync(
	path.join(
		repositoryRoot,
		".github",
		"workflows",
		"security-review-absent-mitigate.yml",
	),
	"utf8",
);

function stepSource(workflow, stepName) {
	const start = workflow.indexOf(`      - name: ${stepName}\n`);
	assert.notEqual(start, -1, `step not found: ${stepName}`);
	const rest = workflow.slice(start + 1);
	const next = rest.indexOf("\n      - name: ");
	return next === -1 ? rest : rest.slice(0, next);
}

test("security dogfood caller exposes workflow_dispatch with pr-number", () => {
	const caller = parseWorkflow(callerSource);
	assert.ok(caller.on.pull_request, "pull_request trigger must remain");
	assert.deepEqual(caller.on.pull_request.types, [
		"opened",
		"synchronize",
		"ready_for_review",
		"reopened",
	]);
	assert.ok(caller.on.workflow_dispatch, "workflow_dispatch entry required");
	assert.equal(caller.on.workflow_dispatch.inputs["pr-number"].required, true);
	assert.equal(caller.on.workflow_dispatch.inputs["pr-number"].type, "string");
	assert.match(
		callerSource,
		/^ {6}pr-number: \$\{\{ inputs\.pr-number \}\}$/mu,
	);
	assert.match(
		callerSource,
		/group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| inputs\.pr-number \|\| github\.run_id \}\}/u,
	);
});

test("security reusable accepts pr-number and resolves PR context before freshness", () => {
	const reusable = parseWorkflow(reusableSource);
	assert.equal(reusable.on.workflow_call.inputs["pr-number"].default, "");
	assert.match(reusableSource, /^ {6}- name: Resolve PR context$/mu);
	assert.match(reusableSource, /^ {8}id: resolve-pr$/mu);

	const resolveIdx = reusableSource.indexOf(
		"      - name: Resolve PR context\n",
	);
	const freshnessIdx = reusableSource.indexOf(
		"      - name: Check whether this head is still current\n",
	);
	assert.ok(resolveIdx !== -1 && freshnessIdx !== -1);
	assert.ok(
		resolveIdx < freshnessIdx,
		"resolve-pr must run before the freshness guard",
	);

	const resolve = stepSource(reusableSource, "Resolve PR context");
	assert.match(resolve, /PR_NUMBER_INPUT: \$\{\{ inputs\.pr-number \}\}/u);
	assert.match(resolve, /context\.payload\.pull_request/u);
	assert.match(resolve, /github\.rest\.pulls\.get/u);
	assert.match(resolve, /core\.setOutput\("head-sha"/u);
	assert.match(resolve, /ci-workflows#227/u);
});

test("security prompts and checkout consume resolved PR outputs", () => {
	assert.match(
		reusableSource,
		/PR NUMBER: \$\{\{ steps\.resolve-pr\.outputs\.number \}\}/u,
	);
	assert.match(
		reusableSource,
		/HEAD SHA: \$\{\{ steps\.resolve-pr\.outputs\.head-sha \}\}/u,
	);
	const checkout = stepSource(reusableSource, "Check out");
	assert.match(
		checkout,
		/^ {10}ref: \$\{\{ steps\.resolve-pr\.outputs\.head-sha \}\}$/mu,
	);
	const first = stepSource(reusableSource, "Claude security review");
	assert.doesNotMatch(
		first,
		/github\.event\.pull_request\.(number|head\.sha)/u,
	);
	assert.match(
		first,
		/track_progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u,
	);
});

test("security privileged-trigger tripwire still rejects pull_request_target and workflow_run", () => {
	const reject = stepSource(reusableSource, "Reject privileged triggers");
	assert.match(
		reject,
		/if: github\.event_name == 'pull_request_target' \|\| github\.event_name == 'workflow_run'/u,
	);
	assert.doesNotMatch(
		reject,
		/if:.*workflow_dispatch/u,
		"workflow_dispatch must remain allowed (mitigation re-entry)",
	);
});

test("absent-mitigate companion is schedule/dispatch only and never privileged", () => {
	const self = parseWorkflow(mitigateSelfSource);
	assert.ok(self.on.schedule, "schedule trigger required");
	assert.ok(self.on.workflow_dispatch, "workflow_dispatch trigger required");
	assert.equal(self.on.pull_request, undefined);
	assert.equal(self.on.pull_request_target, undefined);
	assert.equal(self.on.workflow_run, undefined);
	const reusable = parseWorkflow(mitigateReusableSource);
	assert.ok(reusable.on.workflow_call);
	assert.equal(reusable.on.pull_request_target, undefined);
	assert.equal(reusable.on.workflow_run, undefined);
	assert.match(mitigateSelfSource, /ci-workflows#227/u);
	assert.match(mitigateReusableSource, /security-review-absent-mitigate\.cjs/u);
	assert.match(mitigateReusableSource, /checks: write/u);
});

test("security marker comments receive pull-number and advertise dispatch", () => {
	const failure = stepSource(
		reusableSource,
		"Comment on genuine review failure",
	);
	const clear = stepSource(
		reusableSource,
		"Clear stale failure comment after successful review",
	);
	for (const step of [failure, clear]) {
		assert.match(
			step,
			/^ {10}pull-number: \$\{\{ steps\.resolve-pr\.outputs\.number \}\}$/mu,
		);
		assert.match(step, /claude-lane-marker-comment@[0-9a-f]{40}/u);
	}
	assert.match(failure, /workflow_dispatch this workflow with the PR number/u);
});

test("security compose grants gh delivery tools on non-pull_request", () => {
	const compose = stepSource(reusableSource, "Compose Claude CLI arguments");
	assert.match(compose, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
	assert.match(compose, /mcp__github_inline_comment__create_inline_comment/u);
	assert.match(compose, /Bash\(gh pr comment:\*\)/u);
	assert.match(compose, /Bash\(gh pr review:\*\)/u);
	assert.match(compose, /\[ "\$EVENT_NAME" = "pull_request" \]/u);
});
