"use strict";

// Shared headroom math for prefer-hosted-while-free (ci-workflows#252).
// select-runner consumes only the cached state string; this module turns a
// billing usage report into that state for the probe / poll path.

const DEFAULT_INCLUDED_MINUTES = 3000; // GitHub Team / Pro private-repo pool
const DEFAULT_FREE_THRESHOLD_RATIO = 0.85;

const ACTIONS_PRODUCT = "actions";
const MINUTE_UNIT_TYPES = Object.freeze(["minutes", "minute"]);
const STANDARD_HOSTED_SKUS = Object.freeze([
  "Actions Linux",
  "Actions Linux Slim",
  "Actions Windows",
]);

const ROUTING_STATES = Object.freeze({
  FREE: "free",
  EXHAUSTED: "exhausted",
  UNKNOWN: "unknown",
});

function isActionsMinuteItem(item) {
  return (
    String(item?.product ?? "").toLowerCase() === ACTIONS_PRODUCT &&
    MINUTE_UNIT_TYPES.includes(String(item?.unitType ?? "").toLowerCase())
  );
}

function isStandardHostedSku(item) {
  return STANDARD_HOSTED_SKUS.includes(String(item?.sku ?? ""));
}

function hasRequiredFields(item) {
  const quantity = Number(item?.quantity);
  return (
    Boolean(item?.organizationName) &&
    Boolean(item?.repositoryName) &&
    Boolean(item?.sku) &&
    Number.isFinite(quantity) &&
    quantity >= 0
  );
}

function normalizeRoutingState(value) {
  if (typeof value !== "string") {
    return ROUTING_STATES.UNKNOWN;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === ROUTING_STATES.FREE ||
    normalized === ROUTING_STATES.EXHAUSTED ||
    normalized === ROUTING_STATES.UNKNOWN
  ) {
    return normalized;
  }
  // Accept compact JSON written by the probe: {"state":"free",...}
  if (normalized.startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      return normalizeRoutingState(parsed?.state);
    } catch {
      return ROUTING_STATES.UNKNOWN;
    }
  }
  return ROUTING_STATES.UNKNOWN;
}

function billingMonth(now = Date.now()) {
  const date = new Date(now);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

/**
 * Evaluate private-repo hosted-minute headroom from a usage report.
 *
 * @param {object} options
 * @param {unknown[]} options.usageItems raw `usageItems` from the usage API
 * @param {(owner: string, repo: string) => string | Promise<string>} options.resolveVisibility
 *   returns "private" | "public" | "unknown" — unknown is counted (fail loud)
 * @param {number} [options.includedMinutes]
 * @param {number} [options.freeThresholdRatio] prefer hosted while below this
 * @returns {Promise<object>}
 */
async function evaluateBillingHeadroom({
  usageItems,
  resolveVisibility,
  includedMinutes = DEFAULT_INCLUDED_MINUTES,
  freeThresholdRatio = DEFAULT_FREE_THRESHOLD_RATIO,
} = {}) {
  if (!Array.isArray(usageItems)) {
    throw new Error("usageItems must be an array");
  }
  if (!Number.isFinite(includedMinutes) || includedMinutes <= 0) {
    throw new Error("includedMinutes must be a positive number");
  }
  if (
    !Number.isFinite(freeThresholdRatio) ||
    freeThresholdRatio <= 0 ||
    freeThresholdRatio > 1
  ) {
    throw new Error("freeThresholdRatio must be in (0, 1]");
  }
  if (typeof resolveVisibility !== "function") {
    throw new Error("resolveVisibility(owner, repo) is required");
  }

  let privateMinutes = 0;
  let hasPaidSpend = false;
  const visibilityCache = new Map();

  for (const item of usageItems) {
    if (!isActionsMinuteItem(item) || !isStandardHostedSku(item)) {
      continue;
    }
    // Fail closed: a standard hosted minute SKU with a broken envelope must not
    // under-count into a false `free` (prefer-hosted-while-free).
    if (!hasRequiredFields(item)) {
      throw new Error(
        "standard hosted Actions minute row is missing required fields; refusing free headroom",
      );
    }
    const owner = String(item.organizationName);
    const repo = String(item.repositoryName);
    const cacheKey = `${owner}/${repo}`;
    let visibility = visibilityCache.get(cacheKey);
    if (visibility === undefined) {
      visibility = await resolveVisibility(owner, repo);
      visibilityCache.set(cacheKey, visibility);
    }
    // Public minutes do not draw the included pool. Unknown visibility is
    // counted so under-reporting cannot claim free headroom falsely.
    if (visibility === "public") {
      continue;
    }
    const quantity = Number(item.quantity);
    privateMinutes += quantity;
    const netAmount = Number(item.netAmount);
    if (Number.isFinite(netAmount) && netAmount > 0) {
      hasPaidSpend = true;
    }
  }

  const consumptionRatio = privateMinutes / includedMinutes;
  const withinThreshold = consumptionRatio < freeThresholdRatio;
  const state =
    withinThreshold && !hasPaidSpend
      ? ROUTING_STATES.FREE
      : ROUTING_STATES.EXHAUSTED;

  return Object.freeze({
    state,
    privateMinutes: Math.round(privateMinutes * 10) / 10,
    includedMinutes,
    consumptionRatio: Math.round(consumptionRatio * 1000) / 1000,
    freeThresholdRatio,
    hasPaidSpend,
    withinThreshold,
  });
}

function headroomToCachePayload(headroom, { org, probedAt, month } = {}) {
  return Object.freeze({
    state: headroom.state,
    privateMinutes: headroom.privateMinutes,
    includedMinutes: headroom.includedMinutes,
    consumptionRatio: headroom.consumptionRatio,
    hasPaidSpend: headroom.hasPaidSpend,
    freeThresholdRatio: headroom.freeThresholdRatio,
    org: org || null,
    month: month || null,
    probedAt: probedAt || new Date().toISOString(),
  });
}

module.exports = Object.freeze({
  DEFAULT_FREE_THRESHOLD_RATIO,
  DEFAULT_INCLUDED_MINUTES,
  ROUTING_STATES,
  STANDARD_HOSTED_SKUS,
  billingMonth,
  evaluateBillingHeadroom,
  headroomToCachePayload,
  isActionsMinuteItem,
  isStandardHostedSku,
  normalizeRoutingState,
});
