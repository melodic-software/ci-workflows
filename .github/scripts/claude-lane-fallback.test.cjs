"use strict";

// With the optional fallback token, a review whose first attempt stops on a
// usage limit (class rate-limit) is retried once in the same job on that
// token, inside the review step's budget, and everything after reads the
// attempt that counts. Without the token the job makes one attempt. These
// tests pin the gates, run the prepare and pick steps' own scripts, and hold
// the fallback step equal to the first attempt but for its token.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsRoot = path.join(__dirname, "..", "workflows");
const SECRET = "fallback-claude-code-oauth-token";

function runBash(script, env) {
  const output = path.join(makeTemporaryDirectory("fallback-"), "out");
  fs.writeFileSync(output, "");
  const result = spawnSync("bash", ["-e", "-c", script], {
    env: { PATH: process.env.PATH, ...env, GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const values = Object.fromEntries(
    fs
      .readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/su).slice(0, 2)),
  );
  return { values, stdout: result.stdout };
}

for (const file of ["pr-review.yml", "pr-review-security.yml"]) {
  const workflow = parseWorkflow(
    fs.readFileSync(path.join(workflowsRoot, file), "utf8"),
  );
  const steps = workflow.jobs.claude.steps;
  const byId = (id) => steps.find((step) => step.id === id);
  const first = byId("claude-review");
  const budget = first["timeout-minutes"];

  test(`${file}: the fallback token is an optional secret beside the required one`, () => {
    const secrets = workflow.on.workflow_call.secrets;
    assert.equal(secrets.CLAUDE_CODE_OAUTH_TOKEN.required, true);
    assert.equal(secrets[SECRET].required, false);
    assert.equal(
      first.with.claude_code_oauth_token,
      `\${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`,
    );
    assert.equal(
      byId("claude-review-fallback").with.claude_code_oauth_token,
      `\${{ secrets.${SECRET} }}`,
    );
  });

  test(`${file}: the fallback attempt repeats the first but for its token and gates`, () => {
    const fallback = byId("claude-review-fallback");
    const withoutToken = ({ claude_code_oauth_token, ...rest }) => rest;
    assert.deepEqual(withoutToken(fallback.with), withoutToken(first.with));
    assert.deepEqual(fallback.env, first.env);
    assert.equal(fallback.uses, first.uses);
    assert.equal(fallback["continue-on-error"], true);
    assert.equal(fallback.if, "steps.fallback.outputs.run == 'true'");
    assert.equal(
      fallback["timeout-minutes"],
      `\${{ fromJSON(steps.fallback.outputs.timeout-minutes || '${budget}') }}`,
    );
  });

  test(`${file}: only a failed first attempt with a fallback token is classified, and only a usage limit retries`, () => {
    const classify = byId("first-outcome");
    assert.equal(classify.uses, "$/.github/actions/report-lane-outcome");
    assert.equal(
      classify.if.replace(/\s+/gu, " "),
      "steps.scope.outputs.review != 'false' && steps.compose-args.outputs.fallback == 'true' && steps.claude-review.outcome == 'failure'",
    );
    assert.equal(classify.with.outcome, `\${{ steps.claude-review.outcome }}`);
    assert.equal(
      byId("fallback").if,
      "steps.first-outcome.outputs.failure-class == 'rate-limit'",
    );
    const order = [
      "claude-review",
      "first-outcome",
      "fallback",
      "claude-review-fallback",
      "attempt",
      "verify",
      "review-outcome",
    ];
    const indexes = order.map((id) => steps.indexOf(byId(id)));
    assert.deepEqual(
      [...indexes].sort((a, b) => a - b),
      indexes,
      "steps out of order",
    );
  });

  test(`${file}: the fallback attempt gets what is left of the review budget, and none under 2 minutes`, () => {
    const prepare = byId("fallback");
    const now = Math.floor(Date.now() / 1000);
    // budget 11: 660 s - 30 s used = 630 s, 10 whole minutes; budget 14:
    // 840 - 30 = 810 s, 13 whole minutes. A second's tick keeps both.
    const early = runBash(prepare.run, {
      ...prepare.env,
      STARTED_AT: String(now - 30),
    });
    assert.equal(early.values.run, "true");
    assert.equal(early.values["timeout-minutes"], String(budget - 1));
    assert.ok(Number(early.values["started-at"]) >= now);
    // 100 s or less left: 1 whole minute, below the 2-minute floor.
    const late = runBash(prepare.run, {
      ...prepare.env,
      STARTED_AT: String(now - (budget * 60 - 100)),
    });
    assert.deepEqual(late.values, {});
    assert.match(late.stdout, /^::warning::Usage limit/mu);
  });

  test(`${file}: everything after the attempts reads the one that counts`, () => {
    const pick = byId("attempt");
    const values = {
      FIRST_OUTCOME: "failure",
      FIRST_EXECUTION_FILE: "/tmp/first.json",
      FIRST_STARTED_AT: "100",
      FIRST_TIMEOUT_MINUTES: pick.env.FIRST_TIMEOUT_MINUTES,
      FALLBACK_OUTCOME: "success",
      FALLBACK_EXECUTION_FILE: "/tmp/fallback.json",
      FALLBACK_STARTED_AT: "160",
      FALLBACK_TIMEOUT_MINUTES: "9",
    };
    assert.deepEqual(
      runBash(pick.run, { ...values, FALLBACK_RAN: "true" }).values,
      {
        account: "fallback",
        outcome: "success",
        "execution-file": "/tmp/fallback.json",
        "started-at": "160",
        "timeout-minutes": "9",
      },
    );
    for (const ran of ["", "false"]) {
      assert.deepEqual(
        runBash(pick.run, { ...values, FALLBACK_RAN: ran }).values,
        {
          account: "primary",
          outcome: "failure",
          "execution-file": "/tmp/first.json",
          "started-at": "100",
          "timeout-minutes": String(budget),
        },
      );
    }
  });
}
