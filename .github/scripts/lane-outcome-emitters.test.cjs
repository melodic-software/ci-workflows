"use strict";

// Every ci-workflows lane must emit the lane-outcome record (see
// docs/lane-outcome.md): a job that runs Claude has, in the same job, a
// report-lane-outcome step that sets both `credential` and `lane-id`.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsDir = path.join(__dirname, "..", "workflows");
const fixturesDir = path.join(__dirname, "fixtures", "lane-outcome-emitters");

const RUNS_CLAUDE =
  /(?:^|\/)anthropics\/claude-code-action@[^@]+$|(?:^|\/)\.github\/actions\/run-claude-cli(?:@[^@]*)?$/u;
const REPORTS_OUTCOME =
  /(?:^|\/)\.github\/actions\/report-lane-outcome(?:@[^@]*)?$/u;

const isNonEmpty = (value) => typeof value === "string" && value.trim() !== "";

/**
 * Find the lane jobs of a parsed workflow and what each is missing.
 *
 * @returns {{ job: string, step?: string, missing: string[] }[]} one entry per
 *   lane job with no report-lane-outcome step (`missing` is
 *   ["report-lane-outcome step"]) and one per report step, named by id or name,
 *   that leaves `credential` or `lane-id` empty.
 */
function findMissingEmitters(workflow) {
  const failures = [];
  for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
    const steps = Array.isArray(definition?.steps) ? definition.steps : [];
    if (!steps.some((step) => RUNS_CLAUDE.test(String(step?.uses ?? "")))) {
      continue;
    }
    const reports = steps.filter((step) =>
      REPORTS_OUTCOME.test(String(step?.uses ?? "")),
    );
    if (reports.length === 0) {
      failures.push({ job, missing: ["report-lane-outcome step"] });
    }
    reports.forEach((step, index) => {
      const missing = ["credential", "lane-id"].filter(
        (input) => !isNonEmpty(step.with?.[input]),
      );
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
  const files = fs
    .readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml"))
    .sort();
  assert.notEqual(files.length, 0);
  const failures = files.flatMap((name) =>
    findMissingEmitters(parseFile(path.join(workflowsDir, name))).map(
      ({ job, step, missing }) =>
        `${name} job ${job}${step ? ` step ${step}` : ""} is missing: ${missing.join(", ")}`,
    ),
  );
  assert.deepEqual(failures, []);
});

test("the check detects the known lanes in the real workflows", () => {
  const lanes = [];
  for (const name of fs.readdirSync(workflowsDir).sort()) {
    if (!name.endsWith(".yml")) continue;
    const workflow = parseFile(path.join(workflowsDir, name));
    for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
      if (
        (definition?.steps ?? []).some((s) =>
          RUNS_CLAUDE.test(String(s?.uses ?? "")),
        )
      ) {
        lanes.push(`${name}:${job}`);
      }
    }
  }
  for (const lane of [
    "intake-triage.yml:claude",
    "intake-triage.yml:subscription",
    "pr-review-security.yml:claude",
    "pr-review.yml:claude",
  ]) {
    assert.ok(lanes.includes(lane), `${lane} not detected as a lane`);
  }
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
