"use strict";

// Bounded retry for the guard's GitHub reads.
// - Server errors (HTTP 500, 502, 503, 504; Octokit reports a network failure
//   as status 500) are retried up to twice with 2 s / 5 s backoff (or
//   Retry-After up to 30 s), capped at 59 s per read and 120 s per job.
// - Primary rate limits (HTTP 403/429 with x-ratelimit-remaining: 0 and no
//   secondary-limit message) wait until x-ratelimit-reset (or Retry-After when
//   present, else 60 s) and retry once.
// - Secondary rate limits (HTTP 429 or rate-limit 403) wait Retry-After when
//   present, else back off exponentially (60 s, then 120 s) per GitHub's
//   guidance, up to twice.
// - All waits across one retrier's reads share a 420 s (7 min) job wait budget,
//   staying inside a 10-minute job timeout. Non-rate-limit 4xx errors fail at
//   once.

const RETRY_STATUSES = new Set([500, 502, 503, 504]);
const BACKOFF_MS = [2000, 5000];
const MAX_WAIT_MS = 30_000;
const READ_WAIT_BUDGET_MS = 59_000;
// Shared by server-error retries across one retrier's reads.
const SERVER_JOB_WAIT_BUDGET_MS = 120_000;
// GitHub's secondary rate-limit guidance: wait at least 60 s when Retry-After
// is absent, then double on a repeat hit.
const SECONDARY_BACKOFF_MS = [60_000, 120_000];
// Shared by every wait (5xx and rate limits) one retrier makes, so a 10-minute
// job keeps margin to run the check after waiting out a 5-7 minute reset.
const JOB_WAIT_BUDGET_MS = 420_000;

const RATE_LIMIT_MESSAGE = /rate limit|RATE_LIMITED|abuse detection/iu;
const SECONDARY_LIMIT_MESSAGE = /secondary rate limit|abuse detection/iu;

class ReadError extends Error {}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function header(error, name) {
  const headers = error.response?.headers;
  if (!headers || typeof headers !== "object") return "";
  if (name in headers) return String(headers[name] ?? "").trim();
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return String(value ?? "").trim();
  }
  return "";
}

// Retry-After is delay-seconds (digits only) or an HTTP-date (RFC 9110
// section 10.2.3). A value in neither form, or one asking for no wait, is
// treated as absent so the backoff applies rather than an immediate retry.
function retryAfterMs(error, now) {
  const value = header(error, "retry-after");
  if (value === "") return undefined;
  const ms = /^\d+$/u.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now();
  return ms > 0 ? ms : undefined;
}

function rateLimitResetSec(error) {
  const value = header(error, "x-ratelimit-reset");
  return /^\d{1,10}$/u.test(value) ? Number(value) : undefined;
}

function isRateLimit(error, status) {
  if (status === 429) return true;
  if (status !== 403) return false;
  return (
    header(error, "retry-after") !== "" ||
    header(error, "x-ratelimit-remaining") === "0" ||
    RATE_LIMIT_MESSAGE.test(String(error.message ?? ""))
  );
}

function isPrimaryRateLimit(error) {
  return (
    header(error, "x-ratelimit-remaining") === "0" &&
    !SECONDARY_LIMIT_MESSAGE.test(String(error.message ?? ""))
  );
}

function formatReset(resetSec) {
  return resetSec === undefined
    ? ""
    : `; resets at ${new Date(resetSec * 1000).toISOString()}`;
}

// Returns withRetry(read, describe): retries transient 5xx and GitHub rate
// limits within bounded per-read and job-wide wait budgets. The ReadError it
// throws names the attempts made, so a persistent outage reads differently
// from one blip. log() records each wait, so a saved read still leaves a trace.
function createRetry({
  sleep = realSleep,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  let jobServerWaited = 0;
  let jobWaited = 0;
  return async function withRetry(read, describe) {
    let serverRetries = 0;
    let serverWaited = 0;
    let primaryRetries = 0;
    let secondaryRetries = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        const status = error.status ?? error.response?.status;
        const tries = `${attempt} attempt${attempt === 1 ? "" : "s"}`;
        const fail = (why = "") =>
          new ReadError(`${describe}: ${error.message} (${tries}${why})`, {
            cause: error,
          });
        if (RETRY_STATUSES.has(status)) {
          if (serverRetries >= BACKOFF_MS.length) {
            throw fail();
          }
          const asked = retryAfterMs(error, now);
          if (asked > MAX_WAIT_MS) {
            throw fail(
              `; Retry-After ${Math.ceil(asked / 1000)} s exceeds the ${MAX_WAIT_MS / 1000} s cap`,
            );
          }
          const wait = asked ?? BACKOFF_MS[serverRetries];
          if (serverWaited + wait > READ_WAIT_BUDGET_MS) {
            throw fail(
              `; the next wait would pass ${READ_WAIT_BUDGET_MS / 1000} s`,
            );
          }
          if (jobServerWaited + wait > SERVER_JOB_WAIT_BUDGET_MS) {
            throw fail(
              `; the job's ${SERVER_JOB_WAIT_BUDGET_MS / 1000} s retry wait budget is spent`,
            );
          }
          if (jobWaited + wait > JOB_WAIT_BUDGET_MS) {
            throw fail(
              `; the job's ${JOB_WAIT_BUDGET_MS / 1000} s wait budget is spent`,
            );
          }
          serverRetries++;
          serverWaited += wait;
          jobServerWaited += wait;
          jobWaited += wait;
          log(
            `${describe}: HTTP ${status} ${error.message}; retry ${serverRetries} of ${BACKOFF_MS.length} in ${Math.ceil(wait / 1000)} s`,
          );
          await sleep(wait);
          continue;
        }
        if (isRateLimit(error, status)) {
          const reset = rateLimitResetSec(error);
          const asked = retryAfterMs(error, now);
          const primary = isPrimaryRateLimit(error);
          if (primary && primaryRetries >= 1) {
            throw fail(
              `; still rate limited after waiting${formatReset(reset)}`,
            );
          }
          if (!primary && secondaryRetries >= SECONDARY_BACKOFF_MS.length) {
            throw fail(formatReset(reset));
          }
          const wait = primary
            ? (asked ??
              (reset !== undefined
                ? Math.max(1, reset - Math.floor(now() / 1000)) * 1000
                : SECONDARY_BACKOFF_MS[0]))
            : (asked ?? SECONDARY_BACKOFF_MS[secondaryRetries]);
          const left = JOB_WAIT_BUDGET_MS - jobWaited;
          if (wait > left) {
            const scope =
              jobWaited === 0
                ? `the ${JOB_WAIT_BUDGET_MS / 1000} s wait budget`
                : `the ${Math.floor(left / 1000)} s left of the ${JOB_WAIT_BUDGET_MS / 1000} s wait budget`;
            throw fail(
              `; rate-limit wait ${Math.ceil(wait / 1000)} s exceeds ${scope}${formatReset(reset)}`,
            );
          }
          jobWaited += wait;
          if (primary) {
            primaryRetries++;
            const until =
              reset !== undefined
                ? ` (${new Date(reset * 1000).toISOString()})`
                : "";
            log(
              `${describe}: HTTP ${status} ${error.message}; waiting ${Math.ceil(wait / 1000)} s for primary rate limit reset${until} before retrying`,
            );
          } else {
            secondaryRetries++;
            log(
              `${describe}: HTTP ${status} ${error.message}; secondary rate limit retry ${secondaryRetries} of ${SECONDARY_BACKOFF_MS.length} in ${Math.ceil(wait / 1000)} s`,
            );
          }
          await sleep(wait);
          continue;
        }
        throw fail();
      }
    }
  };
}

module.exports = { createRetry, ReadError };
