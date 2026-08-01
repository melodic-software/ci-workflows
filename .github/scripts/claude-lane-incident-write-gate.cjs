"use strict";

// The write-gate audit for claude-lane-incident-aggregator.yml.
//
// The workflow's guarantee is STRUCTURAL, not analytical. All the work — the
// checkout, the App-token mint, the polls, the inline scripts, the shell —
// happens in `poll`, which holds no write scope and therefore cannot mutate
// anything however its steps are wired. Exactly one job holds a write scope,
// and that job is three steps long, checks out nothing, runs no shell, and
// loads no repository code.
//
// So this audit does not classify steps. It proves the shape:
//
//   - exactly ONE job resolves to a write-scoped permission set, and it is
//     `write`. Zero write-scoped jobs is a HARD FAILURE, never a pass: "looked,
//     found nothing to check, passed" is the shape every bypass produces;
//   - that job matches its pinned text BYTE FOR BYTE, so any edit to it fails
//     CI and is read by a human rather than judged safe by a scanner;
//   - every other job's effective permissions contain no write at all;
//   - nothing anywhere mints a credential that writes regardless of
//     `permissions:` — a job with no write scope still writes if it holds an
//     App token minted with one, or a PAT.
//
// It takes SOURCE TEXT rather than a path so the fixture corpus can feed it
// deliberately-broken workflows.
//
// WHAT IT DOES NOT PROVE. Whether `poll`'s own steps are correct, and whether
// the gate is the RIGHT condition, are read here by a person. `write` consumes
// a file `poll` produced and never inspects it: the body's safety is `poll`'s
// sanitization, not anything this audit or that job checks.

const fs = require("node:fs");
const path = require("node:path");
const { WorkflowYamlError, parseWorkflow } = require("./workflow-yaml.cjs");

const WRITE_JOB_ID = "write";
const JOB_IDS = ["poll", "write"];

// The pinned write job lives in its own file so the pin is a plain diff rather
// than an escaped literal: a change to the write job and a change to its pin
// appear side by side in review, which is the whole point of pinning it.
const PINNED_WRITE_JOB = fs.readFileSync(
  path.join(__dirname, "claude-lane-incident-write-job.pinned.yml"),
  "utf8",
);
const WRITE_JOB_MARKER = "  # THE ONLY WRITE-SCOPED JOB.";

// Adding a trigger is how a write-scoped job starts running in a context an
// outsider influences, so the trigger set is pinned rather than filtered.
const PINNED_TRIGGERS = {
  schedule: [{ cron: "17 * * * *" }],
  workflow_dispatch: {
    inputs: {
      "dry-run": {
        description:
          "Poll and render the report without writing the incident issue, even when the credential is present.",
        type: "boolean",
        default: false,
      },
      repositories: {
        description:
          "Comma-separated owner/name list to poll instead of the credential's installation (smoke tests).",
        type: "string",
        default: "",
      },
    },
  },
};

// The dry-run gate and the dry-run report must stay exact negations, or a run
// could both write the issue and report that it wrote nothing.
const WRITE_GATE = "github.event.inputs.dry-run != 'true'";
const REPORT_GATE = "github.event.inputs.dry-run == 'true'";
const REPORT_STEP = "Publish the dry-run report";

const PINNED_USES =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/u;

// A job may carry none of these: each either runs code that is not in this file
// or rewrites how every `run:` in the job is invoked.
const FORBIDDEN_JOB_KEYS = [
  "container",
  "services",
  "defaults",
  "strategy",
  "environment",
];

const MINT_ACTION = "actions/create-github-app-token";

// The only secrets any step may name. A PAT, or an App key handed somewhere
// unexpected, reaches past `permissions:` entirely — so the set is closed.
const ALLOWED_SECRETS = new Set([
  "secrets.GITHUB_TOKEN",
  "secrets.CLAUDE_LANE_INCIDENT_APP_CLIENT_ID",
  "secrets.CLAUDE_LANE_INCIDENT_APP_PRIVATE_KEY",
]);
const SECRET_REFERENCE = /secrets\.[A-Za-z_][A-Za-z0-9_]*/gu;

/** Collect every scalar string reachable from a node. */
function scalarStrings(node, found = []) {
  if (typeof node === "string") found.push(node);
  else if (Array.isArray(node))
    for (const item of node) scalarStrings(item, found);
  else if (node !== null && typeof node === "object") {
    for (const value of Object.values(node)) scalarStrings(value, found);
  }
  return found;
}

/**
 * Whether a resolved `permissions:` value can mutate anything.
 *
 * `write-all` is a STRING, not a mapping, so a scan that only walked mapping
 * values would read it as granting nothing. Absent, the scopes come from
 * repository or organization defaults this file cannot see and which can be
 * write — unprovable means unsafe.
 */
function isWriteScoped(permissions) {
  if (permissions === undefined || permissions === null) return true;
  if (typeof permissions === "string") return permissions !== "read-all";
  if (typeof permissions !== "object" || Array.isArray(permissions))
    return true;
  return Object.values(permissions).includes("write");
}

/** A job with no `permissions:` of its own runs under the workflow's block. */
function effectivePermissions(job, workflow) {
  return job.permissions === undefined ? workflow.permissions : job.permissions;
}

function auditJobShape(jobId, job, violations) {
  const label = `job '${jobId}'`;
  if (job.uses !== undefined) {
    // A reusable workflow declares no `steps:`, so a step-walking audit passes
    // it vacuously while it runs whatever it likes.
    violations.push(
      `${label} calls a reusable workflow, whose steps are not in this file`,
    );
  }
  for (const key of FORBIDDEN_JOB_KEYS) {
    if (job[key] !== undefined) violations.push(`${label} declares '${key}:'`);
  }
  if (typeof job["runs-on"] !== "string" || job["runs-on"].includes("${{")) {
    violations.push(`${label} must name a literal runner`);
  }
  for (const [index, step] of (job.steps ?? []).entries()) {
    const stepLabel = `${label} step ${index + 1}`;
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      violations.push(`${stepLabel} is not a mapping`);
      continue;
    }
    if (step.shell !== undefined && step.shell !== "bash") {
      violations.push(`${stepLabel} declares shell '${step.shell}'`);
    }
    if (step.uses !== undefined && !PINNED_USES.test(String(step.uses))) {
      violations.push(
        `${stepLabel} must pin 'uses:' to owner/repo@<40-hex sha>; found '${step.uses}'`,
      );
    }
    const action =
      typeof step.uses === "string" && step.uses.includes("@")
        ? step.uses.slice(0, step.uses.indexOf("@"))
        : null;
    if (action === MINT_ACTION) {
      // A minted token is authority `permissions:` does not govern, so one
      // write permission here defeats a read-only job outright.
      for (const [input, value] of Object.entries(step.with ?? {})) {
        if (input.startsWith("permission-") && value !== "read") {
          violations.push(`${stepLabel} mints '${input}: ${value}'`);
        }
      }
    }
    for (const value of scalarStrings(step)) {
      for (const [secret] of value.matchAll(SECRET_REFERENCE)) {
        if (!ALLOWED_SECRETS.has(secret)) {
          violations.push(
            `${stepLabel} names '${secret}', which is not an allowed credential`,
          );
        }
      }
    }
  }
}

/**
 * Audit the aggregator's write gate.
 *
 * @param {string} source the workflow file's text.
 * @returns {string[]} one message per violation; empty means the shape holds.
 */
function auditWriteGate(source) {
  const violations = [];
  let workflow;
  try {
    workflow = parseWorkflow(source);
  } catch (error) {
    if (error instanceof WorkflowYamlError) {
      return [`unparsable workflow: ${error.message}`];
    }
    throw error;
  }
  if (workflow === null || typeof workflow !== "object") {
    return ["the workflow is not a mapping"];
  }

  if (JSON.stringify(workflow.on) !== JSON.stringify(PINNED_TRIGGERS)) {
    violations.push("the trigger block is not the pinned one");
  }

  const jobs = workflow.jobs ?? {};
  const jobIds = Object.keys(jobs);
  if (jobIds.join(",") !== JOB_IDS.join(",")) {
    violations.push(
      `the job set is '${jobIds.join(",")}', not '${JOB_IDS.join(",")}'`,
    );
  }

  const writeScoped = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    if (job === null || typeof job !== "object") {
      violations.push(`job '${jobId}' is not a mapping`);
      continue;
    }
    auditJobShape(jobId, job, violations);
    if (isWriteScoped(effectivePermissions(job, workflow))) {
      writeScoped.push(jobId);
    }
  }

  // A POSITIVE count. Every bypass this gate has admitted produced the same
  // shape: an audit that looked, found nothing to check, and passed.
  if (writeScoped.length !== 1 || writeScoped[0] !== WRITE_JOB_ID) {
    violations.push(
      `exactly one job must hold a write scope and it must be '${WRITE_JOB_ID}'; found [${writeScoped.join(", ")}]`,
    );
  }

  const at = source.indexOf(WRITE_JOB_MARKER);
  if (at < 0) {
    violations.push("the pinned write job is missing");
  } else if (source.slice(at) !== PINNED_WRITE_JOB) {
    violations.push(
      "the write job does not match claude-lane-incident-write-job.pinned.yml byte for byte",
    );
  }

  const writeJob = jobs[WRITE_JOB_ID];
  if (typeof writeJob?.if !== "string") {
    violations.push("the write job must carry a literal 'if:'");
  } else if (
    writeJob.if !== WRITE_GATE &&
    !writeJob.if.startsWith(`${WRITE_GATE} &&`)
  ) {
    violations.push(`the write job must open its 'if:' with ${WRITE_GATE}`);
  }

  const report = (jobs.poll?.steps ?? []).find(
    (step) => step?.name === REPORT_STEP,
  );
  if (!report) {
    violations.push(
      `'${REPORT_STEP}' is missing, so a dry run reports nothing`,
    );
  } else if (report.if !== REPORT_GATE) {
    violations.push(
      `'${REPORT_STEP}' must be gated on ${REPORT_GATE}, the exact negation of the write gate`,
    );
  }

  return violations;
}

module.exports = Object.freeze({
  JOB_IDS,
  REPORT_GATE,
  WRITE_GATE,
  WRITE_JOB_ID,
  auditWriteGate,
  effectivePermissions,
  isWriteScoped,
});
