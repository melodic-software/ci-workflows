// key-credit-gate: whether a keyed lane's key job should skip the model
// because the key ended in a credit stop inside the window.
//
// It reads the calling workflow's completed runs created inside the window
// (one list call) and, newest first, at most MAX_JOB_READS of their job lists
// (one call each), and stops at the first run that settles the question:
//   - the key job or this gate's job has a successful step whose name is
//     RECORD_STEP and an origin run id that is one of the listed runs: skip,
//     citing that origin;
//   - that record names a run outside the list: the credit stop expired, run;
//   - the key job's model step (MODEL_STEP) ran with no record: the key ran
//     with no credit stop, run.
// A run that settles nothing (cancelled, no key job, no review needed) is
// passed over. Any failure, an unreadable answer or no settling run within
// the cap runs the key, as before this gate: it never skips the subscription
// path and never fails the step.
//
// The record step runs in the key job only after the launcher's lane-class
// `credit-stop` (run-claude-cli: classify.cjs isCreditStop), so an auth stop
// (401, or 402 without the credit text) never counts, and names its own run.
// When this gate skips the key, its job's record step names the origin run
// instead, so the window runs from the credit stop itself, not from the
// last skip. A same-repository pull request that edits the caller workflow
// could write a record; the worst it does is move reviews to the
// subscription for the window, and such writers already hold the secrets.
// More than 100 completed runs in the window can push the origin off the
// list, which runs the key.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RECORD_STEP = "Record the key's credit stop in run ";
const RECORD_PATTERN = /^Record the key's credit stop in run (\d{1,20})$/u;
const MODEL_STEP = "Claude review";
const MAX_JOB_READS = 3;
const MAX_WINDOW_HOURS = 168;
const WORKFLOW_REF = /^[\w.-]+\/[\w.-]+\/\.github\/workflows\/([\w.-]+\.ya?ml)@/u;

// The rate-limit reading report-api-budget reads, as the scope step writes
// it. A failed write only drops the reading.
function recordBudget(response, runnerTemp) {
  if (!runnerTemp) return;
  const values = ["limit", "remaining", "used", "reset", "resource"].map(
    (key) => {
      const value = String(response.headers?.get?.(`x-ratelimit-${key}`) ?? "");
      return (key === "resource" ? /^[a-z_]+$/u : /^\d+$/u).test(value)
        ? value
        : "na";
    },
  );
  try {
    const dir = path.join(runnerTemp, "api-budget");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "github-token"),
      `${response.status} ${values.join(" ")}\n`,
    );
  } catch {
    // No reading: the notice is only missing one.
  }
}

// The job named `name` in one run's job list: exactly, or `<caller job> /
// name` when a caller's job runs the reusable.
function jobNamed(jobs, name) {
  return jobs.find(
    (job) =>
      typeof job?.name === "string" &&
      job.status === "completed" &&
      Array.isArray(job.steps) &&
      (job.name === name || job.name.endsWith(` / ${name}`)),
  );
}

// What one run's job list settles: { skip, origin } or { skip: false,
// reason }, or null when it settles nothing. The record is the key job's
// own, or the gate job's (`<key job>-credit`) carried from an earlier run.
function judgeRun(jobs, keyJob, windowIds) {
  const list = Array.isArray(jobs) ? jobs : [];
  const key = jobNamed(list, keyJob);
  const gate = jobNamed(list, `${keyJob}-credit`);
  for (const step of [...(gate?.steps ?? []), ...(key?.steps ?? [])]) {
    const match =
      step?.conclusion === "success" && typeof step.name === "string"
        ? step.name.match(RECORD_PATTERN)
        : null;
    if (!match) continue;
    return windowIds.has(match[1])
      ? { skip: true, origin: match[1] }
      : {
          skip: false,
          reason: `the credit stop in run ${match[1]} is outside the window`,
        };
  }
  const model = key?.steps.find((step) => step?.name === MODEL_STEP);
  if (model?.conclusion === "success" || model?.conclusion === "failure") {
    return { skip: false, reason: "the key ran with no credit stop" };
  }
  return null;
}

// The decision, from injected readers; never throws.
async function decide({
  listRuns,
  listJobs,
  currentRunId,
  keyJob,
  maxJobReads = MAX_JOB_READS,
}) {
  let runs;
  try {
    runs = await listRuns();
  } catch (error) {
    return { skip: false, reason: `the run list was not read (${error.message})` };
  }
  if (!Array.isArray(runs)) {
    return { skip: false, reason: "the run list was not a list" };
  }
  const candidates = runs.filter(
    (run) => Number.isSafeInteger(run?.id) && String(run.id) !== currentRunId,
  );
  const windowIds = new Set(candidates.map((run) => String(run.id)));
  for (const run of candidates.slice(0, maxJobReads)) {
    let jobs;
    try {
      jobs = await listJobs(run.id);
    } catch (error) {
      return {
        skip: false,
        reason: `run ${run.id}'s jobs were not read (${error.message})`,
      };
    }
    const verdict = judgeRun(jobs, keyJob, windowIds);
    if (verdict) return { ...verdict, run: String(run.id) };
  }
  return {
    skip: false,
    reason:
      candidates.length === 0
        ? "no completed run in the window"
        : `no run of the newest ${Math.min(candidates.length, maxJobReads)} settles it`,
  };
}

function readEnv(env) {
  const keyJob = env.KEY_JOB ?? "";
  const hours = Number(env.WINDOW_HOURS);
  const workflow = (env.WORKFLOW_REF ?? "").match(WORKFLOW_REF)?.[1] ?? null;
  const repository = env.GITHUB_REPOSITORY ?? "";
  return {
    keyJob,
    hours,
    workflow,
    repository,
    api: env.GITHUB_API_URL || "https://api.github.com",
    server: env.GITHUB_SERVER_URL || "https://github.com",
    runId: env.GITHUB_RUN_ID ?? "",
    token: env.GITHUB_TOKEN ?? "",
    runnerTemp: env.RUNNER_TEMP ?? "",
    valid:
      /^[a-z][a-z0-9-]{0,99}$/u.test(keyJob) &&
      /^[\w.-]+\/[\w.-]+$/u.test(repository) &&
      workflow !== null &&
      /^\d{1,20}$/u.test(env.GITHUB_RUN_ID ?? ""),
  };
}

async function main(env = process.env, fetchImpl = globalThis.fetch, now = () => new Date()) {
  const config = readEnv(env);
  const lines = [];
  let verdict;
  if (!(config.hours > 0 && config.hours <= MAX_WINDOW_HOURS)) {
    verdict = { skip: false, reason: "the window is off" };
  } else if (!config.valid || config.token === "") {
    verdict = { skip: false, reason: "the run, workflow, job or token is unreadable" };
  } else {
    const get = async (url) => {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${config.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15000),
      });
      recordBudget(response, config.runnerTemp);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };
    const since = new Date(now().getTime() - config.hours * 3600 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/u, "Z");
    const base = `${config.api}/repos/${config.repository}/actions`;
    verdict = await decide({
      currentRunId: config.runId,
      keyJob: config.keyJob,
      listRuns: async () =>
        (
          await get(
            `${base}/workflows/${config.workflow}/runs?status=completed&exclude_pull_requests=true&per_page=100&created=${encodeURIComponent(`>=${since}`)}`,
          )
        )?.workflow_runs,
      listJobs: async (id) =>
        (await get(`${base}/runs/${id}/jobs?filter=latest&per_page=100`))?.jobs,
    });
  }
  if (verdict.skip) {
    lines.push(
      `::notice title=key-credit-gate::${config.keyJob} skips the key: the key's credit stop in run ${verdict.origin} (${config.server}/${config.repository}/actions/runs/${verdict.origin}) is inside the ${config.hours}-hour window; the subscription job reviews`,
    );
  } else {
    lines.push(`key-credit-gate: ${config.keyJob || "the key job"} runs the key: ${verdict.reason}`);
  }
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      `skip-key=${verdict.skip}\norigin-run=${verdict.skip ? verdict.origin : ""}\n`,
    );
  }
  return { verdict, lines };
}

if (require.main === module) {
  main()
    .then(({ lines }) => process.stdout.write(`${lines.join("\n")}\n`))
    .catch(() => {
      // Fail open: no output leaves skip-key empty, so the key runs.
      process.stdout.write("key-credit-gate: the check failed; the key runs\n");
    });
}

module.exports = {
  MAX_JOB_READS,
  MODEL_STEP,
  RECORD_PATTERN,
  RECORD_STEP,
  decide,
  judgeRun,
  main,
};
