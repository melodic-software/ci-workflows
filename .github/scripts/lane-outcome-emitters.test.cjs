"use strict";

// Every ci-workflows lane must emit the lane-outcome record (see
// docs/lane-outcome.md): a job that runs Claude has, in the same job, a
// report-lane-outcome step that sets both `credential` and `lane-id`.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  LANE_ID_PATTERN,
} = require("../actions/report-lane-outcome/classify.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsDir = path.join(__dirname, "..", "workflows");
const fixturesDir = path.join(__dirname, "fixtures", "lane-outcome-emitters");

const workflowFiles = fs
  .readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml"))
  .sort();

const RUNS_CLAUDE =
  /(?:^|\/)anthropics\/claude-code-action@[^@]+$|(?:^|\/)\.github\/actions\/run-claude-cli(?:@[^@]*)?$/u;
const REPORTS_OUTCOME =
  /(?:^|\/)\.github\/actions\/report-lane-outcome(?:@[^@]*)?$/u;

const isNonEmpty = (value) => typeof value === "string" && value.trim() !== "";

/** The [jobId, steps] pairs of a workflow's lane jobs: jobs that run Claude. */
function laneJobs(workflow) {
  return Object.entries(workflow.jobs ?? {})
    .map(([job, definition]) => [
      job,
      Array.isArray(definition?.steps) ? definition.steps : [],
    ])
    .filter(([, steps]) =>
      steps.some((step) => RUNS_CLAUDE.test(String(step?.uses ?? ""))),
    );
}

/** The inputs of a report step that are empty, or a literal lane-id the record rejects. */
function reportGaps(step) {
  const missing = ["credential", "lane-id"].filter(
    (input) => !isNonEmpty(step.with?.[input]),
  );
  const laneId = step.with?.["lane-id"];
  if (
    isNonEmpty(laneId) &&
    !laneId.includes("${{") &&
    !LANE_ID_PATTERN.test(laneId)
  ) {
    missing.push("lane-id (invalid literal)");
  }
  return missing;
}

/**
 * Find the lane jobs of a parsed workflow and what each is missing.
 *
 * @returns {{ job: string, step?: string, missing: string[] }[]} one entry per
 *   lane job with no report-lane-outcome step (`missing` is
 *   ["report-lane-outcome step"]) and one per report step, named by id or name,
 *   that leaves `credential` or `lane-id` empty or sets an invalid literal
 *   `lane-id`.
 */
function findMissingEmitters(workflow) {
  const failures = [];
  for (const [job, steps] of laneJobs(workflow)) {
    const reports = steps.filter((step) =>
      REPORTS_OUTCOME.test(String(step?.uses ?? "")),
    );
    if (reports.length === 0) {
      failures.push({ job, missing: ["report-lane-outcome step"] });
    }
    reports.forEach((step, index) => {
      const missing = reportGaps(step);
      if (missing.length > 0) {
        failures.push({
          job,
          step: step.id ?? step.name ?? `report step ${index + 1}`,
          missing,
        });
      }
    });
  }
  return failures;
}

const parseFile = (file) => parseWorkflow(fs.readFileSync(file, "utf8"));

test("every lane job in .github/workflows emits the lane-outcome record", () => {
  assert.notEqual(workflowFiles.length, 0);
  const failures = workflowFiles.flatMap((name) =>
    findMissingEmitters(parseFile(path.join(workflowsDir, name))).map(
      ({ job, step, missing }) =>
        `${name} job ${job}${step ? ` step ${step}` : ""} is missing: ${missing.join(", ")}`,
    ),
  );
  assert.deepEqual(failures, []);
});

test("the check detects exactly the lanes in the real workflows", () => {
  const lanes = workflowFiles.flatMap((name) =>
    laneJobs(parseFile(path.join(workflowsDir, name))).map(
      ([job]) => `${name}:${job}`,
    ),
  );
  // Source: the Claude-running jobs of intake-triage.yml, pr-review-cli.yml, pr-review.yml and pr-review-security.yml.
  assert.deepEqual(lanes.sort(), [
    "intake-triage.yml:claude",
    "intake-triage.yml:fallback",
    "intake-triage.yml:subscription",
    "pr-review-cli.yml:review-fallback",
    "pr-review-cli.yml:review-key",
    "pr-review-cli.yml:review-subscription",
    "pr-review-security.yml:claude",
    "pr-review.yml:claude",
  ]);
});

for (const [fixture, expected] of [
  [
    "missing-call.yml",
    [{ job: "review", missing: ["report-lane-outcome step"] }],
  ],
  [
    "missing-credential.yml",
    [{ job: "review", step: "report", missing: ["credential"] }],
  ],
  [
    "missing-lane-id.yml",
    [{ job: "review", step: "report", missing: ["lane-id"] }],
  ],
  [
    "second-report-missing-lane-id.yml",
    [{ job: "review", step: "second-report", missing: ["lane-id"] }],
  ],
  [
    "run-claude-cli-no-report.yml",
    [{ job: "triage", missing: ["report-lane-outcome step"] }],
  ],
  [
    "invalid-lane-id.yml",
    [{ job: "review", step: "report", missing: ["lane-id (invalid literal)"] }],
  ],
  ["run-claude-cli-passes.yml", []],
  ["secrets-forwarded.yml", []],
]) {
  test(`fixture ${fixture}`, () => {
    assert.deepEqual(
      findMissingEmitters(parseFile(path.join(fixturesDir, fixture))),
      expected,
    );
  });
}
