"use strict";

// Both Claude lanes conclude green on an infrastructure failure by design, so
// each carries a status job that runs whenever the review job was not skipped,
// goes red whenever no review happened, and names the cause. These tests pin
// the wiring (reads the job result and outputs through env) and run the job's
// own script for every cause, so a green check always means a review ran.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsRoot = path.join(__dirname, "..", "workflows");

const lanes = [
  { file: "claude-review.yml", job: "claude-review-status", needs: "review" },
  {
    file: "claude-security-review.yml",
    job: "claude-security-review-status",
    needs: "security-review",
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
    env: {
      PATH: process.env.PATH,
      ...step.env,
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
  const [step] = job.steps;

  test(`${lane.file}: ${lane.job} runs after the review unless the review was skipped`, () => {
    assert.equal(job.needs, lane.needs);
    assert.equal(job.if, `always() && needs.${lane.needs}.result != 'skipped'`);
    assert.equal(workflow.on.workflow_call.inputs["status-check"], undefined);
    assert.deepEqual(job.permissions, {});
    assert.equal(job.steps.length, 1);
  });

  test(`${lane.file}: the review job survives a failed attempt and forwards the verdict`, () => {
    const reviewJob = workflow.jobs[lane.needs];
    const claudeStep = reviewJob.steps.find((candidate) =>
      String(candidate.uses ?? "").startsWith("anthropics/claude-code-action@"),
    );
    assert.equal(claudeStep["continue-on-error"], true);
    assert.ok(claudeStep["timeout-minutes"] > 0);
    for (const name of ["review-failed", "failure-class"]) {
      assert.equal(
        reviewJob.outputs[name],
        `\${{ steps.review-outcome.outputs.${name} }}`,
      );
    }
  });

  test(`${lane.file}: the verdict reaches the script through env, never inline`, () => {
    assert.equal(step.env.REVIEW_RESULT, `\${{ needs.${lane.needs}.result }}`);
    assert.equal(
      step.env.REVIEW_FAILED,
      `\${{ needs.${lane.needs}.outputs.review-failed }}`,
    );
    assert.equal(
      step.env.FAILURE_CLASS,
      `\${{ needs.${lane.needs}.outputs.failure-class }}`,
    );
    assert.doesNotMatch(step.run, /\$\{\{/u);
  });

  test(`${lane.file}: a review that ran stays green`, () => {
    const result = runStep(step, { REVIEW_FAILED: "false", FAILURE_CLASS: "" });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.summary, /failed:/u);
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
      // The review job ended before the outcome step wrote any output.
      ["", "", "no-outcome"],
    ]) {
      const result = runStep(step, {
        REVIEW_RESULT: "failure",
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
