"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const ciWorkflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "ci.yml",
);
const selectorConformancePath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "selector-conformance.yml",
);
const adrPath = path.join(
  repositoryRoot,
  "docs",
  "topics",
  "ci-fanout-consolidation",
  "ADR.md",
);

const ciStatusActionPath = path.join(
  repositoryRoot,
  ".github",
  "actions",
  "ci-status",
  "action.yml",
);

const ciWorkflow = fs.readFileSync(ciWorkflowPath, "utf8");
const selectorConformance = fs.readFileSync(selectorConformancePath, "utf8");
const adr = fs.readFileSync(adrPath, "utf8");
const ciStatusAction = fs.readFileSync(ciStatusActionPath, "utf8");

// Strip the `${{ }}` wrapper, an outer `!( )`, and every run of whitespace, so
// a folded YAML block scalar and a single workflow line compare equal.
function normalizeExpression(text) {
  let expression = text.trim();
  const wrapper = /^\$\{\{(?<inner>[\s\S]*)\}\}$/u.exec(expression);
  if (wrapper !== null) {
    expression = wrapper.groups.inner.trim();
  }
  const negation = /^!\((?<inner>[\s\S]*)\)$/u.exec(expression);
  if (negation !== null) {
    expression = negation.groups.inner.trim();
  }
  return expression.replace(/\s+/gu, " ");
}

// The contract-only predicate, repeated verbatim in `cancel-in-progress` and in
// every job's `if:`. True only for a SAME-REPOSITORY pull request on a label
// flip, or on an `edited` event that did not change the base branch — a base
// change moves the merge commit the lanes test, and a fork cannot record lane
// state, so both run the full workflow (Phase 3.1 of the ci-perf program).
const CONTRACT_ONLY_PREDICATE =
  "github.event.pull_request.head.repo.full_name == github.repository && " +
  '(contains(fromJSON(\'["labeled","unlabeled"]\'), github.event.action) || ' +
  "(github.event.action == 'edited' && !github.event.changes.base))";
const CONTRACT_ONLY_GATE = `!(${CONTRACT_ONLY_PREDICATE})`;

test("ci.yml uses main-push burst collapse concurrency (#122)", () => {
  // The `github.event_name == 'pull_request'` guard is ANDed with, not replaced
  // by, the negated predicate: on a push there is no `github.event.pull_request`
  // so the predicate is false and `!(predicate)` alone would be true, re-arming
  // the burst collapse #122 disarmed.
  assert.match(
    ciWorkflow,
    /^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' && (?<gate>.+) \}\}$/mu,
  );
  const cancelGate =
    /^ {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' && (?<gate>.+) \}\}$/mu.exec(
      ciWorkflow,
    )?.groups?.gate;
  assert.equal(cancelGate, CONTRACT_ONLY_GATE);
  assert.doesNotMatch(ciWorkflow, /pull_request\.number \|\| github\.run_id/u);
});

test("the contract-only predicate excludes forks and base changes", () => {
  // Both exclusions are load-bearing and both are easy to drop by accident, so
  // pin each clause rather than only the assembled string.
  assert.ok(
    CONTRACT_ONLY_PREDICATE.startsWith(
      "github.event.pull_request.head.repo.full_name == github.repository &&",
    ),
  );
  assert.ok(
    CONTRACT_ONLY_PREDICATE.includes(
      "github.event.action == 'edited' && !github.event.changes.base",
    ),
  );
  // `edited` is never contract-only on its own — only when the base is unchanged.
  assert.doesNotMatch(
    ciWorkflow,
    /contains\(fromJSON\('\["edited","labeled","unlabeled"\]'\)/u,
  );
});

test("ci.yml re-runs on the contract-only pull_request actions", () => {
  assert.match(
    ciWorkflow,
    /^ {4}types: \[opened, synchronize, reopened, edited, labeled, unlabeled\]$/mu,
  );
});

test("every job except ci-status carries the contract-only gate", () => {
  // Job keys are the two-space-indented mapping keys under `jobs:`; the `if:`
  // that follows a job key before the next one is that job's condition.
  const jobsSection = ciWorkflow.slice(ciWorkflow.search(/^jobs:$/mu));
  const jobBlocks = jobsSection.split(/^ {2}(?=[a-z0-9-]+:$)/mu).slice(1);
  const ungated = [];
  for (const block of jobBlocks) {
    const name = /^([a-z0-9-]+):$/mu.exec(block)?.[1];
    if (name === undefined || name === "ci-status") {
      continue;
    }
    const condition = /^ {4}if: (.*)$/mu.exec(block)?.[1] ?? "";
    if (!condition.includes(CONTRACT_ONLY_GATE)) {
      ungated.push(name);
    }
  }
  assert.deepEqual(ungated, []);
  // The gate must never reach ci-status itself: that job IS the carry-forward.
  const ciStatusBlock = jobBlocks.find((block) => /^ci-status:$/mu.test(block));
  assert.ok(ciStatusBlock !== undefined);
  assert.ok(!ciStatusBlock.includes(CONTRACT_ONLY_GATE));
});

test("the ci-status contract-only default matches every job gate", () => {
  // A drifted copy is silently catastrophic rather than noisy: if the workflow
  // gates lanes off on an event where the composite's `contract-only` resolves
  // false, ci-status aggregates all-`skipped` results, passes them under
  // `treat-skipped-as: pass`, and records `ci-lanes=success` for a run in which
  // nothing executed. Nothing else in CI would notice.
  const defaultBlock =
    /^ {2}contract-only:[\s\S]*?^ {4}default: >-\n(?<value>(?: {6}.*\n)+)/mu.exec(
      ciStatusAction,
    );
  assert.ok(
    defaultBlock !== null,
    "ci-status action.yml has no folded contract-only default",
  );
  const actionDefault = normalizeExpression(defaultBlock.groups.value);
  assert.equal(actionDefault, normalizeExpression(CONTRACT_ONLY_PREDICATE));

  const jobsSection = ciWorkflow.slice(ciWorkflow.search(/^jobs:$/mu));
  const jobBlocks = jobsSection.split(/^ {2}(?=[a-z0-9-]+:$)/mu).slice(1);
  let compared = 0;
  for (const block of jobBlocks) {
    const name = /^([a-z0-9-]+):$/mu.exec(block)?.[1];
    if (name === undefined || name === "ci-status") {
      continue;
    }
    const condition = /^ {4}if: \$\{\{ (?<body>.*) \}\}$/mu.exec(block)?.groups
      ?.body;
    assert.ok(condition !== undefined, `job ${name} has no inline if:`);
    // The gate is the leading term; anything after it is the job's own
    // condition, ANDed on.
    const gate = condition.startsWith(CONTRACT_ONLY_GATE)
      ? CONTRACT_ONLY_GATE
      : condition;
    assert.equal(
      normalizeExpression(gate),
      actionDefault,
      `job ${name} gates on an expression the composite default does not match`,
    );
    compared += 1;
  }
  assert.ok(compared > 0);
});

test("the ci-status job runs pr-contract before the aggregation", () => {
  const ciStatusJob = ciWorkflow.slice(ciWorkflow.search(/^ {2}ci-status:$/mu));
  assert.match(ciStatusJob, /^ {6}statuses: write$/mu);
  assert.match(ciStatusJob, /^ {6}pull-requests: write$/mu);
  const contractStep = ciStatusJob.indexOf("./.github/actions/pr-contract");
  const aggregateStep = ciStatusJob.indexOf("./.github/actions/ci-status");
  assert.ok(contractStep !== -1 && aggregateStep !== -1);
  assert.ok(contractStep < aggregateStep);
  // `!cancelled()` so a failing contract step does not skip the status write.
  assert.match(
    ciStatusJob.slice(contractStep),
    /^ {8}if: \$\{\{ !cancelled\(\) \}\}$/mu,
  );
});

test("selector-conformance.yml matches the same concurrency pattern", () => {
  assert.match(
    selectorConformance,
    /^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/mu,
  );
});

test("ci.yml consolidates the hygiene composites into the checks reusable", () => {
  // The hygiene fan-out first collapsed into a local `hygiene` job (#122); it
  // now lives in the `checks` reusable every consumer adopts (ci-perf Phase
  // 6a), so this repository dogfoods the same contract it publishes.
  assert.match(ciWorkflow, /^ {2}checks:$/mu);
  assert.match(
    ciWorkflow,
    /^ {4}uses: \.\/\.github\/workflows\/checks\.yml$/mu,
  );

  // change-detection reads the PR file listing, and a called workflow cannot
  // elevate: without the caller's own grant the job fails at startup.
  const checksJob = ciWorkflow.slice(
    ciWorkflow.search(/^ {2}checks:$/mu),
    ciWorkflow.search(/^ {2}composites-head:$/mu),
  );
  assert.match(checksJob, /^ {6}contents: read$/mu);
  assert.match(checksJob, /^ {6}pull-requests: read$/mu);
  assert.match(checksJob, /^ {6}runner: ubuntu-24\.04$/mu);

  for (const job of [
    "hygiene",
    "editorconfig",
    "exec-bit",
    "machine-specific-paths",
    "eol-renormalize",
    "comment-hygiene",
    "typos",
    "gitleaks",
    "markdown",
    "links",
  ]) {
    assert.doesNotMatch(ciWorkflow, new RegExp(`^ {2}${job}:$`, "mu"));
  }

  assert.match(ciWorkflow, /^ {4}needs: \[[^\n]*\bchecks\b[^\n]*\]$/mu);
  assert.match(
    ciWorkflow,
    /^ {10}results: [^\n]*\$\{\{ needs\.checks\.result \}\}[^\n]*$/mu,
  );
  for (const lane of [
    "hygiene",
    "editorconfig",
    "exec-bit",
    "comment-hygiene",
    "typos",
    "gitleaks",
    "markdown",
    "links",
  ]) {
    assert.doesNotMatch(
      ciWorkflow,
      new RegExp(`needs\\.${lane}\\.result`, "u"),
    );
  }

  // The comment-hygiene prefilter superset test is the scan's load-bearing
  // invariant and cannot ride inside the reusable (a shared reusable cannot run
  // a repo-local script), so it must still run somewhere in this workflow.
  assert.match(
    ciWorkflow,
    /^ {8}run: bash \.github\/actions\/comment-hygiene\/superset-test\.sh$/mu,
  );
});

test("ci.yml runs the moved composites at HEAD alongside the reusable", () => {
  // checks.yml can only reach its composites at a pinned SHA (a relative path
  // inside a called workflow resolves against the caller's checkout), so the
  // reusable runs the bodies of the release it was pinned at. This job runs the
  // same bodies from the commit under test; without it a pull request that
  // breaks one of them passes this repository's own CI.
  const start = ciWorkflow.search(/^ {2}composites-head:$/mu);
  assert.notEqual(start, -1, "ci.yml has no composites-head job");
  const composites = ciWorkflow.slice(
    start,
    ciWorkflow.search(/^ {2}powershell:$/mu),
  );
  assert.match(composites, /^ {4}name: Composites at HEAD$/mu);
  assert.match(composites, /^ {4}needs: changes$/mu);

  // Every composite the reusable moved off HEAD, and only those: actionlint,
  // shellcheck and check-jsonschema already run at HEAD in their own jobs.
  for (const composite of [
    "typos",
    "gitleaks",
    "editorconfig",
    "markdown",
    "exec-bit",
    "machine-specific-paths",
    "eol-renormalize",
    "comment-hygiene",
    "lychee-offline",
  ]) {
    assert.match(
      composites,
      new RegExp(`^ {8}uses: \\./\\.github/actions/${composite}$`, "mu"),
      `composites-head does not run ${composite} at HEAD`,
    );
  }
  // A pinned reference here would reintroduce the lag the job exists to close.
  assert.doesNotMatch(composites, /uses: melodic-software\/ci-workflows\//u);

  // The lane is only real if the required check aggregates it.
  assert.match(
    ciWorkflow,
    /^ {4}needs: \[[^\n]*\bcomposites-head\b[^\n]*\]$/mu,
  );
  assert.match(
    ciWorkflow,
    /^ {10}results: [^\n]*\$\{\{ needs\.composites-head\.result \}\}[^\n]*$/mu,
  );
});

test("ADR records #122 COMPLETED with Shape A done", () => {
  assert.match(adr, /Status: \*\*COMPLETED\*\*/u);
  assert.match(
    adr,
    /\| Shape A \(dotfiles single selector\) \| Done \(confirmed on `dotfiles` `main`\) \|/u,
  );
  assert.match(adr, /Main-push burst collapse wins/u);
  assert.match(adr, /Hygiene lane consolidation/u);
});
