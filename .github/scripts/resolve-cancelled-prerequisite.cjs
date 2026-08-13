"use strict";

// Discriminate a timed-out select-runner prerequisite from a routine
// concurrency supersede. GitHub collapses job timeouts into
// `needs.<job_id>.result == cancelled`, but the Actions Jobs REST API exposes
// distinct `conclusion: timed_out` (#458).

const SELECTOR_JOB_NAME_PATTERN = /select[\s_-]?runner|select runner/i;

/**
 * Whether a workflow job name looks like the select-runner prerequisite job.
 * @param {string} name
 * @returns {boolean}
 */
function isSelectorLikeJobName(name) {
  return typeof name === "string" && SELECTOR_JOB_NAME_PATTERN.test(name);
}

/**
 * Resolve whether a delivered `needs.*.result == cancelled` prerequisite
 * should proceed to validation or fail closed.
 *
 * Heuristic (issue #458):
 * 1. Prefer selector-like jobs (name contains "Select runner" / select-runner)
 *    whose conclusion is `timed_out` or `cancelled`.
 * 2. `timed_out` on a matched selector → fail closed.
 * 3. `cancelled` on matched selector(s) with no `timed_out` → proceed.
 * 4. If no selector match (ambiguous): any `timed_out` job in the run → fail closed.
 * 5. Ambiguous with no `timed_out` → proceed (true cancel / supersede).
 *
 * Callers must pass the complete job list from
 * `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`. A non-array input
 * represents a failed lookup and fails closed.
 *
 * @param {Array<{name?: string, conclusion?: string|null, status?: string}>} jobs
 * @returns {{ outcome: "proceed"|"fail", reason: string, detail: string }}
 */
function resolveCancelledPrerequisite(jobs) {
  if (!Array.isArray(jobs)) {
    return {
      outcome: "fail",
      reason: "lookup-failed",
      detail: "workflow jobs response is not an array",
    };
  }

  const terminalJobs = jobs.filter(
    (job) =>
      job &&
      typeof job === "object" &&
      (job.status === "completed" || typeof job.conclusion === "string"),
  );

  const selectorCandidates = terminalJobs.filter(
    (job) =>
      isSelectorLikeJobName(job.name ?? "") &&
      (job.conclusion === "timed_out" || job.conclusion === "cancelled"),
  );

  if (selectorCandidates.length > 0) {
    if (selectorCandidates.some((job) => job.conclusion === "timed_out")) {
      return {
        outcome: "fail",
        reason: "timed_out",
        detail: "selector-like prerequisite job concluded timed_out",
      };
    }
    return {
      outcome: "proceed",
      reason: "cancelled",
      detail: "selector-like prerequisite job concluded cancelled",
    };
  }

  if (terminalJobs.some((job) => job.conclusion === "timed_out")) {
    return {
      outcome: "fail",
      reason: "timed_out",
      detail:
        "no selector-like job matched; run contains a timed_out job (fail-closed heuristic)",
    };
  }

  return {
    outcome: "proceed",
    reason: "cancelled-ambiguous",
    detail:
      "no selector-like job matched and no timed_out jobs; treating as true cancel",
  };
}

module.exports = {
  SELECTOR_JOB_NAME_PATTERN,
  isSelectorLikeJobName,
  resolveCancelledPrerequisite,
};
