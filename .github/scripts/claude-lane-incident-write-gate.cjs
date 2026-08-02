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
//   - every grant of a write in the RAW TEXT lies inside a pinned region. The
//     rule above reads a projection of the file, so a projection that drops a
//     node hides a write from it; this one never learns what a job is, so no
//     parse can hide a grant from it. Two mechanisms, one property;
//   - every credential reference in the WHOLE FILE — the `secrets` and `vars`
//     contexts in any spelling, and `github.token` — lies inside one of two
//     pinned regions. A credential is authority `permissions:` does not
//     govern: any step able to mint an App token, or to bind a PAT into a job
//     `env:`, writes regardless of its job holding no write scope. Naming the
//     one mint ACTION is not enough — a different App-token action spends the
//     same private key — so the rule is over the SECRET, not the action.
//
// It takes SOURCE TEXT rather than a path so the fixture corpus can feed it
// deliberately-broken workflows.
//
// WHAT IT DOES NOT PROVE. Two bounds worth naming, both of which stay harmless
// only because `poll` holds no write scope — weaken that and they are holes:
//   - `uses:` is checked for SHAPE, not identity. `evil/pwn@<40 hex>` is a
//     valid pin. What a third-party action in `poll` receives is `poll`'s
//     credentials, and those are read-only by the job's own permissions;
//   - the credential scan matches the three context WORDS. An expression that
//     names none of them — `github[format('tok{0}','en')]` — reaches the
//     ambient token without being seen, and that token is likewise read-only
//     in `poll`.
// Whether `poll`'s own steps are correct, and whether
// the gate is the RIGHT condition, are read here by a person. And `poll` still
// decides what `write` acts on: the incident BODY, through the artifact, and
// the TARGET issue, through the `issue-number` output. Neither is checked here.
// `poll` cannot mutate anything with its own token; what it selects, `write`
// performs.

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

// The mint step is pinned for the same reason and by the same means: it is the
// only place either App secret is spent, and a token minted with a write
// permission defeats a read-only job outright.
const PINNED_MINT_STEP = fs.readFileSync(
  path.join(__dirname, "claude-lane-incident-mint-step.pinned.yml"),
  "utf8",
);
const MINT_MARKER = "      # THE ONLY CREDENTIAL-MINTING STEP,";
const MINT_END =
  "\n      - name: Poll consumer repositories for lane failure signals";

// Overlapping cycles would race on one issue body, and a rewritten group or a
// cancel-in-progress turns the serialization off, so it is pinned too.
const PINNED_CONCURRENCY = {
  group: "claude-lane-incident-aggregator",
  "cancel-in-progress": false,
};

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
  // `continue-on-error` on a job makes a FAILED job conclude success, so a
  // poll that hit its own fail-closed guard would still let `write` run.
  "continue-on-error",
];

// The bare WORD, not a dotted path. Expressions reach a context by property
// de-reference OR by the `[ ]` index operator, so `secrets['NAME']` names a
// secret without a dot; the docs do not state whether context names are
// case-sensitive, which is a reason to match case-insensitively rather than a
// reason to assume; and `toJSON(secrets)` names none of them individually while
// dumping all of them. Matching the word covers every spelling at once. A
// comment that merely says "secrets" trips this too — a red build and a
// reworded comment, which is the safe direction to be wrong in.
const SECRET_REFERENCE = /(?<![\w-])secrets(?![\w-])/giu;

// `github.token` is the ambient credential under another name — it reaches no
// `secrets` context at all, so the scan above never sees it. Matched in both
// spellings for the same reason as above.
const AMBIENT_TOKEN_REFERENCE =
  /(?<![\w-])github\s*(?:\.\s*token(?![\w-])|\[\s*['"]token['"]\s*\])/giu;

// `vars` is the third channel a token can arrive on. Variables are NOT secret,
// so a write-capable token in one is a misconfiguration rather than a designed
// seam — but this file's rule is over the CHANNEL, not over whether using it
// was wise, and a PAT bound into a job `env:` from `vars` reaches every `run:`
// in scope exactly as one from `secrets` does. Nothing here reads a variable,
// so the rule costs nothing and closes the gap between what the header claims
// and what it checked.
const VARIABLE_REFERENCE = /(?<![\w-])vars(?![\w-])/giu;

const CREDENTIAL_PATTERNS = [
  SECRET_REFERENCE,
  AMBIENT_TOKEN_REFERENCE,
  VARIABLE_REFERENCE,
];

// Every grant of a write in the WHOLE FILE, matched over raw text. This says
// the same thing the effective-permissions walk says, by a route that does not
// go through the parser — and that redundancy is the point. The permissions
// walk reads a PROJECTION of the file, so a projection that drops a node hides
// a write from it; a job keyed `__proto__` did exactly that, landing on the
// prototype instead of becoming a property, invisible to `Object.keys` while
// the runner enumerated it normally. The parser no longer binds keys that way,
// which is the primary fix. This is the second pair of eyes: it never learns
// what a job is, so no parse can hide a grant from it.
//
// It also subsumes the App-token rule. A minted `permission-<scope>: write` is
// authority `permissions:` does not govern, and it is a `<key>: write` like any
// other, so one pattern covers both.
//
// Deliberately loose: an optional quote either side, whitespace around the
// colon, and no line anchor, so `issues: 'write'`, `issues: write # comment`
// and the flow form `permissions: {issues: write}` all match. Prose in a
// comment matches too, which costs a reworded comment — the safe direction.
// NOT airtight: `write` is a plain scalar with other spellings, so this is
// defence in depth over a demonstrated break shape, never a proof.
const WRITE_PERMISSION = /(?<![\w-])[\w-]+\s*:\s*['"]?write['"]?(?![\w-])/giu;

// `write-all` grants every scope and is a STRING, so it is neither a mapping
// entry the walk enumerates nor a `<key>: write` the pattern above matches.
const WRITE_ALL = /(?<![\w-])write-all(?![\w-])/giu;

const WRITE_GRANT_PATTERNS = [WRITE_PERMISSION, WRITE_ALL];

// The only credential expressions permitted OUTSIDE the pinned regions, as
// exact whole expressions rather than as secret names. The allowlist is
// position-independent, so either may be reused in a new poll step; that is
// safe only because BOTH halves are provably read-only — the ambient token by
// `poll`'s all-read permissions, the App token by the byte-pinned mint step.
// Weakening either of those rules turns this allowlist into a bypass. The presence probe
// discloses whether a secret is set and never its value; the read fallback
// binds the ambient token into a job the audit has already proved holds no
// write scope. Any other spelling of either is a violation.
const PINNED_POLL_CREDENTIALS = new Set([
  `\${{ secrets.CLAUDE_LANE_INCIDENT_APP_PRIVATE_KEY != '' }}`,
  `\${{ steps.credential.outputs.token || secrets.GITHUB_TOKEN }}`,
]);

// The scope values that grant nothing. Everything else counts as a write.
const READ_ONLY_SCOPES = new Set(["read", "none"]);

/**
 * Whether a resolved `permissions:` value can mutate anything.
 *
 * ALLOWLIST, not a search for `"write"`. Asking `includes("write")` decides
 * safety by failing to recognize a value, so every spelling the scan does not
 * anticipate reads as safe — `issues: >` with `write` on the next line resolves
 * to `"write\n"`, which is not `"write"`, and the job reads as read-only. An
 * allowlist inverts that: a value this file cannot prove is read-only is a
 * write, so an unanticipated spelling costs a red build instead of a silent
 * pass. That also removes any need to decide whether the runner trims a scalar
 * before matching its enum — a question the docs do not answer.
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
  return Object.values(permissions).some(
    (scope) => typeof scope !== "string" || !READ_ONLY_SCOPES.has(scope),
  );
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
    if (step["continue-on-error"] !== undefined) {
      violations.push(`${stepLabel} declares 'continue-on-error:'`);
    }
  }
}

/**
 * Every `secrets.` reference in the file must sit inside a pinned region.
 *
 * Scanning steps alone is not enough: a workflow-level `env:`, a job-level
 * `env:`, and a job `outputs:` block each bind a secret without being a step,
 * and each reaches every `run:` in scope.
 */
function auditCredentialSurface(source, regions, violations) {
  const matches = CREDENTIAL_PATTERNS.flatMap((pattern) => [
    ...source.matchAll(pattern),
  ]);
  for (const match of matches) {
    const inside = regions.some(
      ([from, to]) => match.index >= from && match.index < to,
    );
    if (inside) continue;
    // Widen to the whole `${{ … }}` the reference sits in, so the check is on
    // the expression rather than on the secret's name.
    const opened = source.lastIndexOf("${{", match.index);
    const closed = source.indexOf("}}", match.index);
    const expression =
      opened < 0 || closed < 0 ? match[0] : source.slice(opened, closed + 2);
    if (PINNED_POLL_CREDENTIALS.has(expression)) continue;
    violations.push(
      `'${expression}' is a credential expression outside the pinned regions`,
    );
  }
}

/**
 * Every grant of a write must sit inside a byte-pinned region.
 *
 * Both regions are compared against a pin, so a grant inside one is a grant
 * somebody reviewed as a diff. A grant anywhere else is one this file's
 * structure does not account for, whatever the parse says about it.
 */
function auditWriteGrants(source, regions, violations) {
  const matches = WRITE_GRANT_PATTERNS.flatMap((pattern) => [
    ...source.matchAll(pattern),
  ]);
  for (const match of matches) {
    const inside = regions.some(
      ([from, to]) => match.index >= from && match.index < to,
    );
    if (inside) continue;
    violations.push(
      `'${match[0].trim()}' grants a write outside the pinned regions`,
    );
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
  if (
    JSON.stringify(workflow.concurrency) !== JSON.stringify(PINNED_CONCURRENCY)
  ) {
    violations.push("the concurrency block is not the pinned one");
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
    if (
      !Number.isInteger(job["timeout-minutes"]) ||
      job["timeout-minutes"] <= 0
    ) {
      violations.push(`job '${jobId}' must declare a positive timeout-minutes`);
    }
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

  // The SAME offset feeds both the exempt region and the byte comparison. That
  // coupling is what stops a forged marker planted earlier from widening the
  // exempt span: widening it also moves the slice that must equal the pin, so
  // the pin fails. Do not split these into two independent lookups.
  const regions = [];
  const at = source.indexOf(WRITE_JOB_MARKER);
  if (at < 0) {
    violations.push("the pinned write job is missing");
  } else {
    regions.push([at, source.length]);
    if (source.slice(at) !== PINNED_WRITE_JOB) {
      violations.push(
        "the write job does not match claude-lane-incident-write-job.pinned.yml byte for byte",
      );
    }
  }

  const mintAt = source.indexOf(MINT_MARKER);
  const mintEnd = mintAt < 0 ? -1 : source.indexOf(MINT_END, mintAt);
  if (mintAt < 0 || mintEnd < 0) {
    violations.push("the pinned mint step is missing");
  } else {
    regions.push([mintAt, mintEnd]);
    if (source.slice(mintAt, mintEnd) !== PINNED_MINT_STEP) {
      violations.push(
        "the mint step does not match claude-lane-incident-mint-step.pinned.yml byte for byte",
      );
    }
  }

  auditCredentialSurface(source, regions, violations);
  auditWriteGrants(source, regions, violations);

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
