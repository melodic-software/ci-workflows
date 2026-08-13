"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isSelectorLikeJobName,
  resolveCancelledPrerequisite,
} = require("./resolve-cancelled-prerequisite.cjs");

test("isSelectorLikeJobName matches select-runner naming variants", () => {
  for (const name of [
    "Select runner",
    "select-runner",
    "select_runner",
    "selectrunner",
    "select-runner / Select runner",
  ]) {
    assert.equal(isSelectorLikeJobName(name), true, name);
  }
  assert.equal(isSelectorLikeJobName("pr-title"), false);
  assert.equal(isSelectorLikeJobName(""), false);
});

test("resolveCancelledPrerequisite fails closed when lookup data is missing", () => {
  assert.deepEqual(resolveCancelledPrerequisite(null), {
    outcome: "fail",
    reason: "lookup-failed",
    detail: "workflow jobs response is not an array",
  });
});

test("resolveCancelledPrerequisite fails closed when selector timed out", () => {
  assert.deepEqual(
    resolveCancelledPrerequisite([
      { name: "Select runner", status: "completed", conclusion: "timed_out" },
      { name: "pr-title", status: "completed", conclusion: "success" },
    ]),
    {
      outcome: "fail",
      reason: "timed_out",
      detail: "selector-like prerequisite job concluded timed_out",
    },
  );
});

test("resolveCancelledPrerequisite proceeds when selector truly cancelled", () => {
  assert.deepEqual(
    resolveCancelledPrerequisite([
      { name: "select-runner", status: "completed", conclusion: "cancelled" },
      { name: "pr-title", status: "in_progress", conclusion: null },
    ]),
    {
      outcome: "proceed",
      reason: "cancelled",
      detail: "selector-like prerequisite job concluded cancelled",
    },
  );
});

test("resolveCancelledPrerequisite fails closed on ambiguous timed_out jobs", () => {
  assert.deepEqual(
    resolveCancelledPrerequisite([
      { name: "build", status: "completed", conclusion: "timed_out" },
      { name: "pr-title", status: "in_progress", conclusion: null },
    ]),
    {
      outcome: "fail",
      reason: "timed_out",
      detail:
        "no selector-like job matched; run contains a timed_out job (fail-closed heuristic)",
    },
  );
});

test("resolveCancelledPrerequisite proceeds on ambiguous cancel with no timed_out", () => {
  assert.deepEqual(
    resolveCancelledPrerequisite([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "pr-title", status: "in_progress", conclusion: null },
    ]),
    {
      outcome: "proceed",
      reason: "cancelled-ambiguous",
      detail:
        "no selector-like job matched and no timed_out jobs; treating as true cancel",
    },
  );
});

test("resolveCancelledPrerequisite prefers selector match over unrelated timed_out", () => {
  assert.deepEqual(
    resolveCancelledPrerequisite([
      { name: "Select runner", status: "completed", conclusion: "cancelled" },
      { name: "slow-lane", status: "completed", conclusion: "timed_out" },
    ]),
    {
      outcome: "proceed",
      reason: "cancelled",
      detail: "selector-like prerequisite job concluded cancelled",
    },
  );
});
