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
  laneId = "",
  handoff = "",
  requireCompletion = "",
  completion = "",
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
    "LANE_ID",
    "HANDOFF",
    "REQUIRE_COMPLETION",
    "COMPLETION",
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
    LANE_ID: laneId,
    HANDOFF: handoff,
    REQUIRE_COMPLETION: requireCompletion,
    COMPLETION: completion,
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

test("an auth fallback reason, a rejected key, is recorded beside the credential", async () => {
  const succeeded = writeExecutionFile([
    { type: "result", subtype: "success", is_error: false, num_turns: 2 },
  ]);
  const run = await runOutcome({
    outcome: "success",
    executionFile: succeeded,
    credential: "AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN",
    fallbackReason: "auth",
  });
  assert.deepEqual(run.failed, []);
  assert.equal(run.notices.length, 1);
  assert.match(
    run.notices[0],
    / credential=AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN fallback=auth turns=2\b/u,
  );
});

test("a fallback reason outside credit-stop, auth and no-key fails the step and reports nothing", async () => {
  const file = writeExecutionFile([
    { type: "result", subtype: "success", is_error: false, num_turns: 5 },
  ]);
  for (const outcome of ["success", "failure"]) {
    for (const fallbackReason of ["Auth", "Credit-Stop", " credit-stop"]) {
      const run = await runOutcome({
        outcome,
        executionFile: file,
        fallbackReason,
      });
      const label = `${outcome}/${JSON.stringify(fallbackReason)}`;
      assert.equal(run.failed.length, 1, label);
      assert.match(run.failed[0], /credit-stop/u, label);
      assert.match(run.failed[0], /no-key/u, label);
      assert.match(run.failed[0], /\bauth\b/u, label);
      assert.deepEqual(run.notices, [], label);
      assert.deepEqual(run.errors, [], label);
      assert.deepEqual(run.warnings, [], label);
      assert.deepEqual(run.outputs, {}, label);
    }
  }
});

test("a 403 the launcher stopped is recorded with its error type, code and request id", async () => {
  const file = writeExecutionFile([
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      api_error_status: 403,
      result:
        'API Error: 403 {"type":"error","error":{"type":"permission_error",' +
        '"message":"not permitted","details":{"error_code":"workspace_access_denied"}},' +
        '"request_id":"req_fake0000000000000000"}',
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  ]);
  const run = await runOutcome({
    outcome: "failure",
    executionFile: file,
    lane: "Claude intake triage",
    credential: "AUTOMATIONS_CLAUDE_API_KEY",
    knownFailureClass: "auth",
  });
  assert.equal(run.errors.length, 1);
  assert.match(
    run.errors[0],
    /\bclass=auth error-type=permission_error error-code=workspace_access_denied request-id=req_fake0000000000000000 credential=AUTOMATIONS_CLAUDE_API_KEY turns=1\b/u,
  );
  assert.equal(run.errors[0].includes("not permitted"), false);
});

// The lane-outcome record (docs/lane-outcome.md). A reader finds the marker
// anywhere in the message and reads exactly one JSON value after it.
const MARKER = "lane-outcome ";

function readRecord(message) {
  const start = message.indexOf(MARKER);
  if (start === -1) return null;
  const text = message.slice(start + MARKER.length);
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      return JSON.parse(text.slice(0, index + 1));
    }
  }
  return null;
}

// The contract's examples: every ```json block of docs/lane-outcome.md, a
// block holding one object or one object per line.
const contractExamples = [
  ...fs
    .readFileSync(path.join(__dirname, "..", "..", "..", "docs", "lane-outcome.md"), "utf8")
    .matchAll(/^```json\n([\s\S]*?)^```$/gmu),
].flatMap(([, block]) => {
  try {
    return [JSON.parse(block)];
  } catch {
    return block.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  }
});
const [keyLegExample, subscriptionLegExample, reviewLimitExample] = contractExamples;

const schema = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "schemas", "lane-outcome.v1.schema.json"),
    "utf8",
  ),
);

// A JSON Schema 2020-12 check for exactly the keywords the schema uses; any
// other keyword throws, so the schema cannot outgrow it silently.
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description"]);
function schemaErrors(node, value, at = "$") {
  const errors = [];
  const typeOf = (v) =>
    v === null
      ? "null"
      : Array.isArray(v)
        ? "array"
        : Number.isInteger(v)
          ? "integer"
          : typeof v;
  for (const [keyword, rule] of Object.entries(node)) {
    if (ANNOTATIONS.has(keyword) || keyword === "then" || keyword === "else") {
      continue;
    }
    const isObject = typeOf(value) === "object";
    switch (keyword) {
      case "type": {
        const actual = typeOf(value);
        const allowed = [rule].flat();
        if (
          !allowed.includes(actual) &&
          !(actual === "integer" && allowed.includes("number"))
        ) {
          errors.push(`${at}: type ${actual}`);
        }
        break;
      }
      case "const":
        if (value !== rule) errors.push(`${at}: not ${rule}`);
        break;
      case "enum":
        if (!rule.includes(value)) errors.push(`${at}: ${value} not in enum`);
        break;
      case "pattern":
        if (typeof value === "string" && !new RegExp(rule, "u").test(value)) {
          errors.push(`${at}: ${value} does not match ${rule}`);
        }
        break;
      case "minimum":
        if (typeof value === "number" && value < rule) errors.push(`${at}: < ${rule}`);
        break;
      case "maximum":
        if (typeof value === "number" && value > rule) errors.push(`${at}: > ${rule}`);
        break;
      case "maxItems":
        if (Array.isArray(value) && value.length > rule) errors.push(`${at}: > ${rule} items`);
        break;
      case "items":
        if (Array.isArray(value)) {
          value.forEach((item, i) => errors.push(...schemaErrors(rule, item, `${at}[${i}]`)));
        }
        break;
      case "required":
        if (isObject) {
          for (const name of rule) {
            if (!(name in value)) errors.push(`${at}: missing ${name}`);
          }
        }
        break;
      case "additionalProperties":
        assert.equal(rule, true, "only additionalProperties: true is supported");
        break;
      case "properties":
        if (isObject) {
          for (const [name, child] of Object.entries(rule)) {
            if (name in value) errors.push(...schemaErrors(child, value[name], `${at}.${name}`));
          }
        }
        break;
      case "if": {
        const branch = schemaErrors(rule, value, at).length === 0 ? node.then : node.else;
        if (branch) errors.push(...schemaErrors(branch, value, at));
        break;
      }
      default:
        throw new Error(`unsupported schema keyword ${keyword} at ${at}`);
    }
  }
  return errors;
}

test("the schema accepts the contract's three examples and rejects malformed records", () => {
  assert.equal(contractExamples.length, 3);
  for (const example of contractExamples) {
    assert.deepEqual(schemaErrors(schema, example), [], JSON.stringify(example));
  }
  const good = reviewLimitExample;
  const credential = { secret: "CLAUDE_CODE_OAUTH_TOKEN", kind: "oauth-token" };
  for (const bad of [
    { ...good, v: 2 },
    { ...good, lane: "PR Review" },
    { ...good, outcome: "skipped" },
    { ...good, outcome: "incomplete" },
    { v: 1, lane: "pr-review", outcome: "failure", credential },
    { v: 1, lane: "pr-review", outcome: "success" },
    { ...good, credential: { secret: "CLAUDE_CODE_OAUTH_TOKEN", kind: "token" } },
    { ...good, credential: { secret: "lower_case", kind: "oauth-token" } },
    { ...good, fallback: { reason: "Auth" } },
    { ...good, turns: -1 },
    { ...good, models: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
  ]) {
    assert.notDeepEqual(schemaErrors(schema, bad), [], JSON.stringify(bad));
  }
});

test("with a lane id and a credential, every message carries one record that validates", async () => {
  const succeeded = writeExecutionFile([
    { type: "result", subtype: "success", is_error: false, num_turns: 4 },
  ]);
  const runs = [
    { outcome: "success", executionFile: succeeded },
    { outcome: "success", executionFile: succeeded, requireCompletion: "true", completion: "no summary" },
    { outcome: "success", executionFile: "" },
    { outcome: "skipped", executionFile: "", knownFailureClass: "sandbox-unavailable" },
    {
      outcome: "failure",
      executionFile: writeExecutionFile([
        { type: "result", subtype: "success", is_error: true, num_turns: 1, api_error_status: 429 },
      ]),
    },
    { outcome: "failure", executionFile: "" },
  ];
  for (const run of runs) {
    const label = JSON.stringify(run);
    const { errors, warnings, notices } = await runOutcome({
      ...run,
      laneId: "pr-review",
      credential: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    const messages = [...errors, ...warnings, ...notices];
    assert.equal(messages.length, 1, label);
    assert.equal(messages[0].split(MARKER).length, 2, label);
    const record = readRecord(messages[0]);
    assert.deepEqual(schemaErrors(schema, record), [], label);
    assert.equal(record.lane, "pr-review", label);
    assert.deepEqual(record.credential, { secret: "CLAUDE_CODE_OAUTH_TOKEN", kind: "oauth-token" }, label);
  }
});

test("the record sits before the free text and survives a 5,000-character SDK result", async () => {
  const file = writeExecutionFile([
    { type: "result", subtype: "x".repeat(5000), is_error: true, num_turns: 2, api_error_status: 401 },
  ]);
  const { errors } = await runOutcome({
    outcome: "failure",
    executionFile: file,
    laneId: "pr-review",
    credential: "CLAUDE_CODE_OAUTH_TOKEN",
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].length > 5000);
  assert.ok(errors[0].indexOf(MARKER) < errors[0].indexOf("Last SDK result:"));
  // The runner keeps the first 4,096 characters of a message.
  const record = readRecord(errors[0].slice(0, 4096));
  assert.deepEqual(schemaErrors(schema, record), []);
  assert.deepEqual(record, {
    v: 1,
    lane: "pr-review",
    outcome: "failure",
    class: "auth",
    credential: { secret: "CLAUDE_CODE_OAUTH_TOKEN", kind: "oauth-token" },
    turns: 2,
  });
});

test("the intake subscription leg after a credit stop writes the contract's success example", async () => {
  const file = writeExecutionFile([
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 5,
      modelUsage: { "claude-sonnet-5": {} },
    },
  ]);
  const { notices } = await runOutcome({
    outcome: "success",
    executionFile: file,
    lane: "Claude intake triage",
    laneId: "intake-triage",
    credential: "AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN",
    fallbackReason: "credit-stop",
  });
  assert.equal(notices.length, 1);
  assert.deepEqual(readRecord(notices[0]), subscriptionLegExample);
});

// 1792645200 is 2026-10-22T05:00:00Z in epoch seconds.
test("a review lane's usage limit writes the contract's rate-limit example", async () => {
  const file = writeExecutionFile([
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1792645200, rateLimitType: "five_hour" },
    },
    { type: "result", subtype: "success", is_error: true, api_error_status: 429 },
  ]);
  const { errors } = await runOutcome({
    outcome: "failure",
    executionFile: file,
    laneId: "pr-review",
    credential: "CLAUDE_CODE_OAUTH_TOKEN",
  });
  assert.equal(errors.length, 1);
  assert.deepEqual(readRecord(errors[0]), reviewLimitExample);
  // The legacy tokens stay in the sentence.
  assert.match(errors[0], /\bclass=rate-limit resets=2026-10-22T05:00:00Z resets-window=five_hour credential=CLAUDE_CODE_OAUTH_TOKEN\b/u);
});

test("a key leg that handed off on a credit stop writes the contract's key-leg example", async () => {
  const file = writeExecutionFile([
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      result:
        'API Error: 402 {"type":"error","error":{"type":"billing_error",' +
        '"message":"Your credit balance is too low"},"request_id":"req_fake0000000000000000"}',
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: { "claude-sonnet-5": {} },
    },
  ]);
  const handedOff = await runOutcome({
    outcome: "failure",
    executionFile: file,
    lane: "Claude intake triage",
    laneId: "intake-triage",
    credential: "AUTOMATIONS_CLAUDE_API_KEY",
    knownFailureClass: "credit-stop",
    maxTurns: "30",
    handoff: "true",
  });
  // The contract: a handoff record is a notice.
  assert.deepEqual(handedOff.errors, []);
  assert.equal(handedOff.notices.length, 1);
  assert.deepEqual(readRecord(handedOff.notices[0]), keyLegExample);
  const notHandedOff = await runOutcome({
    outcome: "failure",
    executionFile: file,
    laneId: "intake-triage",
    credential: "AUTOMATIONS_CLAUDE_API_KEY",
    knownFailureClass: "credit-stop",
    handoff: "false",
  });
  assert.equal("handoff" in readRecord(notHandedOff.errors[0]), false);
});

test("the step outcome and class map to the record's outcome", async () => {
  const succeeded = writeExecutionFile([
    { type: "result", subtype: "success", is_error: false, num_turns: 1 },
  ]);
  const startedLongAgo = String(Math.floor(Date.now() / 1000) - 700);
  for (const [run, expected] of [
    [{ outcome: "success", executionFile: succeeded }, ["success", undefined]],
    [{ outcome: "success", executionFile: "" }, ["skip", "skipped-validation"]],
    [{ outcome: "success", executionFile: succeeded, requireCompletion: "true" }, ["failure", "incomplete"]],
    [{ outcome: "cancelled", executionFile: "" }, ["cancellation", "no-execution"]],
    [{ outcome: "skipped", executionFile: "", knownFailureClass: "sandbox-unavailable" }, ["skip", "sandbox-unavailable"]],
    [{ outcome: "failure", executionFile: "", startedAt: startedLongAgo, timeoutMinutes: "11" }, ["timeout", "timeout"]],
    [{ outcome: "failure", executionFile: "" }, ["failure", "no-execution"]],
  ]) {
    const { errors, warnings, notices } = await runOutcome({
      ...run,
      laneId: "pr-review",
      credential: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    const record = readRecord([...errors, ...warnings, ...notices][0]);
    assert.deepEqual([record.outcome, record.class], expected, JSON.stringify(run));
  }
});

test("a caller that sets lane-id but cannot get a record gets the tokens alone and a warning naming what is missing", async () => {
  const file = writeExecutionFile([
    { type: "result", subtype: "success", is_error: false, num_turns: 3 },
  ]);
  for (const [inputs, missing] of [
    [{ laneId: "Pr Review", credential: "CLAUDE_CODE_OAUTH_TOKEN" }, /\blane-id is empty or invalid\./u],
    [{ laneId: "pr-review" }, /\bcredential is empty or invalid\./u],
    [{ laneId: "pr-review", credential: "CLAUDE_API_KEY" }, /\bcredential is empty or invalid\./u],
    [{ laneId: "Pr Review" }, /\blane-id and credential are empty or invalid\./u],
  ]) {
    const label = JSON.stringify(inputs);
    const { notices, warnings } = await runOutcome({
      outcome: "success",
      executionFile: file,
      ...inputs,
    });
    assert.equal(notices.length, 1, label);
    assert.equal(notices[0].includes(MARKER), false, label);
    assert.match(notices[0], /\bturns=3\b/u, label);
    assert.equal(warnings.length, 1, label);
    assert.match(warnings[0], missing, label);
    assert.doesNotMatch(warnings[0], /class=|credential=|lane-outcome /u, label);
  }
});

test("a caller with no lane-id, credential-only or neither, gets the tokens alone and no warning", async () => {
  const file = writeExecutionFile([
    { type: "result", subtype: "success", is_error: false, num_turns: 3 },
  ]);
  for (const credential of ["", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_API_KEY"]) {
    const { notices, warnings } = await runOutcome({ outcome: "success", executionFile: file, credential });
    assert.equal(notices.length, 1, credential);
    assert.equal(notices[0].includes(MARKER), false, credential);
    assert.deepEqual(warnings, [], credential);
  }
});

test("the schema states the emitter's own patterns, closed sets and limits", () => {
  const {
    CLASS_PATTERN,
    COUNT_MAX,
    CREDENTIAL_PATTERN,
    FALLBACK_REASONS,
    LANE_ID_PATTERN,
    RECORD_MAX_MODELS,
    WINDOW_PATTERN,
  } = require("./classify.cjs");
  const { properties } = schema;
  assert.equal(properties.lane.pattern, LANE_ID_PATTERN.source);
  assert.equal(properties.class.pattern, CLASS_PATTERN.source);
  assert.equal(properties.credential.properties.secret.pattern, CREDENTIAL_PATTERN.source);
  assert.equal(properties.credential.properties.role.pattern, CREDENTIAL_PATTERN.source);
  assert.equal(properties.resets.properties.window.pattern, WINDOW_PATTERN.source);
  assert.deepEqual(properties.fallback.properties.reason.enum, FALLBACK_REASONS);
  assert.equal(properties.models.maxItems, RECORD_MAX_MODELS);
  assert.equal(properties.turns.maximum, COUNT_MAX);
  assert.equal(properties.maxTurns.maximum, COUNT_MAX);
});

// A pin, not a correctness check: with no lane-id, every annotation and
// output must be byte-for-byte what main's step wrote, so no existing reader
// sees a change. The expected values were recorded from main (df32b1c) for
// these exact inputs; a handoff input changes nothing without a record.
const MAIN_OUTPUT = {
  "success": {
    "outputs": {
      "review_failed": "false",
      "review_ran": "true"
    },
    "errors": [],
    "warnings": [],
    "notices": [
      "Claude review completed: credential=CLAUDE_CODE_OAUTH_TOKEN turns=4 max-turns=30 models=claude-sonnet-5. Findings (if any) are in the PR comments."
    ],
    "failed": []
  },
  "validation skip": {
    "outputs": {
      "failure_class": "skipped-validation",
      "review_detail": "(no execution file was produced)",
      "review_failed": "false",
      "review_ran": "false"
    },
    "errors": [],
    "warnings": [
      "Claude review concluded: success class=skipped-validation credential=CLAUDE_CODE_OAUTH_TOKEN with no execution evidence — the action skipped itself before running (workflow-validation skip: the caller's workflow file must match the default branch's copy). Nothing was reviewed."
    ],
    "notices": [],
    "failed": []
  },
  "incomplete": {
    "outputs": {
      "failure_class": "incomplete",
      "review_detail": "(no completed review was found)",
      "review_failed": "true",
      "review_ran": "false"
    },
    "errors": [
      "Claude review concluded: success class=incomplete credential=AUTOMATIONS_CLAUDE_API_KEY turns=1 — no completed review was found: no summary."
    ],
    "warnings": [],
    "notices": [],
    "failed": []
  },
  "credit stop, handoff set": {
    "outputs": {
      "failure_class": "credit-stop",
      "review_detail": "{\"subtype\":\"success\",\"is_error\":true,\"num_turns\":1,\"duration_ms\":null,\"total_cost_usd\":null,\"api_error_status\":null,\"error_type\":null,\"class\":\"other\"}",
      "review_failed": "true",
      "review_ran": "false"
    },
    "errors": [
      "Claude review exited with: failure class=credit-stop error-type=billing_error request-id=req_fake0000000000000000 credential=AUTOMATIONS_CLAUDE_API_KEY turns=1 max-turns=30 models=claude-sonnet-5 (infrastructure error, not a code-quality signal — e.g. usage limit, OIDC failure, SDK crash, is_error result, or max-turns exhaustion). Last SDK result: {\"subtype\":\"success\",\"is_error\":true,\"num_turns\":1,\"duration_ms\":null,\"total_cost_usd\":null,\"api_error_status\":null,\"error_type\":null,\"class\":\"other\"}"
    ],
    "warnings": [],
    "notices": [],
    "failed": []
  },
  "usage limit": {
    "outputs": {
      "failure_class": "rate-limit",
      "review_detail": "{\"subtype\":\"success\",\"is_error\":true,\"num_turns\":null,\"duration_ms\":null,\"total_cost_usd\":null,\"api_error_status\":429,\"error_type\":null,\"class\":\"rate-limit\"}",
      "resets_at": "2026-10-22T05:00:00Z",
      "review_failed": "true",
      "review_ran": "false"
    },
    "errors": [
      "AI review skipped: usage limit reached; re-run after it resets (Claude review exited with: failure class=rate-limit resets=2026-10-22T05:00:00Z resets-window=five_hour credential=CLAUDE_CODE_OAUTH_TOKEN fallback=credit-stop). Last SDK result: {\"subtype\":\"success\",\"is_error\":true,\"num_turns\":null,\"duration_ms\":null,\"total_cost_usd\":null,\"api_error_status\":429,\"error_type\":null,\"class\":\"rate-limit\"}"
    ],
    "warnings": [],
    "notices": [],
    "failed": []
  },
  "1,000,000 turns": {
    "outputs": {
      "review_failed": "false",
      "review_ran": "true"
    },
    "errors": [],
    "warnings": [],
    "notices": [
      "Claude review completed: credential=CLAUDE_CODE_OAUTH_TOKEN turns=1000000. Findings (if any) are in the PR comments."
    ],
    "failed": []
  },
  "denied": {
    "outputs": {
      "failure_class": "auth",
      "review_detail": "{\"subtype\":\"success\",\"is_error\":true,\"num_turns\":1,\"duration_ms\":null,\"total_cost_usd\":null,\"api_error_status\":403,\"error_type\":null,\"class\":\"auth\"}",
      "review_failed": "true",
      "review_ran": "false"
    },
    "errors": [
      "Claude review exited with: failure class=auth error-type=permission_error error-code=abc_def request-id=req_abcdefgh12 credential=AUTOMATIONS_CLAUDE_API_KEY turns=1 (infrastructure error, not a code-quality signal — e.g. usage limit, OIDC failure, SDK crash, is_error result, or max-turns exhaustion). Last SDK result: {\"subtype\":\"success\",\"is_error\":true,\"num_turns\":1,\"duration_ms\":null,\"total_cost_usd\":null,\"api_error_status\":403,\"error_type\":null,\"class\":\"auth\"}"
    ],
    "warnings": [],
    "notices": [],
    "failed": []
  },
  "cancelled": {
    "outputs": {
      "failure_class": "no-execution",
      "review_detail": "(no execution file was produced)",
      "review_failed": "true",
      "review_ran": "false"
    },
    "errors": [
      "Claude review exited with: cancelled class=no-execution credential=CLAUDE_CODE_OAUTH_TOKEN (infrastructure error, not a code-quality signal — e.g. usage limit, OIDC failure, SDK crash, is_error result, or max-turns exhaustion). Last SDK result: (no execution file was produced)"
    ],
    "warnings": [],
    "notices": [],
    "failed": []
  },
  "sandbox skip": {
    "outputs": {
      "failure_class": "sandbox-unavailable",
      "review_detail": "(no execution file was produced)",
      "review_failed": "true",
      "review_ran": "false"
    },
    "errors": [
      "Claude review exited with: skipped class=sandbox-unavailable credential=CLAUDE_CODE_OAUTH_TOKEN (infrastructure error, not a code-quality signal — e.g. usage limit, OIDC failure, SDK crash, is_error result, or max-turns exhaustion). Last SDK result: (no execution file was produced)"
    ],
    "warnings": [],
    "notices": [],
    "failed": []
  }
};

test("with no lane-id, every branch writes exactly what main wrote", async () => {
  const creditStopText =
    'API Error: 402 {"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low"},"request_id":"req_fake0000000000000000"}';
  const files = {};
  const pinFile = (name, contents) => {
    files[name] = path.join(temporaryDirectory, `pin-${name}.json`);
    fs.writeFileSync(files[name], JSON.stringify(contents));
    return files[name];
  };
  pinFile("ok", [{ type: "result", subtype: "success", is_error: false, num_turns: 4, modelUsage: { "claude-sonnet-5": {} } }]);
  pinFile("creditStop", [{ type: "result", subtype: "success", is_error: true, num_turns: 1, result: creditStopText, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: { "claude-sonnet-5": {} } }]);
  pinFile("denied", [{ type: "result", subtype: "success", is_error: true, num_turns: 1, api_error_status: 403, result: 'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"x","details":{"error_code":"abc_def"}},"request_id":"req_abcdefgh12"}', usage: { input_tokens: 0, output_tokens: 0 } }]);
  pinFile("limited", [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1792645200, rateLimitType: "five_hour" } }, { type: "result", subtype: "success", is_error: true, api_error_status: 429 }]);
  pinFile("manyTurns", [{ type: "result", subtype: "success", is_error: false, num_turns: 1000000 }]);
  const key = "AUTOMATIONS_CLAUDE_API_KEY";
  const token = "CLAUDE_CODE_OAUTH_TOKEN";
  const cases = {
    success: { outcome: "success", executionFile: files.ok, credential: token, maxTurns: "30" },
    "validation skip": { outcome: "success", executionFile: "", credential: token },
    incomplete: { outcome: "success", executionFile: files.denied, credential: key, requireCompletion: "true", completion: "no summary" },
    "credit stop, handoff set": { outcome: "failure", executionFile: files.creditStop, credential: key, knownFailureClass: "credit-stop", maxTurns: "30", handoff: "true" },
    "usage limit": { outcome: "failure", executionFile: files.limited, credential: token, fallbackReason: "credit-stop" },
    "1,000,000 turns": { outcome: "success", executionFile: files.manyTurns, credential: token },
    denied: { outcome: "failure", executionFile: files.denied, credential: key },
    cancelled: { outcome: "cancelled", executionFile: "", credential: token },
    "sandbox skip": { outcome: "skipped", executionFile: "", credential: token, knownFailureClass: "sandbox-unavailable" },
  };
  assert.deepEqual(Object.keys(cases), Object.keys(MAIN_OUTPUT));
  for (const [name, inputs] of Object.entries(cases)) {
    const { outputs, errors, warnings, notices, failed } = await runOutcome(inputs);
    assert.deepEqual({ outputs, errors, warnings, notices, failed }, MAIN_OUTPUT[name], name);
  }
});

test("past six digits of turns the tokens keep the count and the record leaves it out", async () => {
  const file = writeExecutionFile([{ type: "result", subtype: "success", is_error: false, num_turns: 1000000 }]);
  const { notices } = await runOutcome({ outcome: "success", executionFile: file, laneId: "pr-review", credential: "CLAUDE_CODE_OAUTH_TOKEN" });
  assert.match(notices[0], /\bturns=1000000\b/u);
  assert.equal("turns" in readRecord(notices[0]), false);
});

test("with 45 long model ids the record still ends inside the runner's 4,096-character cut", async () => {
  // Every token at its pattern's longest: a 100-character credential and
  // forty-five 100-character model ids on the rate-limit branch.
  const models = Object.fromEntries(
    Array.from({ length: 45 }, (_, i) => [`${"m".repeat(98)}${String(i).padStart(2, "0")}`, {}]),
  );
  const credential = `${"R".repeat(76)}_CLAUDE_CODE_OAUTH_TOKEN`;
  const file = writeExecutionFile([
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1792645200, rateLimitType: "five_hour" } },
    { type: "result", subtype: "x".repeat(5000), is_error: true, num_turns: 999999, api_error_status: 429, modelUsage: models },
  ]);
  const { errors } = await runOutcome({
    outcome: "failure",
    executionFile: file,
    lane: "Claude security review",
    laneId: "pr-review-security",
    credential,
    maxTurns: "999999",
  });
  assert.equal(errors.length, 1);
  const tokenModels = /\bmodels=(\S+)/u.exec(errors[0])[1].split(",");
  assert.equal(tokenModels.length, 8);
  const cut = errors[0].slice(0, 4096);
  const record = readRecord(cut);
  assert.notEqual(record, null);
  assert.equal(record.credential.secret, credential);
  assert.equal(record.class, "rate-limit");
});

test("a failing key leg that did not hand off stays an error; only handoff \"true\" makes it a notice", async () => {
  const file = writeExecutionFile([
    { type: "result", subtype: "success", is_error: true, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0 } },
  ]);
  const leg = (handoff) =>
    runOutcome({
      outcome: "failure",
      executionFile: file,
      lane: "Claude intake triage",
      laneId: "intake-triage",
      credential: "AUTOMATIONS_CLAUDE_API_KEY",
      knownFailureClass: "credit-stop",
      handoff,
    });
  for (const handoff of ["false", "", "True", "true "]) {
    const { errors, notices } = await leg(handoff);
    assert.equal(errors.length, 1, JSON.stringify(handoff));
    assert.equal(notices.length, 0, JSON.stringify(handoff));
    assert.equal("handoff" in readRecord(errors[0]), false, JSON.stringify(handoff));
  }
  const handedOff = await leg("true");
  assert.equal(handedOff.errors.length, 0);
  assert.equal(readRecord(handedOff.notices[0]).handoff, true);
});
