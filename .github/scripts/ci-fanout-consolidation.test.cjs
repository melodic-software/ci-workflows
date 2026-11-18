"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { evaluate } = require("./actions-expression.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");

const repositoryRoot = path.join(__dirname, "..", "..");
const ciWorkflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "pr-require-checks.yml",
);
const ciStatusActionPath = path.join(
  repositoryRoot,
  ".github",
  "actions",
  "pr-require-checks/aggregate-results",
  "action.yml",
);

const ciWorkflow = fs.readFileSync(ciWorkflowPath, "utf8");
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

// The contract-only predicate, repeated verbatim in `concurrency.group` and in
// every job's `if:`. True only for a SAME-REPOSITORY pull request on a label
// flip, or on an `edited` event that did not change the base branch — a base
// change moves the merge commit the lanes test, and a fork cannot record lane
// state, so both run the full workflow.
const CONTRACT_ONLY_PREDICATE =
  "github.event.pull_request.head.repo.full_name == github.repository && " +
  '(contains(fromJSON(\'["labeled","unlabeled"]\'), github.event.action) || ' +
  "(github.event.action == 'edited' && !github.event.changes.base))";
const CONTRACT_ONLY_GATE = `!(${CONTRACT_ONLY_PREDICATE})`;

test("pr-require-checks.yml branches the concurrency group on the contract-only predicate", () => {
  // Eviction of a PENDING run is unconditional in GitHub's
  // queueing and is not governed by `cancel-in-progress`, so a shared group let
  // one contract-only event evict another and leave the current head with a
  // check suite carrying no `ci-status` check run at all, a required check that
  // silently stops reporting. The contract-only branch therefore
  // carries `github.run_id` and is unique per run.
  const groupBlock =
    /^concurrency:\n {2}group: >-\n(?<value>(?: {4}.*\n)+) {2}cancel-in-progress: true\n/mu.exec(
      ciWorkflow,
    );
  assert.ok(
    groupBlock !== null,
    "pr-require-checks.yml has no branched concurrency group with a literal cancel-in-progress: true",
  );
  const group = normalizeExpression(groupBlock.groups.value);
  const branched =
    /^\((?<predicate>.+)\) && format\('ci-contract-\{0\}-\{1\}', github\.event\.pull_request\.number, github\.run_id\) \|\| format\('\{0\}-\{1\}', github\.workflow, github\.event\.pull_request\.number \|\| github\.run_id\)$/u.exec(
      group,
    );
  assert.ok(
    branched !== null,
    `concurrency group is not the branched shape: ${group}`,
  );
  // The same drift hazard as the job gates: a group keyed on a predicate the
  // lanes do not gate on would put a full run in the contract-only branch's
  // unique group and stop supersession, or a contract-only run in the shared
  // group and re-open the eviction.
  assert.equal(
    normalizeExpression(branched.groups.predicate),
    normalizeExpression(CONTRACT_ONLY_PREDICATE),
  );
  // This repository's fallback term is `github.run_id`: no push-side burst
  // collapse, so no `github.event_name == 'pull_request'` guard.
  assert.doesNotMatch(groupBlock[0], /github\.event_name/u);
  assert.doesNotMatch(groupBlock[0], /github\.ref/u);
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

test("pr-require-checks.yml re-runs on the contract-only pull_request actions", () => {
  assert.match(
    ciWorkflow,
    /^ {4}types: \[opened, synchronize, reopened, ready_for_review, edited, labeled, unlabeled\]$/mu,
  );
});

// Job keys are the two-space-indented mapping keys under `jobs:`; the `if:`
// that follows a job key before the next one is that job's condition.
const jobBlocks = ciWorkflow
  .slice(ciWorkflow.search(/^jobs:$/mu))
  .split(/^ {2}(?=[a-z0-9-]+:$)/mu)
  .slice(1);
const jobName = (block) => /^([a-z0-9-]+):$/mu.exec(block)?.[1];
const jobCondition = (block) => /^ {4}if: (.*)$/mu.exec(block)?.[1] ?? "";
const jobBlock = (name) => {
  const block = jobBlocks.find((candidate) => jobName(candidate) === name);
  assert.ok(block !== undefined, `no job named ${name}`);
  return block;
};
const ciStatusNeeds =
  /^ {2}ci-status:\n(?:.*\n)*? {4}needs: \[(?<list>[^\]]*)\]$/mu
    .exec(ciWorkflow)
    ?.groups?.list?.split(/,\s*/u);

// The issue labeler is the only job an `issues` event may start. Any other job
// that ran there would have no pull request to check, and `ci-status` would
// publish a verdict for an issue.
const ISSUE_JOB = "intake-label-needs-triage";

test("only the issue labeler runs on an issues event", () => {
  assert.match(ciWorkflow, /^ {2}issues:\n {4}types: \[opened, reopened\]$/mu);
  const unguarded = [];
  for (const block of jobBlocks) {
    const name = jobName(block);
    if (name === ISSUE_JOB) {
      assert.equal(
        jobCondition(block),
        `\${{ github.event_name == 'issues' }}`,
      );
    } else if (
      !jobCondition(block).startsWith("${{ github.event_name != 'issues' && ")
    ) {
      unguarded.push(name);
    }
  }
  assert.deepEqual(unguarded, []);
});

// A merge queue tests the group commit through `merge_group` alone; a required
// check that never reports there holds every queued pull request until the
// check timeout. The payload carries no `pull_request`, so each gate must
// evaluate true for every lane ci-status aggregates, or the group is green
// on lanes that never ran.
const mergeGroupContext = {
  github: {
    event_name: "merge_group",
    repository: "melodic-software/ci-workflows",
    workflow: "pr-require-checks",
    run_id: "42",
    event: {
      action: "checks_requested",
      merge_group: {
        head_ref:
          "refs/heads/gh-readonly-queue/main/pr-7-0123456789abcdef0123456789abcdef01234567",
        head_sha: "1".repeat(40),
        base_sha: "2".repeat(40),
      },
    },
  },
};

test("pr-require-checks.yml runs on merge_group checks_requested only", () => {
  assert.match(
    ciWorkflow,
    /^ {2}merge_group:\n {4}types: \[checks_requested\]$/mu,
  );
});

test("on merge_group every aggregated lane and ci-status run in full", () => {
  const needs = ciStatusNeeds ?? [];
  assert.ok(needs.length > 0, "ci-status has no needs list");
  // detect-changes falls open off a pull request: every group is relevant.
  const relevant = JSON.stringify(
    Object.fromEntries(
      [...ciWorkflow.matchAll(/\['(?<group>[a-z-]+)'\] != 'false'/gu)].map(
        (match) => [match.groups.group, "true"],
      ),
    ),
  );
  const contexts = {
    ...mergeGroupContext,
    needs: { "detect-changes": { outputs: { results: relevant } } },
  };
  const gated = [];
  for (const name of [...needs, "ci-status"]) {
    if (evaluate(jobCondition(jobBlock(name)), contexts) !== true) {
      gated.push(name);
    }
  }
  assert.deepEqual(gated, []);
});

test("on merge_group the advisory lanes stay off and no run shares a group", () => {
  for (const name of ["pr-review", "pr-review-security", ISSUE_JOB]) {
    assert.equal(
      evaluate(jobCondition(jobBlock(name)), mergeGroupContext),
      false,
    );
  }
  const group = /^concurrency:\n {2}group: >-\n(?<value>(?: {4}.*\n)+)/mu.exec(
    ciWorkflow,
  ).groups.value;
  assert.equal(evaluate(group, mergeGroupContext), "pr-require-checks-42");
});

test("the advisory lanes and issue labeler stay out of ci-status", () => {
  // Claude lane checks are advisory: a model outage must never block a merge.
  assert.ok(ciStatusNeeds !== undefined, "ci-status has no needs list");
  for (const job of ["pr-review", "pr-review-security", ISSUE_JOB]) {
    assert.match(ciWorkflow, new RegExp(`^ {2}${job}:$`, "mu"));
    assert.ok(!ciStatusNeeds.includes(job), `ci-status waits on ${job}`);
    assert.doesNotMatch(ciWorkflow, new RegExp(`needs\\.${job}\\.result`, "u"));
  }
});

test("every job except ci-status and the issue labeler carries the contract-only gate", () => {
  const ungated = [];
  for (const block of jobBlocks) {
    const name = jobName(block);
    if (name === undefined || name === "ci-status" || name === ISSUE_JOB) {
      continue;
    }
    if (!jobCondition(block).includes(CONTRACT_ONLY_GATE)) {
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

  let compared = 0;
  for (const block of jobBlocks) {
    const name = jobName(block);
    if (name === undefined || name === "ci-status" || name === ISSUE_JOB) {
      continue;
    }
    const body = /^ {4}if: \$\{\{ (?<body>.*) \}\}$/mu.exec(block)?.groups
      ?.body;
    assert.ok(body !== undefined, `job ${name} has no inline if:`);
    // The gate leads once the event-name guards are dropped; anything after it
    // is the job's own condition, ANDed on.
    const condition = body.replace(
      /^(?:github\.event_name [!=]= '[a-z_]+' && )+/u,
      "",
    );
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

const ciStatusCompositePath = path.join(
  repositoryRoot,
  ".github",
  "actions",
  "pr-require-checks/report-ci-status",
  "action.yml",
);
const ciStatusComposite = fs.readFileSync(ciStatusCompositePath, "utf8");
const compositeSteps = ciStatusComposite
  .slice(ciStatusComposite.search(/^ {2}steps:$/mu))
  .split(/^ {4}- /mu)
  .slice(1);
const compositeStep = (uses) => {
  const step = compositeSteps.find((candidate) =>
    candidate.includes(`uses: $/.github/actions/pr-require-checks/${uses}\n`),
  );
  assert.ok(
    step !== undefined,
    `the report-ci-status composite has no ${uses} step`,
  );
  return step;
};
const foldedValue = (block, key) => {
  const match = new RegExp(
    `^ +${key}: >-\\n(?<value>(?: {10}.*\\n)+)`,
    "mu",
  ).exec(block);
  assert.ok(match !== null, `no folded ${key}`);
  return match.groups.value;
};

test("the ci-status job runs the report-ci-status composite from this commit", () => {
  const ciStatusJob = ciWorkflow.slice(ciWorkflow.search(/^ {2}ci-status:$/mu));
  assert.match(ciStatusJob, /^ {6}statuses: write$/mu);
  assert.match(ciStatusJob, /^ {6}pull-requests: write$/mu);
  // `yield-to-full-run` lists this workflow's runs on the head SHA and
  // `rerun-contract-only-siblings` re-runs the red contract-only ones; write
  // covers the read, and without the scope the Actions calls 403.
  assert.match(ciStatusJob, /^ {6}actions: write$/mu);
  // `$/`, not a SHA pin: this repository's pull requests test the composite
  // at the commit under test.
  assert.match(
    ciStatusJob,
    /^ {8}uses: \$\/\.github\/actions\/pr-require-checks\/report-ci-status$/mu,
  );
  assert.doesNotMatch(
    ciStatusJob,
    /pr-require-checks\/(?:check-contract|aggregate-results)/u,
  );
  // Change-gated lanes skip on a full run, so a skip passes here; the
  // composite's default is `fail`.
  assert.match(ciStatusJob, /^ {10}treat-skipped-as: pass$/mu);
  // The step-name lookup matches the full run's writer step by name, so the
  // step keeps the name its full runs wrote under.
  const reportStep =
    /^ {6}- name: (?<name>.+)\n {8}id: (?<id>[a-z-]+)\n {8}uses: \$\/\.github\/actions\/pr-require-checks\/report-ci-status$/mu.exec(
      ciStatusJob,
    )?.groups;
  assert.equal(reportStep?.name, "Aggregate lane results");
  assert.match(
    ciStatusJob,
    new RegExp(`^ {10}step-name: ${reportStep.name}$`, "mu"),
  );
  // The composite's step concludes on the lanes alone, so the job fails on
  // the contract and draft outputs in a step after it, which must run even
  // when an earlier step failed.
  const afterReport = ciStatusJob.slice(
    ciStatusJob.indexOf("pr-require-checks/report-ci-status\n"),
  );
  assert.match(
    afterReport,
    new RegExp(
      String.raw`^ {8}if: \$\{\{ !cancelled\(\) && \(steps\.${reportStep.id}\.outputs\.contract == 'failure' \|\| steps\.${reportStep.id}\.outputs\.draft == 'failure'\) \}\}\n {8}run: \|\n(?: {10}.*\n)*? {10}exit 1$`,
      "mu",
    ),
  );

  // A contract-only run holds for an in-flight full run under a ceiling, and
  // the full run re-runs any red contract-only sibling on success. The budget
  // holds the hold plus the job's other waits (two 60 s rate-limit waits and
  // the 120 s own-job lookup), so the timeout cannot preempt the ceiling's red.
  const timeoutMinutes = Number(
    /^ {4}timeout-minutes: (?<minutes>\d+)$/mu.exec(ciStatusJob)?.groups
      ?.minutes,
  );
  assert.ok(
    Number.isInteger(timeoutMinutes),
    "ci-status has no timeout-minutes",
  );
  const holdSeconds = Number(
    /^ {10}yield-wait-seconds: '(?<seconds>[1-9]\d*)'$/mu.exec(ciStatusJob)
      ?.groups?.seconds,
  );
  assert.ok(
    Number.isInteger(holdSeconds),
    "ci-status has no yield-wait-seconds",
  );
  assert.ok(
    holdSeconds + 240 <= timeoutMinutes * 60,
    `yield-wait-seconds ${holdSeconds} leaves too little of timeout-minutes ${timeoutMinutes}`,
  );
});

test("the report-ci-status composite runs the contract, then the draft policy, then the aggregation", () => {
  const contract = ciStatusComposite.indexOf(
    "uses: $/.github/actions/pr-require-checks/check-contract\n",
  );
  const draft = ciStatusComposite.indexOf(
    'run: bash "$GITHUB_ACTION_PATH/draft.sh"',
  );
  const aggregate = ciStatusComposite.indexOf(
    "uses: $/.github/actions/pr-require-checks/aggregate-results\n",
  );
  assert.ok(contract !== -1 && draft !== -1 && aggregate !== -1);
  assert.ok(contract < draft && draft < aggregate);

  // The contract and draft steps run on every run and never fail the
  // composite: aggregate-results trusts a carried success only when the
  // writer step, this whole composite, concluded `success`. Their outcomes
  // are the outputs the caller fails on.
  const contractStep = compositeStep("check-contract");
  const draftStep = compositeSteps.find((step) => step.includes("draft.sh"));
  assert.ok(draftStep !== undefined);
  for (const [step, id] of [
    [contractStep, "contract"],
    [draftStep, "draft"],
  ]) {
    assert.doesNotMatch(step, /^ {6}if:/mu);
    assert.match(step, /^ {6}continue-on-error: true$/mu);
    assert.match(step, new RegExp(`^ {6}id: ${id}$`, "mu"));
    assert.match(
      ciStatusComposite,
      new RegExp(
        String.raw`^ {2}${id}:\n(?: {4}.*\n)*? {4}value: \$\{\{ steps\.${id}\.outcome \}\}$`,
        "mu",
      ),
    );
  }
  // `!cancelled()` so a failed contract or draft step does not skip the
  // `ci-lanes` status write the next contract-only run reads back.
  const aggregateStep = compositeStep("aggregate-results");
  assert.match(aggregateStep, /^ {6}if: \$\{\{ !cancelled\(\) \}\}$/mu);
  // Every caller set these; a wait of `0` is what the hold replaces.
  assert.match(aggregateStep, /^ {8}yield-to-full-run: 'true'$/mu);
  assert.match(aggregateStep, /^ {8}carry-forward-wait-seconds: '0'$/mu);
  assert.match(
    ciStatusComposite,
    /^ {2}rerun-contract-only-siblings:\n(?: {4}.*\n)*? {4}default: 'true'$/mu,
  );
  assert.match(
    ciStatusComposite,
    /^ {2}treat-skipped-as:\n(?: {4}.*\n)*? {4}default: fail$/mu,
  );
  assert.match(
    ciStatusComposite,
    /^ {2}draft:\n(?: {4}.*\n)*? {4}default: allow$/mu,
  );
});

test("the report-ci-status composite's contract-only copies match the aggregation default", () => {
  // The draft step's live read and the hold drop both key on the predicate the
  // lanes gate on; a drifted copy would read the live draft state on a full
  // run, or hold a contract-only run that cannot pass.
  const draftStep = compositeSteps.find((step) => step.includes("draft.sh"));
  assert.ok(draftStep !== undefined);
  assert.equal(
    normalizeExpression(foldedValue(draftStep, "CONTRACT_ONLY")),
    normalizeExpression(CONTRACT_ONLY_PREDICATE),
  );
  const hold = normalizeExpression(
    foldedValue(compositeStep("aggregate-results"), "yield-wait-seconds"),
  );
  assert.ok(
    hold.includes(`(${normalizeExpression(CONTRACT_ONLY_PREDICATE)})`),
    `the hold drop does not use the contract-only predicate: ${hold}`,
  );
});

test("the report-ci-status composite drops the hold only on a failed contract-only run", () => {
  const hold = foldedValue(
    compositeStep("aggregate-results"),
    "yield-wait-seconds",
  );
  const event = (action) => ({
    action,
    pull_request: { head: { repo: { full_name: "o/r" } } },
  });
  const holdFor = ({ action, jobStatus = "success", contract, draft }) =>
    evaluate(hold, {
      github: { repository: "o/r", event: event(action) },
      job: { status: jobStatus },
      steps: {
        contract: { outcome: contract },
        draft: { outcome: draft },
      },
      inputs: { "yield-wait-seconds": "420" },
    });
  // A failed contract on a label flip cannot pass: no hold.
  assert.equal(
    holdFor({ action: "labeled", contract: "failure", draft: "skipped" }),
    "0",
  );
  // A refused draft on a label flip cannot pass either.
  assert.equal(
    holdFor({ action: "unlabeled", contract: "success", draft: "failure" }),
    "0",
  );
  // A caller's own earlier step failed the job.
  assert.equal(
    holdFor({
      action: "edited",
      jobStatus: "failure",
      contract: "success",
      draft: "success",
    }),
    "0",
  );
  // A passing contract-only run holds for the full run.
  assert.equal(
    holdFor({ action: "labeled", contract: "success", draft: "success" }),
    "420",
  );
  // A full run keeps its value constant: that value is what skips
  // `rerun-wait-seconds`.
  assert.equal(
    holdFor({ action: "synchronize", contract: "failure", draft: "skipped" }),
    "420",
  );
});

test("pr-require-checks.yml consolidates the hygiene composites into the checks reusable", () => {
  // This repository dogfoods the `checks` reusable every consumer adopts.
  assert.match(ciWorkflow, /^ {2}pr-run-checks:$/mu);
  assert.match(
    ciWorkflow,
    /^ {4}uses: \$\/\.github\/workflows\/pr-run-checks\.yml$/mu,
  );

  // change-detection reads the PR file listing, and a called workflow cannot
  // elevate: without the caller's own grant the job fails at startup.
  const checksJob = ciWorkflow.slice(
    ciWorkflow.search(/^ {2}pr-run-checks:$/mu),
    ciWorkflow.search(/^ {2}psscriptanalyzer:$/mu),
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

  assert.match(ciWorkflow, /^ {4}needs: \[[^\n]*\bpr-run-checks\b[^\n]*\]$/mu);
  assert.match(
    ciWorkflow,
    /^ {10}results: [^\n]*\$\{\{ needs\.pr-run-checks\.result \}\}[^\n]*$/mu,
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
    /^ {8}run: bash \.github\/actions\/check-comment-markers\/superset-test\.sh$/mu,
  );
});

// Tracked files only: a package installed under .github (node_modules) ships
// workflows of its own that this repository never runs.
function yamlFilesUnder(directory) {
  return execFileSync("git", ["-C", directory, "ls-files", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => /\.ya?ml$/u.test(file))
    .map((file) => path.join(directory, file))
    .sort();
}

const movingLabels = /\b(?:ubuntu|windows)-latest\b/u;

test("the label check reads tracked files, not packages installed under .github", () => {
  const root = makeTemporaryDirectory("ci-fanout-labels-");
  for (const file of [
    ".github/workflows/tracked.yml",
    ".github/actions/pkg/node_modules/dep/.github/workflows/ci.yml",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "runs-on: ubuntu-latest\n");
  }
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "add", ".github/workflows/tracked.yml"]);
  const githubRoot = path.join(root, ".github");
  const offenders = yamlFilesUnder(githubRoot)
    .filter((file) => movingLabels.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(githubRoot, file));
  assert.deepEqual(offenders, [path.join("workflows", "tracked.yml")]);
});

test("hosted workflow contracts use explicit GA operating-system labels", () => {
  const githubRoot = path.join(repositoryRoot, ".github");
  const files = yamlFilesUnder(githubRoot);
  assert.ok(files.length > 0, "the .github tree must not be empty");
  for (const file of files) {
    assert.doesNotMatch(
      fs.readFileSync(file, "utf8"),
      movingLabels,
      `${path.relative(githubRoot, file)} uses a moving hosted image label`,
    );
  }
});

test("reusable workflows never recommend broad secret inheritance", () => {
  const workflowsRoot = path.join(repositoryRoot, ".github", "workflows");
  const files = yamlFilesUnder(workflowsRoot);
  assert.ok(files.length > 0, "the workflows directory must not be empty");
  for (const file of files) {
    assert.doesNotMatch(
      fs.readFileSync(file, "utf8"),
      /\bsecrets:\s*inherit\b/u,
      `${path.relative(workflowsRoot, file)} recommends broad secret inheritance`,
    );
  }
});

test("root CI runs this repository's own test suite in a gating lane", () => {
  // The lane is still called `selector-contract` although the selector is
  // retired: renaming it would change a check context for no behavior gain.
  //
  // Newline-anchored at the job-level two-space indent: the change-detection
  // filter config declares a deeper-indented group with the same name, which a
  // bare substring search would match first.
  const laneStart = ciWorkflow.indexOf("\n  test-contracts:");
  const laneEnd = ciWorkflow.indexOf("\n  pr-audit-workflows:");
  assert.ok(
    laneStart !== -1 && laneEnd > laneStart,
    "pr-require-checks.yml must declare the test-execution lane before the zizmor lane",
  );
  const lane = ciWorkflow.slice(laneStart, laneEnd);
  assert.match(lane, /node --test \.github\/scripts\/\*\.test\.cjs/u);
  assert.match(lane, /bash \.github\/scripts\/osv-scan-guard\.test\.sh/u);
  // The required check must aggregate the lane, or a red suite reports green.
  assert.match(ciWorkflow, /needs: \[[^\]]*test-contracts[^\]]*\]/u);
  // And a script-only change must actually start it.
  assert.match(
    ciWorkflow,
    /^ {12}selector-contract:\n {14}\.github\/\*\*$/mu,
    "the lane's path filter must admit a .github/scripts change",
  );
  // shfmt covers the same tree, so a shell source there cannot skip formatting.
  assert.match(ciWorkflow, /paths: fixtures\/shell\/good \.github\/scripts/u);
});
