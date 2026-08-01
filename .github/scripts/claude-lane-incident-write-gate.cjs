"use strict";

// The write-gate audit for claude-lane-incident-aggregator.yml.
//
// The aggregator's job holds `issues: write`, so the guarantee that a dry run
// cannot write is no longer structural — the token is capable, and only the
// steps' conditions stop it. This audit is what replaces the lost guarantee.
//
// It is DEFAULT-DENY. Every step of every write-scoped job must either be a
// REGISTERED WRITER carrying the shared gate, or affirmatively match one of the
// read-only step shapes below. A step that matches nothing is a violation — the
// audit never clears a step merely because it failed to look dangerous, because
// "looks dangerous" is a property of the spellings someone thought of.
//
// It takes SOURCE TEXT rather than a path so the regression suite can feed it
// deliberately-mutated copies of the shipped workflow.

const { WorkflowYamlError, parseWorkflow } = require("./workflow-yaml.cjs");

/** The one condition every writing step shares, verbatim. */
const WRITE_GATE = "env.WRITES_ENABLED == 'true'";

/** Membership here is the only sanctioned way for a step to mutate anything. */
const WRITER_STEPS = Object.freeze([
  "Open or update the incident issue",
  "Close the recovered incident issue",
]);

// Actions a non-writing step may delegate to. `github-script` is admitted
// despite being fully write-capable, because what it does is legible inline and
// the identifier allowlist below reads it; the point of the set is that no step
// can smuggle capability into an opaque third-party action.
const READ_ONLY_ACTIONS = new Set([
  "actions/checkout",
  "actions/create-github-app-token",
  "actions/github-script",
]);

const PINNED_USES =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/u;

// Anything that could carry authority into a step: an Actions secret or token
// expression, or the environment names the runner and the gh CLI read one from.
const CREDENTIAL_REFERENCE =
  /secrets\.|github\.token|steps\.credential\.outputs\.token|\bGH_TOKEN\b|\bGITHUB_TOKEN\b|\bACTIONS_[A-Z_]*TOKEN\b/u;

// The exact credential expressions a non-writing step may carry. Each is a READ
// path: the App token is minted read-only, and the presence probes disclose only
// whether a secret is set.
const READ_CREDENTIAL_FORMS = new Set([
  `\${{ steps.credential.outputs.token || secrets.GITHUB_TOKEN }}`,
  `\${{ steps.credential.outputs.token != '' }}`,
  `\${{ secrets.CLAUDE_LANE_INCIDENT_APP_CLIENT_ID }}`,
  `\${{ secrets.CLAUDE_LANE_INCIDENT_APP_PRIVATE_KEY }}`,
  `\${{ secrets.CLAUDE_LANE_INCIDENT_APP_PRIVATE_KEY != '' }}`,
]);

const AMBIENT_TOKEN = `\${{ secrets.GITHUB_TOKEN }}`;

// Every Octokit surface a non-writing script may name, as an exact member path.
// Exactness is what kills aliasing: `const api = github.rest` names the path
// `rest`, which is not an endpoint and is therefore not on the list.
const READ_ONLY_SCRIPT_PATHS = new Set([
  // `paginate` only walks whatever endpoint it is handed, and handing it a
  // mutating one means naming that endpoint, which this list still catches.
  "github.paginate",
  "github.paginate.iterator",
  "github.rest.apps.listReposAccessibleToInstallation",
  "github.rest.checks.listAnnotations",
  "github.rest.checks.listForRef",
  "github.rest.issues.listForRepo",
  "github.rest.pulls.list",
  "core.info",
  "core.setFailed",
  "core.setOutput",
  "core.warning",
  "context.repo.owner",
  "context.repo.repo",
]);

// The lookbehind keeps a path segment or a string fragment from reading as a
// reference — `.github/scripts/…` names a directory, not the Octokit handle.
// Comments are deliberately NOT stripped: scanning them costs an occasional
// false positive, which is a reworded comment, while a comment lexer that
// mishandled one regex literal would cost a false negative.
const SCRIPT_ROOTS =
  /(?<![\w$./"'-])(github|octokit|core|context)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)/gu;

// Reflective escapes that would reach the injected `github` handle, or the
// runner's credential, without naming it.
const SCRIPT_ESCAPES =
  /\b(?:arguments|eval|globalThis|Function|constructor|__proto__|child_process|getInput)\b/u;

const ALLOWED_REQUIRE_ARGUMENTS = new Set([
  '"node:fs"',
  '"node:path"',
  'path.join(process.env.GITHUB_WORKSPACE, ".github/scripts/claude-lane-incident.cjs")',
]);

// Commands a non-writing `run:` step may invoke. A word in command position
// outside this set is a violation, so no spelling of a network call — however
// its flags are arranged — has to be anticipated.
const RUN_COMMANDS = new Set([
  ":",
  "[",
  "cat",
  "echo",
  "elif",
  "else",
  "fi",
  "if",
  "printf",
  "set",
  "test",
  "then",
  "true",
]);

const SHELL_SEPARATORS = new Set(["\n", ";", "|", "&", "(", ")", "{", "}"]);

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
 * Tokenize a shell body into command-position fragments, quote-aware, and
 * report whether it opens a command substitution.
 */
function scanShell(body) {
  const fragments = [];
  let current = "";
  let quote = null;
  let substitution = false;
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      index += 1;
      continue;
    }
    if (char === "\\") {
      current += "\\";
      index += 2;
      continue;
    }
    if (char === "`") {
      substitution = true;
      index += 1;
      continue;
    }
    if (char === "$" && body[index + 1] === "(") {
      if (body[index + 2] !== "(") {
        substitution = true;
        index += 2;
        continue;
      }
      // `$(( … ))` is arithmetic, not a command position. Skip the whole span so
      // its parentheses are not mistaken for command separators.
      let depth = 0;
      index += 1;
      do {
        if (body[index] === "(") depth += 1;
        else if (body[index] === ")") depth -= 1;
        index += 1;
      } while (index < body.length && depth > 0);
      current += "0";
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else current += char;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (SHELL_SEPARATORS.has(char)) {
      fragments.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  fragments.push(current);
  return { fragments, substitution, unterminated: quote !== null };
}

/** Every `require(…)` argument in a script, normalized to one line. */
function requireArguments(script) {
  const args = [];
  for (let index = script.indexOf("require("); index >= 0; ) {
    let depth = 1;
    let cursor = index + "require(".length;
    while (cursor < script.length && depth > 0) {
      if (script[cursor] === "(") depth += 1;
      else if (script[cursor] === ")") depth -= 1;
      cursor += 1;
    }
    args.push(
      script
        .slice(index + "require(".length, cursor - 1)
        .replaceAll(/\s+/gu, " ")
        .trim()
        .replace(/,$/u, ""),
    );
    index = script.indexOf("require(", cursor);
  }
  return args;
}

/** The command a fragment invokes, past any redirection or assignment prefix. */
function commandName(fragment) {
  let rest = fragment.trim();
  for (;;) {
    const redirection = /^(?:[0-9]*(?:>>|>|<)&?\s*\S+)\s*/u.exec(rest);
    if (redirection) {
      rest = rest.slice(redirection[0].length);
      continue;
    }
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/u.exec(rest);
    if (assignment) {
      rest = rest.slice(assignment[0].length);
      continue;
    }
    break;
  }
  return rest === "" ? null : rest.split(/\s+/u)[0];
}

function auditRunBody(body, label, violations) {
  if (typeof body !== "string") {
    violations.push(`${label} declares a non-literal 'run:'`);
    return;
  }
  const { fragments, substitution, unterminated } = scanShell(body);
  if (substitution) {
    violations.push(
      `${label} opens a command substitution, which is an unreviewable command position`,
    );
  }
  if (unterminated) violations.push(`${label} has an unterminated quote`);
  for (const fragment of fragments) {
    const command = commandName(fragment);
    if (command !== null && !RUN_COMMANDS.has(command)) {
      violations.push(
        `${label} runs '${command}', which is not a read-only command`,
      );
    }
  }
}

function auditScript(script, label, violations) {
  if (typeof script !== "string") {
    violations.push(
      `${label} delegates to github-script without a literal script`,
    );
    return;
  }
  const reflective = SCRIPT_ESCAPES.exec(script);
  if (reflective) {
    violations.push(
      `${label} names '${reflective[0]}', which can reach the API handle without naming it`,
    );
  }
  for (const [, root, tail] of script.matchAll(SCRIPT_ROOTS)) {
    const memberPath = `${root}${tail.replaceAll(/\s+/gu, "")}`;
    if (!READ_ONLY_SCRIPT_PATHS.has(memberPath)) {
      violations.push(
        `${label} reaches '${memberPath}', which is not a read-only Octokit surface`,
      );
    }
  }
  for (const argument of requireArguments(script)) {
    if (!ALLOWED_REQUIRE_ARGUMENTS.has(argument)) {
      violations.push(
        `${label} requires '${argument}', which is not allowlisted`,
      );
    }
  }
}

function auditCredentials(node, label, violations) {
  for (const value of scalarStrings(node)) {
    if (!CREDENTIAL_REFERENCE.test(value)) continue;
    if (READ_CREDENTIAL_FORMS.has(value.trim())) continue;
    const quoted = CREDENTIAL_REFERENCE.exec(value)[0];
    violations.push(
      `${label} carries a credential reference ('${quoted}') outside the read-only forms`,
    );
  }
}

function auditWriter(step, label, violations) {
  const condition = step.if;
  if (typeof condition !== "string" || !condition.startsWith(WRITE_GATE)) {
    violations.push(`${label} must open its 'if:' with ${WRITE_GATE}`);
  } else if (
    condition.length > WRITE_GATE.length &&
    !condition.slice(WRITE_GATE.length).startsWith(" &&")
  ) {
    // A gate reached through `||` is not a gate, and one appended after another
    // condition is easy to lose in a later edit.
    violations.push(
      `${label} must reach ${WRITE_GATE} as its leading conjunct`,
    );
  }
  const token = step.with?.token ?? step.with?.["github-token"];
  if (token !== AMBIENT_TOKEN) {
    violations.push(`${label} must author with ${AMBIENT_TOKEN}`);
  }
  if (
    scalarStrings(step).some((value) =>
      value.includes("steps.credential.outputs.token"),
    )
  ) {
    violations.push(
      `${label} must not depend on the App token — the write path has to work without one`,
    );
  }
  if (step.uses !== undefined && !PINNED_USES.test(String(step.uses))) {
    violations.push(`${label} must pin 'uses:' to owner/repo@<40-hex sha>`);
  }
}

function auditReadOnlyStep(step, label, violations) {
  const hasUses = step.uses !== undefined && step.uses !== null;
  const hasRun = step.run !== undefined && step.run !== null;
  if (!hasUses && !hasRun) {
    violations.push(`${label} declares neither 'uses:' nor 'run:'`);
    return;
  }
  auditCredentials(step, label, violations);
  if (hasRun) auditRunBody(step.run, label, violations);
  if (!hasUses) return;

  const uses = String(step.uses);
  if (!PINNED_USES.test(uses)) {
    violations.push(
      `${label} must pin 'uses:' to owner/repo@<40-hex sha>; found '${uses}'`,
    );
    return;
  }
  const action = uses
    .slice(0, uses.indexOf("@"))
    .split("/")
    .slice(0, 2)
    .join("/");
  if (!READ_ONLY_ACTIONS.has(action)) {
    violations.push(
      `${label} delegates to '${action}', which is not on the read-only allowlist`,
    );
    return;
  }
  const inputs = step.with ?? {};
  if (
    action === "actions/checkout" &&
    inputs["persist-credentials"] !== false
  ) {
    // Persisted credentials would leave a write-capable git remote behind for
    // every later step, outside anything this audit reads.
    violations.push(`${label} must check out with persist-credentials: false`);
  }
  if (action === "actions/github-script") {
    auditScript(inputs.script, label, violations);
  }
  if (action === "actions/create-github-app-token") {
    for (const [input, value] of Object.entries(inputs)) {
      if (input.startsWith("permission-") && value !== "read") {
        violations.push(
          `${label} requests '${input}: ${value}'; the App token authors nothing`,
        );
      }
    }
  }
}

/** Whether a resolved `permissions:` value can mutate anything. */
function isWriteScoped(permissions) {
  // Absent, the token's scopes come from repository or organization defaults,
  // which this file cannot see and which can be write. Unprovable means unsafe.
  if (permissions === undefined || permissions === null) return true;
  if (typeof permissions === "string") return permissions !== "read-all";
  return Object.values(permissions).includes("write");
}

function auditJob(jobId, job, workflow, violations) {
  const label = (suffix) => `job '${jobId}' ${suffix}`;
  for (const key of ["container", "services", "defaults"]) {
    if (job[key] !== undefined) {
      violations.push(
        label(`declares '${key}:', which this audit cannot reason about`),
      );
    }
  }
  if (workflow.defaults !== undefined) {
    violations.push(
      "the workflow declares 'defaults:', which rewrites every run step",
    );
  }
  if (job.uses !== undefined) {
    violations.push(
      label(
        "calls a reusable workflow, whose steps this audit cannot enumerate",
      ),
    );
  }
  auditCredentials(job.env ?? {}, label("env"), violations);
  const steps = job.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    violations.push(label("holds a write scope but declares no steps"));
    return;
  }
  const writerCounts = new Map(WRITER_STEPS.map((name) => [name, 0]));
  for (const [index, step] of steps.entries()) {
    const name = step === null ? undefined : step.name;
    const stepLabel = label(
      `step ${index + 1} (${JSON.stringify(name ?? null)})`,
    );
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      violations.push(`${stepLabel} is not a mapping`);
      continue;
    }
    if (typeof name !== "string" || name.includes("${{")) {
      // The registry is keyed by name, so a name the audit cannot read
      // literally is a name it cannot match against the registry.
      violations.push(`${stepLabel} must carry a literal 'name:'`);
      continue;
    }
    if (writerCounts.has(name)) {
      writerCounts.set(name, writerCounts.get(name) + 1);
      auditWriter(step, stepLabel, violations);
      continue;
    }
    auditReadOnlyStep(step, stepLabel, violations);
  }
  for (const [name, count] of writerCounts) {
    if (count !== 1) {
      violations.push(
        label(
          `declares the registered writer '${name}' ${count} times, not once`,
        ),
      );
    }
  }
}

/**
 * Audit a workflow's write gate.
 *
 * @param {string} source the workflow file's text.
 * @returns {string[]} one message per violation; empty means the partition holds.
 */
function auditWriteGate(source) {
  const violations = [];
  let workflow;
  try {
    workflow = parseWorkflow(source);
  } catch (error) {
    if (error instanceof WorkflowYamlError)
      return [`unparsable workflow: ${error.message}`];
    throw error;
  }
  if (workflow === null || typeof workflow !== "object") {
    return ["the workflow is not a mapping"];
  }
  const jobs = workflow.jobs ?? {};
  for (const [jobId, job] of Object.entries(jobs)) {
    if (job === null || typeof job !== "object") {
      violations.push(`job '${jobId}' is not a mapping`);
      continue;
    }
    const permissions =
      job.permissions === undefined ? workflow.permissions : job.permissions;
    if (!isWriteScoped(permissions)) continue;
    auditJob(jobId, job, workflow, violations);
  }
  return violations;
}

module.exports = Object.freeze({
  READ_ONLY_ACTIONS,
  WRITER_STEPS,
  WRITE_GATE,
  auditWriteGate,
});
