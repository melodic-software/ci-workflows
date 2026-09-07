"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveCancelledPrerequisite,
} = require("./resolve-cancelled-prerequisite.cjs");

test("resolveCancelledPrerequisite fails closed when lookup data is missing", () => {
  assert.deepEqual(resolveCancelledPrerequisite(null), {
    outcome: "fail",
    reason: "lookup-failed",
    detail: "workflow jobs response is not an array",
  });
});

test("resolveCancelledPrerequisite fails closed when a prerequisite timed out", () => {
  assert.deepEqual(
    resolveCancelledPrerequisite([
      { name: "build", status: "completed", conclusion: "timed_out" },
      { name: "pr-title", status: "completed", conclusion: "success" },
    ]),
    {
      outcome: "fail",
      reason: "timed_out",
      detail: "run contains a timed_out job (fail-closed heuristic)",
    },
  );
});

test("resolveCancelledPrerequisite proceeds when the run was truly cancelled", () => {
  assert.deepEqual(
    resolveCancelledPrerequisite([
      { name: "build", status: "completed", conclusion: "cancelled" },
      { name: "pr-title", status: "in_progress", conclusion: null },
    ]),
    {
      outcome: "proceed",
      reason: "cancelled",
      detail: "no timed_out job in the run; treating as true cancel",
    },
  );
});

test("resolveCancelledPrerequisite ignores jobs that have not reached a terminal state", () => {
  assert.deepEqual(
    resolveCancelledPrerequisite([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "pr-title", status: "in_progress", conclusion: null },
    ]),
    {
      outcome: "proceed",
      reason: "cancelled",
      detail: "no timed_out job in the run; treating as true cancel",
    },
  );
});
