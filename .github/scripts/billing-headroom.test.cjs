"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_FREE_THRESHOLD_RATIO,
  DEFAULT_INCLUDED_MINUTES,
  evaluateBillingHeadroom,
  normalizeRoutingState,
} = require("./billing-headroom.cjs");
const { selectRunner } = require("./select-runner.cjs");

function usageItem(overrides = {}) {
  return {
    date: "2026-08-01T00:00:00Z",
    product: "actions",
    sku: "Actions Linux",
    quantity: 100,
    unitType: "Minutes",
    pricePerUnit: 0.006,
    grossAmount: 0.6,
    discountAmount: 0.6,
    netAmount: 0,
    organizationName: "melodic-software",
    repositoryName: "medley",
    ...overrides,
  };
}

function alwaysPrivate() {
  return "private";
}

function visibilityMap(map) {
  return (owner, repo) => map[`${owner}/${repo}`] || "unknown";
}

test("normalizeRoutingState accepts free/exhausted/unknown and JSON payloads", () => {
  assert.equal(normalizeRoutingState("free"), "free");
  assert.equal(normalizeRoutingState(" exhausted "), "exhausted");
  assert.equal(normalizeRoutingState('{"state":"free"}'), "free");
  assert.equal(normalizeRoutingState('{"state":"nope"}'), "unknown");
  assert.equal(normalizeRoutingState(""), "unknown");
  assert.equal(normalizeRoutingState(null), "unknown");
});

test("headroom: private minutes under threshold with no paid spend → free", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [usageItem({ quantity: 500 })],
    resolveVisibility: alwaysPrivate,
    includedMinutes: 3000,
  });
  assert.equal(headroom.state, "free");
  assert.equal(headroom.privateMinutes, 500);
  assert.equal(headroom.consumptionRatio, 0.167);
  assert.equal(headroom.hasPaidSpend, false);
  assert.equal(headroom.withinThreshold, true);
  assert.equal(headroom.freeThresholdRatio, DEFAULT_FREE_THRESHOLD_RATIO);
});

test("headroom: at-or-over 85% threshold → exhausted even with netAmount 0", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [usageItem({ quantity: 2550 })], // 85% of 3000
    resolveVisibility: alwaysPrivate,
    includedMinutes: DEFAULT_INCLUDED_MINUTES,
  });
  assert.equal(headroom.state, "exhausted");
  assert.equal(headroom.withinThreshold, false);
  assert.equal(headroom.hasPaidSpend, false);
});

test("headroom: any private paid spend → exhausted below threshold", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [
      usageItem({ quantity: 100, netAmount: 0.6, discountAmount: 0 }),
    ],
    resolveVisibility: alwaysPrivate,
  });
  assert.equal(headroom.state, "exhausted");
  assert.equal(headroom.hasPaidSpend, true);
  assert.equal(headroom.withinThreshold, true);
});

test("headroom: public minutes are excluded from the included pool", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [
      usageItem({
        repositoryName: "ci-runner",
        quantity: 70000,
      }),
      usageItem({
        repositoryName: "medley",
        quantity: 100,
      }),
    ],
    resolveVisibility: visibilityMap({
      "melodic-software/ci-runner": "public",
      "melodic-software/medley": "private",
    }),
  });
  assert.equal(headroom.state, "free");
  assert.equal(headroom.privateMinutes, 100);
});

test("headroom: unknown visibility is counted (fail loud toward fleet)", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [usageItem({ quantity: 2900 })],
    resolveVisibility: () => "unknown",
  });
  assert.equal(headroom.state, "exhausted");
  assert.equal(headroom.privateMinutes, 2900);
});

test("headroom: non-minute and non-standard SKUs are ignored", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [
      usageItem({
        sku: "Actions storage",
        unitType: "GigabyteHours",
        quantity: 999,
      }),
      usageItem({
        sku: "Actions macOS",
        quantity: 999,
      }),
      usageItem({ quantity: 10 }),
    ],
    resolveVisibility: alwaysPrivate,
  });
  assert.equal(headroom.privateMinutes, 10);
  assert.equal(headroom.state, "free");
});

function selectorInput(overrides = {}) {
  return {
    policy: "prefer-hosted-while-free",
    selfHostedLabel: "melodic-ubuntu-24.04-x64",
    selfHostedLabelsJSON: "",
    hostedRunner: "ubuntu-24.04",
    scope: "organization",
    managedRunnerPrefix: "ci-runner-melo-",
    observerClientID: "Iv23observer",
    hasObserverSecret: true,
    tokenOutcome: "success",
    owner: "melodic-software",
    repository: "medley",
    apiTimeoutSeconds: 10,
    repositoryPrivate: true,
    eventName: "push",
    isForkPullRequest: false,
    admitsAncillaryEvents: false,
    billingMinutesState: "free",
    ...overrides,
  };
}

function requestMustNotRun() {
  throw new Error("inventory request must not run");
}

// Decision table for prefer-hosted-while-free (ci-workflows#252).
const PREFER_HOSTED_DECISION_TABLE = [
  {
    name: "public repo always hosted",
    input: { repositoryPrivate: false, billingMinutesState: "free" },
    route: "hosted",
    reason: "hosted-only",
  },
  {
    name: "private + free → hosted-while-free",
    input: { billingMinutesState: "free" },
    route: "hosted",
    reason: "hosted-while-free",
  },
  {
    name: "private + free JSON payload → hosted-while-free",
    input: {
      billingMinutesState: JSON.stringify({
        state: "free",
        consumptionRatio: 0.18,
      }),
    },
    route: "hosted",
    reason: "hosted-while-free",
  },
  {
    name: "private + exhausted → fleet",
    input: { billingMinutesState: "exhausted" },
    route: "self-hosted",
    reason: "hosted-pool-exhausted",
  },
  {
    name: "private + unknown → fleet (fail toward fleet)",
    input: { billingMinutesState: "unknown" },
    route: "self-hosted",
    reason: "billing-unknown",
  },
  {
    name: "private + missing state → fleet (fail toward fleet)",
    input: { billingMinutesState: "" },
    route: "self-hosted",
    reason: "billing-unknown",
  },
  {
    name: "private + garbage state → fleet",
    input: { billingMinutesState: "not-a-state" },
    route: "self-hosted",
    reason: "billing-unknown",
  },
];

for (const row of PREFER_HOSTED_DECISION_TABLE) {
  test(`prefer-hosted-while-free decision: ${row.name}`, async () => {
    const result = await selectRunner(selectorInput(row.input), {
      request: requestMustNotRun,
    });
    assert.equal(result.route, row.route, row.name);
    assert.equal(result.reason, row.reason, row.name);
    if (row.route === "hosted") {
      assert.equal(result.runner, "ubuntu-24.04");
    } else {
      assert.equal(result.runner, "melodic-ubuntu-24.04-x64");
    }
  });
}

test("prefer-hosted-while-free free path ignores observer credentials", async () => {
  const result = await selectRunner(
    selectorInput({
      billingMinutesState: "free",
      hasObserverSecret: false,
      tokenOutcome: "skipped",
      observerClientID: "",
      scope: "",
    }),
    { request: requestMustNotRun },
  );
  assert.deepEqual(result, {
    runner: "ubuntu-24.04",
    route: "hosted",
    reason: "hosted-while-free",
    onlineRunnerCount: 0,
  });
});

test("prefer-hosted-while-free exhausted rejects unapproved fleet labels", async () => {
  await assert.rejects(
    selectRunner(
      selectorInput({
        billingMinutesState: "exhausted",
        selfHostedLabel: "not-an-allowlisted-label",
      }),
      { request: requestMustNotRun },
    ),
    (error) =>
      error.name === "StrictRoutingError" &&
      error.reason === "unapproved-label",
  );
});
