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

const {
  CREDENTIAL_PATTERN,
} = require("../actions/report-lane-outcome/classify.cjs");
const { evaluate } = require("./actions-expression.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(__dirname, "..", "workflows", "intake-triage.yml"),
    "utf8",
  ),
);
const { claude, subscription, fallback, status, apply } = workflow.jobs;
const launcher = (job) => job.steps.find((step) => step.id === "claude");

// The shared credential step (select-model-credential), called as the leg
// jobs call it: `decide` is a leg job's first call, `handedOn` the job
// outputs its last call leaves for the next job.
const select = require("../actions/select-model-credential/select.cjs");
const decide = (leg, flags = {}) =>
  select.leg({ leg, role: "automations", credentialSet: "true", ...flags });
const handedOn = (leg, flags = {}, launched = {}) =>
  select.next({
    state: decide(leg, flags).outputs.state,
    handoff: launched.handoff,
    handoffReason: launched["handoff-reason"],
  });
// Every leg's lane record takes the reason from that step, which checks the
// previous leg's next-reason against report-lane-outcome's closed list.
const LEG_REASON = `\${{ steps.credential.outputs.fallback-reason }}`;

test("only the subscription job references the OAuth token, and only the claude job the key", () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const text = JSON.stringify(job);
    assert.equal(
      text.includes("secrets.CLAUDE_CODE_OAUTH_TOKEN"),
      name === "subscription",
      name,
    );
    // The fallback token's value reaches only the fallback job's launcher;
    // the other model jobs read only whether it is set.
    assert.equal(
      text.includes("secrets.FALLBACK_CLAUDE_CODE_OAUTH_TOKEN }}"),
      name === "fallback",
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
  assert.deepEqual(
    Object.keys(launcher(fallback).with).filter((k) => /key|token/u.test(k)),
    ["fallback-token"],
  );
  assert.equal(
    workflow.on.workflow_call.secrets.FALLBACK_CLAUDE_CODE_OAUTH_TOKEN.required,
    false,
  );
});

test("every model job tells its launcher whether the fallback token is set, never its value", () => {
  for (const job of [claude, subscription, fallback]) {
    const credential = job.steps.find((step) => step.id === "credential");
    assert.equal(credential.uses, "$/.github/actions/select-model-credential");
    assert.equal(
      credential.with["fallback-set"],
      `\${{ secrets.FALLBACK_CLAUDE_CODE_OAUTH_TOKEN != '' }}`,
      job.name,
    );
    assert.equal(
      launcher(job).with["fallback-ready"],
      `\${{ steps.credential.outputs.fallback-ready }}`,
      job.name,
    );
    assert.equal(
      job.outputs["handoff-reason"],
      `\${{ steps.claude.outputs.handoff-reason }}`,
      job.name,
    );
  }
  const ready = (present) =>
    decide("subscription", { fallbackSet: present }).outputs["fallback-ready"];
  assert.equal(ready("true"), "true");
  for (const present of ["false", "", "True"]) {
    assert.equal(ready(present), "false", JSON.stringify(present));
  }
});

test("the fallback job runs on a fixed GitHub-hosted label only after the subscription job hands off or finds its token empty with the fallback token set", () => {
  assert.equal(fallback.name, "claude-intake-triage-fallback");
  assert.equal(fallback["runs-on"], "ubuntu-24.04");
  assert.deepEqual(fallback.needs, ["claude", "subscription"]);
  // The subscription job's outputs, as its last step leaves them.
  const starts = (outputs, result = "success") =>
    Boolean(
      evaluate(fallback.if, { needs: { subscription: { result, outputs } } }),
    );
  const ready = { fallbackSet: "true" };
  const limit = { handoff: "true", "handoff-reason": "limit-stop" };
  assert.equal(starts(handedOn("subscription", ready, limit)), true);
  for (const handoff of ["", "false", "True", "true ", "1"]) {
    assert.equal(
      starts(handedOn("subscription", ready, { ...limit, handoff })),
      false,
      JSON.stringify(handoff),
    );
  }
  // An empty subscription token hands on as an empty key does, but only to
  // a fallback token that is set (claude-code-plugins#13586).
  assert.equal(
    starts(handedOn("subscription", { credentialSet: "false", ...ready })),
    true,
  );
  assert.equal(
    starts(handedOn("subscription", { credentialSet: "false" })),
    false,
  );
  assert.equal(starts({}), false);
  // The next-leg step is the job's last, with no if:, so it names a leg
  // only when the job succeeded; the if checks that result itself, since a
  // claude job the key-credit gate skipped leaves success() false.
  assert.equal(subscription.steps.at(-2).id, "next");
  assert.equal(subscription.steps.at(-2).if, undefined);
  const handed = handedOn("subscription", ready, limit);
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.equal(starts(handed, result), false, result);
  }
  for (const step of fallback.steps) {
    assert.doesNotMatch(
      step.uses ?? "",
      /actions\/(download-artifact|cache)/u,
      step.name,
    );
    assert.doesNotMatch(step.run ?? "", /needs\./u, step.name);
    assert.doesNotMatch(step.with?.script ?? "", /needs\./u, step.name);
  }
});

test("the fallback job repeats the subscription job's steps but for the credential and the fallback reason", () => {
  const strip = (steps, leg, secret, input, previous) =>
    steps.map((step) => {
      const copy = structuredClone(step);
      if (copy.id === "credential") {
        assert.equal(copy.with.leg, leg);
        assert.equal(
          copy.with["credential-set"],
          `\${{ secrets.${secret} != '' }}`,
        );
        assert.equal(copy.with.reason, previous);
        delete copy.with.leg;
        delete copy.with["credential-set"];
        delete copy.with.reason;
      }
      if (copy.id === "claude") {
        assert.equal(copy.with[input], `\${{ secrets.${secret} }}`);
        delete copy.with[input];
      }
      return copy;
    });
  assert.deepEqual(
    strip(
      fallback.steps,
      "fallback",
      "FALLBACK_CLAUDE_CODE_OAUTH_TOKEN",
      "fallback-token",
      `\${{ needs.subscription.outputs.next-reason }}`,
    ),
    strip(
      subscription.steps,
      "subscription",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "subscription-token",
      `\${{ needs.claude.outputs.next-reason || needs.check-key-credit.outputs.next-reason }}`,
    ),
  );
  for (const key of [
    "permissions",
    "outputs",
    "timeout-minutes",
    "cache-mode",
  ]) {
    assert.deepEqual(fallback[key], subscription[key], key);
  }
  const value = fallback.steps.find((step) => step.id === "review-outcome")
    .with["fallback-reason"];
  assert.equal(value, LEG_REASON);
  const reason = (handoffReason) =>
    decide("fallback", {
      reason: handedOn(
        "subscription",
        { fallbackSet: "true" },
        { handoff: "true", "handoff-reason": handoffReason },
      )["next-reason"],
    }).outputs["fallback-reason"];
  for (const known of ["limit-stop", "credit-stop", "auth"])
    assert.equal(reason(known), known);
  assert.equal(
    decide("fallback", {
      reason: handedOn("subscription", {
        credentialSet: "false",
        fallbackSet: "true",
      })["next-reason"],
    }).outputs["fallback-reason"],
    "no-key",
  );
  for (const forged of ["", "no-key", "Limit-Stop", "limit-stop\n::error::x"]) {
    assert.equal(reason(forged), "", JSON.stringify(forged));
  }
  // A forged next-reason never reaches the record.
  assert.equal(
    decide("fallback", { reason: "limit-stop\n::error::x" }).outputs[
      "fallback-reason"
    ],
    "",
  );
});

test("every model job's leg uploads its sealed transcript under a job id unique in the run", () => {
  const artifact = /^lane-transcript-(.+)-([1-9][0-9]{0,4})$/u;
  const jobId = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u;
  const seen = new Set();
  for (const [name, job] of Object.entries({
    claude,
    subscription,
    fallback,
  })) {
    const uploads = job.steps.filter(
      (step) => step.uses === "$/.github/actions/upload-lane-transcript",
    );
    assert.equal(uploads.length, 1, name);
    const [upload] = uploads;
    const outcome = job.steps.findIndex((step) => step.id === "review-outcome");
    assert.ok(outcome >= 0, name);
    assert.ok(job.steps.indexOf(upload) > outcome, name);
    assert.equal(upload["continue-on-error"], true);
    assert.equal(
      upload.if,
      "always() && steps.claude.outputs.execution-file != ''",
    );
    assert.equal(
      upload.with["execution-file"],
      `\${{ steps.claude.outputs.execution-file }}`,
    );
    assert.equal(
      upload.with["public-key"],
      `\${{ inputs.lane-transcript-public-key }}`,
    );
    const id = upload.with["job-id"].replace(`\${{ github.job }}`, name);
    assert.match(id, jobId);
    assert.equal(seen.has(id), false, id);
    seen.add(id);
    assert.equal(artifact.exec(`lane-transcript-${id}-1`)?.[1], id);
  }
  assert.equal(
    workflow.on.workflow_call.inputs["lane-transcript-public-key"].default,
    "",
  );
});

test("the subscription job runs on a fixed GitHub-hosted label, after the claude job", () => {
  assert.equal(subscription["runs-on"], "ubuntu-24.04");
  assert.deepEqual(subscription.needs, ["check-key-credit", "claude"]);
  assert.equal(subscription.name, "claude-intake-triage-subscription");
});

test("the subscription job starts only on an exact handoff or an empty key", () => {
  // The claude job's outputs, as its last step leaves them, after a gate
  // job that ran the key.
  const gateRan = {
    result: "success",
    outputs: select.start({ skipKey: false }),
  };
  const starts = (outputs, result = "success") =>
    Boolean(
      evaluate(subscription.if, {
        needs: { "check-key-credit": gateRan, claude: { result, outputs } },
      }),
    );
  for (const why of ["credit-stop", "auth"]) {
    assert.equal(
      starts(handedOn("key", {}, { handoff: "true", "handoff-reason": why })),
      true,
      why,
    );
  }
  assert.equal(starts(handedOn("key", { credentialSet: "false" })), true);
  assert.equal(starts(handedOn("key", { selected: "subscription" })), true);
  // The handoff alone decides: a reason with no handoff starts nothing.
  for (const why of ["credit-stop", "auth", "rate-limit", "other", ""]) {
    assert.equal(
      starts(handedOn("key", {}, { handoff: "false", "handoff-reason": why })),
      false,
      why,
    );
  }
  for (const handoff of ["", "True", "true ", "1"]) {
    assert.equal(
      starts(handedOn("key", {}, { handoff, "handoff-reason": "auth" })),
      false,
      JSON.stringify(handoff),
    );
  }
  assert.equal(claude.steps.at(-2).id, "next");
  assert.equal(claude.steps.at(-2).if, undefined);
  // A failed or cancelled claude job never starts it, even with a handoff
  // in its outputs.
  const auth = handedOn(
    "key",
    {},
    { handoff: "true", "handoff-reason": "auth" },
  );
  for (const result of ["failure", "cancelled"]) {
    assert.equal(starts(auth, result), false, result);
  }
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

test("the subscription job repeats the claude job's steps but for the credential and the fallback reason", () => {
  // The key leg alone reads the key-credit gate and writes its marker.
  const KEY_ONLY = new Set([
    "credit-marker",
    "credit-marker-scan",
    "Upload the key's credit-stop marker",
  ]);
  const strip = (steps, secret, input) =>
    steps
      .filter((step) => !KEY_ONLY.has(step.id) && !KEY_ONLY.has(step.name))
      .map((step) => {
        const copy = structuredClone(step);
        if (copy.id === "credential") {
          assert.equal(
            copy.with["credential-set"],
            `\${{ secrets.${secret} != '' }}`,
          );
          if (input === "api-key") {
            assert.equal(copy.with.leg, "key");
            // The key leg reads the gate's choice; the subscription leg the
            // key leg's reason.
            assert.equal(
              copy.with.selected,
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
              "${{ needs.check-key-credit.outputs.next-leg }}",
            );
          } else {
            assert.equal(copy.with.leg, "subscription");
            assert.equal(
              copy.with.reason,
              // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
              "${{ needs.claude.outputs.next-reason || needs.check-key-credit.outputs.next-reason }}",
            );
          }
          for (const name of ["leg", "credential-set", "selected", "reason"]) {
            delete copy.with[name];
          }
        }
        if (copy.id === "claude") {
          assert.equal(copy.with[input], `\${{ secrets.${secret} }}`);
          delete copy.with[input];
        }
        if (copy.id === "review-outcome" && input === "subscription-token") {
          assert.equal(copy.with["fallback-reason"], LEG_REASON);
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
    // key-skipped is the key leg's alone: the credit gate skipped its key.
    const { "key-skipped": keySkipped, ...keyOutputs } = claude.outputs;
    assert.deepEqual(
      subscription[key],
      key === "outputs" ? keyOutputs : claude[key],
      key,
    );
  }
  assert.equal(
    claude.outputs["key-skipped"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    "${{ steps.credential.outputs.key-skipped }}",
  );
  assert.deepEqual(claude.needs, "check-key-credit");
  // A failed gate job still runs the key leg: the if opens with
  // !cancelled(), so it carries no implicit success() of its needs.
  assert.match(claude.if, /^\$\{\{ !cancelled\(\) && /u);
  // The hardening runs before the checkout in both jobs.
  const order = subscription.steps.map((step) => step.name);
  assert.ok(
    order.indexOf("Isolate the runner") < order.indexOf("Check out") &&
      order.indexOf("Apply the Claude managed settings") <
        order.indexOf("Isolate the runner"),
  );
});

test("the subscription job's lane record names the credit stop, the rejected key or the empty key it ran for", () => {
  assert.equal(
    subscription.steps.find((step) => step.id === "review-outcome").with[
      "fallback-reason"
    ],
    LEG_REASON,
  );
  // The claude job's next-reason, as the subscription leg checks it.
  const reason = (flags, launched) =>
    decide("subscription", {
      reason: handedOn("key", flags, launched)["next-reason"],
    }).outputs["fallback-reason"];
  assert.equal(
    reason({}, { handoff: "true", "handoff-reason": "credit-stop" }),
    "credit-stop",
  );
  assert.equal(reason({ credentialSet: "false" }), "no-key");
  assert.equal(
    reason({}, { handoff: "true", "handoff-reason": "auth" }),
    "auth",
  );
  // A key the credit gate held off is the credit stop it follows.
  assert.equal(reason({ selected: "subscription" }), "credit-stop");
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
  assert.equal(
    outcome.with.credential,
    `\${{ steps.claude.outputs.credential }}`,
  );
  // Only run-claude-cli's handoff output, `true` only when the leg handed
  // off, sets the flag: a key leg that fails without handing off stays an
  // error (outcome-step.test.cjs holds the level).
  assert.equal(outcome.with.handoff, `\${{ steps.claude.outputs.handoff }}`);
  assert.equal(
    outcome.with["known-failure-class"],
    `\${{ steps.claude.outputs.lane-class }}`,
  );
  // The subscription leg reports from its own step, with its fallback reason.
  const sub = subscription.steps.find((step) => step.id === "review-outcome");
  assert.equal(sub.with["fallback-reason"], LEG_REASON);
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
    FB_RESULT: "skipped",
    FB_PRESENT: "",
    FB_FAILED: "",
    FB_CLASS: "",
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
  assert.deepEqual(status.needs, [
    "claude",
    "subscription",
    "fallback",
    "apply",
  ]);
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

test("the status job reads the fallback job, the last leg, when it ran", () => {
  const sub = {
    KEY_CLASS: "credit-stop",
    SUB_RESULT: "success",
    SUB_PRESENT: "true",
    SUB_FAILED: "true",
    SUB_CLASS: "rate-limit",
    SUB_CREDENTIAL: "AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN",
  };
  const triaged = report({
    ...sub,
    FB_RESULT: "success",
    FB_PRESENT: "true",
    FB_FAILED: "false",
    FB_CREDENTIAL: "FALLBACK_CLAUDE_CODE_OAUTH_TOKEN",
  });
  assert.equal(triaged.code, 0);
  assert.deepEqual(triaged.outputs, {
    "triage-failed": "false",
    "failure-class": "",
  });
  const limited = report({
    ...sub,
    FB_RESULT: "success",
    FB_PRESENT: "true",
    FB_FAILED: "true",
    FB_CLASS: "rate-limit",
    FB_CREDENTIAL: "FALLBACK_CLAUDE_CODE_OAUTH_TOKEN",
  });
  assert.equal(limited.code, 1);
  assert.match(
    limited.stdout,
    /failure-class=rate-limit job=success credential=FALLBACK_CLAUDE_CODE_OAUTH_TOKEN; read the job log\./u,
  );
  // A fallback job with no token reports the subscription leg's stop.
  const noToken = report({ ...sub, FB_RESULT: "success", FB_PRESENT: "false" });
  assert.equal(noToken.code, 1);
  assert.deepEqual(noToken.outputs, {
    "triage-failed": "true",
    "failure-class": "rate-limit",
  });
  assert.match(
    noToken.stdout,
    /credential=AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN; read/u,
  );
  // Skipped, the subscription job is read as before.
  const before = report({ ...sub, FB_RESULT: "skipped" });
  assert.equal(before.code, 1);
  assert.match(
    before.stdout,
    /credential=AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN; read/u,
  );
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
  for (const job of [claude, subscription, fallback]) {
    assert.equal(
      job.outputs.credential,
      `\${{ steps.claude.outputs.credential }}`,
      job.name,
    );
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
    /failure-class=rate-limit job=success credential=AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN; read the job log\./u,
  );
  // The key leg alone failed: the key is named.
  const keyFailed = report({
    KEY_FAILED: "true",
    KEY_CLASS: "other",
    KEY_CREDENTIAL: key,
  });
  assert.match(
    keyFailed.stdout,
    /job=success credential=AUTOMATIONS_CLAUDE_API_KEY; read the job log\./u,
  );
  // A key credit stop with no subscription token: the stop is the key's.
  const noToken = report({
    KEY_CLASS: "credit-stop",
    KEY_CREDENTIAL: key,
    SUB_RESULT: "success",
    SUB_PRESENT: "false",
  });
  assert.match(
    noToken.stdout,
    /failure-class=rate-limit job=success credential=AUTOMATIONS_CLAUDE_API_KEY; read the job log\./u,
  );
  // Both secrets empty: no credential ran.
  const neither = report({
    KEY_PRESENT: "false",
    KEY_CREDENTIAL: key,
    SUB_RESULT: "success",
    SUB_PRESENT: "false",
  });
  assert.doesNotMatch(neither.stdout, /credential=/u);
  // With no credential the line is main's, byte for byte.
  assert.match(
    neither.stdout,
    /failure-class=other job=success; read the job log\.$/mu,
  );
  // A value that is not a secret name is dropped, never printed.
  const forged = report({
    KEY_FAILED: "true",
    KEY_CLASS: "other",
    KEY_CREDENTIAL: "KEY\n::error::planted",
  });
  assert.doesNotMatch(forged.stdout, /credential=|planted/u);
  assert.deepEqual(limited.outputs, {
    "triage-failed": "true",
    "failure-class": "rate-limit",
  });
});

test("the status step checks a secret name with report-lane-outcome's own pattern", () => {
  const match = /\[\[ "\$credential" =~ (\S+) \]\]/u.exec(status.steps[0].run);
  assert.notEqual(match, null);
  assert.equal(match[1], CREDENTIAL_PATTERN.source);
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
  for (const job of [claude, subscription, fallback]) {
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
  assert.deepEqual(apply.needs, ["claude", "subscription", "fallback"]);
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
  for (const job of [claude, subscription, fallback]) {
    assert.equal(
      job.steps.some((step) => step.name === "Apply the triage"),
      false,
      job.name,
    );
  }
});

// The key-credit gate (claude-code-plugins#13586): a job with no secret reads
// the key's credit history; a credit-stopped key skips the claude job, so
// the subscription job triages with reason credit-stop, and the key leg
// uploads the marker after its own credit stop.
test("a credit-stopped key hands the triage to the subscription job before any key call", () => {
  const gate = workflow.jobs["check-key-credit"];
  assert.deepEqual(gate.permissions, { actions: "read" });
  const read = gate.steps.find((step) => step.id === "gate");
  assert.equal(read.uses, "$/.github/actions/select-model-credential");
  assert.equal(read.with.leg, "start");
  assert.equal(read.with["key-job"], "claude-intake-triage");
  assert.equal(read.with["probe-minutes"], "0");
  assert.equal(read["continue-on-error"], true);
  assert.equal(gate.outputs["next-leg"], `\${{ steps.gate.outputs.next-leg }}`);
  assert.equal(
    gate.outputs["next-reason"],
    `\${{ steps.gate.outputs.next-reason }}`,
  );
  // The gate's choice, as its job leaves it: subscription skips the claude
  // job, key or a failed gate job (empty next-leg) runs it, and an author
  // gate that turned the run away (gate job skipped) runs neither leg.
  const held = {
    result: "success",
    outputs: select.start({ skipKey: true }),
  };
  const keyRuns = (gateJob) =>
    Boolean(evaluate(claude.if, { needs: { "check-key-credit": gateJob } }));
  assert.equal(keyRuns(held), false);
  assert.equal(
    keyRuns({ result: "success", outputs: select.start({ skipKey: false }) }),
    true,
  );
  assert.equal(keyRuns({ result: "failure", outputs: {} }), true);
  assert.equal(keyRuns({ result: "skipped", outputs: {} }), false);
  const subscriptionRuns = (gateJob, claudeJob) =>
    Boolean(
      evaluate(subscription.if, {
        needs: { "check-key-credit": gateJob, claude: claudeJob },
      }),
    );
  assert.equal(
    subscriptionRuns(held, { result: "skipped", outputs: {} }),
    true,
  );
  assert.equal(
    subscriptionRuns({ result: "skipped", outputs: {} }, { result: "skipped" }),
    false,
  );
  assert.equal(
    decide("subscription", {
      credentialSet: "true",
      reason: held.outputs["next-reason"],
    }).outputs["fallback-reason"],
    "credit-stop",
  );
  // Apply and status run once either leg ran, so a held key still applies
  // and reports the subscription job's triage.
  for (const name of ["apply", "status"]) {
    const runs = (claudeResult, subscriptionResult) =>
      Boolean(
        evaluate(workflow.jobs[name].if, {
          needs: {
            claude: { result: claudeResult },
            subscription: { result: subscriptionResult },
          },
        }),
      );
    assert.equal(runs("skipped", "success"), true, name);
    assert.equal(runs("success", "skipped"), true, name);
    assert.equal(runs("skipped", "skipped"), false, name);
  }
  // The claude job still reads the gate's choice in its credential step.
  const credential = claude.steps.find((step) => step.id === "credential");
  assert.equal(
    credential.with.selected,
    `\${{ needs.check-key-credit.outputs.next-leg }}`,
  );
  const run = (gateOutputs) =>
    decide("key", {
      selected: gateOutputs["next-leg"],
      fallbackSet: "true",
    }).outputs;
  assert.equal(run(select.start({ skipKey: true })).present, "false");
  assert.equal(run(select.start({ skipKey: true }))["key-skipped"], "true");
  assert.equal(run(select.start({ skipKey: false })).present, "true");
  assert.equal(run(select.start({ skipKey: false }))["key-skipped"], "false");
  // A failed gate job leaves next-leg empty: the key runs.
  assert.equal(run({}).present, "true");
  const upload = claude.steps.find(
    (step) => step.name === "Upload the key's credit-stop marker",
  );
  assert.equal(
    upload.with.name,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    "${{ needs.check-key-credit.outputs.marker }}",
  );
  assert.match(
    claude.steps.find((step) => step.id === "credit-marker").if,
    /steps\.claude\.outputs\.lane-class == 'credit-stop'/u,
  );
});
