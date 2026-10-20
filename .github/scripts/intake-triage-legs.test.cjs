"use strict";

// The intake lane runs the API key and the subscription token in separate
// jobs (ci-workflows#799). The claude job holds only the key; the
// claude-subscription job holds only the token, runs on a fixed GitHub-hosted
// runner only after a key credit stop (or with no key), repeats the claude
// job's hardening, and takes nothing from it but two compared outputs. The
// status job reports one outcome: the subscription job's when it ran.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { evaluate } = require("./actions-expression.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(__dirname, "..", "workflows", "intake-triage.yml"),
    "utf8",
  ),
);
const { claude, subscription, status } = workflow.jobs;
const launcher = (job) => job.steps.find((step) => step.id === "claude");

test("only the subscription job references the OAuth token, and only the claude job the key", () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const text = JSON.stringify(job);
    assert.equal(
      text.includes("secrets.CLAUDE_CODE_OAUTH_TOKEN"),
      name === "subscription",
      name,
    );
    assert.equal(
      text.includes("secrets.CLAUDE_API_KEY"),
      name === "claude",
      name,
    );
  }
  assert.deepEqual(
    Object.keys(launcher(claude).with).filter((k) => /key|token/u.test(k)),
    ["api-key"],
  );
  assert.deepEqual(
    Object.keys(launcher(subscription).with).filter((k) =>
      /key|token/u.test(k),
    ),
    ["subscription-token"],
  );
});

test("the subscription job runs on a fixed GitHub-hosted label, after the claude job", () => {
  assert.equal(subscription["runs-on"], "ubuntu-24.04");
  assert.equal(subscription.needs, "claude");
  assert.equal(subscription.name, "claude-intake-triage-subscription");
});

test("the subscription job starts only on an exact credit-stop or an empty key", () => {
  const starts = (outputs) =>
    Boolean(evaluate(subscription.if, { needs: { claude: { outputs } } }));
  assert.equal(
    starts({ "lane-class": "credit-stop", "credential-present": "true" }),
    true,
  );
  assert.equal(
    starts({ "lane-class": "", "credential-present": "false" }),
    true,
  );
  for (const laneClass of [
    "",
    "rate-limit",
    "auth",
    "other",
    "credit-stop-x",
    " credit-stop",
  ]) {
    assert.equal(
      starts({ "lane-class": laneClass, "credential-present": "true" }),
      false,
      laneClass,
    );
  }
  // A failed or cancelled claude job never starts it: the if has no status
  // function, so success() applies.
  assert.doesNotMatch(subscription.if, /always\(\)|failure\(\)|cancelled\(\)/u);
});

test("the subscription job downloads nothing from the claude job and never writes its outputs into a script", () => {
  for (const step of subscription.steps) {
    assert.doesNotMatch(
      step.uses ?? "",
      /actions\/(download-artifact|cache)/u,
      step.name,
    );
    assert.doesNotMatch(step.run ?? "", /needs\./u, step.name);
    assert.doesNotMatch(step.with?.script ?? "", /needs\./u, step.name);
  }
});

test("the subscription job repeats the claude job's steps but for the credential", () => {
  const strip = (steps, secret, input) =>
    steps.map((step) => {
      const copy = structuredClone(step);
      if (copy.id === "credential") {
        assert.equal(copy.env.PRESENT, `\${{ secrets.${secret} != '' }}`);
        assert.equal(copy.env.SECRET_NAME, secret);
        delete copy.env.PRESENT;
        delete copy.env.SECRET_NAME;
      }
      if (copy.id === "claude") {
        assert.equal(copy.with[input], `\${{ secrets.${secret} }}`);
        delete copy.with[input];
      }
      return copy;
    });
  assert.deepEqual(
    strip(subscription.steps, "CLAUDE_CODE_OAUTH_TOKEN", "subscription-token"),
    strip(claude.steps, "CLAUDE_API_KEY", "api-key"),
  );
  for (const key of ["permissions", "outputs", "timeout-minutes"]) {
    assert.deepEqual(subscription[key], claude[key], key);
  }
  // The hardening runs before the checkout in both jobs.
  const order = subscription.steps.map((step) => step.name);
  assert.ok(
    order.indexOf("Isolate the runner") < order.indexOf("Check out") &&
      order.indexOf("Apply the Claude managed settings") <
        order.indexOf("Isolate the runner"),
  );
});

test("a key credit stop skips the claude job's outcome and apply steps", () => {
  const byId = (id) => claude.steps.find((step) => step.id === id);
  const apply = claude.steps.find((step) => step.name === "Apply the triage");
  const steps = (laneClass, present = "true") => ({
    compose: { outcome: "success" },
    credential: { outputs: { present } },
    claude: { outputs: { "lane-class": laneClass } },
  });
  for (const step of [byId("review-outcome"), apply]) {
    assert.equal(
      Boolean(evaluate(step.if, { steps: steps("credit-stop") })),
      false,
      step.name,
    );
    assert.equal(
      Boolean(evaluate(step.if, { steps: steps("") })),
      true,
      step.name,
    );
    assert.equal(
      Boolean(evaluate(step.if, { steps: steps("auth") })),
      true,
      step.name,
    );
    assert.equal(
      Boolean(evaluate(step.if, { steps: steps("", "false") })),
      false,
      step.name,
    );
  }
  assert.equal(
    Boolean(evaluate(byId("claude").if, { steps: steps("", "false") })),
    false,
  );
});

// Runs the status step's script; returns its exit code and outputs.
function report(env) {
  const dir = makeTemporaryDirectory("intake-status-");
  const output = path.join(dir, "output");
  fs.writeFileSync(output, "");
  const defaults = {
    KEY_RESULT: "success",
    KEY_PRESENT: "true",
    KEY_FAILED: "",
    KEY_CLASS: "",
    SUB_RESULT: "skipped",
    SUB_PRESENT: "",
    SUB_FAILED: "",
    SUB_CLASS: "",
  };
  const result = spawnSync("bash", ["-e", "-c", status.steps[0].run], {
    env: { PATH: process.env.PATH, ...defaults, ...env, GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  const outputs = Object.fromEntries(
    fs
      .readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/su).slice(0, 2)),
  );
  return { code: result.status, outputs, stdout: result.stdout };
}

test("the status job reads the subscription job when it ran, else the claude job", () => {
  assert.equal(status.name, "claude-intake-triage-status");
  assert.deepEqual(status.needs, ["claude", "subscription"]);
  assert.equal(
    workflow.on.workflow_call.outputs["failure-class"].value,
    `\${{ jobs.status.outputs.failure-class }}`,
  );
  const keyOnly = report({ KEY_FAILED: "false" });
  assert.equal(keyOnly.code, 0);
  assert.deepEqual(keyOnly.outputs, {
    "triage-failed": "false",
    "failure-class": "",
  });
  const fellBack = report({
    KEY_CLASS: "credit-stop",
    SUB_RESULT: "success",
    SUB_PRESENT: "true",
    SUB_FAILED: "false",
  });
  assert.equal(fellBack.code, 0);
  assert.deepEqual(fellBack.outputs, {
    "triage-failed": "false",
    "failure-class": "",
  });
  const limited = report({
    KEY_CLASS: "credit-stop",
    SUB_RESULT: "success",
    SUB_PRESENT: "true",
    SUB_FAILED: "true",
    SUB_CLASS: "rate-limit",
  });
  assert.equal(limited.code, 1);
  assert.deepEqual(limited.outputs, {
    "triage-failed": "true",
    "failure-class": "rate-limit",
  });
  assert.match(limited.stdout, /failure-class=rate-limit job=success/u);
});

test("an empty secret in the job that should triage fails with a fixed class", () => {
  // A key credit stop with no subscription token is a limit stop.
  const noToken = report({
    KEY_CLASS: "credit-stop",
    SUB_RESULT: "success",
    SUB_PRESENT: "false",
  });
  assert.equal(noToken.code, 1);
  assert.deepEqual(noToken.outputs, {
    "triage-failed": "true",
    "failure-class": "rate-limit",
  });
  // Both secrets empty.
  const neither = report({
    KEY_PRESENT: "false",
    SUB_RESULT: "success",
    SUB_PRESENT: "false",
  });
  assert.equal(neither.code, 1);
  assert.deepEqual(neither.outputs, {
    "triage-failed": "true",
    "failure-class": "other",
  });
});

test("the status job prints and writes only closed values", () => {
  const forged = report({
    KEY_RESULT: "failure",
    KEY_FAILED: "true\n::error::planted",
    KEY_CLASS: "::error::planted",
  });
  assert.equal(forged.code, 1);
  assert.deepEqual(forged.outputs, {
    "triage-failed": "",
    "failure-class": "other",
  });
  assert.equal(forged.stdout.includes("planted"), false);
});
