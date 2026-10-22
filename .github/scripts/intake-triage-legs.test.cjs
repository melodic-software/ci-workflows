"use strict";

// The intake lane runs the API key and the subscription token in separate
// jobs (ci-workflows#799). The claude job holds only the key; the
// claude-subscription job holds only the token, runs on a fixed GitHub-hosted
// runner only after the key job hands off (a credit stop or a rejected key)
// or with no key, repeats the claude job's hardening, and takes nothing from
// it but compared outputs. Both
// model jobs are read-only (ci-workflows#804): one apply job with no model
// writes the triage of whichever leg triaged. The status job reports one
// outcome: the subscription job's when it ran, red when the apply job failed.

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
const { claude, subscription, status, apply } = workflow.jobs;
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

test("the subscription job starts only on an exact handoff or an empty key", () => {
  const starts = (outputs) =>
    Boolean(evaluate(subscription.if, { needs: { claude: { outputs } } }));
  for (const laneClass of ["credit-stop", "auth"]) {
    assert.equal(
      starts({
        handoff: "true",
        "lane-class": laneClass,
        "credential-present": "true",
      }),
      true,
      laneClass,
    );
  }
  assert.equal(
    starts({ handoff: "", "lane-class": "", "credential-present": "false" }),
    true,
  );
  // The handoff alone decides: a lane-class with no handoff starts nothing.
  for (const laneClass of ["credit-stop", "auth", "rate-limit", "other", ""]) {
    assert.equal(
      starts({
        handoff: "false",
        "lane-class": laneClass,
        "credential-present": "true",
      }),
      false,
      laneClass,
    );
  }
  for (const handoff of ["", "True", "true ", "1"]) {
    assert.equal(
      starts({
        handoff,
        "lane-class": "auth",
        "credential-present": "true",
      }),
      false,
      JSON.stringify(handoff),
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

// The subscription job's outcome step names why it ran (ci-workflows#806).
const FALLBACK_REASON =
  "${{ needs.claude.outputs.lane-class == 'credit-stop' && 'credit-stop' || " +
  "needs.claude.outputs.lane-class == 'auth' && 'auth' || " +
  "needs.claude.outputs.credential-present == 'false' && 'no-key' || '' }}";

test("the subscription job repeats the claude job's steps but for the credential and the fallback reason", () => {
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
      if (copy.id === "review-outcome" && input === "subscription-token") {
        assert.equal(copy.with["fallback-reason"], FALLBACK_REASON);
        delete copy.with["fallback-reason"];
      }
      return copy;
    });
  assert.deepEqual(
    strip(subscription.steps, "CLAUDE_CODE_OAUTH_TOKEN", "subscription-token"),
    strip(claude.steps, "CLAUDE_API_KEY", "api-key"),
  );
  for (const key of [
    "permissions",
    "outputs",
    "timeout-minutes",
    "cache-mode",
  ]) {
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

test("the subscription job's lane record names the credit stop, the rejected key or the empty key it ran for", () => {
  const value = subscription.steps.find((step) => step.id === "review-outcome")
    .with["fallback-reason"];
  const reason = (outputs) =>
    evaluate(value, { needs: { claude: { outputs } } });
  assert.equal(
    reason({ "lane-class": "credit-stop", "credential-present": "true" }),
    "credit-stop",
  );
  assert.equal(
    reason({ "lane-class": "", "credential-present": "false" }),
    "no-key",
  );
  assert.equal(
    reason({ "lane-class": "auth", "credential-present": "true" }),
    "auth",
  );
});

test("a handoff skips the claude job's extract step", () => {
  const extract = claude.steps.find((step) => step.id === "extract");
  const steps = (handoff, present = "true") => ({
    compose: { outcome: "success" },
    credential: { outputs: { present } },
    claude: { outputs: { handoff } },
  });
  assert.equal(Boolean(evaluate(extract.if, { steps: steps("true") })), false);
  // No handoff, or a step that failed before the leg ran: the claude job
  // extracts.
  for (const handoff of ["false", ""]) {
    assert.equal(
      Boolean(evaluate(extract.if, { steps: steps(handoff) })),
      true,
      JSON.stringify(handoff),
    );
  }
  assert.equal(
    Boolean(evaluate(extract.if, { steps: steps("", "false") })),
    false,
  );
  assert.equal(
    Boolean(evaluate(launcher(claude).if, { steps: steps("", "false") })),
    false,
  );
});

test("the key leg's outcome step writes its record on a handoff too, flagged by the launcher's own handoff", () => {
  const outcome = claude.steps.find((step) => step.id === "review-outcome");
  const steps = (handoff, present = "true") => ({
    credential: { outputs: { present } },
    claude: { outputs: { handoff } },
  });
  // A handoff, whether or not the subscription token is set (the key job
  // cannot see it), and no handoff alike: the key leg reports.
  for (const handoff of ["true", "false", ""]) {
    assert.equal(
      Boolean(evaluate(outcome.if, { steps: steps(handoff) })),
      true,
      JSON.stringify(handoff),
    );
  }
  // An empty key ran nothing, so there is nothing to report.
  assert.equal(
    Boolean(evaluate(outcome.if, { steps: steps("", "false") })),
    false,
  );
  assert.equal(outcome.with["lane-id"], "intake-triage");
  assert.equal(outcome.with.credential, "${{ steps.claude.outputs.credential }}");
  // Only run-claude-cli's handoff output, `true` only when the leg handed
  // off, sets the flag: a key leg that fails without handing off stays an
  // error (outcome-step.test.cjs holds the level).
  assert.equal(outcome.with.handoff, "${{ steps.claude.outputs.handoff }}");
  assert.equal(
    outcome.with["known-failure-class"],
    "${{ steps.claude.outputs.lane-class }}",
  );
  // The subscription leg reports from its own step, with its fallback reason.
  const sub = subscription.steps.find((step) => step.id === "review-outcome");
  assert.equal(sub.with["fallback-reason"], FALLBACK_REASON);
  assert.equal(sub.with["lane-id"], "intake-triage");
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
    APPLY_RESULT: "success",
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
  assert.deepEqual(status.needs, ["claude", "subscription", "apply"]);
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
  // A rejected key with no subscription token stays an auth failure.
  const deadKeyNoToken = report({
    KEY_CLASS: "auth",
    SUB_RESULT: "success",
    SUB_PRESENT: "false",
  });
  assert.equal(deadKeyNoToken.code, 1);
  assert.deepEqual(deadKeyNoToken.outputs, {
    "triage-failed": "true",
    "failure-class": "auth",
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

test("an unusable key warns the owner to replace the secret, even when the subscription job triaged", () => {
  const warning = /^::warning[^:]*::class=auth: .*replace the secret/mu;
  const fellBack = report({
    KEY_CLASS: "auth",
    SUB_RESULT: "success",
    SUB_PRESENT: "true",
    SUB_FAILED: "false",
  });
  assert.equal(fellBack.code, 0);
  assert.match(fellBack.stdout, warning);
  // An auth class with no numeric status does not hand off: the key job
  // alone reports, red, and still warns.
  const refused = report({
    KEY_RESULT: "success",
    KEY_FAILED: "true",
    KEY_CLASS: "auth",
  });
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, warning);
  for (const keyClass of ["", "credit-stop", "rate-limit", "other"]) {
    const run = report({ KEY_CLASS: keyClass, KEY_FAILED: "false" });
    assert.doesNotMatch(run.stdout, /::warning/u, keyClass);
  }
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

test("the status line names the credential of the leg it reports, in legacy tokens only", () => {
  for (const job of [claude, subscription]) {
    assert.equal(job.outputs.credential, "${{ steps.claude.outputs.credential }}", job.name);
  }
  const key = "AUTOMATIONS_CLAUDE_API_KEY";
  const token = "AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN";
  // The subscription leg ran and hit its limit: its token is named.
  const limited = report({
    KEY_CLASS: "credit-stop",
    KEY_CREDENTIAL: key,
    SUB_RESULT: "success",
    SUB_PRESENT: "true",
    SUB_FAILED: "true",
    SUB_CLASS: "rate-limit",
    SUB_CREDENTIAL: token,
  });
  assert.equal(limited.code, 1);
  assert.match(
    limited.stdout,
    /failure-class=rate-limit job=success credential=AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN /u,
  );
  // The key leg alone failed: the key is named.
  const keyFailed = report({
    KEY_FAILED: "true",
    KEY_CLASS: "other",
    KEY_CREDENTIAL: key,
  });
  assert.match(keyFailed.stdout, /job=success credential=AUTOMATIONS_CLAUDE_API_KEY /u);
  // A key credit stop with no subscription token: the stop is the key's.
  const noToken = report({
    KEY_CLASS: "credit-stop",
    KEY_CREDENTIAL: key,
    SUB_RESULT: "success",
    SUB_PRESENT: "false",
  });
  assert.match(
    noToken.stdout,
    /failure-class=rate-limit job=success credential=AUTOMATIONS_CLAUDE_API_KEY /u,
  );
  // Both secrets empty: no credential ran.
  const neither = report({
    KEY_PRESENT: "false",
    KEY_CREDENTIAL: key,
    SUB_RESULT: "success",
    SUB_PRESENT: "false",
  });
  assert.doesNotMatch(neither.stdout, /credential=/u);
  // A value that is not a secret name is dropped, never printed.
  const forged = report({
    KEY_FAILED: "true",
    KEY_CLASS: "other",
    KEY_CREDENTIAL: "KEY\n::error::planted",
  });
  assert.doesNotMatch(forged.stdout, /credential=|planted/u);
  assert.deepEqual(limited.outputs, { "triage-failed": "true", "failure-class": "rate-limit" });
});

test("a failed or cancelled apply job turns the status red", () => {
  for (const result of ["failure", "cancelled"]) {
    const run = report({ KEY_FAILED: "false", APPLY_RESULT: result });
    assert.equal(run.code, 1, result);
    assert.match(run.stdout, new RegExp(`job=${result}`, "u"), result);
  }
  assert.equal(
    report({ KEY_FAILED: "false", APPLY_RESULT: "skipped" }).code,
    0,
  );
});

test("the model jobs are read-only, cache-less, and give the model no GitHub token or gh", () => {
  for (const job of [claude, subscription]) {
    assert.deepEqual(
      job.permissions,
      { contents: "read", issues: "read" },
      job.name,
    );
    assert.equal(job["cache-mode"], "none", job.name);
    const step = launcher(job);
    assert.equal(step.uses, "$/.github/actions/run-claude-cli", job.name);
    assert.equal(step.env, undefined, job.name);
    assert.doesNotMatch(
      JSON.stringify(step),
      /github\.token|GH_TOKEN|GITHUB_TOKEN/u,
      job.name,
    );
    assert.deepEqual(
      Object.values(step.with).filter((value) => /secrets\./u.test(value))
        .length,
      1,
      job.name,
    );
    assert.deepEqual(
      step.with.tools.trim().split("\n"),
      ["Read", "Grep", "Glob"],
      job.name,
    );
    assert.equal(step.with["allowed-tools"], undefined, job.name);
    assert.ok(
      step.with["disallowed-tools"].split("\n").includes("Bash"),
      job.name,
    );
    assert.doesNotMatch(JSON.stringify(job), /Bash\(gh /u, job.name);
  }
});

test("exactly one job, with no model, writes the triage", () => {
  assert.equal(apply.name, "claude-intake-triage-apply");
  assert.deepEqual(apply.needs, ["claude", "subscription"]);
  assert.deepEqual(apply.permissions, { issues: "write" });
  assert.equal(apply["runs-on"], "ubuntu-24.04");
  for (const step of apply.steps) {
    assert.doesNotMatch(
      step.uses ?? "",
      /run-claude-cli|actions\/(checkout|download-artifact|cache)/u,
      step.name,
    );
    // Job outputs reach the script only through env.
    assert.doesNotMatch(step.with?.script ?? "", /\$\{\{/u, step.name);
  }
  const writers = Object.entries(workflow.jobs)
    .filter(([, job]) => job.permissions?.issues === "write")
    .map(([name]) => name);
  // The skipped job writes only skipped-label on an issue no model read.
  assert.deepEqual(writers, ["apply", "skipped"]);
  for (const job of [claude, subscription]) {
    assert.equal(
      job.steps.some((step) => step.name === "Apply the triage"),
      false,
      job.name,
    );
  }
});
