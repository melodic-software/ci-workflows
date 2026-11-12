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

test("one job's reads share a 120 s wait budget", async () => {
  const sleeps = [];
  const withRetry = createRetry({ sleep: async (ms) => sleeps.push(ms) });
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

test("separate retriers keep separate budgets", async () => {
  const wait29 = () =>
    httpError(503, "Service Unavailable", { "retry-after": "29" });
  const sleep = async () => {};
  for (let i = 0; i < 3; i++) {
    const withRetry = createRetry({ sleep });
    assert.equal(await withRetry(flaky(wait29(), wait29()), "read"), "ok");
    assert.equal(await withRetry(flaky(wait29(), wait29()), "read"), "ok");
  }
});
