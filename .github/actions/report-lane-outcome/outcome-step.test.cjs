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
}) {
  const keys = [
    "LANE_OUTCOME",
    "EXECUTION_FILE",
    "LANE_NAME",
    "STEP_STARTED_AT",
    "STEP_TIMEOUT_MINUTES",
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
    ACTION_PATH: __dirname,
  });
  const outputs = {};
  const errors = [];
  const warnings = [];
  const failed = [];
  const infos = [];
  try {
    const core = {
      setOutput: (key, value) => (outputs[key] = value),
      error: (message) => errors.push(message),
      warning: (message) => warnings.push(message),
      info: (message) => infos.push(message),
      setFailed: (message) => failed.push(message),
    };
    const execute = new AsyncFunction(
      "core",
      "require",
      "process",
      stepScript(),
    );
    await execute(core, require, process);
    return { outputs, errors, warnings, failed, infos };
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
  assert.equal(outputs.failure_class, "other");
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
      "other",
      `${startedAt}/${timeoutMinutes}`,
    );
  }
});
