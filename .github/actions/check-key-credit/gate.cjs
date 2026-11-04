// check-key-credit: whether a keyed lane's key job should skip the model
// because the key ended in a credit stop inside the window.
//
// The key job uploads an artifact named markerName(workflow, keyJob) after
// the launcher's lane-class `credit-stop` (run-claude-cli: classify.cjs
// isCreditStop), so an auth stop (401, or 402 without the credit text) never
// writes one. This gate's first call reads the repository's artifacts of that
// exact name, and skips the key when the newest unexpired one was created
// inside the window, citing the run that uploaded it. The window counts from
// that upload, so a topped-up or rotated key is tried on the first run after
// it. No marker in the window, any failure or an unreadable answer runs the
// key, as before this gate: it never skips the subscription path and never
// fails the step.
//
// The name carries the caller workflow's file and the key job, so each
// caller's key is judged on its own credit stops. A fork's pull_request run
// holds no secret but can upload an artifact of any name from a modified
// workflow, so a marker counts only when its run's head repository is this
// repository (workflow_run.head_repository_id equal to repository_id), as
// the run-history read's exclude_pull_requests did. Any workflow of this
// repository can still upload one; the worst it does is move reviews to the
// subscription for the window. More than 100 markers of one name in
// retention can push the newest off the page, which runs the key.
//
// The probing marker closes the re-probe race: when the window has ended but
// a credit-stop marker is still in retention, every gate until the first
// re-probe's own credit stop lands would run the empty key. So the gate then
// makes a second call, the probing markers (probeName), and:
//   - a probing marker created after that credit stop and inside the probe
//     window skips, citing the probing run;
//   - one created after it but older than the probe window means that probe
//     hit no credit stop, so the key runs and no new probe is written;
//   - none means this gate is the probe: the key runs and the probing-marker
//     output names the artifact the gate job uploads.
// With no credit-stop marker in retention the key is healthy: one call, no
// probe, so a working key is never held to one call per probe window. A
// failed probe read runs the key and writes no probe. A probe run cancelled
// before its key leg leaves no credit stop either, so the next gate after it
// expires runs the key as healthy.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MARKER_PREFIX = "key-credit-stop-";
const PROBE_PREFIX = "key-credit-probing-";
const MAX_WINDOW_HOURS = 168;
// The markers are kept one day, so a longer probe window would outlive them.
const MAX_PROBE_MINUTES = 1440;
const WORKFLOW_REF = /^[\w.-]+\/[\w.-]+\/\.github\/workflows\/([\w.-]+\.ya?ml)@/u;

// The rate-limit reading report-api-budget reads, as the scope step writes
// it, under the route of the gate's one request (the artifact list). A
// failed write only drops the reading.
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
      `${response.status} ${values.join(" ")} repos/{repo}/actions/artifacts\n`,
    );
  } catch {
    // No reading: the notice is only missing one.
  }
}

// The artifact name the key job uploads and this gate reads.
function markerName(workflow, keyJob) {
  return `${MARKER_PREFIX}${workflow}-${keyJob}`;
}

// The artifact name the gate job uploads when it passes the key as a probe.
function probeName(workflow, keyJob) {
  return `${PROBE_PREFIX}${workflow}-${keyJob}`;
}

// The newest unexpired marker of the exact name, created at or after
// `sinceMs` by a run whose head is this repository, or null.
function newestMarker(artifacts, name, sinceMs) {
  let newest = null;
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const created = Date.parse(artifact?.created_at ?? "");
    const run = artifact?.workflow_run?.id;
    const repo = artifact?.workflow_run?.repository_id;
    if (
      artifact?.name !== name ||
      artifact.expired !== false ||
      !Number.isFinite(created) ||
      created < sinceMs ||
      !Number.isSafeInteger(run) ||
      !Number.isSafeInteger(repo) ||
      artifact.workflow_run.head_repository_id !== repo
    ) {
      continue;
    }
    if (!newest || created > newest.created) newest = { created, run };
  }
  return newest;
}

// The decision from one credit-stop listing: a marker inside the window
// skips, citing its run.
function judgeMarkers(artifacts, name, sinceMs) {
  const newest = newestMarker(artifacts, name, sinceMs);
  return newest
    ? { skip: true, origin: String(newest.run) }
    : { skip: false, reason: "no credit-stop marker in the window" };
}

async function read(listArtifacts, name, what) {
  try {
    const artifacts = await listArtifacts(name);
    return Array.isArray(artifacts)
      ? { artifacts }
      : { reason: `the ${what} list was not a list` };
  } catch (error) {
    return { reason: `the ${what}s were not read (${error.message})` };
  }
}

// The decision, from an injected reader of one exact name; never throws.
// `probe` (the probing marker's name and `probeSinceMs`) is optional: without
// it the gate reads and judges the credit-stop marker alone. `probe: true` on
// a verdict asks the gate job to upload the probing marker.
async function decide({ listArtifacts, name, sinceMs, probe = null, probeSinceMs = 0, nowMs = 0 }) {
  const stops = await read(listArtifacts, name, "marker");
  if (!stops.artifacts) return { skip: false, reason: stops.reason };
  const verdict = judgeMarkers(stops.artifacts, name, sinceMs);
  if (verdict.skip || !probe) return verdict;
  const stop = newestMarker(stops.artifacts, name, -Infinity);
  if (!stop) return verdict;
  const probes = await read(listArtifacts, probe, "probing marker");
  if (!probes.artifacts) return { skip: false, reason: probes.reason };
  const prior = newestMarker(probes.artifacts, probe, stop.created);
  if (!prior) {
    return {
      skip: false,
      reason: `the credit stop in run ${stop.run} is past the window; this run probes the key`,
      probe: true,
    };
  }
  if (prior.created >= probeSinceMs) {
    return {
      skip: true,
      origin: String(prior.run),
      probing: Math.max(0, Math.round((nowMs - prior.created) / 60000)),
    };
  }
  return {
    skip: false,
    reason: `run ${prior.run} probed the key after its credit stop with no new credit stop`,
  };
}

function readEnv(env) {
  const keyJob = env.KEY_JOB ?? "";
  const hours = Number(env.WINDOW_HOURS);
  const probeMinutes = Number(env.PROBE_MINUTES);
  const workflow = (env.WORKFLOW_REF ?? "").match(WORKFLOW_REF)?.[1] ?? null;
  const repository = env.GITHUB_REPOSITORY ?? "";
  const valid =
    /^[a-z][a-z0-9-]{0,99}$/u.test(keyJob) &&
    /^[\w.-]+\/[\w.-]+$/u.test(repository) &&
    workflow !== null;
  return {
    keyJob,
    hours,
    // Out of range or unreadable turns probing off: the key runs as before.
    probeMinutes:
      probeMinutes > 0 && probeMinutes <= MAX_PROBE_MINUTES ? probeMinutes : 0,
    repository,
    marker: valid ? markerName(workflow, keyJob) : "",
    probe: valid ? probeName(workflow, keyJob) : "",
    api: env.GITHUB_API_URL || "https://api.github.com",
    server: env.GITHUB_SERVER_URL || "https://github.com",
    token: env.GITHUB_TOKEN ?? "",
    runnerTemp: env.RUNNER_TEMP ?? "",
    valid,
  };
}

async function main(env = process.env, fetchImpl = globalThis.fetch, now = () => new Date()) {
  const config = readEnv(env);
  const lines = [];
  let verdict;
  if (!(config.hours > 0 && config.hours <= MAX_WINDOW_HOURS)) {
    verdict = { skip: false, reason: "the window is off" };
  } else if (!config.valid || config.token === "") {
    verdict = { skip: false, reason: "the workflow, job or token is unreadable" };
  } else {
    const nowMs = now().getTime();
    verdict = await decide({
      name: config.marker,
      sinceMs: nowMs - config.hours * 3600 * 1000,
      probe: config.probeMinutes > 0 ? config.probe : null,
      probeSinceMs: nowMs - config.probeMinutes * 60 * 1000,
      nowMs,
      // The API's name filter takes one exact name, so each marker is a call.
      listArtifacts: async (name) => {
        const response = await fetchImpl(
          `${config.api}/repos/${config.repository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${config.token}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
            signal: AbortSignal.timeout(15000),
          },
        );
        recordBudget(response, config.runnerTemp);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json())?.artifacts;
      },
    });
  }
  if (verdict.skip && verdict.probing !== undefined) {
    lines.push(
      `::notice title=check-key-credit::${config.keyJob} skips the key: run ${verdict.origin} (${config.server}/${config.repository}/actions/runs/${verdict.origin}) is probing the key, ${verdict.probing} minutes ago, inside the ${config.probeMinutes}-minute probe window; the subscription job reviews`,
    );
  } else if (verdict.skip) {
    lines.push(
      `::notice title=check-key-credit::${config.keyJob} skips the key: the key's credit stop in run ${verdict.origin} (${config.server}/${config.repository}/actions/runs/${verdict.origin}) is inside the ${config.hours}-hour window; the subscription job reviews`,
    );
  } else {
    lines.push(`check-key-credit: ${config.keyJob || "the key job"} runs the key: ${verdict.reason}`);
  }
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      `skip-key=${verdict.skip}\norigin-run=${verdict.skip ? verdict.origin : ""}\nmarker=${config.marker}\nprobing-marker=${verdict.probe ? config.probe : ""}\n`,
    );
  }
  return { verdict, lines };
}

if (require.main === module) {
  main()
    .then(({ lines }) => process.stdout.write(`${lines.join("\n")}\n`))
    .catch(() => {
      // Fail open: no output leaves skip-key empty, so the key runs.
      process.stdout.write("check-key-credit: the check failed; the key runs\n");
    });
}

module.exports = {
  MARKER_PREFIX,
  PROBE_PREFIX,
  decide,
  judgeMarkers,
  main,
  markerName,
  probeName,
};
