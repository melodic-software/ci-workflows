// Project the last claude-code-action SDK result message into safe, structured
// metadata and classify a genuine infrastructure failure into exactly one coarse
// class: auth | rate-limit | overloaded | other. Reads the action's
// execution_file output (which may be unset, missing, or unparsable) and returns
// the review detail plus failure class.
//
// This runs on a PUBLIC repo. The result message's `result` field is
// model-authored free text and its `errors[]` entries are raw error stacks; both
// are read INSIDE this module only, and nothing but the class token and the
// structured projection below ever leaves it. Never widen the projection to
// either field, and never emit the result message wholesale.
//
// Classification order:
//   1. `api_error_status` — the Anthropic-API HTTP status the SDK records when
//      the last assistant turn was an API error: 401/402/403 auth, 429
//      rate-limit, 5xx overloaded, every other status other.
//   2. an allowlisted substring over `errors[]`, matching the serialized
//      Anthropic error body (`{"type":"error","error":{"type":"<type>",...}}`)
//      that the API SDK folds into an APIError's message, and so into its stack.
//   3. other.
//
// The allowlist mirrors the status mapping type-for-type, so a payload that
// recovers no numeric status still lands in the same class the status would
// have chosen. Against the published error table that is: `authentication_error`
// (401), `billing_error` (402), `permission_error` (403) -> auth;
// `rate_limit_error` (429) -> rate-limit; `api_error` (500), `timeout_error`
// (504), `overloaded_error` (529) -> overloaded. The remaining published types
// — `invalid_request_error` (400), `not_found_error` (404), `conflict_error`
// (409), `request_too_large` (413) — are client errors, not infrastructure, and
// are deliberately left to `other` on both paths. Adding a type to one path
// without the other reopens the asymmetry this note exists to prevent.
//
// `auth` is the credential-unusable class, not the 401-only class: it covers
// every status where the credential cannot be used until a human acts. Per the
// published error table that is 401 `authentication_error`, 402 `billing_error`,
// and 403 `permission_error`. 402 belongs here because the incident this
// classifier exists for (ci-workflows#228 / claude-code-plugins#1122) is
// described as a *usage-dead account credential* — a billing/entitlement death,
// which the API reports as 402, not 401. Leaving 402 in `other` would classify
// the originating incident as unremarkable. The downstream aggregator routes
// `auth` to a human-gated incident, correct for a billing death as much as for
// a revocation.
//
// The two sources are disjoint members of the SDK's result union:
// `api_error_status` exists only on the success variant (the shape a dead
// credential produces — subtype success, is_error true) and `errors[]` only on
// the error subtypes. So the substring pass is the error-variant path, not a
// second look at the same payload, and a present-but-unmapped status stays a
// status decision rather than falling through to it.
"use strict";

const fs = require("node:fs");

function classFromStatus(status) {
  if (status === 401 || status === 402 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status >= 500 && status < 600) return "overloaded";
  return "other";
}

function classFromErrorText(text) {
  if (
    text.includes('"type":"authentication_error"') ||
    text.includes('"type":"billing_error"') ||
    text.includes('"type":"permission_error"')
  ) {
    return "auth";
  }
  if (text.includes('"type":"rate_limit_error"')) return "rate-limit";
  if (
    text.includes('"type":"overloaded_error"') ||
    text.includes('"type":"timeout_error"') ||
    text.includes('"type":"api_error"')
  ) {
    return "overloaded";
  }
  return "other";
}

// Mirrors jq's `tostring`: strings pass through, everything else serializes
// compactly — an object error entry must expose its `"type":"..."` body to the
// substring pass exactly as the jq implementation did.
function toStringLikeJq(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function classifyExecutionFile(executionFilePath) {
  if (!executionFilePath || !fs.existsSync(executionFilePath)) {
    return {
      reviewDetail: "(no execution file was produced)",
      failureClass: "other",
    };
  }

  let last;
  try {
    const parsed = JSON.parse(fs.readFileSync(executionFilePath, "utf8"));
    last = Array.isArray(parsed) ? parsed[parsed.length - 1] : undefined;
  } catch {
    last = undefined;
  }
  if (last === undefined || last === null) {
    return {
      reviewDetail: "(execution file present but unparsable)",
      failureClass: "other",
    };
  }

  const status = last.api_error_status;
  let failureClass;
  if (typeof status === "number") {
    failureClass = classFromStatus(status);
  } else {
    const text = (Array.isArray(last.errors) ? last.errors : [])
      .map(toStringLikeJq)
      .join("\n");
    failureClass = classFromErrorText(text);
  }

  const projection = {
    subtype: last.subtype ?? null,
    is_error: last.is_error ?? null,
    num_turns: last.num_turns ?? null,
    duration_ms: last.duration_ms ?? null,
    total_cost_usd: last.total_cost_usd ?? null,
    api_error_status: status ?? null,
    class: failureClass,
  };

  return { reviewDetail: JSON.stringify(projection), failureClass };
}

module.exports = { classifyExecutionFile };
