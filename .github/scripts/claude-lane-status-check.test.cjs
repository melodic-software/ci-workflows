"use strict";

// Each Claude lane is one job that reviews and reports. The job carries the
// status-check name consumers read (`<caller job> / claude-review-status`),
// and its last step goes red whenever no review happened and names the cause,
// so a green check always means a review ran or was not needed. These tests
// pin the wiring (values reach the script through env) and run the step's own
// script for every cause.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsRoot = path.join(__dirname, "..", "workflows");

const lanes = [
  { file: "claude-review.yml", job: "review", name: "claude-review-status" },
  {
    file: "claude-security-review.yml",
    job: "security-review",
    name: "claude-security-review-status",
  },
];

function load(file) {
  return parseWorkflow(fs.readFileSync(path.join(workflowsRoot, file), "utf8"));
}

function runStep(step, env) {
  const summary = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "status-")),
    "summary",
  );
  fs.writeFileSync(summary, "");
  const result = spawnSync("bash", ["-e", "-c", step.run], {
    // step.env holds unexpanded expressions; only the literal LANE is real.
    env: {
      PATH: process.env.PATH,
      LANE: step.env.LANE,
      JOB_STATUS: "failure",
      SKIP_REASON: "",
      ...env,
      GITHUB_STEP_SUMMARY: summary,
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    summary: fs.readFileSync(summary, "utf8"),
  };
}

for (const lane of lanes) {
  const workflow = load(lane.file);
  const job = workflow.jobs[lane.job];
  const step = job.steps.at(-1);

  test(`${lane.file}: one job reviews and reports under the status-check name`, () => {
    assert.deepEqual(Object.keys(workflow.jobs), [lane.job]);
    assert.equal(job.name, lane.name);
    assert.equal(step.name, "Report the review status");
    assert.equal(step.if, "always()");
    assert.equal(workflow.on.workflow_call.inputs["status-check"], undefined);
  });

  test(`${lane.file}: the review step survives a failed attempt and the job forwards the verdict`, () => {
    const claudeStep = job.steps.find((candidate) =>
      String(candidate.uses ?? "").startsWith("anthropics/claude-code-action@"),
    );
    assert.equal(claudeStep["continue-on-error"], true);
    assert.ok(claudeStep["timeout-minutes"] > 0);
    for (const name of ["review-failed", "failure-class"]) {
      assert.equal(
        job.outputs[name],
        `\${{ steps.review-outcome.outputs.${name} }}`,
      );
    }
  });

  test(`${lane.file}: the verdict reaches the script through env, never inline`, () => {
    assert.equal(step.env.JOB_STATUS, `\${{ job.status }}`);
    assert.equal(
      step.env.SKIP_REASON,
      `\${{ steps.scope.outputs.skip-reason }}`,
    );
    assert.equal(
      step.env.REVIEW_FAILED,
      `\${{ steps.review-outcome.outputs.review-failed }}`,
    );
    assert.equal(
      step.env.FAILURE_CLASS,
      `\${{ steps.review-outcome.outputs.failure-class }}`,
    );
    assert.doesNotMatch(step.run, /\$\{\{/u);
  });

  test(`${lane.file}: a review that ran stays green`, () => {
    const result = runStep(step, { REVIEW_FAILED: "false", FAILURE_CLASS: "" });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.summary, /failed:/u);
  });

  test(`${lane.file}: a review that was not needed stays green and says why`, () => {
    const result = runStep(step, {
      SKIP_REASON: "every file in scope matches docs-only-paths",
      REVIEW_FAILED: "",
      FAILURE_CLASS: "",
    });
    assert.equal(result.status, 0);
    assert.match(result.summary, /no review needed: every file in scope/u);
  });

  test(`${lane.file}: every way no review happened goes red and is named`, () => {
    for (const [failed, klass, named] of [
      ["true", "auth", "auth"],
      ["true", "rate-limit", "rate-limit"],
      ["true", "overloaded", "overloaded"],
      ["true", "other", "other"],
      ["true", "", "unknown"],
      // The action skipped itself: green step, nothing reviewed.
      ["false", "skipped-validation", "skipped-validation"],
      // The job ended before the outcome step wrote any output.
      ["", "", "no-outcome"],
    ]) {
      const result = runStep(step, {
        REVIEW_FAILED: failed,
        FAILURE_CLASS: klass,
      });
      assert.equal(
        result.status,
        1,
        `'${failed}'/'${klass}' must fail the check`,
      );
      assert.match(result.summary, new RegExp(`failed: \`${named}\``, "u"));
      assert.match(
        result.stdout,
        new RegExp(`^::error .*failure-class=${named}:`, "mu"),
      );
    }
  });
}
