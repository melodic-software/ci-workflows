"use strict";

// Bounded retry for the guard's GitHub reads. A read answered with a server
// error, or a network failure (Octokit reports one as status 500), is tried
// again. Client errors and rate limits (403, 429) are not: a retry cannot fix
// them, and a loop would spend the pool.

const RETRY_STATUSES = new Set([500, 502, 503, 504]);
const BACKOFF_MS = [2000, 5000];
const MAX_WAIT_MS = 30_000;
const READ_WAIT_BUDGET_MS = 59_000;
// Shared by every read one retrier makes, so a job's added wait stays bounded
// however many reads it needs.
const JOB_WAIT_BUDGET_MS = 120_000;

class ReadError extends Error {}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(error) {
  const value = error.response?.headers?.["retry-after"];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

// Returns withRetry(read, describe): read() runs up to BACKOFF_MS.length + 1
// times, and the ReadError it throws names the attempts made, so a persistent
// outage reads differently from one blip.
function createRetry({ sleep = realSleep } = {}) {
  let jobWaited = 0;
  return async function withRetry(read, describe) {
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        const tries = `${attempt} attempt${attempt === 1 ? "" : "s"}`;
        const fail = (why = "") =>
          new ReadError(`${describe}: ${error.message} (${tries}${why})`);
        if (!RETRY_STATUSES.has(error.status) || attempt > BACKOFF_MS.length) {
          throw fail();
        }
        const asked = retryAfterMs(error);
        if (asked > MAX_WAIT_MS) {
          throw fail(
            `; Retry-After ${asked / 1000} s exceeds the ${MAX_WAIT_MS / 1000} s cap`,
          );
        }
        const wait = asked ?? BACKOFF_MS[attempt - 1];
        if (waited + wait > READ_WAIT_BUDGET_MS) {
          throw fail(
            `; the next wait would pass ${READ_WAIT_BUDGET_MS / 1000} s`,
          );
        }
        if (jobWaited + wait > JOB_WAIT_BUDGET_MS) {
          throw fail(
            `; the job's ${JOB_WAIT_BUDGET_MS / 1000} s retry wait budget is spent`,
          );
        }
        waited += wait;
        jobWaited += wait;
        await sleep(wait);
      }
    }
  };
}

module.exports = { createRetry, ReadError };
