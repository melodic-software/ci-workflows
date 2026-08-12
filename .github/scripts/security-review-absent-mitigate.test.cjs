"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	MitigateUsageError,
	filterSecurityReviewContexts,
	pastGracePeriod,
	findAbsentSecurityReview,
	failureCheckPayload,
	parseArgs,
	mitigatePull,
	main,
} = require("./security-review-absent-mitigate.cjs");

function job(
	name,
	{
		conclusion = "success",
		status = "completed",
		at = "2026-07-23T08:00:00Z",
	} = {},
) {
	return {
		id: 1,
		name,
		status,
		conclusion,
		started_at: at,
		completed_at: at,
	};
}

function check(
	name,
	{
		conclusion = "success",
		status = "completed",
		at = "2026-07-23T08:00:00Z",
	} = {},
) {
	return {
		id: 1,
		name,
		status,
		conclusion,
		started_at: at,
		completed_at: at,
	};
}

test("filterSecurityReviewContexts keeps only security-review names", () => {
	const filtered = filterSecurityReviewContexts([
		"pr-title / pr-title",
		"security-review / security-review",
		"ci-status",
		{ context: "gate / security-review", integrationId: 15368 },
	]);
	assert.deepEqual(
		filtered.map((entry) => entry.context),
		["security-review / security-review", "gate / security-review"],
	);
});

test("pastGracePeriod respects the delivery-lag window", () => {
	const opened = "2026-07-23T07:39:05Z";
	const now = Date.parse("2026-07-23T07:50:05Z");
	assert.equal(pastGracePeriod(opened, 15, now), false);
	assert.equal(pastGracePeriod(opened, 10, now), true);
	assert.throws(() => pastGracePeriod("nope", 15, now), MitigateUsageError);
});

test("findAbsentSecurityReview reports missing security contexts only", () => {
	const found = findAbsentSecurityReview({
		requiredContexts: [
			"pr-title / pr-title",
			"security-review / security-review",
			"do-not-merge / do-not-merge",
		],
		checkRuns: [
			check("pr-title / pr-title"),
			check("do-not-merge / do-not-merge"),
		],
		workflowJobs: [
			job("pr-title / pr-title"),
			job("do-not-merge / do-not-merge"),
		],
	});
	assert.equal(found.ok, false);
	assert.equal(found.absent.length, 1);
	assert.equal(found.absent[0].context, "security-review / security-review");
	assert.equal(found.absent[0].verdict, "missing");
});

test("findAbsentSecurityReview is ok when the security check is present", () => {
	const found = findAbsentSecurityReview({
		requiredContexts: ["security-review / security-review"],
		checkRuns: [
			check("security-review / security-review", { conclusion: "skipped" }),
		],
		workflowJobs: [
			job("security-review / security-review", { conclusion: "skipped" }),
		],
	});
	assert.equal(found.ok, true);
	assert.equal(found.absent.length, 0);
});

test("failureCheckPayload names the absent context and points at #227", () => {
	const payload = failureCheckPayload({
		context: "security-review / security-review",
		sha: "a".repeat(40),
		prNumber: 1103,
		detail:
			"required context has neither a workflow job nor a commit check-run on this SHA",
	});
	assert.equal(payload.name, "security-review / security-review");
	assert.equal(payload.conclusion, "failure");
	assert.equal(payload.head_sha, "a".repeat(40));
	assert.match(payload.output.summary, /ci-workflows#227/u);
	assert.match(payload.output.summary, /pull_request_target/u);
	assert.match(payload.output.summary, /workflow_dispatch/u);
});

test("mitigatePull skips drafts, grace, and present checks", () => {
	const base = {
		requiredContexts: ["security-review / security-review"],
		checkRuns: [],
		workflowJobs: [],
		contextPattern: /security-review/iu,
		graceMinutes: 15,
		mode: "report",
		workflow: "Claude Security Review",
		dryRun: true,
		now: Date.parse("2026-07-23T08:00:00Z"),
		repo: "melodic-software/claude-code-plugins",
	};
	assert.equal(
		mitigatePull({
			...base,
			pull: {
				number: 1,
				sha: "a".repeat(40),
				openedAt: "2026-07-23T07:00:00Z",
				baseRef: "main",
				title: "draft",
				draft: true,
			},
		}).skipped,
		"draft",
	);
	assert.equal(
		mitigatePull({
			...base,
			pull: {
				number: 2,
				sha: "b".repeat(40),
				openedAt: "2026-07-23T07:50:00Z",
				baseRef: "main",
				title: "fresh",
				draft: false,
			},
		}).skipped,
		"within-grace",
	);
	assert.equal(
		mitigatePull({
			...base,
			checkRuns: [check("security-review / security-review")],
			workflowJobs: [job("security-review / security-review")],
			pull: {
				number: 3,
				sha: "c".repeat(40),
				openedAt: "2026-07-23T07:00:00Z",
				baseRef: "main",
				title: "present",
				draft: false,
			},
		}).skipped,
		"security-review-present",
	);
});

test("mitigatePull report mode records absent actions without writing", () => {
	const result = mitigatePull({
		repo: "melodic-software/claude-code-plugins",
		pull: {
			number: 1103,
			sha: "67ffa66f9742c6c483698165aa6d8b190d315fb1",
			openedAt: "2026-07-23T07:39:05Z",
			baseRef: "main",
			title: "chore: sync standards components",
			draft: false,
		},
		requiredContexts: ["security-review / security-review"],
		checkRuns: [check("do-not-merge / do-not-merge")],
		workflowJobs: [job("do-not-merge / do-not-merge")],
		contextPattern: /security-review/iu,
		graceMinutes: 15,
		mode: "report",
		workflow: "Claude Security Review",
		dryRun: false,
		now: Date.parse("2026-07-23T21:00:00Z"),
	});
	assert.equal(result.skipped, null);
	assert.equal(result.absentCount, 1);
	assert.equal(result.actions[0].status, "reported");
	assert.equal(result.actions[0].context, "security-review / security-review");
});

test("mitigatePull post-failure-check dry-run builds the Checks payload", () => {
	const result = mitigatePull({
		repo: "melodic-software/claude-code-plugins",
		pull: {
			number: 1103,
			sha: "67ffa66f9742c6c483698165aa6d8b190d315fb1",
			openedAt: "2026-07-23T07:39:05Z",
			baseRef: "main",
			title: "chore: sync",
			draft: false,
		},
		requiredContexts: ["security-review / security-review"],
		checkRuns: [],
		workflowJobs: [],
		contextPattern: /security-review/iu,
		graceMinutes: 15,
		mode: "post-failure-check",
		workflow: "Claude Security Review",
		dryRun: true,
		now: Date.parse("2026-07-23T21:00:00Z"),
	});
	assert.equal(result.actions[0].status, "dry-run");
	assert.equal(result.actions[0].payload.conclusion, "failure");
	assert.equal(
		result.actions[0].payload.name,
		"security-review / security-review",
	);
});

test("parseArgs accepts mode and grace window", () => {
	const options = parseArgs([
		"--repo",
		"melodic-software/ci-workflows",
		"--from-rulesets",
		"--mode",
		"dispatch",
		"--grace-minutes",
		"30",
		"--dry-run",
	]);
	assert.equal(options.mode, "dispatch");
	assert.equal(options.graceMinutes, 30);
	assert.equal(options.dryRun, true);
	assert.equal(options.fromRulesets, true);
});

test("fixture main reports absent security-review and exits 1", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sec-absent-"));
	const pullsPath = path.join(directory, "pulls.json");
	const checksPath = path.join(directory, "checks.json");
	const jobsPath = path.join(directory, "jobs.json");
	const sha = "67ffa66f9742c6c483698165aa6d8b190d315fb1";
	fs.writeFileSync(
		pullsPath,
		JSON.stringify([
			{
				number: 1103,
				created_at: "2026-07-23T07:39:05Z",
				title: "chore: sync",
				draft: false,
				head: { sha },
				base: { ref: "main" },
			},
		]),
	);
	fs.writeFileSync(
		checksPath,
		JSON.stringify([check("do-not-merge / do-not-merge")]),
	);
	fs.writeFileSync(
		jobsPath,
		JSON.stringify([job("do-not-merge / do-not-merge")]),
	);

	const previous = Date.now;
	Date.now = () => Date.parse("2026-07-23T21:00:00Z");
	try {
		const exit = main([
			"--repo",
			"melodic-software/claude-code-plugins",
			"--pulls-json",
			pullsPath,
			"--check-runs-json",
			checksPath,
			"--jobs-json",
			jobsPath,
			"--context",
			"security-review / security-review",
			"--mode",
			"report",
			"--json",
		]);
		assert.equal(exit, 1);
	} finally {
		Date.now = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
