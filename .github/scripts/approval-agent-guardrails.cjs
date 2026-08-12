"use strict";

// Approval Agent guardrails (ci-workflows#256). Pure decision helpers used by
// .github/workflows/approval-agent.yml. Keep this module free of Actions
// runtime globals so unit tests can exercise every refuse path without a
// workflow harness.

/** Default paths that must never be auto-approved when changed on a PR. */
const DEFAULT_PROTECTED_PATHS = Object.freeze([
  ".github/workflows/approval-agent.yml",
  ".github/workflows/approval-agent-self.yml",
  ".github/scripts/approval-agent-guardrails.cjs",
  "docs/topics/claude-review-lanes/approval-agent-ADR.md",
]);

/**
 * Parse a newline- or comma-separated path list. Empty / whitespace-only
 * entries are dropped. Caller-supplied paths are **unioned** with
 * DEFAULT_PROTECTED_PATHS so a fleet caller cannot drop the Approval Agent's
 * own deny-list by accident.
 *
 * @param {string | null | undefined} raw
 * @returns {string[]}
 */
function parseProtectedPaths(raw) {
  const extras = [];
  if (raw != null) {
    const trimmed = String(raw).trim();
    if (trimmed !== "") {
      for (const part of trimmed.split(/[\n,]/u)) {
        const path = part.trim();
        if (path !== "") {
          extras.push(path);
        }
      }
    }
  }
  const seen = new Set(DEFAULT_PROTECTED_PATHS);
  const merged = [...DEFAULT_PROTECTED_PATHS];
  for (const path of extras) {
    if (!seen.has(path)) {
      seen.add(path);
      merged.push(path);
    }
  }
  return merged;
}

/**
 * Collect every path GitHub associates with a PR file entry, including
 * `previous_filename` on renames. Renames report only the new path in
 * `filename`; ignoring the old path would let a PR relocate policy files past
 * the deny-list.
 *
 * @param {Iterable<{ filename?: string, previous_filename?: string | null }>} files
 * @returns {string[]}
 */
function collectChangedPaths(files) {
  const paths = [];
  const seen = new Set();
  for (const file of files) {
    if (!file || typeof file !== "object") {
      continue;
    }
    for (const candidate of [file.filename, file.previous_filename]) {
      if (typeof candidate !== "string" || candidate === "") {
        continue;
      }
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      paths.push(candidate);
    }
  }
  return paths;
}

/**
 * True when any changed path equals a protected path or is nested under a
 * protected directory prefix (trailing `/` on the protected entry).
 *
 * @param {Iterable<string>} changedPaths
 * @param {Iterable<string>} protectedPaths
 * @returns {{ blocked: boolean, matches: string[] }}
 */
function findProtectedPathHits(changedPaths, protectedPaths) {
  const matches = [];
  const protectedList = [...protectedPaths];
  for (const changed of changedPaths) {
    if (typeof changed !== "string" || changed === "") {
      continue;
    }
    for (const protectedPath of protectedList) {
      if (changed === protectedPath) {
        matches.push(changed);
        break;
      }
      if (
        protectedPath.endsWith("/") &&
        (changed === protectedPath.slice(0, -1) ||
          changed.startsWith(protectedPath))
      ) {
        matches.push(changed);
        break;
      }
    }
  }
  return { blocked: matches.length > 0, matches };
}

/**
 * Normalize a GitHub login for identity comparison. Bot accounts are stored
 * as `slug[bot]`; callers may pass either form.
 *
 * @param {string | null | undefined} login
 * @returns {string}
 */
function normalizeLogin(login) {
  if (login == null) {
    return "";
  }
  return String(login).trim().toLowerCase();
}

/**
 * Approver must be distinct from PR author and last pusher
 * (`require_last_push_approval` compatible). Empty approver fails closed when
 * an approve was requested.
 *
 * @param {{
 *   approverLogin: string | null | undefined,
 *   authorLogin: string | null | undefined,
 *   lastPusherLogin: string | null | undefined,
 * }} identities
 * @returns {{ ok: boolean, reason: string | null }}
 */
function checkIdentitySeparation({
  approverLogin,
  authorLogin,
  lastPusherLogin,
}) {
  const approver = normalizeLogin(approverLogin);
  const author = normalizeLogin(authorLogin);
  const pusher = normalizeLogin(lastPusherLogin);

  if (approver === "") {
    return {
      ok: false,
      reason: "approver identity is empty (cannot verify separation)",
    };
  }
  if (author !== "" && approver === author) {
    return {
      ok: false,
      reason: `approver '${approver}' matches PR author`,
    };
  }
  if (pusher !== "" && approver === pusher) {
    return {
      ok: false,
      reason: `approver '${approver}' matches last pusher`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Human-risk findings input. Non-empty text (after trim) means findings are
 * present. A JSON empty array `[]` counts as absent. When refuseOnHumanRisk is
 * false, findings never block.
 *
 * @param {{
 *   findingsRaw: string | null | undefined,
 *   refuseOnHumanRisk: boolean,
 * }} options
 * @returns {{ blocked: boolean, summary: string | null }}
 */
function checkHumanRiskFindings({ findingsRaw, refuseOnHumanRisk }) {
  if (!refuseOnHumanRisk) {
    return { blocked: false, summary: null };
  }
  const raw = findingsRaw == null ? "" : String(findingsRaw).trim();
  if (raw === "") {
    return { blocked: false, summary: null };
  }
  if (raw === "[]") {
    return { blocked: false, summary: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return { blocked: false, summary: null };
      }
      return {
        blocked: true,
        summary: `${parsed.length} human-risk finding(s) present`,
      };
    }
  } catch {
    // Non-JSON text: treat as opaque findings blob.
  }
  return {
    blocked: true,
    summary: "human-risk findings text is non-empty",
  };
}

/**
 * Derive the GitHub bot login from an App slug (`melodic-ai` → `melodic-ai[bot]`).
 *
 * @param {string | null | undefined} appSlug
 * @returns {string}
 */
function botLoginFromAppSlug(appSlug) {
  const slug = normalizeLogin(appSlug);
  if (slug === "") {
    return "";
  }
  if (slug.endsWith("[bot]")) {
    return slug;
  }
  return `${slug}[bot]`;
}

/**
 * Decide whether the Approval Agent may APPROVE, must COMMENT-only, or must
 * refuse. Enable-approve defaults off (safe). Guardrails always run.
 *
 * @param {{
 *   enableApprove: boolean,
 *   changedPaths: Iterable<string>,
 *   protectedPaths?: Iterable<string>,
 *   approverLogin: string | null | undefined,
 *   authorLogin: string | null | undefined,
 *   lastPusherLogin: string | null | undefined,
 *   findingsRaw?: string | null | undefined,
 *   refuseOnHumanRisk?: boolean,
 * }} input
 * @returns {{
 *   decision: "approve" | "comment" | "refuse",
 *   reasons: string[],
 *   protectedMatches: string[],
 * }}
 */
function evaluateApproval({
  enableApprove,
  changedPaths,
  protectedPaths = DEFAULT_PROTECTED_PATHS,
  approverLogin,
  authorLogin,
  lastPusherLogin,
  findingsRaw = "",
  refuseOnHumanRisk = true,
}) {
  const reasons = [];
  const pathHits = findProtectedPathHits(changedPaths, protectedPaths);
  if (pathHits.blocked) {
    reasons.push(
      `PR modifies Approval Agent policy/workflow files: ${pathHits.matches.join(", ")}`,
    );
  }

  // Identity separation is mandatory whenever APPROVE is requested. Comment-
  // only scaffold runs still compute it when an approver login is known so
  // dry-runs surface problems early; missing approver on comment-only is OK.
  if (enableApprove || normalizeLogin(approverLogin) !== "") {
    const identity = checkIdentitySeparation({
      approverLogin,
      authorLogin,
      lastPusherLogin,
    });
    if (!identity.ok) {
      reasons.push(identity.reason);
    }
  }

  const risk = checkHumanRiskFindings({ findingsRaw, refuseOnHumanRisk });
  if (risk.blocked) {
    reasons.push(risk.summary);
  }

  if (reasons.length > 0) {
    return {
      decision: "refuse",
      reasons,
      protectedMatches: pathHits.matches,
    };
  }

  if (enableApprove) {
    return {
      decision: "approve",
      reasons: [],
      protectedMatches: [],
    };
  }

  return {
    decision: "comment",
    reasons: [],
    protectedMatches: [],
  };
}

/**
 * Parse Actions boolean inputs that arrive as strings.
 *
 * @param {unknown} value
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function parseBooleanInput(value, defaultValue) {
  if (value == null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return defaultValue;
}

module.exports = {
  DEFAULT_PROTECTED_PATHS,
  parseProtectedPaths,
  collectChangedPaths,
  findProtectedPathHits,
  normalizeLogin,
  checkIdentitySeparation,
  checkHumanRiskFindings,
  botLoginFromAppSlug,
  evaluateApproval,
  parseBooleanInput,
};
