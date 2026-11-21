"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createRetry, ReadError } = require("./retry.cjs");

function httpError(status, message, headers = {}) {
  return Object.assign(new Error(message), {
    status,
    response: { status, headers },
  });
}

// A read that throws each queued error in turn, then answers "ok".
function flaky(...errors) {
  let calls = 0;
  const read = async () => {
    const error = errors[calls++];
    if (error) throw error;
    return "ok";
  };
  read.calls = () => calls;
  return read;
}

function setup({ now } = {}) {
  const sleeps = [];
  const logs = [];
  const withRetry = createRetry({
    sleep: async (ms) => sleeps.push(ms),
    log: (message) => logs.push(message),
    now,
  });
  return { withRetry, sleeps, logs };
}

test("each wait is logged with the read, the answer, the retry count and the wait", async () => {
  const { withRetry, logs } = setup();
  const read = flaky(
    httpError(503, "Service Unavailable"),
    httpError(502, "Bad Gateway"),
  );
  assert.equal(await withRetry(read, "could not read pull request #7"), "ok");
  assert.deepEqual(logs, [
    "could not read pull request #7: HTTP 503 Service Unavailable; retry 1 of 2 in 2 s",
    "could not read pull request #7: HTTP 502 Bad Gateway; retry 2 of 2 in 5 s",
  ]);
});

test("a read that fails at once logs no retry", async () => {
  const { withRetry, logs } = setup();
  await assert.rejects(
    withRetry(flaky(httpError(404, "Not Found")), "read"),
    ReadError,
  );
  assert.deepEqual(logs, []);
});

test("the ReadError keeps the last error as its cause", async () => {
  const { withRetry } = setup();
  const last = httpError(404, "Not Found");
  await assert.rejects(withRetry(flaky(last), "read"), (error) => {
    assert.equal(error.cause, last);
    return true;
  });
});

test("a retrier's reads share a 120 s wait budget", async () => {
  const { withRetry, sleeps } = setup();
  const wait29 = () =>
    httpError(503, "Service Unavailable", { "retry-after": "29" });
  assert.equal(await withRetry(flaky(wait29(), wait29()), "read one"), "ok");
  assert.equal(await withRetry(flaky(wait29(), wait29()), "read two"), "ok");
  const third = flaky(wait29());
  await assert.rejects(withRetry(third, "read three"), (error) => {
    assert.ok(error instanceof ReadError);
    assert.equal(
      error.message,
      "read three: Service Unavailable (1 attempt; the job's 120 s retry wait budget is spent)",
    );
    return true;
  });
  assert.equal(third.calls(), 1);
  assert.deepEqual(sleeps, [29000, 29000, 29000, 29000]);
});

// RFC 9110 section 10.2.3: Retry-After is an HTTP-date or a non-negative
// decimal integer of seconds. A value that asks for no wait, or that is not
// one of those forms, falls back to the 2 s backoff.
for (const value of ["", " ", "0", "0x1E", "-5", "1.5"]) {
  test(`Retry-After ${JSON.stringify(value)} falls back to the 2 s backoff`, async () => {
    const { withRetry, sleeps } = setup();
    const read = flaky(
      httpError(503, "Service Unavailable", { "retry-after": value }),
    );
    assert.equal(await withRetry(read, "read"), "ok");
    assert.deepEqual(sleeps, [2000]);
  });
}

test("a past Retry-After date falls back to the 2 s backoff", async () => {
  const { withRetry, sleeps } = setup();
  const past = new Date(Date.now() - 60_000).toUTCString();
  const read = flaky(
    httpError(503, "Service Unavailable", { "retry-after": past }),
  );
  assert.equal(await withRetry(read, "read"), "ok");
  assert.deepEqual(sleeps, [2000]);
});

test("a Retry-After date 10 s ahead waits until then", async () => {
  const { withRetry, sleeps } = setup();
  const soon = new Date(Date.now() + 10_000).toUTCString();
  const read = flaky(
    httpError(503, "Service Unavailable", { "retry-after": soon }),
  );
  assert.equal(await withRetry(read, "read"), "ok");
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 8000 && sleeps[0] <= 10_000, `waited ${sleeps[0]}`);
});

test("a Retry-After date 2 minutes ahead fails without a retry", async () => {
  const { withRetry, sleeps } = setup();
  const late = new Date(Date.now() + 120_000).toUTCString();
  const read = flaky(
    httpError(503, "Service Unavailable", { "retry-after": late }),
  );
  await assert.rejects(withRetry(read, "read"), /exceeds the 30 s cap/u);
  assert.equal(read.calls(), 1);
  assert.deepEqual(sleeps, []);
});

const FIXED_NOW_MS = Date.parse("2026-11-19T19:44:08.000Z");
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

test("a primary rate limit waits until x-ratelimit-reset and retries once", async () => {
  const reset = FIXED_NOW_SEC + 300;
  const { withRetry, sleeps, logs } = setup({ now: () => FIXED_NOW_MS });
  const read = flaky(
    httpError(403, "API rate limit exceeded for installation", {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset),
    }),
  );
  assert.equal(
    await withRetry(read, "could not read pull request #17482"),
    "ok",
  );
  assert.equal(read.calls(), 2);
  assert.deepEqual(sleeps, [300_000]);
  assert.equal(logs.length, 1);
  assert.match(
    logs[0],
    /HTTP 403 API rate limit exceeded for installation; waiting 300 s for primary rate limit reset \(2026-11-19T19:49:08\.000Z\) before retrying/u,
  );
});

test("a primary rate limit with a past x-ratelimit-reset waits 1 s and retries", async () => {
  const { withRetry, sleeps } = setup({ now: () => FIXED_NOW_MS });
  const read = flaky(
    httpError(403, "API rate limit exceeded", {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(FIXED_NOW_SEC - 10),
    }),
  );
  assert.equal(await withRetry(read, "read"), "ok");
  assert.equal(read.calls(), 2);
  assert.deepEqual(sleeps, [1000]);
});

test("a primary rate limit without reset headers falls back to 60 s", async () => {
  const { withRetry, sleeps } = setup({ now: () => FIXED_NOW_MS });
  const read = flaky(
    httpError(403, "API rate limit exceeded", {
      "x-ratelimit-remaining": "0",
    }),
  );
  assert.equal(await withRetry(read, "read"), "ok");
  assert.equal(read.calls(), 2);
  assert.deepEqual(sleeps, [60_000]);
});

test("a primary rate limit whose reset exceeds 420 s fails without waiting", async () => {
  const reset = FIXED_NOW_SEC + 900;
  const { withRetry, sleeps, logs } = setup({ now: () => FIXED_NOW_MS });
  const read = flaky(
    httpError(403, "API rate limit exceeded for installation", {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset),
    }),
  );
  await assert.rejects(withRetry(read, "read"), (error) => {
    assert.ok(error instanceof ReadError);
    assert.match(
      error.message,
      /read: API rate limit exceeded for installation \(1 attempt; rate-limit wait 900 s exceeds the 420 s wait budget; resets at 2026-11-19T19:59:08\.000Z\)/u,
    );
    return true;
  });
  assert.equal(read.calls(), 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(logs, []);
});

test("a primary rate limit that persists after waiting fails after 2 attempts", async () => {
  const reset = FIXED_NOW_SEC + 120;
  const limited = () =>
    httpError(403, "API rate limit exceeded for installation", {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset),
    });
  const { withRetry, sleeps } = setup({ now: () => FIXED_NOW_MS });
  const read = flaky(limited(), limited());
  await assert.rejects(withRetry(read, "read"), (error) => {
    assert.ok(error instanceof ReadError);
    assert.match(
      error.message,
      /\(2 attempts; still rate limited after waiting; resets at 2026-11-19T19:46:08\.000Z\)/u,
    );
    return true;
  });
  assert.equal(read.calls(), 2);
  assert.deepEqual(sleeps, [120_000]);
});

test("a secondary rate limit without Retry-After backs off exponentially (60 s, 120 s) and fails after 3 attempts", async () => {
  const secondary = () =>
    httpError(403, "You have exceeded a secondary rate limit.");
  const { withRetry, sleeps, logs } = setup({ now: () => FIXED_NOW_MS });
  const read = flaky(secondary(), secondary(), secondary());
  await assert.rejects(withRetry(read, "read"), (error) => {
    assert.ok(error instanceof ReadError);
    assert.match(error.message, /\(3 attempts\)/u);
    return true;
  });
  assert.equal(read.calls(), 3);
  assert.deepEqual(sleeps, [60_000, 120_000]);
  assert.deepEqual(logs, [
    "read: HTTP 403 You have exceeded a secondary rate limit.; secondary rate limit retry 1 of 2 in 60 s",
    "read: HTTP 403 You have exceeded a secondary rate limit.; secondary rate limit retry 2 of 2 in 120 s",
  ]);
});

test("a 429 or abuse-detection 403 respects Retry-After and succeeds on retry", async () => {
  for (const error of [
    httpError(429, "Too Many Requests", { "Retry-After": "15" }),
    httpError(403, "You have triggered an abuse detection mechanism", {
      "retry-after": "15",
    }),
  ]) {
    const { withRetry, sleeps } = setup({ now: () => FIXED_NOW_MS });
    const read = flaky(error);
    assert.equal(await withRetry(read, "read"), "ok");
    assert.equal(read.calls(), 2);
    assert.deepEqual(sleeps, [15_000]);
  }
});

test("a secondary rate limit whose Retry-After exceeds 420 s fails without waiting", async () => {
  const { withRetry, sleeps } = setup({ now: () => FIXED_NOW_MS });
  const read = flaky(
    httpError(429, "Too Many Requests", { "retry-after": "600" }),
  );
  await assert.rejects(
    withRetry(read, "read"),
    /rate-limit wait 600 s exceeds the 420 s wait budget/u,
  );
  assert.equal(read.calls(), 1);
  assert.deepEqual(sleeps, []);
});

test("a non-rate-limit 403 fails at once without waiting", async () => {
  const { withRetry, sleeps, logs } = setup({ now: () => FIXED_NOW_MS });
  const read = flaky(
    httpError(403, "Resource not accessible by integration", {
      "x-ratelimit-remaining": "4999",
    }),
  );
  await assert.rejects(
    withRetry(read, "read"),
    /Resource not accessible by integration \(1 attempt\)/u,
  );
  assert.equal(read.calls(), 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(logs, []);
});

test("rate-limit waits across reads share the 420 s job wait budget", async () => {
  const { withRetry, sleeps } = setup({ now: () => FIXED_NOW_MS });
  const primary = (deltaSec) =>
    httpError(403, "API rate limit exceeded", {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(FIXED_NOW_SEC + deltaSec),
    });
  assert.equal(await withRetry(flaky(primary(300)), "read one"), "ok");
  const second = flaky(primary(200));
  await assert.rejects(withRetry(second, "read two"), (error) => {
    assert.ok(error instanceof ReadError);
    assert.match(
      error.message,
      /rate-limit wait 200 s exceeds the 120 s left of the 420 s wait budget/u,
    );
    return true;
  });
  assert.equal(second.calls(), 1);
  assert.deepEqual(sleeps, [300_000]);
});
