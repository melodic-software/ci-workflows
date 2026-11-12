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

function setup() {
  const sleeps = [];
  const logs = [];
  const withRetry = createRetry({
    sleep: async (ms) => sleeps.push(ms),
    log: (message) => logs.push(message),
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
