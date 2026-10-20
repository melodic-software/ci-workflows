// Project the last claude-code-action SDK result message into safe, structured
// metadata and classify a genuine infrastructure failure into exactly one coarse
// class: auth | rate-limit | overloaded | max-turns | timeout |
// install-failed | other, plus credit-stop for a caller that opts in (see
// isCreditStop). Reads
// the action's execution_file output (which may be unset, missing, or
// unparsable) and returns the review detail plus failure class.
//
// This runs on a PUBLIC repo. The result message's `result` field is
// model-authored free text and its `errors[]` entries are raw error stacks; both
// are read INSIDE this module only, and nothing but the class token and the
// structured projection below ever leaves it. Never widen the projection to
// either field, and never emit the result message wholesale.
//
// Classification order:
//   0. `timedOut` — the caller saw the step run its whole timeout-minutes
//      budget. A killed step leaves no result message, so wall time decides.
//      Then `installFailed` with no execution file: the action's Bun install
//      failed (seen as an HTTP 429 on the GitHub release download), so Claude
//      never started.
//   1. `api_error_status` — the Anthropic-API HTTP status the SDK records when
//      the last assistant turn was an API error: 401/402/403 auth, 429
//      rate-limit, 5xx overloaded, every other status other.
//   2. max-turns: subtype `error_max_turns` (the run used every turn
//      --max-turns allows), or a success-subtype result with `num_turns` above
//      the caller's `maxTurns`. The second is claude-code-action failing a run that finished past the cap
//      ("Claude reported a successful result after N turns, exceeding the
//      configured maximum of M"), whose result message reads as a success.
//   3. an allowlisted substring over `errors[]`, matching the serialized
//      Anthropic error body (`{"type":"error","error":{"type":"<type>",...}}`)
//      that the API SDK folds into an APIError's message, and so into its stack.
//   4. other.
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
// and 403 `permission_error`. 402 belongs here because a usage-dead
// account credential is a billing/entitlement death, which the API reports as 402.
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

// Closed published-type allowlist. Values projected as error_type come ONLY
// from this list — never from raw model/SDK text — so public-log hygiene holds.
const ERROR_TYPE_ALLOWLIST = [
  ["authentication_error", "auth"],
  ["billing_error", "auth"],
  ["permission_error", "auth"],
  ["rate_limit_error", "rate-limit"],
  ["overloaded_error", "overloaded"],
  ["timeout_error", "overloaded"],
  ["api_error", "overloaded"],
];

function matchErrorType(text) {
  for (const [errorType, failureClass] of ERROR_TYPE_ALLOWLIST) {
    if (text.includes(`"type":"${errorType}"`)) {
      return { errorType, failureClass };
    }
  }
  return { errorType: null, failureClass: "other" };
}

// Mirrors jq's `tostring`, so an object error entry exposes its
// `"type":"..."` body to the substring pass.
function toStringLikeJq(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

// The execution file's messages, or null when it is unset, missing or not a
// JSON array.
function readMessages(executionFilePath) {
  if (!executionFilePath || !fs.existsSync(executionFilePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(executionFilePath, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// credit-stop: an API-key credential whose Console organization has no credit
// left or has hit a spend limit, judged only where no model output exists, so
// the error text read below is the CLI's own. Opt-in through
// `detectCreditStop`; existing callers never see this class.
//
// Proof that the text is the CLI's: the run made no tool call and every
// assistant message carries the SDK's `error` field (a synthesized API-error
// message), and the result reports 0 output tokens. Then a credit-stop
// status (400 spend limit, 402 billing, 429 tier spend cap) or SDK error
// category must be present, the exit code non-zero, and the text must match
// one documented credit-stop phrase. A real workspace spend-limit stop matches
// (the observed test in classify.test.cjs); a zero-balance stop is not yet
// observed. This function is the one place to change.
const CREDIT_STOP_STATUSES = new Set([400, 402, 429]);
const CREDIT_STOP_ERRORS = new Set([
  "billing_error",
  "rate_limit",
  "invalid_request",
]);
const CREDIT_STOP_PHRASES = [
  /credit balance is too low/iu,
  /you have reached your specified (?:workspace )?api usage limits/iu,
  /you have reached your api usage limits/iu,
  /enforced_spend_limit_reached/u,
];
const REGAIN_ACCESS =
  /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}):(\d{2}) UTC/u;

function creditStopText(messages) {
  const result = messages.findLast((message) => message?.type === "result");
  if (result?.is_error !== true) return null;
  const assistants = messages.filter((m) => m?.type === "assistant");
  const content = assistants.flatMap((m) =>
    Array.isArray(m.message?.content) ? m.message.content : [],
  );
  if (content.some((block) => block?.type === "tool_use")) return null;
  if (assistants.some((m) => typeof m.error !== "string")) return null;
  const outputTokens = result.usage?.output_tokens;
  if (outputTokens !== undefined && outputTokens !== 0) return null;
  const status = result.api_error_status;
  const statusMatches =
    typeof status === "number" && CREDIT_STOP_STATUSES.has(status);
  const errorMatches = assistants.some((m) => CREDIT_STOP_ERRORS.has(m.error));
  if (!statusMatches && !errorMatches) return null;
  const text = [
    typeof result.result === "string" ? result.result : "",
    ...(Array.isArray(result.errors) ? result.errors : []).map(toStringLikeJq),
    ...content
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text ?? "")),
  ].join("\n");
  return CREDIT_STOP_PHRASES.some((phrase) => phrase.test(text)) ? text : null;
}

function isCreditStop(messages, { exitCode = null } = {}) {
  if (!Array.isArray(messages)) return false;
  if (typeof exitCode === "number" && exitCode === 0) return false;
  return creditStopText(messages) !== null;
}

// The time a tier spend cap lifts, from the documented "You will regain
// access on YYYY-MM-DD at HH:MM UTC." sentence of a credit stop; else null.
function creditStopResetsAt(messages) {
  const text = Array.isArray(messages) ? creditStopText(messages) : null;
  const match = text?.match(REGAIN_ACCESS);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:00Z`);
  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString().replace(/\.000Z$/u, "Z");
}

function classifyExecutionFile(
  executionFilePath,
  {
    timedOut = false,
    maxTurns = "",
    installFailed = false,
    detectCreditStop = false,
    exitCode = null,
  } = {},
) {
  const fallbackClass = timedOut ? "timeout" : "other";
  if (!executionFilePath || !fs.existsSync(executionFilePath)) {
    return {
      reviewDetail: "(no execution file was produced)",
      failureClass:
        installFailed && !timedOut ? "install-failed" : fallbackClass,
    };
  }

  const last = readMessages(executionFilePath)?.at(-1);
  if (last === undefined || last === null) {
    return {
      reviewDetail: "(execution file present but unparsable)",
      failureClass: fallbackClass,
    };
  }

  const status = last.api_error_status;
  let failureClass;
  // error_type is set only on the substring path: numeric-status classification
  // already has api_error_status as its discriminator.
  let errorType = null;
  if (timedOut) {
    failureClass = "timeout";
  } else if (
    detectCreditStop &&
    isCreditStop(readMessages(executionFilePath), { exitCode })
  ) {
    failureClass = "credit-stop";
  } else if (typeof status === "number") {
    failureClass = classFromStatus(status);
  } else if (
    last.subtype === "error_max_turns" ||
    (last.subtype === "success" &&
      /^\d{1,6}$/u.test(maxTurns) &&
      Number.isInteger(last.num_turns) &&
      last.num_turns > Number(maxTurns))
  ) {
    failureClass = "max-turns";
  } else {
    const text = (Array.isArray(last.errors) ? last.errors : [])
      .map(toStringLikeJq)
      .join("\n");
    const matched = matchErrorType(text);
    failureClass = matched.failureClass;
    errorType = matched.errorType;
  }

  const projection = {
    subtype: last.subtype ?? null,
    is_error: last.is_error ?? null,
    num_turns: last.num_turns ?? null,
    duration_ms: last.duration_ms ?? null,
    total_cost_usd: last.total_cost_usd ?? null,
    api_error_status: status ?? null,
    error_type: errorType,
    class: failureClass,
  };

  return { reviewDetail: JSON.stringify(projection), failureClass };
}

// The run record: structured facts about a run, each printed as a bare
// `key=value` token on the lane's annotation line so a brief can read limit
// stops, the credential behind them, turn headroom and the models used.
// Values come only from typed SDK fields and caller inputs, each checked
// against a closed pattern, never from free text.
const CREDENTIAL_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/u;
const MODEL_PATTERN = /^[\w.:@[\]-]{1,100}$/u;
const COUNT_PATTERN = /^\d{1,6}$/u;
const WINDOW_PATTERN = /^[a-z0-9_]{1,40}$/u;

// SDK `resetsAt` is epoch time; a value past 1e12 can only be milliseconds.
function isoFromEpoch(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const date = new Date(value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString().replace(/\.000Z$/u, "Z");
}

// The limit that stopped the run: the newest `rate_limit_event` whose status
// is `rejected`. Only a rejected event names the window that stopped the run;
// an allowed or warning event's reset is another window's and would bring the
// restart too early, so with none the caller's fallback delay applies.
function limitStopFrom(messages) {
  const info = messages.findLast(
    (message) =>
      message?.type === "rate_limit_event" &&
      message.rate_limit_info?.status === "rejected" &&
      isoFromEpoch(message.rate_limit_info.resetsAt) !== null,
  )?.rate_limit_info;
  if (!info) return { resetsAt: null, resetsWindow: null };
  return {
    resetsAt: isoFromEpoch(info.resetsAt),
    resetsWindow: WINDOW_PATTERN.test(info.rateLimitType ?? "")
      ? info.rateLimitType
      : null,
  };
}

function readRunRecord(executionFilePath) {
  const messages = readMessages(executionFilePath) ?? [];
  const result = messages.findLast((message) => message?.type === "result");
  const turns = result?.num_turns;
  const usage = result?.modelUsage;
  return {
    turns: Number.isInteger(turns) && turns >= 0 ? turns : null,
    models:
      usage && typeof usage === "object" && !Array.isArray(usage)
        ? Object.keys(usage).filter((key) => MODEL_PATTERN.test(key))
        : [],
    ...limitStopFrom(messages),
  };
}

// The record tokens for one annotation line, unknown values omitted.
// `resets=` and `resets-window=` are printed only on a limit stop: that
// stop's reset time and the window (rateLimitType) that stopped it.
function recordTokens(
  { turns = null, models = [], resetsAt = null, resetsWindow = null },
  { failureClass = "", maxTurns = "", credential = "" } = {},
) {
  const tokens = [];
  if (failureClass === "rate-limit" && resetsAt) {
    tokens.push(`resets=${resetsAt}`);
    if (resetsWindow) tokens.push(`resets-window=${resetsWindow}`);
  }
  if (CREDENTIAL_PATTERN.test(credential)) {
    tokens.push(`credential=${credential}`);
  }
  if (turns !== null) tokens.push(`turns=${turns}`);
  if (COUNT_PATTERN.test(maxTurns)) {
    tokens.push(`max-turns=${Number(maxTurns)}`);
  }
  if (models.length > 0) tokens.push(`models=${models.join(",")}`);
  return tokens.join(" ");
}

module.exports = {
  classifyExecutionFile,
  creditStopResetsAt,
  isCreditStop,
  readMessages,
  readRunRecord,
  recordTokens,
};
