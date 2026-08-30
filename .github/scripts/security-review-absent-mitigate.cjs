#!/usr/bin/env node
// Mitigate an intermittent pull_request event-delivery gap that leaves the
// required `security-review / security-review` check ABSENT (ci-workflows#227).
//
// Extends check-run-reconcile: find open PRs whose ruleset-required security
// contexts have no commit check-run on the head SHA, then either:
//   - post a FAILED check-run under that exact context (forces visibility;
//     the merge gate stops looking "mysteriously blocked with zero status"), or
//   - workflow_dispatch the consumer's Claude Security Review caller with the
//     PR number so the real always-report lane attaches a check (preferred
//     when the caller exposes dispatch — see claude-security-review-self.yml).
//
// Never calls the security reusable from pull_request_target / workflow_run
// (that trips the reusable's privileged-trigger tripwire). Companion workflows
// stay schedule / workflow_dispatch only and re-enter the lane via dispatch.
//
//   node .github/scripts/security-review-absent-mitigate.cjs \
//     --repo OWNER/NAME --from-rulesets --grace-minutes 15 --mode report
//
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const {
  UsageError,
  extractRequiredContextsFromRulesets,
  reconcileRequiredChecks,
  formatReconcileReport,
  normalizeRequiredCheck,
} = require("./check-run-reconcile.cjs");

const DEFAULT_CONTEXT_PATTERN = /security-review/iu;
const SECURITY_CONTEXT_HINT = "security-review / security-review";

class MitigateUsageError extends UsageError {
  constructor(message) {
    super(message);
    this.name = "MitigateUsageError";
  }
}

/**
 * Keep required contexts whose name matches the security-review lane.
 * Defaults to /security-review/i so `<caller-job> / security-review` matches.
 */
function filterSecurityReviewContexts(
  requiredContexts,
  pattern = DEFAULT_CONTEXT_PATTERN,
) {
  if (!Array.isArray(requiredContexts)) {
    throw new MitigateUsageError("requiredContexts must be an array");
  }
  if (!(pattern instanceof RegExp)) {
    throw new MitigateUsageError("pattern must be a RegExp");
  }
  return requiredContexts
    .map(normalizeRequiredCheck)
    .filter((entry) => pattern.test(entry.context));
}

/**
 * Whether an absent security-review row is old enough to mitigate.
 * `anchorAt` must reflect when the *current head* appeared (committer date,
 * earliest sibling check-run/job on the SHA, or updated_at) — not PR
 * created_at, which never moves on synchronize and would defeat the race
 * guard on any PR older than the grace window.
 */
function pastGracePeriod(anchorAt, graceMinutes, now = Date.now()) {
  if (
    typeof graceMinutes !== "number" ||
    !Number.isFinite(graceMinutes) ||
    graceMinutes < 0
  ) {
    throw new MitigateUsageError("graceMinutes must be a non-negative number");
  }
  const anchor = Date.parse(anchorAt);
  if (!Number.isFinite(anchor)) {
    throw new MitigateUsageError(`invalid grace anchor timestamp: ${anchorAt}`);
  }
  return now - anchor >= graceMinutes * 60 * 1000;
}

/**
 * Earliest observed activity on this head SHA among sibling check-runs / jobs,
 * falling back to the pull's headCommittedAt / updatedAt / openedAt. Prefers
 * evidence that the head already reached Actions so we wait grace from delivery
 * start rather than from an ancient PR open time.
 */
function resolveGraceAnchor(pull, checkRuns, workflowJobs) {
  const stamps = [];
  for (const item of [...(checkRuns ?? []), ...(workflowJobs ?? [])]) {
    for (const key of ["started_at", "completed_at", "created_at"]) {
      const value = item?.[key];
      if (typeof value === "string" && value.length > 0) {
        const ms = Date.parse(value);
        if (Number.isFinite(ms)) {
          stamps.push(ms);
        }
      }
    }
  }
  if (stamps.length > 0) {
    return new Date(Math.min(...stamps)).toISOString();
  }
  for (const key of ["headCommittedAt", "updatedAt", "openedAt"]) {
    const value = pull?.[key];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      Number.isFinite(Date.parse(value))
    ) {
      return value;
    }
  }
  throw new MitigateUsageError(
    `PR #${pull?.number ?? "?"} has no usable grace anchor timestamp`,
  );
}

/**
 * Rows where the required security-review context has no check-run on the SHA.
 * Uses reconcileRequiredChecks so verdict taxonomy stays shared with #399/#422.
 */
function findAbsentSecurityReview({
  requiredContexts,
  checkRuns,
  workflowJobs,
  contextPattern = DEFAULT_CONTEXT_PATTERN,
}) {
  const securityContexts = filterSecurityReviewContexts(
    requiredContexts,
    contextPattern,
  );
  if (securityContexts.length === 0) {
    return {
      ok: true,
      securityContexts: [],
      report: null,
      absent: [],
    };
  }
  const report = reconcileRequiredChecks({
    requiredContexts: securityContexts,
    checkRuns,
    workflowJobs,
  });
  const absent = report.results.filter((row) => row.checkRun === null);
  return {
    ok: absent.length === 0,
    securityContexts,
    report,
    absent,
  };
}

function parseArgs(argv) {
  const options = {
    repo: null,
    pr: null,
    sha: null,
    graceMinutes: 15,
    mode: "report",
    workflow: "Claude Security Review",
    contextPattern: DEFAULT_CONTEXT_PATTERN.source,
    fromRulesets: false,
    contexts: [],
    json: false,
    dryRun: false,
    checkRunsJson: null,
    jobsJson: null,
    rulesetsJson: null,
    pullsJson: null,
    targetRef: null,
    defaultBranch: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new MitigateUsageError(`missing value for ${arg}`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--repo":
        options.repo = next();
        break;
      case "--pr":
        options.pr = next();
        break;
      case "--sha":
        options.sha = next();
        break;
      case "--grace-minutes":
        options.graceMinutes = Number(next());
        break;
      case "--mode":
        options.mode = next();
        break;
      case "--workflow":
        options.workflow = next();
        break;
      case "--context-pattern":
        options.contextPattern = next();
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
      case "--dry-run":
        options.dryRun = true;
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
      case "--pulls-json":
        options.pullsJson = next();
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
        throw new MitigateUsageError(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return `Usage:
  security-review-absent-mitigate.cjs --repo OWNER/NAME --from-rulesets [options]
  security-review-absent-mitigate.cjs --repo OWNER/NAME --pr N --context NAME [options]
  security-review-absent-mitigate.cjs --check-runs-json FILE --jobs-json FILE \\
    --pulls-json FILE --context NAME... [--mode report|post-failure-check|dispatch]

Detect open PRs whose required security-review check-run is ABSENT on the head
SHA (ci-workflows#227) and mitigate:

  report              print findings only (default; exit 1 when any absent)
  post-failure-check  create a FAILED check-run under the missing context name
  dispatch            workflow_dispatch the security-review caller with pr-number

--grace-minutes (default 15) skips PRs younger than the window so a healthy
pull_request delivery is not raced. --dry-run prints planned writes without
calling the Checks or Actions APIs.
`;
}

function readJsonFile(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    throw new MitigateUsageError(
      `could not read JSON from ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function ghApiJson(
  path,
  { method = "GET", paginate = false, input = null } = {},
) {
  const args = ["api", path, "--method", method];
  if (paginate) {
    args.push("--paginate");
  }
  if (input !== null) {
    args.push("--input", "-");
  }
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    input: input === null ? undefined : JSON.stringify(input),
  });
  if (result.error) {
    throw new MitigateUsageError(`failed to spawn gh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new MitigateUsageError(
      `gh api ${method} ${path} failed (exit ${result.status}): ${detail}`,
    );
  }
  if (!result.stdout || result.stdout.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new MitigateUsageError(
      `gh api ${path} returned non-JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function ghWorkflowDispatch(repo, workflow, prNumber, ref) {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new MitigateUsageError(
      "workflow_dispatch requires the PR head ref so the check attaches to the PR head SHA (ci-workflows#227)",
    );
  }
  const result = spawnSync(
    "gh",
    [
      "workflow",
      "run",
      workflow,
      "--repo",
      repo,
      "--ref",
      ref,
      "-f",
      `pr-number=${prNumber}`,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error) {
    throw new MitigateUsageError(`failed to spawn gh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new MitigateUsageError(
      `gh workflow run ${workflow} failed (exit ${result.status}): ${detail}`,
    );
  }
  return (result.stdout || "").trim();
}

function collectCheckRuns(repo, sha) {
  const runs = [];
  let page = 1;
  for (;;) {
    const payload = ghApiJson(
      `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    );
    if (payload === null || typeof payload !== "object") {
      throw new MitigateUsageError(
        `check-runs response for ${sha} was empty or not an object`,
      );
    }
    const batch = Array.isArray(payload.check_runs) ? payload.check_runs : [];
    runs.push(...batch);
    if (batch.length < 100) {
      break;
    }
    page += 1;
    if (page > 50) {
      throw new MitigateUsageError("check-run pagination exceeded safety cap");
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
    if (payload === null || typeof payload !== "object") {
      throw new MitigateUsageError(
        `workflow runs response for ${sha} was empty or not an object`,
      );
    }
    const runs = Array.isArray(payload.workflow_runs)
      ? payload.workflow_runs
      : [];
    for (const run of runs) {
      let jobPage = 1;
      for (;;) {
        const jobPayload = ghApiJson(
          `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100&page=${jobPage}`,
        );
        if (jobPayload === null || typeof jobPayload !== "object") {
          throw new MitigateUsageError(
            `jobs response for run ${run.id} was empty or not an object`,
          );
        }
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
          throw new MitigateUsageError("job pagination exceeded safety cap");
        }
      }
    }
    if (runs.length < 100) {
      break;
    }
    page += 1;
    if (page > 20) {
      throw new MitigateUsageError(
        "workflow-run pagination exceeded safety cap",
      );
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

function resolveDefaultBranch(repo) {
  const info = ghApiJson(`repos/${repo}`);
  const branch = info?.default_branch;
  if (typeof branch !== "string" || branch.length === 0) {
    throw new MitigateUsageError(
      `could not resolve default branch for ${repo}`,
    );
  }
  return branch;
}

function listOpenPulls(repo) {
  const pulls = [];
  let page = 1;
  for (;;) {
    const batch = ghApiJson(
      `repos/${repo}/pulls?state=open&per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) {
      throw new MitigateUsageError("expected an array of pull requests");
    }
    pulls.push(...batch);
    if (batch.length < 100) {
      break;
    }
    page += 1;
    if (page > 20) {
      throw new MitigateUsageError("pull pagination exceeded safety cap");
    }
  }
  return pulls;
}

function failureCheckPayload({ context, sha, prNumber, detail }) {
  return {
    name: context,
    head_sha: sha,
    status: "completed",
    conclusion: "failure",
    output: {
      title: "Required security-review check never attached",
      summary:
        `The required context \`${context}\` is ABSENT on \`${sha}\` ` +
        `(ci-workflows#227: intermittent \`pull_request\` event-delivery gap). ` +
        `This FAILED check forces visibility; it is not a security finding.\n\n` +
        `PR: #${prNumber}\n` +
        `Detail: ${detail}\n\n` +
        `Clear by workflow_dispatch of the Claude Security Review caller with ` +
        `\`pr-number=${prNumber}\`, or by any new push that re-delivers \`pull_request\`. ` +
        `Do not move the security lane onto \`pull_request_target\` / \`workflow_run\` ` +
        `with secrets — that trips the reusable's privileged-trigger tripwire.`,
    },
  };
}

function postFailureCheck(repo, payload) {
  return ghApiJson(`repos/${repo}/check-runs`, {
    method: "POST",
    input: payload,
  });
}

function normalizePull(pull) {
  const number = pull?.number;
  const sha = pull?.head?.sha;
  const openedAt = pull?.created_at;
  const updatedAt = pull?.updated_at;
  const headRef = pull?.head?.ref;
  const baseRef = pull?.base?.ref;
  if (!Number.isInteger(number) || number <= 0) {
    throw new MitigateUsageError("pull.number must be a positive integer");
  }
  if (typeof sha !== "string" || sha.length === 0) {
    throw new MitigateUsageError(`PR #${number} has no head SHA`);
  }
  if (typeof openedAt !== "string" || openedAt.length === 0) {
    throw new MitigateUsageError(`PR #${number} has no created_at`);
  }
  return {
    number,
    sha,
    openedAt,
    updatedAt: typeof updatedAt === "string" ? updatedAt : openedAt,
    headRef: typeof headRef === "string" && headRef.length > 0 ? headRef : null,
    headCommittedAt:
      typeof pull?.headCommittedAt === "string" ? pull.headCommittedAt : null,
    baseRef: typeof baseRef === "string" ? baseRef : null,
    title: typeof pull?.title === "string" ? pull.title : "",
    draft: Boolean(pull?.draft),
  };
}

function resolveHeadCommittedAt(repo, sha) {
  const commit = ghApiJson(`repos/${repo}/commits/${sha}`);
  const stamp =
    commit?.commit?.committer?.date ?? commit?.commit?.author?.date ?? null;
  if (typeof stamp !== "string" || stamp.length === 0) {
    return null;
  }
  return stamp;
}

function mitigatePull({
  repo,
  pull,
  requiredContexts,
  checkRuns,
  workflowJobs,
  contextPattern,
  graceMinutes,
  mode,
  workflow,
  dryRun,
  now,
}) {
  const actions = [];
  if (pull.draft) {
    return {
      pull: pull.number,
      sha: pull.sha,
      skipped: "draft",
      actions,
    };
  }
  const graceAnchor = resolveGraceAnchor(pull, checkRuns, workflowJobs);
  if (!pastGracePeriod(graceAnchor, graceMinutes, now)) {
    return {
      pull: pull.number,
      sha: pull.sha,
      skipped: "within-grace",
      graceAnchor,
      actions,
    };
  }

  const found = findAbsentSecurityReview({
    requiredContexts,
    checkRuns,
    workflowJobs,
    contextPattern,
  });
  if (found.securityContexts.length === 0) {
    return {
      pull: pull.number,
      sha: pull.sha,
      skipped: "no-security-review-required",
      actions,
    };
  }
  if (found.absent.length === 0) {
    return {
      pull: pull.number,
      sha: pull.sha,
      skipped: "security-review-present",
      actions,
      report: found.report,
    };
  }

  for (const row of found.absent) {
    const action = {
      context: row.context,
      detail: row.detail,
      mode,
    };
    if (mode === "report") {
      action.status = "reported";
    } else if (mode === "post-failure-check") {
      const payload = failureCheckPayload({
        context: row.context,
        sha: pull.sha,
        prNumber: pull.number,
        detail: row.detail,
      });
      if (dryRun) {
        action.status = "dry-run";
        action.payload = payload;
      } else {
        const created = postFailureCheck(repo, payload);
        action.status = "posted";
        action.checkRunId = created?.id ?? null;
      }
    } else if (mode === "dispatch") {
      if (!pull.headRef) {
        throw new MitigateUsageError(
          `PR #${pull.number} has no head ref; cannot workflow_dispatch onto the PR head`,
        );
      }
      if (dryRun) {
        action.status = "dry-run";
        action.workflow = workflow;
        action.prNumber = pull.number;
        action.ref = pull.headRef;
      } else {
        ghWorkflowDispatch(repo, workflow, String(pull.number), pull.headRef);
        action.status = "dispatched";
        action.workflow = workflow;
        action.ref = pull.headRef;
      }
    } else {
      throw new MitigateUsageError(
        `unknown mode: ${mode} (expected report|post-failure-check|dispatch)`,
      );
    }
    actions.push(action);
  }

  return {
    pull: pull.number,
    sha: pull.sha,
    title: pull.title,
    skipped: null,
    absentCount: found.absent.length,
    reportText: found.report
      ? formatReconcileReport(found.report, { repo, sha: pull.sha })
      : null,
    actions,
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  if (!["report", "post-failure-check", "dispatch"].includes(options.mode)) {
    throw new MitigateUsageError(
      `--mode must be report|post-failure-check|dispatch (got ${options.mode})`,
    );
  }
  if (
    typeof options.graceMinutes !== "number" ||
    !Number.isFinite(options.graceMinutes) ||
    options.graceMinutes < 0
  ) {
    throw new MitigateUsageError(
      "--grace-minutes must be a non-negative number",
    );
  }

  let contextPattern;
  try {
    contextPattern = new RegExp(options.contextPattern, "iu");
  } catch (error) {
    throw new MitigateUsageError(
      `invalid --context-pattern: ${error instanceof Error ? error.message : error}`,
    );
  }

  let pulls;
  let requiredContexts = options.contexts.map((c) => c.trim()).filter(Boolean);
  const repo = options.repo;
  let defaultBranch = options.defaultBranch;
  const now = Date.now();
  const results = [];

  if (options.pullsJson) {
    const raw = readJsonFile(options.pullsJson);
    pulls = (Array.isArray(raw) ? raw : raw.pulls).map(normalizePull);
    if (!options.checkRunsJson || !options.jobsJson) {
      throw new MitigateUsageError(
        "fixture mode requires --check-runs-json and --jobs-json with --pulls-json",
      );
    }
    const checkPayload = readJsonFile(options.checkRunsJson);
    const jobsPayload = readJsonFile(options.jobsJson);
    const checkRuns = Array.isArray(checkPayload)
      ? checkPayload
      : checkPayload.check_runs;
    const workflowJobs = Array.isArray(jobsPayload)
      ? jobsPayload
      : jobsPayload.jobs;
    if (
      options.rulesetsJson &&
      (options.fromRulesets || requiredContexts.length === 0)
    ) {
      const rulesets = readJsonFile(options.rulesetsJson);
      requiredContexts = extractRequiredContextsFromRulesets(
        Array.isArray(rulesets) ? rulesets : [rulesets],
        { targetRef: options.targetRef, defaultBranch },
      );
    }
    if (requiredContexts.length === 0) {
      requiredContexts = [SECURITY_CONTEXT_HINT];
    }
    // Fixture mode: one shared check/job snapshot applied to each pull, or
    // per-sha maps keyed by head SHA when the JSON is an object of arrays.
    for (const pull of pulls) {
      const perShaChecks =
        !Array.isArray(checkPayload) && Array.isArray(checkPayload[pull.sha])
          ? checkPayload[pull.sha]
          : null;
      const perShaJobs =
        !Array.isArray(jobsPayload) && Array.isArray(jobsPayload[pull.sha])
          ? jobsPayload[pull.sha]
          : null;
      results.push(
        mitigatePull({
          repo: repo ?? "fixture/repo",
          pull,
          requiredContexts,
          checkRuns: perShaChecks ?? checkRuns,
          workflowJobs: perShaJobs ?? workflowJobs,
          contextPattern,
          graceMinutes: options.graceMinutes,
          mode: options.mode,
          workflow: options.workflow,
          dryRun: options.dryRun,
          now,
        }),
      );
    }
  } else {
    if (!repo || typeof repo !== "string" || !repo.includes("/")) {
      throw new MitigateUsageError(
        "--repo OWNER/NAME is required for live fetches",
      );
    }
    if (options.pr) {
      const pull = ghApiJson(`repos/${repo}/pulls/${options.pr}`);
      pulls = [normalizePull(pull)];
    } else {
      pulls = listOpenPulls(repo).map(normalizePull);
    }

    // Extract once without targetRef, then re-filter per PR base below when
    // needed. Most org rulesets use ~DEFAULT_BRANCH / ~ALL; per-PR base is
    // applied inside the loop when targetRef was not forced on the CLI.
    const needsRulesets = options.fromRulesets || requiredContexts.length === 0;
    if (needsRulesets && !defaultBranch) {
      defaultBranch = resolveDefaultBranch(repo);
    }

    const rulesets = needsRulesets ? collectRulesetDetails(repo) : null;

    for (const pull of pulls) {
      let contextsForPull = requiredContexts;
      if (rulesets) {
        contextsForPull = extractRequiredContextsFromRulesets(rulesets, {
          targetRef: options.targetRef ?? pull.baseRef,
          defaultBranch: defaultBranch ?? resolveDefaultBranch(repo),
        });
      }
      if (contextsForPull.length === 0 && options.contexts.length === 0) {
        // No required contexts from rulesets — nothing to mitigate.
        results.push({
          pull: pull.number,
          sha: pull.sha,
          skipped: "no-required-contexts",
          actions: [],
        });
        continue;
      }
      if (contextsForPull.length === 0) {
        contextsForPull = options.contexts;
      }
      const checkRuns = collectCheckRuns(repo, pull.sha);
      const workflowJobs = collectWorkflowJobs(repo, pull.sha);
      pull.headCommittedAt =
        pull.headCommittedAt ?? resolveHeadCommittedAt(repo, pull.sha);
      results.push(
        mitigatePull({
          repo,
          pull,
          requiredContexts: contextsForPull,
          checkRuns,
          workflowJobs,
          contextPattern,
          graceMinutes: options.graceMinutes,
          mode: options.mode,
          workflow: options.workflow,
          dryRun: options.dryRun,
          now,
        }),
      );
    }
  }

  const mitigated = results.filter((row) => row.skipped === null);
  const payload = {
    repo,
    mode: options.mode,
    dryRun: options.dryRun,
    graceMinutes: options.graceMinutes,
    mitigatedCount: mitigated.length,
    results,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const lines = [
      `security-review absent mitigate (${repo ?? "fixture"} mode=${options.mode}` +
        `${options.dryRun ? " dry-run" : ""})`,
    ];
    for (const row of results) {
      if (row.skipped) {
        lines.push(
          `- PR #${row.pull} @ ${row.sha.slice(0, 7)}: skipped (${row.skipped})`,
        );
        continue;
      }
      lines.push(
        `- PR #${row.pull} @ ${row.sha.slice(0, 7)}: ${row.absentCount} absent security-review context(s)`,
      );
      for (const action of row.actions) {
        lines.push(
          `  - ${action.context}: ${action.status}` +
            (action.checkRunId ? ` check_run=${action.checkRunId}` : "") +
            (action.workflow ? ` workflow=${action.workflow}` : ""),
        );
      }
      if (row.reportText) {
        for (const line of row.reportText.trim().split("\n")) {
          lines.push(`  ${line}`);
        }
      }
    }
    if (mitigated.length > 0) {
      lines.push(
        `::error::${mitigated.length} open PR(s) have an ABSENT required security-review check (ci-workflows#227).`,
      );
    } else {
      lines.push("ok: no absent required security-review checks past grace.");
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  return mitigated.length === 0 ? 0 : 1;
}

module.exports = Object.freeze({
  MitigateUsageError,
  DEFAULT_CONTEXT_PATTERN,
  SECURITY_CONTEXT_HINT,
  filterSecurityReviewContexts,
  pastGracePeriod,
  resolveGraceAnchor,
  findAbsentSecurityReview,
  failureCheckPayload,
  parseArgs,
  mitigatePull,
  main,
});

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 2;
  }
}
