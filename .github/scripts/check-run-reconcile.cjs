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
// Merge-gate blocking conclusions. Completed checks with these conclusions
// must not report aligned/ok even when job and check-run agree.
const FAILING_CHECK_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
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
function pickLatestByName(
  items,
  nameKey = "name",
  timeKeys = ["completed_at", "started_at"],
) {
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
 * GitHub ruleset ref_name patterns use fnmatch with FNM_PATHNAME (* does not
 * cross `/`). Also accepts ~ALL and ~DEFAULT_BRANCH.
 */
function matchRefPattern(pattern, fullRef, defaultBranch) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return false;
  }
  if (pattern === "~ALL") {
    return true;
  }
  if (pattern === "~DEFAULT_BRANCH") {
    if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
      return false;
    }
    const defaultRef = defaultBranch.startsWith("refs/")
      ? defaultBranch
      : `refs/heads/${defaultBranch}`;
    return fullRef === defaultRef;
  }
  // Escape regex metacharacters, then map fnmatch * / ? (pathname: * ≠ `/`).
  let regexSource = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` matches across slashes (GitHub docs allow qa/**/*).
        regexSource += ".*";
        i += 1;
      } else {
        regexSource += "[^/]*";
      }
    } else if (ch === "?") {
      regexSource += "[^/]";
    } else if ("\\^$.|()+[{}".includes(ch) || ch === "]" || ch === "/") {
      regexSource += `\\${ch}`;
    } else {
      regexSource += ch;
    }
  }
  return new RegExp(`^${regexSource}$`, "u").test(fullRef);
}

/**
 * Whether a ruleset's conditions.ref_name applies to the PR target ref.
 * When targetRef is omitted, every ruleset is kept (fixture / sha-only paths).
 */
function rulesetAppliesToRef(
  ruleset,
  { targetRef = null, defaultBranch = null } = {},
) {
  if (targetRef === null || targetRef === undefined || targetRef === "") {
    return true;
  }
  if (ruleset.target && ruleset.target !== "branch") {
    return false;
  }
  const fullRef = targetRef.startsWith("refs/")
    ? targetRef
    : `refs/heads/${targetRef}`;
  const refName = ruleset.conditions?.ref_name;
  if (!refName || typeof refName !== "object") {
    return true;
  }
  const include = Array.isArray(refName.include) ? refName.include : [];
  const exclude = Array.isArray(refName.exclude) ? refName.exclude : [];
  const included =
    include.length === 0 ||
    include.some((pattern) => matchRefPattern(pattern, fullRef, defaultBranch));
  if (!included) {
    return false;
  }
  return !exclude.some((pattern) =>
    matchRefPattern(pattern, fullRef, defaultBranch),
  );
}

/**
 * Normalize a required-check entry to `{ context, integrationId }`.
 * Strings (CLI `--context`) carry a null integrationId (any publisher).
 */
function normalizeRequiredCheck(entry) {
  if (typeof entry === "string") {
    const context = entry.trim();
    if (context === "") {
      throw new UsageError("required contexts must be non-empty strings");
    }
    return { context, integrationId: null };
  }
  if (entry === null || typeof entry !== "object") {
    throw new UsageError(
      "required checks must be strings or {context, integrationId} objects",
    );
  }
  const context = typeof entry.context === "string" ? entry.context.trim() : "";
  if (context === "") {
    throw new UsageError("required contexts must be non-empty strings");
  }
  const rawId = entry.integrationId ?? entry.integration_id ?? null;
  let integrationId = null;
  if (rawId !== null && rawId !== undefined) {
    if (typeof rawId !== "number" || !Number.isInteger(rawId)) {
      throw new UsageError(
        `integration_id for ${context} must be an integer or null`,
      );
    }
    integrationId = rawId;
  }
  return { context, integrationId };
}

/**
 * Pull required status-check context/integration pairs from ruleset payloads.
 *
 * Skips `disabled` and `evaluate` (evaluate does not enforce). When
 * `targetRef` is set, only rulesets whose ref_name conditions match that
 * PR base ref contribute.
 *
 * @returns {Array<{ context: string, integrationId: number | null }>}
 */
function extractRequiredContextsFromRulesets(
  rulesets,
  { targetRef = null, defaultBranch = null } = {},
) {
  if (!Array.isArray(rulesets)) {
    throw new UsageError("expected an array of ruleset objects");
  }
  const contexts = [];
  // Dedup key includes integration so the same name from two apps stays distinct.
  const seen = new Set();
  for (const ruleset of rulesets) {
    if (ruleset === null || typeof ruleset !== "object") {
      continue;
    }
    if (
      ruleset.enforcement === "disabled" ||
      ruleset.enforcement === "evaluate"
    ) {
      continue;
    }
    if (!rulesetAppliesToRef(ruleset, { targetRef, defaultBranch })) {
      continue;
    }
    const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
    for (const rule of rules) {
      if (rule?.type !== "required_status_checks") {
        continue;
      }
      const checks = rule.parameters?.required_status_checks;
      if (!Array.isArray(checks)) {
        continue;
      }
      for (const check of checks) {
        const context =
          typeof check?.context === "string" ? check.context.trim() : "";
        if (context === "") {
          continue;
        }
        const rawId = check.integration_id;
        const integrationId =
          typeof rawId === "number" && Number.isInteger(rawId) ? rawId : null;
        const key = `${context}\0${integrationId ?? ""}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        contexts.push({ context, integrationId });
      }
    }
  }
  return contexts;
}

/**
 * Pick the newest check-run matching name and optional integration_id
 * (compared to check-run `app.id`).
 */
function pickLatestCheckRun(checkRuns, context, integrationId) {
  const candidates = [];
  for (const run of checkRuns) {
    if (run === null || typeof run !== "object") {
      continue;
    }
    if (run.name !== context) {
      continue;
    }
    if (integrationId !== null && integrationId !== undefined) {
      const appId = run.app?.id;
      if (appId !== integrationId) {
        continue;
      }
    }
    candidates.push(run);
  }
  if (candidates.length === 0) {
    return null;
  }
  return pickLatestByName(candidates).get(context) ?? null;
}

/**
 * Classify one required context against the latest job and check-run of that name.
 *
 * @returns {{
 *   context: string,
 *   integrationId: number | null,
 *   verdict:
 *     | "aligned"
 *     | "divergence"
 *     | "missing"
 *     | "pending"
 *     | "mismatch"
 *     | "check_only"
 *     | "failed",
 *   job: object | null,
 *   checkRun: object | null,
 *   detail: string,
 * }}
 */
function classifyContext(context, job, checkRun, integrationId = null) {
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
  // Anything other than status=completed is still in flight for check-runs
  // (PENDING_STATUSES is a documented subset; unknown statuses stay pending).
  const checkPending = checkRun !== null && checkStatus !== "completed";

  if (jobPending || checkPending) {
    return {
      context,
      integrationId,
      verdict: "pending",
      job,
      checkRun,
      detail: "job or check-run still in flight",
    };
  }

  if (job !== null && checkRun === null) {
    return {
      context,
      integrationId,
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
      integrationId,
      verdict: "missing",
      job,
      checkRun,
      detail:
        "required context has neither a workflow job nor a commit check-run on this SHA",
    };
  }

  if (job === null && checkRun !== null) {
    if (FAILING_CHECK_CONCLUSIONS.has(checkConclusion)) {
      return {
        context,
        integrationId,
        verdict: "failed",
        job,
        checkRun,
        detail: `required check-run concluded ${checkConclusion}`,
      };
    }
    return {
      context,
      integrationId,
      verdict: "check_only",
      job,
      checkRun,
      detail: `check-run present (${checkConclusion ?? checkStatus}); no matching workflow job observed`,
    };
  }

  if (jobConclusion !== checkConclusion) {
    return {
      context,
      integrationId,
      verdict: "mismatch",
      job,
      checkRun,
      detail: `workflow job conclusion=${jobConclusion} vs check-run conclusion=${checkConclusion}`,
    };
  }

  if (FAILING_CHECK_CONCLUSIONS.has(checkConclusion)) {
    return {
      context,
      integrationId,
      verdict: "failed",
      job,
      checkRun,
      detail: `required check concluded ${checkConclusion}`,
    };
  }

  return {
    context,
    integrationId,
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
 * (job without check-run), mismatched, still pending, or completed failing.
 *
 * `requiredContexts` accepts plain strings or `{ context, integrationId }`
 * objects (ruleset extraction preserves integration_id).
 */
function reconcileRequiredChecks({
  requiredContexts,
  checkRuns,
  workflowJobs,
}) {
  if (!Array.isArray(requiredContexts) || requiredContexts.length === 0) {
    throw new UsageError("at least one required context is required");
  }
  const requiredChecks = requiredContexts.map(normalizeRequiredCheck);

  if (!Array.isArray(checkRuns)) {
    throw new UsageError("checkRuns must be an array");
  }
  if (!Array.isArray(workflowJobs)) {
    throw new UsageError("workflowJobs must be an array");
  }

  const jobsByName = pickLatestByName(workflowJobs);
  const results = requiredChecks.map(({ context, integrationId }) => {
    const checkRun = pickLatestCheckRun(checkRuns, context, integrationId);
    return classifyContext(
      context,
      jobsByName.get(context) ?? null,
      checkRun,
      integrationId,
    );
  });

  const problems = results.filter((row) =>
    ["divergence", "missing", "mismatch", "pending", "failed"].includes(
      row.verdict,
    ),
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
    lines.push(
      "ok: every required context is present on the commit check-run list.",
    );
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
    targetRef: null,
    defaultBranch: null,
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
      case "--target-ref":
        options.targetRef = next();
        break;
      case "--default-branch":
        options.defaultBranch = next();
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
  check-run-reconcile.cjs --check-runs-json FILE --jobs-json FILE --rulesets-json FILE \\
    [--target-ref REF] [--default-branch NAME]

Compares workflow jobs on a head SHA to commit check-runs for each required
context. Exit 0 when every required context has an attached non-failing
check-run and no divergence/mismatch/pending/failed rows remain; exit 1 on
reconcile problems; exit 2 on usage or fetch errors.

--rulesets-json / --from-rulesets derive contexts from rulesets (skipping
disabled and evaluate). Explicit --context values win unless --from-rulesets
is also set (fixture --rulesets-json follows the same rule: only overrides
when no --context was given). Pass --target-ref (PR base) to filter rulesets
by conditions.ref_name; --default-branch resolves ~DEFAULT_BRANCH.
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

function resolvePull(repo, pr) {
  const pull = ghApiJson(`repos/${repo}/pulls/${pr}`);
  const sha = pull?.head?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new UsageError(`could not resolve head SHA for PR #${pr}`);
  }
  const baseRef = pull?.base?.ref;
  if (typeof baseRef !== "string" || baseRef.length === 0) {
    throw new UsageError(`could not resolve base ref for PR #${pr}`);
  }
  return { sha, baseRef };
}

function resolveDefaultBranch(repo) {
  const info = ghApiJson(`repos/${repo}`);
  const branch = info?.default_branch;
  if (typeof branch !== "string" || branch.length === 0) {
    throw new UsageError(`could not resolve default branch for ${repo}`);
  }
  return branch;
}

function contextNames(requiredChecks) {
  return requiredChecks.map((entry) =>
    typeof entry === "string" ? entry : entry.context,
  );
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
  let targetRef = options.targetRef;
  let defaultBranch = options.defaultBranch;

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
    workflowJobs = Array.isArray(jobsPayload) ? jobsPayload : jobsPayload.jobs;
    if (!Array.isArray(checkRuns) || !Array.isArray(workflowJobs)) {
      throw new UsageError(
        "fixture JSON must be an array or an object with check_runs/jobs arrays",
      );
    }
    // Match live mode: --rulesets-json only overrides when no explicit
    // --context was given (or the caller also set --from-rulesets).
    if (
      options.rulesetsJson &&
      (options.fromRulesets || requiredContexts.length === 0)
    ) {
      const rulesets = readJsonFile(options.rulesetsJson);
      requiredContexts = extractRequiredContextsFromRulesets(
        Array.isArray(rulesets) ? rulesets : [rulesets],
        { targetRef, defaultBranch },
      );
    }
  } else {
    if (!repo || typeof repo !== "string" || !repo.includes("/")) {
      throw new UsageError("--repo OWNER/NAME is required for live fetches");
    }
    if (options.pr && !sha) {
      const pull = resolvePull(repo, options.pr);
      sha = pull.sha;
      if (!targetRef) {
        targetRef = pull.baseRef;
      }
    }
    if (!sha) {
      throw new UsageError("--sha or --pr is required");
    }
    if (options.fromRulesets || requiredContexts.length === 0) {
      if (!defaultBranch) {
        defaultBranch = resolveDefaultBranch(repo);
      }
      requiredContexts = extractRequiredContextsFromRulesets(
        collectRulesetDetails(repo),
        { targetRef, defaultBranch },
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
      `${JSON.stringify(
        {
          repo,
          sha,
          requiredContexts: contextNames(requiredContexts),
          requiredChecks: requiredContexts.map(normalizeRequiredCheck),
          ...report,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(formatReconcileReport(report, { repo, sha }));
  }

  return report.ok ? 0 : 1;
}

module.exports = Object.freeze({
  UsageError,
  FAILING_CHECK_CONCLUSIONS,
  pickLatestByName,
  matchRefPattern,
  rulesetAppliesToRef,
  normalizeRequiredCheck,
  extractRequiredContextsFromRulesets,
  pickLatestCheckRun,
  classifyContext,
  reconcileRequiredChecks,
  formatReconcileReport,
  parseArgs,
  main,
});

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    // Usage/fetch errors and unexpected failures both exit 2 (see usage()).
    process.exitCode = 2;
  }
}
