"use strict";

// Discriminate a timed-out prerequisite job from a routine concurrency
// supersede. GitHub collapses job timeouts into
// `needs.<job_id>.result == cancelled`, but the Actions Jobs REST API exposes
// distinct `conclusion: timed_out` (see cancelled-prerequisite discrimination).

/**
 * Resolve whether a delivered `needs.*.result == cancelled` prerequisite
 * should proceed to validation or fail closed.
 *
 * Heuristic (timed-out vs cancelled discrimination):
 * 1. Any `timed_out` job in the run means a prerequisite hit its own ceiling
 *    rather than being superseded, so fail closed.
 * 2. Otherwise proceed (true cancel / supersede).
 *
 * Until ci-perf Phase 7 the run's routing prefix job was matched by name and
 * preferred over an unrelated `timed_out` job. That prefix job no longer
 * exists in any consumer, so the fail-closed rule applies to the whole run.
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

  if (terminalJobs.some((job) => job.conclusion === "timed_out")) {
    return {
      outcome: "fail",
      reason: "timed_out",
      detail: "run contains a timed_out job (fail-closed heuristic)",
    };
  }

  return {
    outcome: "proceed",
    reason: "cancelled",
    detail: "no timed_out job in the run; treating as true cancel",
  };
}

module.exports = {
  resolveCancelledPrerequisite,
};
