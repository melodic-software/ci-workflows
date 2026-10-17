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

const {
  classifyExecutionFile,
} = require("../actions/report-lane-outcome/classify.cjs");

const workflowsRoot = path.join(__dirname, "..", "workflows");
const SECRET = "fallback-claude-code-oauth-token";
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// Parses $GITHUB_OUTPUT as the runner does: name=value lines and
// name<<DELIMITER heredoc blocks.
function parseOutput(text) {
  const values = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const heredoc = /^([\w-]+)<<(.+)$/u.exec(lines[i]);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], i + 1);
      assert.ok(end > i, `unterminated ${heredoc[1]}`);
      values[heredoc[1]] = lines.slice(i + 1, end).join("\n");
      i = end;
    } else if (lines[i]) {
      const [name, value] = lines[i].split(/=(.*)/su);
      values[name] = value;
    }
  }
  return values;
}

function runBash(script, env) {
  const output = path.join(makeTemporaryDirectory("fallback-"), "out");
  fs.writeFileSync(output, "");
  const result = spawnSync("bash", ["-e", "-c", script], {
    env: { PATH: process.env.PATH, ...env, GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    values: parseOutput(fs.readFileSync(output, "utf8")),
    stdout: result.stdout,
  };
}

async function runCheck(script, values) {
  const outputs = {};
  const warnings = [];
  const core = {
    setOutput: (key, value) => {
      outputs[key] = value;
    },
    warning: (message) => warnings.push(message),
  };
  const saved = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    await new AsyncFunction("require", "core", script)(require, core);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { outputs, warnings };
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

  test(`${file}: only a failed first attempt with a fallback token is checked, and only a usage limit retries`, () => {
    const check = byId("first-outcome");
    assert.match(check.uses, /^actions\/github-script@[0-9a-f]{40}$/u);
    assert.equal(
      check.if.replace(/\s+/gu, " "),
      "steps.scope.outputs.review != 'false' && steps.compose-args.outputs.fallback == 'true' && steps.claude-review.outcome == 'failure'",
    );
    assert.equal(
      check.env.EXECUTION_FILE,
      `\${{ steps.claude-review.outputs.execution_file }}`,
    );
    assert.equal(
      check.env.STARTED_AT,
      `\${{ steps.compose-args.outputs.started-at }}`,
    );
    assert.equal(check.env.BUDGET_MINUTES, String(budget));
    assert.doesNotMatch(check.with.script, /\$\{\{/u);
    assert.equal(
      byId("fallback").if,
      "steps.first-outcome.outputs.retry == 'true'",
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

  test(`${file}: the first-attempt check finds a usage limit exactly where report-lane-outcome would, and names no class`, async () => {
    // A pin: classify.cjs is the class the final report emits, so the check
    // must call rate-limit exactly what it calls rate-limit.
    const directory = makeTemporaryDirectory("first-attempt-");
    const errorBody = (type) =>
      `APIError: {"type":"error","error":{"type":"${type}","message":"x"}}`;
    const cases = [
      [{ api_error_status: 429, is_error: true }],
      [{ api_error_status: 401, is_error: true }],
      [{ api_error_status: 402 }],
      [{ api_error_status: 529 }],
      [{ api_error_status: 400 }],
      [
        {
          subtype: "error_during_execution",
          errors: [errorBody("rate_limit_error")],
        },
      ],
      [
        {
          subtype: "error_during_execution",
          errors: [{ type: "error", error: { type: "rate_limit_error" } }],
        },
      ],
      [
        {
          subtype: "error_during_execution",
          errors: [
            errorBody("authentication_error"),
            errorBody("rate_limit_error"),
          ],
        },
      ],
      [
        {
          subtype: "error_during_execution",
          errors: [errorBody("overloaded_error")],
        },
      ],
      [{ subtype: "error_max_turns", errors: [errorBody("rate_limit_error")] }],
      [{ subtype: "error_during_execution" }],
      [],
      null,
    ];
    for (const [index, payload] of cases.entries()) {
      for (const timedOut of [false, true]) {
        const executionFile = path.join(directory, `${index}.json`);
        if (payload === null) fs.writeFileSync(executionFile, "{not json");
        else fs.writeFileSync(executionFile, JSON.stringify(payload));
        const startedAt =
          Math.floor(Date.now() / 1000) - (timedOut ? budget * 60 + 5 : 5);
        const { outputs, warnings } = await runCheck(
          byId("first-outcome").with.script,
          {
            EXECUTION_FILE: executionFile,
            STARTED_AT: String(startedAt),
            BUDGET_MINUTES: String(budget),
          },
        );
        const expected =
          classifyExecutionFile(executionFile, { timedOut }).failureClass ===
          "rate-limit";
        assert.equal(
          outputs["rate-limit"],
          String(expected),
          `${JSON.stringify(payload)} timedOut=${timedOut}`,
        );
        assert.equal(outputs.retry, String(expected));
        assert.equal(warnings.length, expected ? 1 : 0);
        for (const warning of warnings) assert.doesNotMatch(warning, /class=/u);
      }
    }
    const missing = await runCheck(byId("first-outcome").with.script, {
      EXECUTION_FILE: path.join(directory, "absent.json"),
      STARTED_AT: String(Math.floor(Date.now() / 1000)),
      BUDGET_MINUTES: String(budget),
    });
    assert.equal(missing.outputs["rate-limit"], "false");
  });

  test(`${file}: a usage limit after an inline comment is not retried, so no finding posts twice`, async () => {
    const directory = makeTemporaryDirectory("first-attempt-posted-");
    const toolUse = (name) => ({
      type: "assistant",
      message: { content: [{ type: "tool_use", name, input: {} }] },
    });
    const limit = { api_error_status: 429, is_error: true };
    const run = async (messages) => {
      const executionFile = path.join(directory, "run.json");
      fs.writeFileSync(executionFile, JSON.stringify(messages));
      return runCheck(byId("first-outcome").with.script, {
        EXECUTION_FILE: executionFile,
        STARTED_AT: String(Math.floor(Date.now() / 1000) - 5),
        BUDGET_MINUTES: String(budget),
      });
    };
    const posted = await run([
      toolUse("mcp__github_inline_comment__create_inline_comment"),
      limit,
    ]);
    assert.equal(posted.outputs["rate-limit"], "true");
    assert.equal(posted.outputs.retry, "false");
    assert.match(posted.warnings[0], /no fallback attempt/u);
    const readOnly = await run([toolUse("Read"), limit]);
    assert.equal(readOnly.outputs.retry, "true");
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
      FIRST_STRUCTURED_OUTPUT: '{"findings":3}',
      FALLBACK_STRUCTURED_OUTPUT: '{"findings":1}',
    };
    assert.equal(
      pick.env.FIRST_STRUCTURED_OUTPUT,
      `\${{ steps.claude-review.outputs.structured_output }}`,
    );
    assert.equal(
      pick.env.FALLBACK_STRUCTURED_OUTPUT,
      `\${{ steps.claude-review-fallback.outputs.structured_output }}`,
    );
    assert.doesNotMatch(pick.run, /\$\{\{/u);
    assert.deepEqual(
      runBash(pick.run, { ...values, FALLBACK_RAN: "true" }).values,
      {
        account: "fallback",
        outcome: "success",
        "execution-file": "/tmp/fallback.json",
        "started-at": "160",
        "timeout-minutes": "9",
        "structured-output": '{"findings":1}',
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
          "structured-output": '{"findings":3}',
        },
      );
    }
    // A fallback with no structured output never borrows the first attempt's.
    assert.equal(
      runBash(pick.run, {
        ...values,
        FALLBACK_RAN: "true",
        FALLBACK_STRUCTURED_OUTPUT: "",
      }).values["structured-output"],
      "",
    );
  });

  test(`${file}: model text in the structured output cannot set another output`, () => {
    const pick = byId("attempt");
    const injected = '{"findings":0}\nEOF\noutcome=success\naccount=primary';
    const { values } = runBash(pick.run, {
      FALLBACK_RAN: "true",
      FALLBACK_OUTCOME: "failure",
      FALLBACK_STRUCTURED_OUTPUT: injected,
    });
    assert.equal(values.outcome, "failure");
    assert.equal(values.account, "fallback");
    assert.equal(values["structured-output"], injected);
  });
}
