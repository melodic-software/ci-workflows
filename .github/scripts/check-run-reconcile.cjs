#!/usr/bin/env node
// Reconcile required-check contexts against workflow jobs and commit check-runs.
//
// GitHub's merge gate resolves required contexts from the commit check-run list.
// Workflow runs / `gh pr checks` can still report green when a required context
// never attached (ci-workflows#399). This probe correlates the two surfaces and
// fails loudly on divergence: a completed workflow job on the head SHA with no
// matching check-run on that SHA.
//
// Pure reconcile logic is network-free and unit-tested. The CLI shells out to
// `gh api` to fetch live surfaces for operator use:
//
//   node .github/scripts/check-run-reconcile.cjs \
//     --repo melodic-software/claude-code-plugins --pr 2123 --from-rulesets
//
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const TERMINAL_JOB_STATUSES = new Set(["completed"]);
const PENDING_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
]);

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Prefer the newest record when several share a name (reopen / rerun churn).
 */
function pickLatestByName(items, nameKey = "name", timeKeys = ["completed_at", "started_at"]) {
  if (!Array.isArray(items)) {
    throw new UsageError("expected an array of named records");
  }
  const latest = new Map();
  for (const item of items) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const name = item[nameKey];
    if (typeof name !== "string" || name.length === 0) {
      continue;
    }
    const stamp = timeKeys
      .map((key) => item[key])
      .find((value) => typeof value === "string" && value.length > 0);
    const rank = stamp ? Date.parse(stamp) : Number.NaN;
    const prev = latest.get(name);
    if (!prev) {
      latest.set(name, { item, rank: Number.isFinite(rank) ? rank : 0 });
      continue;
    }
    const nextRank = Number.isFinite(rank) ? rank : 0;
    if (nextRank >= prev.rank) {
      latest.set(name, { item, rank: nextRank });
    }
  }
  const out = new Map();
  for (const [name, entry] of latest) {
    out.set(name, entry.item);
  }
  return out;
}

/**
 * Pull required status-check context names from ruleset detail payloads.
 */
function extractRequiredContextsFromRulesets(rulesets) {
  if (!Array.isArray(rulesets)) {
    throw new UsageError("expected an array of ruleset objects");
  }
  const contexts = [];
  const seen = new Set();
  for (const ruleset of rulesets) {
    if (ruleset === null || typeof ruleset !== "object") {
      continue;
    }
    if (ruleset.enforcement === "disabled") {
      continue;
    }
    const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
    for (const rule of rules) {
      if (!rule || rule.type !== "required_status_checks") {
        continue;
      }
      const checks = rule.parameters?.required_status_checks;
      if (!Array.isArray(checks)) {
        continue;
      }
      for (const check of checks) {
        const context =
          typeof check?.context === "string" ? check.context.trim() : "";
        if (context === "" || seen.has(context)) {
          continue;
        }
        seen.add(context);
        contexts.push(context);
      }
    }
  }
  return contexts;
}

/**
 * Classify one required context against the latest job and check-run of that name.
 *
 * @returns {{
 *   context: string,
 *   verdict:
 *     | "aligned"
 *     | "divergence"
 *     | "missing"
 *     | "pending"
 *     | "mismatch"
 *     | "check_only",
 *   job: object | null,
 *   checkRun: object | null,
 *   detail: string,
 * }}
 */
function classifyContext(context, job, checkRun) {
  const jobStatus = typeof job?.status === "string" ? job.status : null;
  const jobConclusion =
    typeof job?.conclusion === "string" ? job.conclusion : null;
  const checkStatus =
    typeof checkRun?.status === "string" ? checkRun.status : null;
  const checkConclusion =
    typeof checkRun?.conclusion === "string" ? checkRun.conclusion : null;

  const jobPending =
    job !== null &&
    (PENDING_STATUSES.has(jobStatus) ||
      (TERMINAL_JOB_STATUSES.has(jobStatus) && jobConclusion === null));
  const checkPending =
    checkRun !== null &&
    (PENDING_STATUSES.has(checkStatus) || checkStatus !== "completed");

  if (jobPending || checkPending) {
    return {
      context,
      verdict: "pending",
      job,
      checkRun,
      detail: "job or check-run still in flight",
    };
  }

  if (job !== null && checkRun === null) {
    return {
      context,
      verdict: "divergence",
      job,
      checkRun,
      detail:
        `workflow job completed (${jobConclusion ?? jobStatus}) on the head SHA ` +
        "but no matching check-run is attached to that commit (ci-workflows#399)",
    };
  }

  if (job === null && checkRun === null) {
    return {
      context,
      verdict: "missing",
      job,
      checkRun,
      detail:
        "required context has neither a workflow job nor a commit check-run on this SHA",
    };
  }

  if (job === null && checkRun !== null) {
    return {
      context,
      verdict: "check_only",
      job,
      checkRun,
      detail:
        `check-run present (${checkConclusion ?? checkStatus}); no matching workflow job observed`,
    };
  }

  if (jobConclusion !== checkConclusion) {
    return {
      context,
      verdict: "mismatch",
      job,
      checkRun,
      detail:
        `workflow job conclusion=${jobConclusion} vs check-run conclusion=${checkConclusion}`,
    };
  }

  return {
    context,
    verdict: "aligned",
    job,
    checkRun,
    detail: `both surfaces report ${checkConclusion ?? checkStatus}`,
  };
}

/**
 * Reconcile every required context.
 *
 * A non-empty `problems` list means merge-readiness cannot be trusted from
 * "no failing checks" alone: either a required context is absent, diverged
 * (job without check-run), mismatched, or still pending.
 */
function reconcileRequiredChecks({
  requiredContexts,
  checkRuns,
  workflowJobs,
}) {
  if (!Array.isArray(requiredContexts) || requiredContexts.length === 0) {
    throw new UsageError("at least one required context is required");
  }
  for (const context of requiredContexts) {
    if (typeof context !== "string" || context.trim() === "") {
      throw new UsageError("required contexts must be non-empty strings");
    }
  }

  const jobsByName = pickLatestByName(workflowJobs);
  const checksByName = pickLatestByName(checkRuns);
  const results = requiredContexts.map((raw) => {
    const context = raw.trim();
    return classifyContext(
      context,
      jobsByName.get(context) ?? null,
      checksByName.get(context) ?? null,
    );
  });

  const problems = results.filter((row) =>
    ["divergence", "missing", "mismatch", "pending"].includes(row.verdict),
  );
  const divergences = results.filter((row) => row.verdict === "divergence");

  return {
    ok: problems.length === 0,
    results,
    problems,
    divergences,
    // Required contexts with no attached check-run — the merge-gate signal.
    absentCheckRuns: results.filter((row) => row.checkRun === null),
  };
}

function formatReconcileReport(report, { sha = null, repo = null } = {}) {
  const lines = [];
  const where = [repo, sha].filter((part) => typeof part === "string" && part);
  lines.push(
    `check-run reconcile${where.length ? ` (${where.join(" @ ")})` : ""}`,
  );
  for (const row of report.results) {
    const jobBit = row.job
      ? `job=${row.job.conclusion ?? row.job.status}`
      : "job=ABSENT";
    const checkBit = row.checkRun
      ? `check=${row.checkRun.conclusion ?? row.checkRun.status}`
      : "check=ABSENT";
    lines.push(
      `- ${row.context}: ${row.verdict} (${jobBit}; ${checkBit}) — ${row.detail}`,
    );
  }
  if (report.divergences.length > 0) {
    lines.push(
      `::error::${report.divergences.length} required context(s) ran as workflow jobs but did not attach as commit check-runs (ci-workflows#399).`,
    );
  } else if (report.absentCheckRuns.length > 0) {
    lines.push(
      `::error::${report.absentCheckRuns.length} required context(s) have no check-run on this SHA; merge will stay BLOCKED even if other surfaces look green.`,
    );
  } else if (!report.ok) {
    lines.push(
      `::error::required-check reconcile found ${report.problems.length} problem(s).`,
    );
  } else {
    lines.push("ok: every required context is present on the commit check-run list.");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = {
    repo: null,
    sha: null,
    pr: null,
    contexts: [],
    fromRulesets: false,
    json: false,
    checkRunsJson: null,
    jobsJson: null,
    rulesetsJson: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new UsageError(`missing value for ${arg}`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--repo":
        options.repo = next();
        break;
      case "--sha":
        options.sha = next();
        break;
      case "--pr":
        options.pr = next();
        break;
      case "--context":
        options.contexts.push(next());
        break;
      case "--from-rulesets":
        options.fromRulesets = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--check-runs-json":
        options.checkRunsJson = next();
        break;
      case "--jobs-json":
        options.jobsJson = next();
        break;
      case "--rulesets-json":
        options.rulesetsJson = next();
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return `Usage:
  check-run-reconcile.cjs --repo OWNER/NAME --sha SHA --context NAME [--context NAME...]
  check-run-reconcile.cjs --repo OWNER/NAME --pr N --from-rulesets
  check-run-reconcile.cjs --check-runs-json FILE --jobs-json FILE --context NAME...

Compares workflow jobs on a head SHA to commit check-runs for each required
context. Exit 0 when every required context has an attached check-run and no
divergence/mismatch/pending rows remain; exit 1 on reconcile problems; exit 2
on usage or fetch errors.
`;
}

function readJsonFile(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(
      `could not read JSON from ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function ghApiJson(path, { paginate = false } = {}) {
  const args = ["api", path, "--method", "GET"];
  if (paginate) {
    args.push("--paginate");
  }
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    throw new UsageError(`failed to spawn gh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new UsageError(
      `gh api ${path} failed (exit ${result.status}): ${detail}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new UsageError(
      `gh api ${path} returned non-JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function collectCheckRuns(repo, sha) {
  const runs = [];
  let page = 1;
  for (;;) {
    const payload = ghApiJson(
      `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    );
    const batch = Array.isArray(payload.check_runs) ? payload.check_runs : [];
    runs.push(...batch);
    if (batch.length < 100) {
      break;
    }
    page += 1;
    if (page > 50) {
      throw new UsageError("check-run pagination exceeded safety cap");
    }
  }
  return runs;
}

function collectWorkflowJobs(repo, sha) {
  const jobs = [];
  let page = 1;
  for (;;) {
    const payload = ghApiJson(
      `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100&page=${page}`,
    );
    const runs = Array.isArray(payload.workflow_runs)
      ? payload.workflow_runs
      : [];
    for (const run of runs) {
      let jobPage = 1;
      for (;;) {
        const jobPayload = ghApiJson(
          `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100&page=${jobPage}`,
        );
        const batch = Array.isArray(jobPayload.jobs) ? jobPayload.jobs : [];
        for (const job of batch) {
          jobs.push({
            ...job,
            workflow_name: run.name,
            workflow_id: run.id,
            workflow_path: run.path,
            head_sha: run.head_sha,
          });
        }
        if (batch.length < 100) {
          break;
        }
        jobPage += 1;
        if (jobPage > 20) {
          throw new UsageError("job pagination exceeded safety cap");
        }
      }
    }
    if (runs.length < 100) {
      break;
    }
    page += 1;
    if (page > 20) {
      throw new UsageError("workflow-run pagination exceeded safety cap");
    }
  }
  return jobs;
}

function collectRulesetDetails(repo) {
  const listing = ghApiJson(`repos/${repo}/rulesets`);
  const rulesets = Array.isArray(listing) ? listing : [];
  return rulesets.map((entry) =>
    ghApiJson(`repos/${repo}/rulesets/${entry.id}`),
  );
}

function resolveHeadSha(repo, pr) {
  const pull = ghApiJson(`repos/${repo}/pulls/${pr}`);
  const sha = pull?.head?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new UsageError(`could not resolve head SHA for PR #${pr}`);
  }
  return sha;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  let checkRuns;
  let workflowJobs;
  let requiredContexts = options.contexts.map((c) => c.trim()).filter(Boolean);
  let sha = options.sha;
  const repo = options.repo;

  if (options.checkRunsJson || options.jobsJson) {
    if (!options.checkRunsJson || !options.jobsJson) {
      throw new UsageError(
        "--check-runs-json and --jobs-json must be provided together",
      );
    }
    const checkPayload = readJsonFile(options.checkRunsJson);
    const jobsPayload = readJsonFile(options.jobsJson);
    checkRuns = Array.isArray(checkPayload)
      ? checkPayload
      : checkPayload.check_runs;
    workflowJobs = Array.isArray(jobsPayload)
      ? jobsPayload
      : jobsPayload.jobs;
    if (!Array.isArray(checkRuns) || !Array.isArray(workflowJobs)) {
      throw new UsageError(
        "fixture JSON must be an array or an object with check_runs/jobs arrays",
      );
    }
    if (options.rulesetsJson) {
      const rulesets = readJsonFile(options.rulesetsJson);
      requiredContexts = extractRequiredContextsFromRulesets(
        Array.isArray(rulesets) ? rulesets : [rulesets],
      );
    }
  } else {
    if (!repo || typeof repo !== "string" || !repo.includes("/")) {
      throw new UsageError("--repo OWNER/NAME is required for live fetches");
    }
    if (options.pr && !sha) {
      sha = resolveHeadSha(repo, options.pr);
    }
    if (!sha) {
      throw new UsageError("--sha or --pr is required");
    }
    if (options.fromRulesets || requiredContexts.length === 0) {
      requiredContexts = extractRequiredContextsFromRulesets(
        collectRulesetDetails(repo),
      );
    }
    checkRuns = collectCheckRuns(repo, sha);
    workflowJobs = collectWorkflowJobs(repo, sha);
  }

  if (requiredContexts.length === 0) {
    throw new UsageError(
      "no required contexts provided; pass --context or --from-rulesets",
    );
  }

  const report = reconcileRequiredChecks({
    requiredContexts,
    checkRuns,
    workflowJobs,
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ repo, sha, requiredContexts, ...report }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(formatReconcileReport(report, { repo, sha }));
  }

  return report.ok ? 0 : 1;
}

module.exports = {
  UsageError,
  pickLatestByName,
  extractRequiredContextsFromRulesets,
  classifyContext,
  reconcileRequiredChecks,
  formatReconcileReport,
  parseArgs,
  main,
};

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 2;
  }
}
