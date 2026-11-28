"use strict";

// Offline stale-lockfile contract for `.github/workflows/actions.lock`.
// Verifies that every workflow under `.github/workflows/` is onboarded, every
// direct external action ref (including refs nested inside `parallel:` blocks
// and `$/.github/actions/*` composites) is locked with matching SHA, no stale
// workflow or orphaned dependency entry remains, no `uses: ./` local ref
// bypasses the lockfile, and actions/cache stays on v6.
//
// Maintenance: because every workflow is onboarded here, Dependabot
// regenerates matching lockfile entries in the same PR on version bumps
// without extra configuration; only newly added workflows need `gh actions-lock`
// (https://docs.github.com/en/actions/how-tos/administer/enforce-workflow-lockfiles#2-keep-lockfiles-current).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const REPO_ROOT = path.join(__dirname, "..", "..");
const ACTIONS_DIR = path.join(REPO_ROOT, ".github", "actions");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const LOCKFILE_PATH = path.join(WORKFLOWS_DIR, "actions.lock");

const SHA_REF = /^[0-9a-f]{40}$/u;

/** Normalize `owner/repo/subpath@ref` to `owner/repo@ref` as `gh actions-lock` keys it. */
function normalizeActionKey(uses) {
  const at = uses.lastIndexOf("@");
  assert.ok(at > 0, `external uses ref is missing '@ref': ${uses}`);
  const target = uses.slice(0, at);
  const ref = uses.slice(at + 1);
  const segments = target.split("/");
  assert.ok(
    segments.length >= 2,
    `external uses ref is not owner/repo[@ref]: ${uses}`,
  );
  return {
    key: `${segments[0]}/${segments[1]}@${ref}`,
    repo: `${segments[0]}/${segments[1]}`,
    ref,
  };
}

/** Flatten job or composite steps, recursing into native `parallel:` blocks. */
function flattenSteps(steps) {
  if (!Array.isArray(steps)) return [];
  const flat = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    if (Array.isArray(step.parallel)) {
      flat.push(...flattenSteps(step.parallel));
    } else {
      flat.push(step);
    }
  }
  return flat;
}

/** Collect every external action key referenced by a step list, descending into `$/` composites. */
function collectExternalActions(steps, visitedComposites = new Set()) {
  const refs = new Set();
  for (const step of flattenSteps(steps)) {
    if (typeof step.uses !== "string") continue;
    const uses = step.uses.trim();
    if (uses.startsWith("$/")) {
      const relative = uses.slice(2);
      if (visitedComposites.has(relative)) continue;
      visitedComposites.add(relative);
      const actionFile = path.join(REPO_ROOT, relative, "action.yml");
      assert.ok(
        fs.existsSync(actionFile),
        `self-repo action not found: ${uses}`,
      );
      const composite = parseWorkflow(fs.readFileSync(actionFile, "utf8"));
      for (const nested of collectExternalActions(
        composite?.runs?.steps,
        visitedComposites,
      )) {
        refs.add(nested);
      }
      continue;
    }
    assert.ok(
      !uses.startsWith("./"),
      `local action ref must use '$/...' instead of './...': ${uses}`,
    );
    if (uses.startsWith("docker://")) continue;
    refs.add(normalizeActionKey(uses).key);
  }
  return refs;
}

function listActionFiles(directory = ACTIONS_DIR) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listActionFiles(full));
    } else if (entry.isFile() && entry.name === "action.yml") {
      files.push(path.relative(REPO_ROOT, full));
    }
  }
  return files.sort();
}

function listWorkflowFiles() {
  return fs
    .readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
}

test("actions.lock exists, parses cleanly, and covers every workflow without stale entries", () => {
  assert.ok(
    fs.existsSync(LOCKFILE_PATH),
    ".github/workflows/actions.lock is missing",
  );
  const lockfile = parseWorkflow(fs.readFileSync(LOCKFILE_PATH, "utf8"));
  assert.equal(lockfile.version, "v0.0.3");
  assert.ok(
    lockfile.workflows && typeof lockfile.workflows === "object",
    "actions.lock must contain a workflows map",
  );
  assert.ok(
    lockfile.dependencies && typeof lockfile.dependencies === "object",
    "actions.lock must contain a dependencies map",
  );

  const diskWorkflows = listWorkflowFiles();
  const lockedWorkflows = Object.keys(lockfile.workflows).sort();
  assert.deepEqual(
    lockedWorkflows,
    diskWorkflows,
    "actions.lock workflow keys must match .github/workflows/*.yml exactly (run `gh actions-lock --no-narrow --no-interactive`)",
  );

  const reachableDeps = new Set();
  for (const workflowPath of diskWorkflows) {
    const workflow = parseWorkflow(
      fs.readFileSync(path.join(REPO_ROOT, workflowPath), "utf8"),
    );
    const expected = new Set();
    for (const job of Object.values(workflow.jobs ?? {})) {
      if (!job || typeof job !== "object") continue;
      // Reusable workflow calls (`jobs.<id>.uses`) are not locked by actions.lock.
      if (typeof job.uses === "string") continue;
      for (const dep of collectExternalActions(job.steps)) {
        expected.add(dep);
      }
    }

    const actualList = lockfile.workflows[workflowPath];
    assert.ok(
      Array.isArray(actualList),
      `actions.lock entry for ${workflowPath} must be an array`,
    );
    assert.deepEqual(
      [...actualList].sort(),
      [...expected].sort(),
      `actions.lock entries for ${workflowPath} are out of sync with workflow + $/ composite uses`,
    );

    for (const dep of actualList) {
      reachableDeps.add(dep);
    }
  }

  // Follow transitive `uses:` declarations inside locked dependencies.
  const queue = [...reachableDeps];
  while (queue.length > 0) {
    const depKey = queue.pop();
    const record = lockfile.dependencies[depKey];
    assert.ok(
      record && typeof record === "object",
      `actions.lock references ${depKey} without a dependencies entry`,
    );
    assert.match(
      String(record.commit ?? ""),
      /^sha1-[0-9a-f]{40}$/u,
      `actions.lock entry ${depKey} must record a sha1-<40-hex> commit`,
    );
    assert.ok(
      Number.isInteger(record.owner_id) && record.owner_id > 0,
      `actions.lock entry ${depKey} must record a positive integer owner_id`,
    );
    assert.ok(
      Number.isInteger(record.repo_id) && record.repo_id > 0,
      `actions.lock entry ${depKey} must record a positive integer repo_id`,
    );

    const { repo, ref } = normalizeActionKey(depKey);
    if (SHA_REF.test(ref)) {
      assert.equal(
        record.commit,
        `sha1-${ref}`,
        `actions.lock commit for ${depKey} must match its pinned SHA`,
      );
    }
    if (repo === "actions/cache") {
      assert.match(
        String(record.ref ?? ""),
        /^v6\./u,
        `actions/cache must stay on v6 (got ${record.ref})`,
      );
    }

    if (Array.isArray(record.uses)) {
      for (const transitive of record.uses) {
        if (!reachableDeps.has(transitive)) {
          reachableDeps.add(transitive);
          queue.push(transitive);
        }
      }
    }
  }

  const allDeps = Object.keys(lockfile.dependencies).sort();
  assert.deepEqual(
    allDeps,
    [...reachableDeps].sort(),
    "actions.lock contains orphaned dependencies not referenced by any workflow",
  );
});

test("every self-repo workflow and composite action reference uses $/ instead of ./", () => {
  const offenders = [];

  for (const workflowPath of listWorkflowFiles()) {
    const workflow = parseWorkflow(
      fs.readFileSync(path.join(REPO_ROOT, workflowPath), "utf8"),
    );
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      if (!job || typeof job !== "object") continue;
      if (typeof job.uses === "string" && job.uses.trim().startsWith("./")) {
        offenders.push(`${workflowPath} job ${jobId}: ${job.uses.trim()}`);
      }
      for (const step of flattenSteps(job.steps)) {
        if (
          typeof step.uses === "string" &&
          step.uses.trim().startsWith("./")
        ) {
          offenders.push(`${workflowPath} job ${jobId}: ${step.uses.trim()}`);
        }
      }
    }
  }

  for (const actionPath of listActionFiles()) {
    const composite = parseWorkflow(
      fs.readFileSync(path.join(REPO_ROOT, actionPath), "utf8"),
    );
    for (const step of flattenSteps(composite?.runs?.steps)) {
      if (typeof step.uses === "string" && step.uses.trim().startsWith("./")) {
        offenders.push(`${actionPath}: ${step.uses.trim()}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `self-repo refs must use '$/...' instead of './...':\n${offenders.join("\n")}`,
  );
});
