"use strict";

// Each Claude lane is one job that reviews and reports. The job carries the
// check name consumers read (`<caller job> / claude-review-status`, and
// `security-review / security-review`), and its last step goes red whenever
// no review happened and names the cause, so a green check always means a
// review ran or was not needed. These tests pin the wiring (values reach the
// script through env) and run the step's own script for every cause.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsRoot = path.join(__dirname, "..", "workflows");

const lanes = [
  { file: "pr-review.yml", job: "claude", name: "claude-review-status" },
  {
    file: "pr-review-security.yml",
    job: "claude",
    name: "security-review",
  },
];

function load(file) {
  return parseWorkflow(fs.readFileSync(path.join(workflowsRoot, file), "utf8"));
}

function runStep(step, env) {
  const summary = path.join(makeTemporaryDirectory("status-"), "summary");
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
      assert.equal(
        workflow.on.workflow_call.outputs?.[name]?.value,
        `\${{ jobs.${lane.job}.outputs.${name} }}`,
        `${name} must reach the caller through workflow_call`,
      );
    }
  });

  test(`${lane.file}: the outcome step times the attempt that counts against that attempt's own budget`, () => {
    const claudeStep = job.steps.find((candidate) =>
      String(candidate.uses ?? "").startsWith("anthropics/claude-code-action@"),
    );
    const byId = (id) => job.steps.find((candidate) => candidate.id === id);
    const outcome = byId("review-outcome");
    assert.equal(
      outcome.with["step-timeout-minutes"],
      `\${{ steps.attempt.outputs.timeout-minutes }}`,
    );
    assert.equal(
      outcome.with["step-started-at"],
      `\${{ steps.attempt.outputs.started-at }}`,
    );
    const attempt = byId("attempt");
    assert.equal(
      attempt.env.FIRST_TIMEOUT_MINUTES,
      String(claudeStep["timeout-minutes"]),
    );
    assert.equal(
      attempt.env.FIRST_STARTED_AT,
      `\${{ steps.compose-args.outputs.started-at }}`,
    );
    for (const id of ["first-outcome", "fallback"]) {
      assert.equal(
        byId(id).env.BUDGET_MINUTES,
        String(claudeStep["timeout-minutes"]),
        id,
      );
    }
  });

  test(`${lane.file}: a review on the fallback account says so on its record`, () => {
    const ran = (account) =>
      runStep(step, {
        REVIEW_FAILED: "false",
        FAILURE_CLASS: "",
        HEAD_SHA: "a".repeat(40),
        FINDINGS: "2",
        INLINE: "1",
        SCOPE: "whole",
        ACCOUNT: account,
      });
    const record = `claude-lane-review-complete lane=${step.env.LANE} sha=${"a".repeat(40)} findings=2 inline=1 scope=whole`;
    const fallback = ran("fallback");
    assert.equal(fallback.status, 0);
    assert.match(
      fallback.stdout,
      new RegExp(
        `^::notice title=claude-lane-review-complete::${record} account=fallback$`,
        "mu",
      ),
    );
    assert.match(fallback.summary, /fallback account/u);
    for (const account of ["primary", ""]) {
      const first = ran(account);
      assert.match(
        first.stdout,
        new RegExp(
          `^::notice title=claude-lane-review-complete::${record}$`,
          "mu",
        ),
      );
      assert.doesNotMatch(first.summary, /fallback/u);
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

  test(`${lane.file}: a usage limit stays red but reads as a skipped review`, () => {
    const result = runStep(step, {
      REVIEW_FAILED: "true",
      FAILURE_CLASS: "rate-limit",
    });
    const message =
      "AI review skipped: usage limit reached; re-run after it resets";
    assert.equal(result.status, 1);
    assert.match(result.summary, new RegExp(`^### ${message}$`, "mu"));
    assert.doesNotMatch(result.summary, /failed:/u);
    assert.match(
      result.stdout,
      new RegExp(`^::error .*${message}.*failure-class=rate-limit`, "mu"),
    );
  });

  test(`${lane.file}: a failed sandbox probe skips the model and reaches the outcome step as its class`, () => {
    const at = (predicate) => job.steps.findIndex(predicate);
    const probeAt = at((candidate) => candidate.id === "sandbox");
    const probe = job.steps[probeAt];
    assert.equal(probe.uses, "$/.github/actions/check-subprocess-sandbox");
    assert.equal(probe["continue-on-error"], true);
    assert.match(probe.if, /runner\.os == 'Linux'/u);
    // After bwrap is installed, before the model runs.
    assert.ok(
      at((candidate) => candidate.name === "Install subprocess isolation") <
        probeAt,
    );
    const modelAt = at((candidate) => candidate.id === "claude-review");
    assert.ok(probeAt < modelAt);
    assert.match(
      job.steps[modelAt].if,
      /&& steps\.sandbox\.outcome != 'failure'$/u,
    );
    const outcome = job.steps.find(
      (candidate) => candidate.id === "review-outcome",
    );
    assert.equal(
      outcome.with["known-failure-class"],
      `\${{ steps.sandbox.outcome == 'failure' && 'sandbox-unavailable' || '' }}`,
    );
  });

  test(`${lane.file}: a sandbox that could not start goes red and says why`, () => {
    const result = runStep(step, {
      REVIEW_FAILED: "true",
      FAILURE_CLASS: "sandbox-unavailable",
    });
    assert.equal(result.status, 1);
    assert.match(result.summary, /failed: `sandbox-unavailable`/u);
    assert.match(result.summary, /could not create a namespace/u);
    assert.doesNotMatch(result.summary, /unclassified/u);
  });

  test(`${lane.file}: every other way no review happened goes red and is named`, () => {
    for (const [failed, klass, named] of [
      ["true", "auth", "auth"],
      ["true", "overloaded", "overloaded"],
      ["true", "max-turns", "max-turns"],
      ["true", "timeout", "timeout"],
      ["true", "other", "other"],
      ["true", "", "unknown"],
      // bubblewrap could not create a namespace, so the model never ran.
      ["true", "sandbox-unavailable", "sandbox-unavailable"],
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

  test(`${lane.file}: a failed isolation install goes red as install-failed, not no-outcome`, () => {
    const isolate = job.steps.find((candidate) => candidate.id === "isolate");
    assert.equal(isolate?.name, "Install subprocess isolation");
    assert.equal(step.env.ISOLATE_OUTCOME, `\${{ steps.isolate.outcome }}`);
    for (const [outcome, named] of [
      ["failure", "install-failed"],
      ["cancelled", "install-failed"],
      ["success", "no-outcome"],
    ]) {
      const result = runStep(step, {
        REVIEW_FAILED: "",
        FAILURE_CLASS: "",
        ISOLATE_OUTCOME: outcome,
      });
      assert.equal(result.status, 1, outcome);
      assert.match(result.summary, new RegExp(`failed: \`${named}\``, "u"));
      assert.match(
        result.stdout,
        new RegExp(`^::error .*failure-class=${named}:`, "mu"),
      );
    }
  });

  test(`${lane.file}: a reported outcome keeps its class whatever the isolation step did`, () => {
    const result = runStep(step, {
      REVIEW_FAILED: "true",
      FAILURE_CLASS: "timeout",
      ISOLATE_OUTCOME: "failure",
    });
    assert.equal(result.status, 1);
    assert.match(result.summary, /failed: `timeout`/u);
  });
}
