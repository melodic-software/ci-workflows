"use strict";

// Shared headroom math for prefer-hosted-while-free (ci-workflows#252).
// select-runner consumes only the cached state string; this module turns a
// billing usage report into that state for the probe / poll path.
//
// Every branch here fails closed (ci-workflows#519): the only way to reach
// `free` is a usage report in which every Actions minute row is a recognized
// standard SKU whose multiplied draw stays under the threshold. Anything this
// module does not understand throws, which the probe records as `unknown` and
// the selector routes to the fleet.

const DEFAULT_INCLUDED_MINUTES = 3000; // GitHub Team / Pro private-repo pool
const DEFAULT_FREE_THRESHOLD_RATIO = 0.85;

const ACTIONS_PRODUCT = "actions";
const MINUTE_UNIT_TYPES = Object.freeze(["minutes", "minute"]);

// Included-pool draw per billed minute for standard GitHub-hosted runner SKUs,
// keyed by the lowercased `sku` string. Both the display names the usage API
// emits (observed live: "Actions Linux", "Actions Linux Slim",
// "Actions Windows", "Actions macOS 3-core") and the snake_case billing SKU
// ids from the pricing reference are accepted.
//
// Two sources, merged fail-closed — a SKU is never credited below its
// documented legacy multiplier:
//   - legacy included-pool multipliers (removed from current docs, still what
//     the pool empirically draws at): Linux 1, Windows 2, macOS 10
//   - current per-minute rates
//     (https://docs.github.com/en/billing/reference/actions-runner-pricing):
//     Linux slim $0.002, Linux x64 $0.006, Linux ARM $0.005, Windows $0.010,
//     macOS $0.062. macOS / Linux x64 ≈ 10.33; 10 is the documented floor and
//     the value used here.
// Linux Slim is deliberately NOT credited below 1 — that would undercount
// pool draw and is exactly the direction a false `free` comes from.
const STANDARD_HOSTED_SKU_MULTIPLIERS = Object.freeze({
  "actions linux": 1,
  "actions linux slim": 1,
  "actions linux arm": 1,
  actions_linux: 1,
  actions_linux_slim: 1,
  actions_linux_arm: 1,
  "actions windows": 2,
  "actions windows arm": 2,
  actions_windows: 2,
  actions_windows_arm: 2,
  "actions macos": 10,
  "actions macos 3-core": 10,
  "actions macos 4-core": 10,
  actions_macos: 10,
});

// Larger-runner SKUs from the pricing reference. "Included minutes cannot be
// used for larger runners" — they are always paid, so a private or
// unknown-visibility row on one of these means paid Actions usage exists and
// we cannot claim free headroom. Both the bare ids and the `actions_`-prefixed
// forms from the product-and-sku-names reference are accepted.
const LARGER_RUNNER_SKU_IDS = Object.freeze([
  "linux_2_core_advanced",
  "linux_4_core",
  "linux_8_core",
  "linux_16_core",
  "linux_32_core",
  "linux_64_core",
  "linux_96_core",
  "linux_2_core_arm",
  "linux_4_core_arm",
  "linux_8_core_arm",
  "linux_16_core_arm",
  "linux_32_core_arm",
  "linux_64_core_arm",
  "linux_4_core_gpu",
  "windows_2_core",
  "windows_2_core_advanced",
  "windows_4_core",
  "windows_8_core",
  "windows_16_core",
  "windows_32_core",
  "windows_64_core",
  "windows_96_core",
  "windows_2_core_arm",
  "windows_4_core_arm",
  "windows_8_core_arm",
  "windows_16_core_arm",
  "windows_32_core_arm",
  "windows_64_core_arm",
  "windows_4_core_gpu",
  "macos_l",
  "macos_xl",
]);
const LARGER_RUNNER_SKUS = Object.freeze(
  new Set(
    LARGER_RUNNER_SKU_IDS.flatMap((id) => [
      id,
      `actions_${id}`,
      // Display-name form, e.g. "Actions Linux 4-core" / "Actions macOS L".
      `actions ${id.replace(/_core/u, "-core").replace(/_/gu, " ")}`,
    ]),
  ),
);

const SKU_KINDS = Object.freeze({
  STANDARD: "standard",
  LARGER: "larger",
  UNRECOGNIZED: "unrecognized",
});

const ROUTING_STATES = Object.freeze({
  FREE: "free",
  EXHAUSTED: "exhausted",
  UNKNOWN: "unknown",
});

function normalizeSku(sku) {
  return String(sku ?? "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function isActionsMinuteItem(item) {
  return (
    String(item?.product ?? "").toLowerCase() === ACTIONS_PRODUCT &&
    MINUTE_UNIT_TYPES.includes(String(item?.unitType ?? "").toLowerCase())
  );
}

/**
 * Classify an Actions minute SKU.
 *
 * @param {unknown} sku raw `sku` field from a usage row
 * @returns {{ kind: "standard", multiplier: number } | { kind: "larger" } | { kind: "unrecognized" }}
 */
function classifyActionsSku(sku) {
  const normalized = normalizeSku(sku);
  const multiplier = STANDARD_HOSTED_SKU_MULTIPLIERS[normalized];
  if (Number.isFinite(multiplier) && multiplier >= 1) {
    return Object.freeze({ kind: SKU_KINDS.STANDARD, multiplier });
  }
  if (LARGER_RUNNER_SKUS.has(normalized)) {
    return Object.freeze({ kind: SKU_KINDS.LARGER });
  }
  return Object.freeze({ kind: SKU_KINDS.UNRECOGNIZED });
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
 * Throws (→ probe records `unknown`) rather than returning `free` whenever the
 * report contains an Actions minute row this module cannot account for: an
 * unrecognized SKU, a larger-runner SKU on a private / unknown-visibility
 * repo, or a standard row with a broken envelope.
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
    if (!isActionsMinuteItem(item)) {
      continue;
    }
    const sku = classifyActionsSku(item?.sku);
    // Fail closed: minutes on a SKU we cannot map to a pool multiplier are
    // invisible to the math, and invisible minutes are how a false `free`
    // happens (ci-workflows#519 D2).
    if (sku.kind === SKU_KINDS.UNRECOGNIZED) {
      throw new Error(
        `unrecognized Actions minute SKU ${JSON.stringify(String(item?.sku ?? ""))}; refusing free headroom`,
      );
    }
    // Fail closed: an Actions minute row with a broken envelope must not
    // under-count into a false `free` (prefer-hosted-while-free).
    if (!hasRequiredFields(item)) {
      throw new Error(
        "hosted Actions minute row is missing required fields; refusing free headroom",
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
    // Larger runners can never use included minutes: a private row on one is
    // paid Actions usage, so there is no free headroom to claim.
    if (sku.kind === SKU_KINDS.LARGER) {
      throw new Error(
        `larger-runner Actions SKU ${JSON.stringify(String(item.sku))} on ${visibility} repo ${cacheKey} is paid-only; refusing free headroom`,
      );
    }
    const quantity = Number(item.quantity);
    privateMinutes += quantity * sku.multiplier;
    // Kept as an additional tripwire only. Under a $0 Actions budget with
    // prevent_further_usage, overage is blocked before it bills, so this is
    // empirically never true; pool math + fail-closed SKUs are the real guards.
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
  LARGER_RUNNER_SKUS,
  ROUTING_STATES,
  SKU_KINDS,
  STANDARD_HOSTED_SKU_MULTIPLIERS,
  billingMonth,
  classifyActionsSku,
  evaluateBillingHeadroom,
  headroomToCachePayload,
  isActionsMinuteItem,
  normalizeRoutingState,
});
