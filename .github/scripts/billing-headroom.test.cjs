"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_FREE_THRESHOLD_RATIO,
  DEFAULT_INCLUDED_MINUTES,
  STANDARD_HOSTED_SKU_MULTIPLIERS,
  classifyActionsSku,
  evaluateBillingHeadroom,
  normalizeRoutingState,
} = require("./billing-headroom.cjs");
const {
  normalizeBillingMinutesState,
  selectRunner,
} = require("./select-runner.cjs");

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

function freshFreeState(overrides = {}) {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return JSON.stringify({
    state: "free",
    probedAt: now.toISOString(),
    month,
    ...overrides,
  });
}

test("normalizeRoutingState accepts free/exhausted/unknown and JSON payloads", () => {
  assert.equal(normalizeRoutingState("free"), "free");
  assert.equal(normalizeRoutingState(" exhausted "), "exhausted");
  assert.equal(normalizeRoutingState('{"state":"free"}'), "free");
  assert.equal(normalizeRoutingState('{"state":"nope"}'), "unknown");
  assert.equal(normalizeRoutingState(""), "unknown");
  assert.equal(normalizeRoutingState(null), "unknown");
});

test("normalizeBillingMinutesState rejects untimestamped or stale free", () => {
  assert.equal(normalizeBillingMinutesState("free"), "unknown");
  assert.equal(normalizeBillingMinutesState("FREE"), "unknown");
  assert.equal(normalizeBillingMinutesState("exhausted"), "exhausted");
  assert.equal(normalizeBillingMinutesState("UNKNOWN"), "unknown");
  assert.equal(
    normalizeBillingMinutesState(
      JSON.stringify({
        state: "free",
        probedAt: "2020-01-01T00:00:00.000Z",
        month: "2020-01",
      }),
    ),
    "unknown",
  );
  assert.equal(normalizeBillingMinutesState(freshFreeState()), "free");
  assert.equal(
    normalizeBillingMinutesState(freshFreeState({ state: "FREE" })),
    "free",
  );
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

test("headroom: non-minute rows and non-Actions products are ignored", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [
      usageItem({
        sku: "Actions storage",
        unitType: "GigabyteHours",
        quantity: 999,
      }),
      usageItem({
        product: "codespaces",
        sku: "Codespaces Linux 2-core",
        unitType: "Minutes",
        quantity: 999,
      }),
      usageItem({ quantity: 10 }),
    ],
    resolveVisibility: alwaysPrivate,
  });
  assert.equal(headroom.privateMinutes, 10);
  assert.equal(headroom.state, "free");
});

test("headroom: malformed standard hosted minute rows fail closed", async () => {
  await assert.rejects(
    evaluateBillingHeadroom({
      usageItems: [usageItem({ repositoryName: "", quantity: 10 })],
      resolveVisibility: alwaysPrivate,
    }),
    /missing required fields/u,
  );
});

// ci-workflows#519 D2/D3: pool multipliers. The old allowlist made macOS rows
// invisible: 300 private macOS minutes drain the whole 3 000 pool while
// privateMinutes read 0 → false `free`.
test("headroom: macOS SKU row draws the pool at 10x (D2 regression)", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [usageItem({ sku: "Actions macOS 3-core", quantity: 300 })],
    resolveVisibility: alwaysPrivate,
    includedMinutes: 3000,
  });
  assert.equal(headroom.privateMinutes, 3000);
  assert.equal(headroom.consumptionRatio, 1);
  assert.equal(headroom.state, "exhausted");
});

test("headroom: multipliers apply per SKU (Linux 1, Slim 1, Windows 2, macOS 10)", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [
      usageItem({ sku: "Actions Linux", quantity: 100 }),
      usageItem({ sku: "Actions Linux Slim", quantity: 100 }),
      usageItem({ sku: "Actions Windows", quantity: 100 }),
      usageItem({ sku: "Actions macOS", quantity: 10 }),
    ],
    resolveVisibility: alwaysPrivate,
    includedMinutes: 3000,
  });
  // 100 + 100 + 200 + 100
  assert.equal(headroom.privateMinutes, 500);
  assert.equal(headroom.state, "free");
});

test("headroom: Linux Slim is never credited below 1x", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [usageItem({ sku: "Actions Linux Slim", quantity: 2600 })],
    resolveVisibility: alwaysPrivate,
    includedMinutes: 3000,
  });
  assert.equal(headroom.privateMinutes, 2600);
  assert.equal(headroom.state, "exhausted");
});

test("headroom: snake_case billing SKU ids resolve to the same multipliers", () => {
  assert.deepEqual(classifyActionsSku("actions_linux"), {
    kind: "standard",
    multiplier: 1,
  });
  assert.deepEqual(classifyActionsSku("actions_linux_slim"), {
    kind: "standard",
    multiplier: 1,
  });
  assert.deepEqual(classifyActionsSku("actions_linux_arm"), {
    kind: "standard",
    multiplier: 1,
  });
  assert.deepEqual(classifyActionsSku("actions_windows"), {
    kind: "standard",
    multiplier: 2,
  });
  assert.deepEqual(classifyActionsSku("actions_macos"), {
    kind: "standard",
    multiplier: 10,
  });
  assert.deepEqual(classifyActionsSku("  Actions  macOS 3-core "), {
    kind: "standard",
    multiplier: 10,
  });
  assert.deepEqual(classifyActionsSku("linux_4_core"), { kind: "larger" });
  assert.deepEqual(classifyActionsSku("actions_macos_l"), { kind: "larger" });
  assert.deepEqual(classifyActionsSku("Actions Linux 4-core"), {
    kind: "larger",
  });
  assert.deepEqual(classifyActionsSku("Actions Quantum"), {
    kind: "unrecognized",
  });
  assert.deepEqual(classifyActionsSku(""), { kind: "unrecognized" });
  assert.deepEqual(classifyActionsSku(undefined), { kind: "unrecognized" });
});

test("headroom: every standard multiplier is at least the documented legacy floor", () => {
  for (const [sku, multiplier] of Object.entries(
    STANDARD_HOSTED_SKU_MULTIPLIERS,
  )) {
    const floor = sku.includes("macos") ? 10 : sku.includes("windows") ? 2 : 1;
    assert.ok(
      multiplier >= floor,
      `${sku} multiplier ${multiplier} is below its floor ${floor}`,
    );
  }
});

test("headroom: an unrecognized Actions minute SKU fails closed (never free)", async () => {
  await assert.rejects(
    evaluateBillingHeadroom({
      usageItems: [
        usageItem({ quantity: 10 }),
        usageItem({ sku: "Actions Quantum 2-qubit", quantity: 1 }),
      ],
      resolveVisibility: alwaysPrivate,
    }),
    /unrecognized Actions minute SKU "Actions Quantum 2-qubit"/u,
  );
  // Visibility does not rescue it: an unrecognized SKU is refused before the
  // repo is looked up, so even an all-public report cannot claim free.
  await assert.rejects(
    evaluateBillingHeadroom({
      usageItems: [usageItem({ sku: "Actions Quantum 2-qubit", quantity: 1 })],
      resolveVisibility: () => "public",
    }),
    /unrecognized Actions minute SKU/u,
  );
  // An Actions minute row with no sku at all is unrecognized, not malformed.
  await assert.rejects(
    evaluateBillingHeadroom({
      usageItems: [usageItem({ sku: "", quantity: 1 })],
      resolveVisibility: alwaysPrivate,
    }),
    /unrecognized Actions minute SKU ""/u,
  );
});

test("headroom: larger-runner SKU on a private or unknown repo fails closed", async () => {
  await assert.rejects(
    evaluateBillingHeadroom({
      usageItems: [usageItem({ sku: "linux_4_core", quantity: 1 })],
      resolveVisibility: alwaysPrivate,
    }),
    /larger-runner Actions SKU "linux_4_core" on private repo melodic-software\/medley is paid-only/u,
  );
  await assert.rejects(
    evaluateBillingHeadroom({
      usageItems: [usageItem({ sku: "macos_l", quantity: 1 })],
      resolveVisibility: () => "unknown",
    }),
    /larger-runner Actions SKU "macos_l" on unknown repo/u,
  );
});

test("headroom: larger-runner SKU on a public repo does not touch the pool", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [
      usageItem({
        repositoryName: "ci-runner",
        sku: "linux_4_core",
        quantity: 5000,
      }),
      usageItem({ repositoryName: "medley", quantity: 10 }),
    ],
    resolveVisibility: visibilityMap({
      "melodic-software/ci-runner": "public",
      "melodic-software/medley": "private",
    }),
  });
  assert.equal(headroom.privateMinutes, 10);
  assert.equal(headroom.state, "free");
});

// ci-workflows#519 D1: the probe's resolveVisibility used to turn an empty or
// `private`-less body into "public". The headroom math must count whatever it
// hands back as "unknown", so a missing answer can never subtract minutes.
test("headroom: a visibility that is neither private nor public is counted", async () => {
  for (const visibility of ["unknown", undefined, null, "", "PUBLIC", 42]) {
    const headroom = await evaluateBillingHeadroom({
      usageItems: [usageItem({ quantity: 2600 })],
      resolveVisibility: () => visibility,
    });
    assert.equal(
      headroom.privateMinutes,
      2600,
      `visibility ${String(visibility)} must be counted`,
    );
    assert.equal(headroom.state, "exhausted");
  }
});

// The live scenario from #519: 3 913 raw private Linux minutes plus a macOS
// row. Dropping any single repo (here via a "public" misclassification of
// provisioning) used to flip exhausted → free; with the macOS row counted at
// 10x the pool is over threshold regardless.
test("headroom: #519 live shape stays exhausted when a macOS row is present", async () => {
  const headroom = await evaluateBillingHeadroom({
    usageItems: [
      usageItem({ repositoryName: "provisioning", quantity: 1469 }),
      usageItem({ repositoryName: "medley", quantity: 1183 }),
      usageItem({ repositoryName: "dotfiles", quantity: 814 }),
      usageItem({ repositoryName: "github-iac", quantity: 426 }),
      usageItem({ repositoryName: "claude-code-proxy", quantity: 21 }),
      usageItem({ repositoryName: "medley", quantity: 34, sku: "Actions Windows" }),
      usageItem({
        repositoryName: "medley",
        quantity: 20,
        sku: "Actions macOS 3-core",
      }),
    ],
    resolveVisibility: visibilityMap({
      "melodic-software/provisioning": "public",
      "melodic-software/medley": "private",
      "melodic-software/dotfiles": "private",
      "melodic-software/github-iac": "private",
      "melodic-software/claude-code-proxy": "private",
    }),
  });
  // 1183 + 814 + 426 + 21 + 34*2 + 20*10 = 2712 ≥ 2550
  assert.equal(headroom.privateMinutes, 2712);
  assert.equal(headroom.state, "exhausted");
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
    billingMinutesState: freshFreeState(),
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
    input: { repositoryPrivate: false, billingMinutesState: freshFreeState() },
    route: "hosted",
    reason: "hosted-only",
  },
  {
    name: "private + fresh free JSON → hosted-while-free",
    input: { billingMinutesState: freshFreeState() },
    route: "hosted",
    reason: "hosted-while-free",
  },
  {
    name: "private + compact free → fleet (untimestamped free rejected)",
    input: { billingMinutesState: "free" },
    route: "self-hosted",
    reason: "billing-unknown",
  },
  {
    name: "private + stale free JSON → fleet",
    input: {
      billingMinutesState: JSON.stringify({
        state: "free",
        probedAt: "2020-01-01T00:00:00.000Z",
        month: "2020-01",
      }),
    },
    route: "self-hosted",
    reason: "billing-unknown",
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
      billingMinutesState: freshFreeState(),
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
