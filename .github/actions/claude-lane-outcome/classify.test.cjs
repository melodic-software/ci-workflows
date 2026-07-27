// Port of the classify-infra-failure.sh corpus to the JS classifier. The
// shell version's final case (unset GITHUB_OUTPUT fails closed) has no
// analog here: output delivery is owned by github-script's core.setOutput in
// action.yml, not by this module.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { classifyExecutionFile } = require("./classify.cjs");

// A distinctive string standing in for the model-authored `result` text and the
// raw error stacks: it must never reach an output, because those two fields are
// the ones this repo keeps off every public surface.
const CANARY = "canary-never-publish-this";

// The first element of a real error-variant `errors[]` is always a synthetic
// diagnostic line; no allowlist token may collide with its vocabulary.
const DIAGNOSTIC =
  "[ede_diagnostic] result_type=api_error last_content_type=text stop_reason=null"; // spellchecker:disable-line

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "classify-"));
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
  assert.equal(failureClass, expectedClass, `${label}: class (detail: ${reviewDetail})`);
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
    resultMessage(null, { errors: [DIAGNOSTIC, apiErrorBody("authentication_error")] }),
  );
});

test("the error-variant substring pass, one case per allowlisted token", () => {
  assertClass(
    "authentication_error",
    "auth",
    errorMessage([DIAGNOSTIC, apiErrorBody("authentication_error")]),
  );
  assertClass("billing_error", "auth", errorMessage([DIAGNOSTIC, apiErrorBody("billing_error")]));
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
  assertClass("api_error", "overloaded", errorMessage([DIAGNOSTIC, apiErrorBody("api_error")]));
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

test("no execution file at all (the action failed before producing one)", () => {
  fs.rmSync(executionFile, { force: true });
  let result = classifyExecutionFile(executionFile);
  assert.equal(result.failureClass, "other");
  assert.equal(result.reviewDetail, "(no execution file was produced)");

  result = classifyExecutionFile("");
  assert.equal(result.failureClass, "other");
  assert.equal(result.reviewDetail, "(no execution file was produced)");
});
