"use strict";

// ci-workflows#619: both Claude lanes conclude green on an infrastructure
// failure by design, so each carries an opt-in status job that goes red and
// names the failure class. These tests pin the wiring (opt-in, default off,
// reads the declared outputs through env) and run the job's own script for
// every class, so the check's colour cannot drift from `review-failed`.

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

  test(`${lane.file}: status-check is an opt-in boolean, default off`, () => {
    const input = workflow.on.workflow_call.inputs["status-check"];
    assert.equal(input.type, "boolean");
    assert.equal(input.default, false);
  });

  test(`${lane.file}: ${lane.job} runs after the review whatever it concluded`, () => {
    assert.equal(job.needs, lane.needs);
    assert.equal(job.if, `\${{ always() && inputs.status-check }}`);
    assert.deepEqual(job.permissions, {});
    assert.equal(job.steps.length, 1);
  });

  test(`${lane.file}: the verdict reaches the script through env, never inline`, () => {
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

  test(`${lane.file}: a success or an absent verdict stays green`, () => {
    for (const [failed, klass] of [
      ["false", ""],
      ["false", "skipped-validation"],
      ["", ""],
    ]) {
      const result = runStep(step, {
        REVIEW_FAILED: failed,
        FAILURE_CLASS: klass,
      });
      assert.equal(
        result.status,
        0,
        `review-failed='${failed}' must not go red`,
      );
      assert.doesNotMatch(result.summary, /failed:/u);
    }
  });

  test(`${lane.file}: every failure class goes red and is named`, () => {
    for (const klass of [
      "auth",
      "rate-limit",
      "overloaded",
      "no-delivery",
      "other",
      "",
    ]) {
      const result = runStep(step, {
        REVIEW_FAILED: "true",
        FAILURE_CLASS: klass,
      });
      assert.equal(result.status, 1, `class '${klass}' must fail the check`);
      assert.match(
        result.summary,
        new RegExp(`failed: \`${klass || "unknown"}\``, "u"),
      );
      assert.match(
        result.stdout,
        new RegExp(`^::error .*failure-class=${klass || "unknown"}:`, "mu"),
      );
    }
  });
}
