// Port of the classify-infra-failure.sh corpus to the JS classifier. The
// shell version's final case (unset GITHUB_OUTPUT fails closed) has no
// analog here: output delivery is owned by github-script's core.setOutput in
// action.yml, not by this module.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  makeTemporaryDirectory,
} = require("../../scripts/temporary-directories.cjs");
const {
  classifyExecutionFile,
  readRunRecord,
  recordTokens,
} = require("./classify.cjs");

// A distinctive string standing in for the model-authored `result` text and the
// raw error stacks: it must never reach an output, because those two fields are
// the ones this repo keeps off every public surface.
const CANARY = "canary-never-publish-this";

// The first element of a real error-variant `errors[]` is always a synthetic
// diagnostic line; no allowlist token may collide with its vocabulary.
const DIAGNOSTIC =
  "[ede_diagnostic] result_type=api_error last_content_type=text stop_reason=null"; // spellchecker:disable-line

const temporaryDirectory = makeTemporaryDirectory("classify-");
const executionFile = path.join(temporaryDirectory, "execution.json");

function resultMessage(apiErrorStatus, extra = {}) {
  return [
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      duration_ms: 1856,
      total_cost_usd: 0,
      result: `model-authored free text ${CANARY}`,
      api_error_status: apiErrorStatus,
      ...extra,
    },
  ];
}

function errorMessage(errors) {
  return [
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 2,
      duration_ms: 42,
      total_cost_usd: 0,
      errors,
    },
  ];
}

function apiErrorBody(errorType) {
  return (
    `APIError: {"type":"error","error":{"type":"${errorType}",` +
    `"message":"${CANARY}"}}\n    at request (/x/y.js:1:1)`
  );
}

function run(contents) {
  fs.writeFileSync(executionFile, JSON.stringify(contents));
  return classifyExecutionFile(executionFile);
}

function assertClass(label, expectedClass, contents) {
  const { reviewDetail, failureClass } = run(contents);
  assert.equal(
    failureClass,
    expectedClass,
    `${label}: class (detail: ${reviewDetail})`,
  );
  assert.ok(
    !`${reviewDetail}${failureClass}`.includes(CANARY),
    `${label}: free-text field reached an output surface`,
  );
}

test("the structured Anthropic-API status decides the class", () => {
  assertClass("401", "auth", resultMessage(401));
  assertClass("402", "auth", resultMessage(402));
  assertClass("403", "auth", resultMessage(403));
  assertClass("429", "rate-limit", resultMessage(429));
  assertClass("500", "overloaded", resultMessage(500));
  assertClass("529", "overloaded", resultMessage(529));
});

test("a status outside the mapped set is still a status decision", () => {
  // 413 request_too_large is a genuine non-infra client error: it resolves to
  // `other` rather than falling through to the substring pass, even with a
  // rate-limit body in errors[].
  assertClass(
    "unmapped status",
    "other",
    resultMessage(413, { errors: [apiErrorBody("rate_limit_error")] }),
  );
});

test("a status present but null is treated as absent, so the substring pass runs", () => {
  assertClass(
    "null status with auth text",
    "auth",
    resultMessage(null, {
      errors: [DIAGNOSTIC, apiErrorBody("authentication_error")],
    }),
  );
});

test("the error-variant substring pass, one case per allowlisted token", () => {
  assertClass(
    "authentication_error",
    "auth",
    errorMessage([DIAGNOSTIC, apiErrorBody("authentication_error")]),
  );
  assertClass(
    "billing_error",
    "auth",
    errorMessage([DIAGNOSTIC, apiErrorBody("billing_error")]),
  );
  assertClass(
    "permission_error",
    "auth",
    errorMessage([DIAGNOSTIC, apiErrorBody("permission_error")]),
  );
  assertClass(
    "rate_limit_error",
    "rate-limit",
    errorMessage([DIAGNOSTIC, apiErrorBody("rate_limit_error")]),
  );
  assertClass(
    "overloaded_error",
    "overloaded",
    errorMessage([DIAGNOSTIC, apiErrorBody("overloaded_error")]),
  );
  assertClass(
    "timeout_error",
    "overloaded",
    errorMessage([DIAGNOSTIC, apiErrorBody("timeout_error")]),
  );
  assertClass(
    "api_error",
    "overloaded",
    errorMessage([DIAGNOSTIC, apiErrorBody("api_error")]),
  );
});

test("the client-error types stay `other` on the substring path", () => {
  assertClass(
    "invalid_request_error",
    "other",
    errorMessage([DIAGNOSTIC, apiErrorBody("invalid_request_error")]),
  );
  assertClass(
    "not_found_error",
    "other",
    errorMessage([DIAGNOSTIC, apiErrorBody("not_found_error")]),
  );
});

test("the synthetic diagnostic line alone must not match any token", () => {
  // It can carry the literal text `api_error` in its result_type field.
  assertClass("diagnostic only", "other", errorMessage([DIAGNOSTIC]));
});

test("the observed incident payload with nothing to classify", () => {
  assertClass("unclassifiable", "other", [
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      duration_ms: 1856,
      total_cost_usd: 0,
    },
  ]);
});

test("the class token joins the safe projection alongside the numeric status", () => {
  const { reviewDetail } = run(resultMessage(401));
  const projection = JSON.parse(reviewDetail);
  assert.equal(projection.class, "auth");
  assert.equal(projection.api_error_status, 401);
  assert.ok(
    !("result" in projection) && !("errors" in projection),
    `projection leaked a free-text field (${reviewDetail})`,
  );
});

test("a run that used every turn classifies as max-turns", () => {
  assertClass("error_max_turns", "max-turns", [
    {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 76,
      duration_ms: 600000,
      total_cost_usd: 1.5,
      errors: [DIAGNOSTIC],
    },
  ]);
});

test("an error result past the caller's cap keeps its errors[] class", () => {
  fs.writeFileSync(
    executionFile,
    JSON.stringify([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 20,
        errors: [
          'APIError: {"type":"error","error":{"type":"authentication_error","message":"x"}}',
        ],
      },
    ]),
  );
  assert.equal(
    classifyExecutionFile(executionFile, { maxTurns: "15" }).failureClass,
    "auth",
  );
});

test("a success result past the caller's cap classifies as max-turns", () => {
  // The shape of claude-code-plugins run 39038437240: the action failed with
  // "Claude reported a successful result after 16 turns, exceeding the
  // configured maximum of 15" over a result message that reads as a success.
  const pastCap = [
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 16,
      duration_ms: 65265,
    },
  ];
  fs.writeFileSync(executionFile, JSON.stringify(pastCap));
  const classify = (maxTurns) =>
    classifyExecutionFile(executionFile, { maxTurns }).failureClass;
  assert.equal(classify("15"), "max-turns");
  // At the cap, or with no cap known, nothing shows the cap was crossed.
  assert.equal(classify("16"), "other");
  assert.equal(classify(""), "other");
  assert.equal(classify("fifteen"), "other");
  // A timeout and an API status still decide first.
  assert.equal(
    classifyExecutionFile(executionFile, { maxTurns: "15", timedOut: true })
      .failureClass,
    "timeout",
  );
  assertClass(
    "429 past the cap",
    "rate-limit",
    resultMessage(429, { num_turns: 16 }),
  );
});

test("a step that ran its whole budget classifies as timeout, file or not", () => {
  const missing = classifyExecutionFile(
    path.join(temporaryDirectory, "never-written.json"),
    { timedOut: true },
  );
  assert.equal(missing.failureClass, "timeout");
  assert.equal(missing.reviewDetail, "(no execution file was produced)");

  fs.writeFileSync(executionFile, JSON.stringify(resultMessage(429)));
  const projected = classifyExecutionFile(executionFile, { timedOut: true });
  assert.equal(projected.failureClass, "timeout");
  assert.equal(JSON.parse(projected.reviewDetail).class, "timeout");
});

test("an unparsable execution file degrades to `other` and says so", () => {
  fs.writeFileSync(executionFile, "[]");
  let result = classifyExecutionFile(executionFile);
  assert.equal(result.failureClass, "other");
  assert.equal(result.reviewDetail, "(execution file present but unparsable)");

  fs.writeFileSync(executionFile, "");
  result = classifyExecutionFile(executionFile);
  assert.equal(result.failureClass, "other");
  assert.equal(result.reviewDetail, "(execution file present but unparsable)");
});

test("no execution file, no timeout and no install failure classifies as no-execution", () => {
  fs.rmSync(executionFile, { force: true });
  let result = classifyExecutionFile(executionFile);
  assert.equal(result.failureClass, "no-execution");
  assert.equal(result.reviewDetail, "(no execution file was produced)");

  result = classifyExecutionFile("", { timedOut: false, installFailed: false });
  assert.equal(result.failureClass, "no-execution");
  assert.equal(result.reviewDetail, "(no execution file was produced)");
});

// claude-code-plugins run 39101440826: the Bun release download answered
// "Unexpected HTTP response: 429" and the action failed before Claude started,
// leaving no execution file.
test("a failed Bun install with no execution file classifies as install-failed", () => {
  fs.rmSync(executionFile, { force: true });
  const result = classifyExecutionFile(executionFile, { installFailed: true });
  assert.equal(result.failureClass, "install-failed");
  assert.equal(result.reviewDetail, "(no execution file was produced)");

  assert.equal(
    classifyExecutionFile("", { installFailed: true, timedOut: true })
      .failureClass,
    "timeout",
  );

  // An execution file means Claude ran: the run decides.
  fs.writeFileSync(executionFile, JSON.stringify(resultMessage(429)));
  assert.equal(
    classifyExecutionFile(executionFile, { installFailed: true }).failureClass,
    "rate-limit",
  );
});

test("error_type carries the matched allowlist token on the substring path only", () => {
  const substring = run(
    errorMessage([DIAGNOSTIC, apiErrorBody("billing_error")]),
  );
  const substringProjection = JSON.parse(substring.reviewDetail);
  assert.equal(substring.failureClass, "auth");
  assert.equal(substringProjection.error_type, "billing_error");

  const status = run(resultMessage(401));
  const statusProjection = JSON.parse(status.reviewDetail);
  assert.equal(status.failureClass, "auth");
  assert.equal(statusProjection.error_type, null);

  const unmatched = run(errorMessage([DIAGNOSTIC]));
  const unmatchedProjection = JSON.parse(unmatched.reviewDetail);
  assert.equal(unmatched.failureClass, "other");
  assert.equal(unmatchedProjection.error_type, null);
});

// Run record. Message shapes follow the Agent SDK types: SDKRateLimitEvent
// `{type: "rate_limit_event", rate_limit_info: {status, resetsAt?}}` and the
// result message's `num_turns` and `modelUsage` map. 1767225600 is
// 2026-01-01T00:00:00Z in epoch seconds.
const NEW_YEAR = 1767225600;
const rateLimitEvent = (status, resetsAt, rateLimitType = "five_hour") => ({
  type: "rate_limit_event",
  rate_limit_info: { status, resetsAt, rateLimitType },
  uuid: "u",
  session_id: "s",
});

function record(contents) {
  fs.writeFileSync(executionFile, JSON.stringify(contents));
  return readRunRecord(executionFile);
}

test("the run record reads turns and modelUsage keys from the result message", () => {
  const { turns, models, resetsAt } = record([
    { type: "system", subtype: "init" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 11,
      modelUsage: { "claude-sonnet-5": {}, "claude-haiku-5": {} },
      result: CANARY,
    },
  ]);
  assert.equal(turns, 11);
  assert.deepEqual(models, ["claude-sonnet-5", "claude-haiku-5"]);
  assert.equal(resetsAt, null);
});

test("a modelUsage key outside the model-id character set is dropped", () => {
  const { models } = record([
    {
      type: "result",
      num_turns: 1,
      modelUsage: { "claude-opus-5-5[1m]": {}, "evil key\n::error::x": {} },
    },
  ]);
  assert.deepEqual(models, ["claude-opus-5-5[1m]"]);
});

test("resets and its window come from the newest rejected rate_limit_event, in seconds or milliseconds", () => {
  // The seven-day window stopped the run; a later five-hour warning must not
  // move the reset an hour forward.
  const stopped = record([
    rateLimitEvent("rejected", NEW_YEAR, "seven_day"),
    rateLimitEvent("allowed_warning", NEW_YEAR + 3600),
    { type: "result", num_turns: 1, api_error_status: 429 },
  ]);
  assert.equal(stopped.resetsAt, "2026-01-01T00:00:00Z");
  assert.equal(stopped.resetsWindow, "seven_day");
  assert.equal(
    record([rateLimitEvent("rejected", NEW_YEAR * 1000)]).resetsAt,
    "2026-01-01T00:00:00Z",
  );
});

test("with no rejected event there is no reset, so the caller's fallback applies", () => {
  const unstopped = record([
    rateLimitEvent("allowed", NEW_YEAR),
    rateLimitEvent("allowed_warning", NEW_YEAR + 3600),
    { type: "result", num_turns: 1, api_error_status: 429 },
  ]);
  assert.equal(unstopped.resetsAt, null);
  assert.equal(unstopped.resetsWindow, null);
});

test("a window name outside the token character set is dropped, the reset kept", () => {
  const odd = record([rateLimitEvent("rejected", NEW_YEAR, "five hour\n")]);
  assert.equal(odd.resetsAt, "2026-01-01T00:00:00Z");
  assert.equal(odd.resetsWindow, null);
});

test("no rate_limit_event, a missing file or an unparsable one leaves the record empty", () => {
  const empty = {
    turns: null,
    models: [],
    resetsAt: null,
    resetsWindow: null,
    errorType: null,
    errorCode: null,
    requestId: null,
  };
  assert.deepEqual(record([{ type: "result", subtype: "success" }]), empty);
  fs.writeFileSync(executionFile, "not json");
  assert.deepEqual(readRunRecord(executionFile), empty);
  assert.deepEqual(readRunRecord(""), empty);
});

test("record tokens: resets only on a limit stop, unknown and malformed values omitted", () => {
  const run = {
    turns: 16,
    models: ["claude-sonnet-5"],
    resetsAt: "2026-01-01T00:00:00Z",
    resetsWindow: "seven_day",
  };
  assert.equal(
    recordTokens(run, {
      failureClass: "rate-limit",
      maxTurns: "15",
      credential: "CLAUDE_CODE_OAUTH_TOKEN",
    }),
    "resets=2026-01-01T00:00:00Z resets-window=seven_day " +
      "credential=CLAUDE_CODE_OAUTH_TOKEN " +
      "turns=16 max-turns=15 models=claude-sonnet-5",
  );
  assert.equal(
    recordTokens(run, { failureClass: "auth", maxTurns: "15" }),
    "turns=16 max-turns=15 models=claude-sonnet-5",
  );
  // A value that is not a secret name, a lower-case name or a non-number
  // never prints.
  assert.equal(
    recordTokens(
      { turns: null, models: [], resetsAt: null },
      { maxTurns: "15; x", credential: "value-not-a-name" },
    ),
    "",
  );
  assert.equal(
    recordTokens(
      { turns: 0, models: [], resetsAt: null },
      { credential: "lower_case" },
    ),
    "turns=0",
  );
});

// ci-workflows#806: a subscription job that ran because the key job
// credit-stopped, or had no key, says so right after the credential.
test("record tokens: a fallback reason prints right after the credential, only from its vocabulary", () => {
  const run = { turns: 4, models: [], resetsAt: null };
  const credential = "AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN";
  assert.equal(
    recordTokens(run, { credential, fallbackReason: "credit-stop" }),
    "credential=AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN fallback=credit-stop turns=4",
  );
  assert.equal(
    recordTokens(run, { credential, fallbackReason: "no-key" }),
    "credential=AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN fallback=no-key turns=4",
  );
  assert.equal(
    recordTokens(run, { credential, fallbackReason: "auth" }),
    "credential=AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN fallback=auth turns=4",
  );
  for (const forged of [
    "",
    "Auth",
    "Credit-Stop",
    " no-key",
    "credit-stop\n::error::x",
  ]) {
    assert.equal(
      recordTokens(run, { credential, fallbackReason: forged }),
      "credential=AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN turns=4",
      JSON.stringify(forged),
    );
  }
});

// credit-stop. The stop texts come from the published pages:
// "Credit balance is too low" (code.claude.com/docs/en/errors), the self-set
// spend limit "You have reached your specified API usage limits" (400) and the
// tier spend cap body with `enforced_spend_limit_reached` (429)
// (platform.claude.com/docs/en/api/rate-limits). The message shapes follow the
// Agent SDK reference: `api_error_status` on the result, `error` on a
// synthesized assistant message. Which of those fields a real credit stop
// fills is not yet observed.
const { creditStopResetsAt, isCreditStop } = require("./classify.cjs");

const TIER_CAP_TEXT =
  'API Error: 429 {"type":"error","error":{"type":"rate_limit_error",' +
  '"message":"You have reached your API usage limits: your organization has ' +
  "crossed its monthly API usage threshold, set based on your organization's " +
  'API tier. You will regain access on 2026-09-01 at 00:00 UTC.",' +
  '"details":{"error_code":"enforced_spend_limit_reached"}}}';

function stopMessages({
  status = 400,
  error = "invalid_request",
  text = "Credit balance is too low",
  outputTokens = 0,
  toolUse = false,
  extraAssistant = null,
} = {}) {
  const content = [{ type: "text", text }];
  if (toolUse) content.push({ type: "tool_use", id: "t1", name: "Bash" });
  const assistants = [{ type: "assistant", error, message: { content } }];
  if (extraAssistant) assistants.push(extraAssistant);
  return [
    { type: "system", subtype: "init" },
    ...assistants,
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 0,
      result: text,
      api_error_status: status,
      usage: { input_tokens: 0, output_tokens: outputTokens },
    },
  ];
}

function classifyStop(messages, options) {
  fs.writeFileSync(executionFile, JSON.stringify(messages));
  return classifyExecutionFile(executionFile, options).failureClass;
}

test("credit-stop: an exhausted Console credit balance (400) with opt-in", () => {
  assert.equal(
    classifyStop(stopMessages(), { detectCreditStop: true, exitCode: 1 }),
    "credit-stop",
  );
});

// Observed, not modeled: Claude Code 2.1.302's `claude -p --output-format
// stream-json` at a workspace spend limit (pr-pipeline-sandbox run 39168823785),
// trimmed to the fields the classifier reads. Unlike the modeled shape above it
// reports `num_turns: 1`, `subtype: "success"` and the SDK error `unknown`.
const OBSERVED_SPEND_LIMIT_TEXT =
  "API Error: 400 You have reached your specified workspace API usage limits. " +
  "You will regain access on 2026-11-01 at 00:00 UTC.";
const OBSERVED_SPEND_LIMIT = [
  {
    type: "assistant",
    error: "unknown",
    is_api_error_message: true,
    api_error_status: 400,
    message: {
      model: "<synthetic>",
      content: [{ type: "text", text: OBSERVED_SPEND_LIMIT_TEXT }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  },
  {
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0,
    api_error_status: 400,
    terminal_reason: "api_error",
    result: OBSERVED_SPEND_LIMIT_TEXT,
    usage: { input_tokens: 0, output_tokens: 0 },
  },
];

test("credit-stop: the observed workspace spend-limit result (CLI 2.1.302)", () => {
  const options = { detectCreditStop: true, exitCode: 1 };
  assert.equal(classifyStop(OBSERVED_SPEND_LIMIT, options), "credit-stop");
  assert.equal(
    creditStopResetsAt(OBSERVED_SPEND_LIMIT),
    "2026-11-01T00:00:00Z",
  );
});

// Observed: a disabled and a deleted Console key return the same result
// (pr-pipeline-sandbox runs 39169782027 and 39170251719). It is auth, never a
// credit stop, so the launcher does not fall back on it.
test("auth: the observed rejected-key result (CLI 2.1.302) is never credit-stop", () => {
  const text = "Invalid API key · Fix external API key";
  const rejected = [
    {
      type: "assistant",
      error: "authentication_failed",
      is_api_error_message: true,
      api_error_status: 401,
      message: {
        model: "<synthetic>",
        content: [{ type: "text", text }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      total_cost_usd: 0,
      api_error_status: 401,
      terminal_reason: "api_error",
      result: text,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  ];
  assert.equal(
    classifyStop(rejected, { detectCreditStop: true, exitCode: 1 }),
    "auth",
  );
});

test("credit-stop: callers that do not opt in keep the existing class", () => {
  assert.equal(classifyStop(stopMessages(), {}), "other");
  assert.equal(
    classifyStop(stopMessages({ status: 402, error: "billing_error" }), {}),
    "auth",
  );
  assert.equal(
    classifyStop(
      stopMessages({ status: 429, error: "rate_limit", text: TIER_CAP_TEXT }),
      {},
    ),
    "rate-limit",
  );
});

test("credit-stop: self-set spend limit, tier spend cap and 402 billing", () => {
  const options = { detectCreditStop: true, exitCode: 1 };
  assert.equal(
    classifyStop(
      stopMessages({
        text: "You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
      }),
      options,
    ),
    "credit-stop",
  );
  assert.equal(
    classifyStop(
      stopMessages({ status: 429, error: "rate_limit", text: TIER_CAP_TEXT }),
      options,
    ),
    "credit-stop",
  );
  assert.equal(
    classifyStop(
      stopMessages({ status: null, error: "billing_error" }),
      options,
    ),
    "credit-stop",
  );
});

test("credit-stop: the tier spend cap's documented regain time is its reset", () => {
  assert.equal(
    creditStopResetsAt(
      stopMessages({ status: 429, error: "rate_limit", text: TIER_CAP_TEXT }),
    ),
    "2026-09-01T00:00:00Z",
  );
  assert.equal(creditStopResetsAt(stopMessages()), null);
});

test("credit-stop: never on a throttle 429, an auth failure or exit 0", () => {
  assert.equal(
    isCreditStop(
      stopMessages({
        status: 429,
        error: "rate_limit",
        text: "API Error: 429 Number of request tokens has exceeded your per-minute rate limit",
      }),
      { exitCode: 1 },
    ),
    false,
  );
  assert.equal(
    isCreditStop(
      stopMessages({ status: 401, error: "authentication_failed" }),
      { exitCode: 1 },
    ),
    false,
  );
  assert.equal(isCreditStop(stopMessages(), { exitCode: 0 }), false);
});

test("credit-stop: never when the model could have written the text", () => {
  const options = { exitCode: 1 };
  // A tool ran: head code could have printed the phrase.
  assert.equal(isCreditStop(stopMessages({ toolUse: true }), options), false);
  // The model produced output tokens.
  assert.equal(
    isCreditStop(stopMessages({ outputTokens: 12 }), options),
    false,
  );
  // A model-authored assistant message (no SDK `error`) sits beside the stop.
  assert.equal(
    isCreditStop(
      stopMessages({
        extraAssistant: {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Credit balance is too low" }],
          },
        },
      }),
      options,
    ),
    false,
  );
});

// A 403 in the published error shape (platform.claude.com/docs/en/api/errors:
// error.type and request_id), with an error.details.error_code as the tier
// spend-cap body above carries one; the code and the low-entropy request id
// are made up, so the secret scan does not read them as a key.
const { apiErrorFacts } = require("./classify.cjs");
const PERMISSION_TEXT =
  'API Error: 403 {"type":"error","error":{"type":"permission_error",' +
  '"message":"not permitted","details":{"error_code":"workspace_access_denied"}},' +
  '"request_id":"req_fake0000000000000000"}';

function permissionMessages({ outputTokens = 0, text = PERMISSION_TEXT } = {}) {
  return [
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      api_error_status: 403,
      result: text,
      usage: { input_tokens: 0, output_tokens: outputTokens },
    },
  ];
}

test("api error facts: a 403's type, error_code and request_id from the CLI's own text", () => {
  assert.deepEqual(apiErrorFacts(permissionMessages()), {
    errorType: "permission_error",
    errorCode: "workspace_access_denied",
    requestId: "req_fake0000000000000000",
  });
  const none = { errorType: null, errorCode: null, requestId: null };
  // Model output means the text may be the model's: nothing is read.
  assert.deepEqual(apiErrorFacts(permissionMessages({ outputTokens: 3 })), none);
  // A value outside its closed pattern is dropped.
  assert.deepEqual(
    apiErrorFacts(
      permissionMessages({
        text: 'API Error: 403 {"type":"error","error":{"type":"Permission Error::x","details":{"error_code":"a b"}},"request_id":"req_::x"}',
      }),
    ),
    none,
  );
});

test("record tokens: error facts print only on a failure", () => {
  const run = {
    turns: 1,
    errorType: "permission_error",
    errorCode: "workspace_access_denied",
    requestId: "req_fake0000000000000000",
  };
  assert.equal(
    recordTokens(run, { failureClass: "auth" }),
    "error-type=permission_error error-code=workspace_access_denied request-id=req_fake0000000000000000 turns=1",
  );
  assert.equal(recordTokens(run, {}), "turns=1");
});

test("credit-stop: a 403 is never a credit stop, whatever its text", () => {
  for (const error of ["billing_error", "invalid_request"]) {
    const messages = stopMessages({
      status: 403,
      error,
      text: "Your credit balance is too low",
    });
    assert.equal(isCreditStop(messages, { exitCode: 1 }), false, error);
    assert.equal(
      classifyStop(messages, { detectCreditStop: true, exitCode: 1 }),
      "auth",
      error,
    );
  }
});
