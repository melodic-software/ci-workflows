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
//
// WHAT THIS DOES NOT PROVE. The step partition is structural: it reads a parsed
// document, so its enumeration of steps, `uses:` pins, conditions and job shape
// are facts about the file. The scan it applies to an INLINE SCRIPT is not. That
// scan is a lexical approximation over code with comments and string literals
// blanked — it has no scope resolution and no expression grammar, so a binding
// form it does not recognize is a false positive (a red build), and a construct
// it mislexes is a false negative (an admission). It is defence in depth with a
// ceiling, not a proof.
//
// That ceiling is load-bearing for exactly two steps. `actions/github-script`
// reads `github-token` as a REQUIRED input, so a script step cannot be given an
// unauthenticated client; with no App credential configured the poll and the
// issue lookup therefore hold the ambient token, which carries `issues: write`.
// Their capability cannot be removed, only their code read — so read it, at
// review time, rather than treating a green audit as a substitute.

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
// `INPUT_*` covers the environment spelling of an action's own inputs, which is
// how a github-script body reaches the token it was handed without naming a
// secret — note the hyphen `github-token` survives into `INPUT_GITHUB-TOKEN`.
const CREDENTIAL_REFERENCE =
  /secrets\.|github\.token|steps\.credential\.outputs\.token|\bGH_TOKEN\b|\bGITHUB_TOKEN\b|\bACTIONS_[A-Z_]*TOKEN\b|\bINPUT_[A-Z0-9_-]*TOKEN\b/u;

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

// Every surface a non-writing script may name off a permitted global, as an
// exact member path. Exactness is what kills aliasing: `const api = github.rest`
// names the path `github.rest`, which is not an endpoint and is not on the list.
// Every permitted global is pinned this way, not just the Octokit handle: any
// value reaches a Function constructor through its own prototype, so a global
// admitted with its members unexamined is a way to run anything at all.
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
  "Date",
  "Date.now",
  "Date.parse",
  "JSON.parse",
  "JSON.stringify",
  "Number",
  "Number.isSafeInteger",
  "Set",
  "String",
  "require",
]);

// Reflection reaches a Function constructor from ANY value, including a local
// this audit does not track, so these three member names are refused wherever
// they appear. The set is closed by the language rather than guessed at, and
// the computed-access rule below stops them being spelled dynamically.
const REFLECTIVE_MEMBER = /\.\s*(constructor|__proto__|prototype)\b/u;

// A subscript that is not a plain number is a property name this audit cannot
// read, which is the whole of `github[k]` and `x["constructor"]`.
const COMPUTED_ACCESS = /(?<=[\w$)\]])\s*\[([^[\]]*)\]/gu;
const NUMERIC_SUBSCRIPT = /^\s*[0-9]+\s*$/u;
const SUBSCRIPT_EXEMPT_KEYWORDS =
  /\b(?:const|let|var|of|in|return|new|await|yield|typeof|case|do|else)\s*$/u;

// `process.env.NAME` is a read of one named variable. Computed access —
// `process.env[expression]` — is the dynamic lookup that reaches a name this
// audit cannot see, so it is not admitted: it produces the bare path
// `process.env`, which is absent from the set above.
const PROCESS_ENVIRONMENT_READ = /^process\.env\.[A-Za-z_][A-Za-z0-9_]*$/u;

// The only free identifiers a non-writing script may name. Everything else —
// `fetch`, `exec`, `io`, `glob`, `__original_require__`, `Buffer`, and whatever
// a future runtime injects next — is denied by absence, which is the point: the
// set of ways to reach the network is not a list anyone can finish writing.
const PERMITTED_GLOBALS = new Set([
  "Date",
  "JSON",
  "Number",
  "Set",
  "String",
  "context",
  "core",
  "github",
  "process",
  "require",
]);

// Names bound by the script itself. A declaration this misses costs a false
// positive; the scan that feeds it runs on code with comments and string
// literals already blanked, so a declaration cannot be faked in either.
const DECLARATIONS = [
  /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gu,
  /\b(?:const|let|var)\s*[[{]([^\]}]*)[\]}]/gu,
  /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/gu,
  /\(([^()]*)\)\s*=>/gu,
  /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/gu,
  /\bfunction\s*[A-Za-z_$]?[\w$]*\s*\(([^()]*)\)/gu,
];

const JAVASCRIPT_KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "static",
  "switch",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);

// Every identifier that is not a member name (`.foo`).
const IDENTIFIER = /(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/gu;

// An object-literal key is written, not evaluated, so it is exempt — but a
// trailing colon alone does not make one: `cond ? fetch : null` also puts a
// colon after an identifier, and there the identifier IS evaluated. A key is
// the token that opens an entry, so it also has `{` or `,` before it.
const KEY_FOLLOWS = /^\s*:/u;
const KEY_PRECEDES = /[{,]\s*$/u;
const MEMBER_PATH =
  /(?<![\w$.])([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)/gu;

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

/**
 * Blank out everything in a script that cannot execute — comments, and the
 * literal chunks of strings and template literals — while keeping the code
 * inside a template's `${…}` substitutions, which can.
 *
 * Blanking rather than deleting keeps offsets, so a token cannot be created by
 * two fragments becoming adjacent. `//` and `/*` in code position are always
 * comments: an unescaped `//` cannot occur inside a regular expression literal
 * (it would close it), and `/ *` is not a valid expression.
 *
 * @returns {{code: string, unterminated: boolean}}
 */
function stripNonCode(script) {
  const code = [...script];
  const blank = (from, to) => {
    for (let index = from; index < to && index < code.length; index += 1) {
      if (code[index] !== "\n") code[index] = " ";
    }
  };
  // One entry per open template literal, holding the `{` nesting depth inside
  // its current `${…}`; 0 means the template's own literal text.
  const templates = [];
  let index = 0;
  while (index < script.length) {
    const char = script[index];
    const inTemplateText = templates.length > 0 && templates.at(-1) === 0;
    if (inTemplateText) {
      if (char === "\\") {
        blank(index, index + 2);
        index += 2;
      } else if (char === "`") {
        templates.pop();
        blank(index, index + 1);
        index += 1;
      } else if (char === "$" && script[index + 1] === "{") {
        templates[templates.length - 1] = 1;
        blank(index, index + 2);
        index += 2;
      } else {
        blank(index, index + 1);
        index += 1;
      }
      continue;
    }
    if (char === "/" && script[index + 1] === "/") {
      const end = script.indexOf("\n", index);
      blank(index, end < 0 ? script.length : end);
      index = end < 0 ? script.length : end;
      continue;
    }
    if (char === "/" && script[index + 1] === "*") {
      const end = script.indexOf("*/", index + 2);
      if (end < 0) return { code: code.join(""), unterminated: true };
      blank(index, end + 2);
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < script.length && script[cursor] !== char) {
        if (script[cursor] === "\\") cursor += 1;
        else if (script[cursor] === "\n") break;
        cursor += 1;
      }
      if (script[cursor] !== char) {
        return { code: code.join(""), unterminated: true };
      }
      blank(index, cursor + 1);
      index = cursor + 1;
      continue;
    }
    if (char === "`") {
      templates.push(0);
      blank(index, index + 1);
      index += 1;
      continue;
    }
    if (templates.length > 0 && (char === "{" || char === "}")) {
      templates[templates.length - 1] += char === "{" ? 1 : -1;
      if (templates.at(-1) === 0) blank(index, index + 1);
      index += 1;
      continue;
    }
    index += 1;
  }
  return { code: code.join(""), unterminated: templates.length > 0 };
}

/** Names the script binds itself, read from code with literals already blanked. */
function declaredNames(code) {
  const declared = new Set();
  for (const pattern of DECLARATIONS) {
    for (const [, captured] of code.matchAll(pattern)) {
      for (const part of captured.split(/[,:]/u)) {
        const name = part.replace(/\.\.\./u, "").trim();
        if (/^[A-Za-z_$][\w$]*$/u.test(name)) declared.add(name);
      }
    }
  }
  return declared;
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
  const { code, unterminated } = stripNonCode(script);
  if (unterminated) {
    violations.push(
      `${label} has an unterminated string, template, or comment`,
    );
    return;
  }
  // Every free identifier must be allowlisted, not merely fail to look
  // dangerous: `actions/github-script` defaults `github-token` to the ambient
  // token, so each of these steps holds write capability and this scan is the
  // only thing standing between that capability and a `fetch`.
  const declared = declaredNames(code);
  for (const match of code.matchAll(IDENTIFIER)) {
    const name = match[1];
    if (JAVASCRIPT_KEYWORDS.has(name) || declared.has(name)) continue;
    if (PERMITTED_GLOBALS.has(name)) continue;
    const after = code.slice(match.index + name.length);
    const before = code.slice(0, match.index);
    if (KEY_FOLLOWS.test(after) && KEY_PRECEDES.test(before)) continue;
    violations.push(
      `${label} names '${name}', which is neither declared in the script nor a permitted global`,
    );
  }
  for (const [, root, tail] of code.matchAll(MEMBER_PATH)) {
    if (!PERMITTED_GLOBALS.has(root)) continue;
    const memberPath = `${root}${tail.replaceAll(/\s+/gu, "")}`;
    if (READ_ONLY_SCRIPT_PATHS.has(memberPath)) continue;
    if (PROCESS_ENVIRONMENT_READ.test(memberPath)) continue;
    violations.push(
      `${label} reaches '${memberPath}', which is not a read-only surface`,
    );
  }
  const reflective = REFLECTIVE_MEMBER.exec(code);
  if (reflective) {
    violations.push(
      `${label} reads '${reflective[1]}', which reaches a Function constructor`,
    );
  }
  for (const match of code.matchAll(COMPUTED_ACCESS)) {
    const before = code.slice(0, match.index + 1);
    if (SUBSCRIPT_EXEMPT_KEYWORDS.test(before)) continue;
    if (NUMERIC_SUBSCRIPT.test(match[1])) continue;
    violations.push(
      `${label} subscripts with '${match[1].trim()}', a property name this scan cannot read`,
    );
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
