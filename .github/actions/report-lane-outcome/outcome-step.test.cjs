"use strict";

// The validation-skip detection lives in the composite's own step script, not
// in classify.cjs, so these tests EXECUTE the shipped script text against a
// mock core. A regex over action.yml could not tell a success
// branch that requires execution evidence from one that does not, and the
// evidence check is the entire fix: a green step with no execution file is
// claude-code-action skipping itself, and it must never read as a review.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  makeTemporaryDirectory,
} = require("../../scripts/temporary-directories.cjs");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const actionSource = fs.readFileSync(
  path.join(__dirname, "action.yml"),
  "utf8",
);

// The shipped script IS the text under test. `script: |` is the final key in
// the file, so everything after the marker is the block; the dedent asserts
// every non-blank line carries the block indent rather than silently
// truncating on a stray line.
function stepScript() {
  const marker = "        script: |\n";
  const start = actionSource.indexOf(marker);
  assert.notEqual(start, -1, "the outcome step must carry a literal script");
  const body = actionSource.slice(start + marker.length);
  return body
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return "";
      assert.ok(
        line.startsWith(" ".repeat(10)),
        `script line lost the block indent: ${JSON.stringify(line)}`,
      );
      return line.slice(10);
    })
    .join("\n");
}

const temporaryDirectory = makeTemporaryDirectory("outcome-");

function writeExecutionFile(contents) {
  const file = path.join(temporaryDirectory, "execution.json");
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

async function runOutcome({
  outcome,
  executionFile,
  lane = "Claude review",
  startedAt = "",
  timeoutMinutes = "",
  credential = "",
  maxTurns = "",
  knownFailureClass = "",
  fallbackReason = "",
}) {
  const keys = [
    "LANE_OUTCOME",
    "EXECUTION_FILE",
    "LANE_NAME",
    "STEP_STARTED_AT",
    "STEP_TIMEOUT_MINUTES",
    "CREDENTIAL",
    "MAX_TURNS",
    "KNOWN_FAILURE_CLASS",
    "FALLBACK_REASON",
    "ACTION_PATH",
  ];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    LANE_OUTCOME: outcome,
    EXECUTION_FILE: executionFile,
    LANE_NAME: lane,
    STEP_STARTED_AT: startedAt,
    STEP_TIMEOUT_MINUTES: timeoutMinutes,
    CREDENTIAL: credential,
    MAX_TURNS: maxTurns,
    KNOWN_FAILURE_CLASS: knownFailureClass,
    FALLBACK_REASON: fallbackReason,
    ACTION_PATH: __dirname,
  });
  const outputs = {};
  const errors = [];
  const warnings = [];
  const failed = [];
  const infos = [];
  const notices = [];
  try {
    const core = {
      setOutput: (key, value) => (outputs[key] = value),
      error: (message) => errors.push(message),
      warning: (message) => warnings.push(message),
      info: (message) => infos.push(message),
      notice: (message) => notices.push(message),
      setFailed: (message) => failed.push(message),
    };
    const execute = new AsyncFunction(
      "core",
      "require",
      "process",
      stepScript(),
    );
    await execute(core, require, process);
    return { outputs, errors, warnings, failed, infos, notices };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

test("a success with execution evidence is a review that ran", async () => {
  const file = writeExecutionFile([
    { type: "result", subtype: "success", is_error: false, num_turns: 12 },
  ]);
  const { outputs, errors, warnings, failed } = await runOutcome({
    outcome: "success",
    executionFile: file,
  });
  assert.equal(outputs.review_failed, "false");
  assert.equal(outputs.review_ran, "true");
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(failed, []);
});

test("a success with no execution evidence is the validation-skip shape, not a review", async () => {
  // claude-code-action's workflow-validation guard exits 0 before running
  // anything, so the step concludes green while nothing was reviewed. The
  // step must say so machine-readably (a `class=` annotation on the check
  // run) without counting it as a failure — the skip is
  // expected on exactly the PRs that edit the caller workflow.
  for (const executionFile of [
    "",
    path.join(temporaryDirectory, "never-written.json"),
  ]) {
    const { outputs, errors, warnings } = await runOutcome({
      outcome: "success",
      executionFile,
    });
    assert.equal(outputs.review_failed, "false", executionFile);
    assert.equal(outputs.review_ran, "false", executionFile);
    assert.equal(outputs.failure_class, "skipped-validation", executionFile);
    assert.deepEqual(errors, [], executionFile);
    assert.equal(warnings.length, 1, executionFile);

    assert.match(warnings[0], /\bclass=skipped-validation\b/u, executionFile);
  }
});

test("a genuine failure still classifies and reports as failed", async () => {
  const file = writeExecutionFile([
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      api_error_status: 401,
    },
  ]);
  const { outputs, errors } = await runOutcome({
    outcome: "failure",
    executionFile: file,
  });
  assert.equal(outputs.review_failed, "true");
  assert.equal(outputs.review_ran, "false");
  assert.equal(outputs.failure_class, "auth");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\bclass=auth\b/u);
});

test("a caller's known failure class wins over reclassifying the file", async () => {
  const file = writeExecutionFile([
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      api_error_status: 401,
    },
  ]);
  const known = await runOutcome({
    outcome: "failure",
    executionFile: file,
    knownFailureClass: "timeout",
  });
  assert.equal(known.outputs.failure_class, "timeout");
  assert.match(known.errors[0], /\bclass=timeout\b/u);
  const unsafe = await runOutcome({
    outcome: "failure",
    executionFile: file,
    knownFailureClass: "Timeout; rm",
  });
  assert.equal(unsafe.outputs.failure_class, "auth");
});

test("a review the sandbox probe kept from starting is a failure of its own class", async () => {
  // The review lanes skip the model step when the bubblewrap probe fails and
  // pass the probe's class here, so the step's outcome is "skipped" with no
  // execution file. It must read as a failure, never as a review or a skip.
  const { outputs, errors, warnings } = await runOutcome({
    outcome: "skipped",
    executionFile: "",
    knownFailureClass: "sandbox-unavailable",
  });
  assert.equal(outputs.review_failed, "true");
  assert.equal(outputs.review_ran, "false");
  assert.equal(outputs.failure_class, "sandbox-unavailable");
  assert.deepEqual(warnings, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\bclass=sandbox-unavailable\b/u);
});

test("a usage limit reads as a skipped review and keeps the class token", async () => {
  const file = writeExecutionFile([
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      api_error_status: 429,
    },
  ]);
  const { outputs, errors } = await runOutcome({
    outcome: "failure",
    executionFile: file,
  });
  assert.equal(outputs.review_failed, "true");
  assert.equal(outputs.failure_class, "rate-limit");
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /^AI review skipped: usage limit reached; re-run after it resets/u,
  );
  assert.match(errors[0], /\bclass=rate-limit\b/u);
});

test("a usage limit on a lane that is not a review names the lane", async () => {
  const file = writeExecutionFile([
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      api_error_status: 429,
    },
  ]);
  const { errors } = await runOutcome({
    outcome: "failure",
    executionFile: file,
    lane: "Claude intake triage",
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /^Claude intake triage skipped: usage limit reached; re-run after it resets/u,
  );
  assert.doesNotMatch(errors[0], /AI review/u);
  assert.match(errors[0], /\bclass=rate-limit\b/u);
});

test("a failure with no execution file keeps the fail-path class, not the skip class", async () => {
  // The skip shape is specifically SUCCESS with no evidence. A failed step
  // with no file is an infrastructure failure classify.cjs already owns —
  // conflating the two would relabel real failures as benign skips.
  const { outputs } = await runOutcome({
    outcome: "failure",
    executionFile: "",
  });
  assert.equal(outputs.review_failed, "true");
  assert.equal(outputs.review_ran, "false");
  assert.equal(outputs.failure_class, "no-execution");
});

test("a failed step that ran its whole timeout-minutes is a timeout", async () => {
  // 11 minutes is 660 s; the step started 700 s ago, so it ran past its budget.
  const startedAt = String(Math.floor(Date.now() / 1000) - 700);
  const { outputs, errors } = await runOutcome({
    outcome: "failure",
    executionFile: "",
    startedAt,
    timeoutMinutes: "11",
  });
  assert.equal(outputs.review_failed, "true");
  assert.equal(outputs.failure_class, "timeout");
  assert.match(errors[0], /\bclass=timeout\b/u);
});

test("a failed step that stopped inside its budget, or reported no start, is not a timeout", async () => {
  // 600 s of an 11-minute (660 s) budget, then the two inputs left empty.
  for (const [startedAt, timeoutMinutes] of [
    [String(Math.floor(Date.now() / 1000) - 600), "11"],
    ["", ""],
  ]) {
    const { outputs } = await runOutcome({
      outcome: "failure",
      executionFile: "",
      startedAt,
      timeoutMinutes,
    });
    assert.equal(
      outputs.failure_class,
      "no-execution",
      `${startedAt}/${timeoutMinutes}`,
    );
  }
});

// 1767225600 is 2026-01-01T00:00:00Z in epoch seconds.
test("a limit stop puts resets, credential, turns, max-turns and models on the class line", async () => {
  const file = writeExecutionFile([
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1767225600,
        rateLimitType: "five_hour",
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 3,
      api_error_status: 429,
      modelUsage: { "claude-sonnet-5": {} },
    },
  ]);
  const { outputs, errors } = await runOutcome({
    outcome: "failure",
    executionFile: file,
    credential: "CLAUDE_CODE_OAUTH_TOKEN",
    maxTurns: "30",
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /\bclass=rate-limit resets=2026-01-01T00:00:00Z resets-window=five_hour credential=CLAUDE_CODE_OAUTH_TOKEN turns=3 max-turns=30 models=claude-sonnet-5\b/u,
  );
  assert.equal(outputs.resets_at, "2026-01-01T00:00:00Z");
});

test("a non-limit failure carries the record but no resets", async () => {
  const file = writeExecutionFile([
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1767225600 },
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      api_error_status: 401,
    },
  ]);
  const { outputs, errors } = await runOutcome({
    outcome: "failure",
    executionFile: file,
    credential: "CLAUDE_CODE_OAUTH_TOKEN",
  });
  assert.match(
    errors[0],
    /\bclass=auth credential=CLAUDE_CODE_OAUTH_TOKEN turns=1 /u,
  );
  assert.doesNotMatch(errors[0], /resets=/u);
  assert.equal(outputs.resets_at, undefined);
});

test("a success writes a notice with turn headroom and models, and no class", async () => {
  const file = writeExecutionFile([
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 11,
      modelUsage: { "claude-sonnet-5": {}, "claude-haiku-5": {} },
    },
  ]);
  const { outputs, errors, notices } = await runOutcome({
    outcome: "success",
    executionFile: file,
    maxTurns: "30",
  });
  assert.deepEqual(errors, []);
  assert.equal(outputs.review_ran, "true");
  assert.equal(notices.length, 1);
  assert.match(
    notices[0],
    /\bturns=11 max-turns=30 models=claude-sonnet-5,claude-haiku-5\b/u,
  );
  assert.doesNotMatch(notices[0], /class=/u);
});

test("a run that finished past its turn cap reads as max-turns with its turns and cap", async () => {
  // claude-code-plugins run 39038437240: 16 turns against a cap of 15.
  const file = writeExecutionFile([
    { type: "result", subtype: "success", is_error: false, num_turns: 16 },
  ]);
  const { outputs, errors } = await runOutcome({
    outcome: "failure",
    executionFile: file,
    lane: "Claude intake triage",
    maxTurns: "15",
  });
  assert.equal(outputs.failure_class, "max-turns");
  assert.equal(outputs.review_failed, "true");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\bclass=max-turns turns=16 max-turns=15\b/u);
});

// ci-workflows#806: the subscription job of the two-job pattern writes the
// run's one lane record, so it names why it ran beside the credential.
test("a fallback reason rides beside the credential on the notice and the class line", async () => {
  const succeeded = writeExecutionFile([
    { type: "result", subtype: "success", is_error: false, num_turns: 5 },
  ]);
  const ok = await runOutcome({
    outcome: "success",
    executionFile: succeeded,
    credential: "AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN",
    fallbackReason: "credit-stop",
  });
  assert.deepEqual(ok.failed, []);
  assert.equal(ok.notices.length, 1);
  assert.match(
    ok.notices[0],
    / credential=AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN fallback=credit-stop turns=5\b/u,
  );
  const authFailed = writeExecutionFile([
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      api_error_status: 401,
    },
  ]);
  const failed = await runOutcome({
    outcome: "failure",
    executionFile: authFailed,
    credential: "AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN",
    fallbackReason: "no-key",
  });
  assert.equal(failed.errors.length, 1);
  assert.match(
    failed.errors[0],
    /\bclass=auth credential=AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN fallback=no-key turns=1\b/u,
  );
  const none = await runOutcome({
    outcome: "success",
    executionFile: succeeded,
    credential: "AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN",
  });
  assert.doesNotMatch(none.notices[0], /fallback=/u);
});

test("a fallback reason outside credit-stop and no-key fails the step and reports nothing", async () => {
  const file = writeExecutionFile([
    { type: "result", subtype: "success", is_error: false, num_turns: 5 },
  ]);
  for (const outcome of ["success", "failure"]) {
    for (const fallbackReason of ["auth", "Credit-Stop", " credit-stop"]) {
      const run = await runOutcome({
        outcome,
        executionFile: file,
        fallbackReason,
      });
      const label = `${outcome}/${JSON.stringify(fallbackReason)}`;
      assert.equal(run.failed.length, 1, label);
      assert.match(run.failed[0], /credit-stop/u, label);
      assert.match(run.failed[0], /no-key/u, label);
      assert.deepEqual(run.notices, [], label);
      assert.deepEqual(run.errors, [], label);
      assert.deepEqual(run.warnings, [], label);
      assert.deepEqual(run.outputs, {}, label);
    }
  }
});
