"use strict";

// Fails a change to a reusable workflow's `on.workflow_call` surface that the
// runner-policy contract has not caught up with. A caller may only pass
// what the contract lists, and GitHub refuses a call that passes an input or
// secret the reusable no longer declares, or omits one it requires. So the
// surface changes expand/contract (Fowler, ParallelChange): the contract grows
// before the reusable requires anything new, and shrinks before the reusable
// drops anything. standards components/runner-policy/README.md, "Contract
// revision lockstep", states the order.
//
// Usage: node check-workflow-call-surface.cjs <base-ref> [repository]
// Run from the repository root; the head is the working tree's HEAD commit.
// The contract is the synced copy in the working tree, or, when it is absent,
// standards' own components/runner-policy/policy.json at the commit the
// checkout-standards action resolves for STANDARDS_REF (default main).

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { basename, join } = require("node:path");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const POLICY_PATH = ".github/standards/runner-policy-contract/policy.json";
const STANDARDS_POLICY_PATH = "components/runner-policy/policy.json";
const CHECKOUT_STANDARDS = join(
  __dirname,
  "..",
  "actions",
  "checkout-standards",
  "checkout.sh",
);
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/u;
const ORDER_SOURCE =
  'standards components/runner-policy/README.md, "Contract revision lockstep"';

class SurfaceCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = "SurfaceCheckError";
  }
}

/**
 * The contract's text and a label for it: the synced copy when the working
 * tree has one, else standards' own, failing with a named error.
 */
function readPolicy() {
  if (fs.existsSync(POLICY_PATH)) {
    return { text: fs.readFileSync(POLICY_PATH, "utf8"), source: POLICY_PATH };
  }
  let checkout;
  try {
    checkout = execFileSync("bash", [CHECKOUT_STANDARDS], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  } catch (error) {
    throw new SurfaceCheckError(
      `runner-policy contract missing: ${POLICY_PATH} does not exist and melodic-software/standards could not be checked out: ${error.message}`,
    );
  }
  const file = join(checkout, STANDARDS_POLICY_PATH);
  if (!fs.existsSync(file)) {
    throw new SurfaceCheckError(
      `runner-policy contract missing: ${POLICY_PATH} does not exist and melodic-software/standards at ${basename(checkout)} has no ${STANDARDS_POLICY_PATH}.`,
    );
  }
  return {
    text: fs.readFileSync(file, "utf8"),
    source: `melodic-software/standards ${STANDARDS_POLICY_PATH} at ${basename(checkout)}`,
  };
}

/** Parse the contract, failing with a named error the author can act on. */
function loadContracts({ text, source }) {
  let policy;
  try {
    policy = JSON.parse(text);
  } catch (error) {
    throw new SurfaceCheckError(
      `runner-policy contract unparsable: ${source}: ${error.message}.`,
    );
  }
  const contracts = policy?.approvedReusableWorkflowContracts;
  if (
    contracts === null ||
    typeof contracts !== "object" ||
    Array.isArray(contracts)
  ) {
    throw new SurfaceCheckError(
      `runner-policy contract unparsable: ${source} has no approvedReusableWorkflowContracts object.`,
    );
  }
  return contracts;
}

/**
 * The reusable's caller surface, or null when the document declares no
 * `workflow_call` trigger.
 */
function workflowCallSurface(document) {
  const on = document?.on;
  const listed =
    on === "workflow_call" ||
    (Array.isArray(on) && on.includes("workflow_call"));
  const mapped =
    !listed && on !== null && typeof on === "object" && "workflow_call" in on;
  if (!listed && !mapped) return null;
  const call = mapped ? on.workflow_call : null;
  const entries = (block) =>
    new Map(
      Object.entries(block && typeof block === "object" ? block : {}).map(
        ([name, spec]) => [name, { required: spec?.required === true }],
      ),
    );
  return { inputs: entries(call?.inputs), secrets: entries(call?.secrets) };
}

/**
 * Compare one reusable's surface before and after the change against its
 * contract entry. Returns one message per violation.
 */
function compareSurface({ key, base, head, contract }) {
  const empty = { inputs: new Map(), secrets: new Map() };
  const before = base ?? empty;
  const after = head ?? empty;
  const allowedInputs = new Set(contract.allowedInputs ?? []);
  const inputListed = (name) => allowedInputs.has(name);
  const { allowedSecrets } = contract;
  const maps = Array.isArray(allowedSecrets)
    ? allowedSecrets
    : [allowedSecrets ?? {}];
  const listedBy = {
    input: { any: inputListed, every: inputListed },
    secret: {
      any: (name) => maps.some((map) => Object.hasOwn(map ?? {}, name)),
      every: (name) => maps.every((map) => Object.hasOwn(map ?? {}, name)),
    },
  };
  const findings = [];
  for (const [kind, field] of [
    ["input", "inputs"],
    ["secret", "secrets"],
  ]) {
    for (const name of before[field].keys()) {
      if (after[field].has(name) || !listedBy[kind].any(name)) continue;
      findings.push(
        `${key}: ${kind} '${name}' was removed or renamed, but the synced runner-policy contract still lists it, so callers may still pass it and GitHub would refuse their call. Contract first: remove '${name}' from every caller, then from this path's contract in standards components/runner-policy/policy.json, let the component sync land, then remove it from the reusable (${ORDER_SOURCE}).`,
      );
    }
    for (const [name, spec] of after[field]) {
      if (!spec.required || before[field].get(name)?.required) continue;
      if (listedBy[kind].every(name)) continue;
      findings.push(
        `${key}: required ${kind} '${name}' was added, but the synced runner-policy contract does not list it${kind === "secret" ? " in every secret map" : ""}, so no caller may pass it and every call would fail. Expand first: add '${name}' to this path's contract in standards components/runner-policy/policy.json, let the component sync land and callers pass it, then make it required here; or add it as optional (${ORDER_SOURCE}).`,
      );
    }
  }
  return findings;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readAt(revision, path) {
  try {
    return git(["show", `${revision}:${path}`]);
  } catch {
    return null;
  }
}

function surfaceOf(source, label) {
  if (source === null) return null;
  try {
    return workflowCallSurface(parseWorkflow(source));
  } catch (error) {
    throw new SurfaceCheckError(
      `${label} could not be parsed: ${error.message}`,
    );
  }
}

function run({ baseRef, repository }) {
  const policy = readPolicy();
  const contracts = loadContracts(policy);
  const mergeBase = git(["merge-base", baseRef, "HEAD"]).trim();
  const changed = git([
    "diff",
    "--name-only",
    "--no-renames",
    mergeBase,
    "HEAD",
    "--",
    ".github/workflows/",
  ])
    .split("\n")
    .filter((path) => WORKFLOW_PATH.test(path));
  const findings = [];
  const notices = [];
  for (const path of changed) {
    const base = surfaceOf(readAt(mergeBase, path), `${path} at the base`);
    const head = surfaceOf(readAt("HEAD", path), `${path} at the head`);
    if (base === null && head === null) continue;
    const key = `${repository}/${path}`;
    const contract = contracts[key];
    if (!contract) {
      notices.push(
        `${key}: no runner-policy contract entry, so no governed caller depends on its surface.`,
      );
      continue;
    }
    findings.push(...compareSurface({ key, base, head, contract }));
  }
  return { changed, findings, notices, source: policy.source };
}

function main(argv) {
  const [baseRef, repository = process.env.GITHUB_REPOSITORY] = argv;
  if (!baseRef || !repository) {
    console.error(
      "usage: check-workflow-call-surface.cjs <base-ref> [repository]",
    );
    return 2;
  }
  let result;
  try {
    result = run({ baseRef, repository });
  } catch (error) {
    if (!(error instanceof SurfaceCheckError)) throw error;
    console.log(`::error::${error.message}`);
    return 1;
  }
  for (const notice of result.notices) console.log(`::notice::${notice}`);
  for (const finding of result.findings) console.log(`::error::${finding}`);
  console.log(
    `Checked ${result.changed.length} changed workflow file(s) against ${result.source}: ${result.findings.length} violation(s).`,
  );
  return result.findings.length === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = Object.freeze({
  POLICY_PATH,
  main,
});
