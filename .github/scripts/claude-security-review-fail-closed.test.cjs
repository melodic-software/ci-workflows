"use strict";

// The security lane's required check certifies EXECUTION, so "in scope and could
// not run" must conclude failure — `neutral` and `skipped` both satisfy a
// required check and cannot express it (#266). These tests run the outcome step's
// real script rather than grepping for `exit 1`, because the thing worth pinning
// is the exit code a replayed 429 payload actually produces.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const workflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "claude-security-review.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");

function stepSource(stepName) {
  const start = workflow.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(start, -1, `step not found: ${stepName}`);
  const rest = workflow.slice(start + 1);
  const next = rest.indexOf("\n      - name: ");
  return next === -1 ? rest : rest.slice(0, next);
}

// The `run:` body is plain shell with no ${{ }} interpolation, which is what
// makes executing it here faithful rather than an approximation.
function runScript(stepName) {
  const step = stepSource(stepName);
  const marker = "        run: |\n";
  const start = step.indexOf(marker);
  assert.notEqual(start, -1, `${stepName} has no literal run block`);
  const body = step.slice(start + marker.length);
  assert.doesNotMatch(
    body,
    /\$\{\{/u,
    `${stepName}'s run block interpolates a github expression, so executing it here would not match CI`,
  );
  return body
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

// Run 30217744377's payload: the shape a rate-limited call leaves behind — the
// SDK's success variant with is_error true and no turns taken. This is the run
// #266 was filed from, and it concluded green.
function rateLimitedExecutionFile() {
  return JSON.stringify([
    {
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      duration_ms: 480,
      total_cost_usd: 0,
      result: "model-authored free text that must never be published",
      api_error_status: 429,
    },
  ]);
}

function reportOutcome({ outcome, executionFileContents }) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "security-review-outcome-"),
  );
  try {
    const githubOutput = path.join(directory, "github-output");
    fs.writeFileSync(githubOutput, "");
    const environment = {
      ...process.env,
      REVIEW_OUTCOME: outcome,
      GITHUB_OUTPUT: githubOutput,
    };
    if (executionFileContents !== undefined) {
      const executionFile = path.join(directory, "execution.json");
      fs.writeFileSync(executionFile, executionFileContents);
      environment.EXECUTION_FILE = executionFile;
    }
    const result = spawnSync(
      "bash",
      ["-c", runScript("Report review outcome")],
      {
        encoding: "utf8",
        env: environment,
      },
    );
    const outputs = Object.fromEntries(
      fs
        .readFileSync(githubOutput, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return { ...result, outputs };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("a replayed rate-limited review fails the job and still reports its class", () => {
  const result = reportOutcome({
    outcome: "failure",
    executionFileContents: rateLimitedExecutionFile(),
  });

  assert.equal(
    result.status,
    1,
    `the outcome step must exit nonzero so the required check concludes failure\n${result.stdout}\n${result.stderr}`,
  );
  assert.equal(result.outputs.review_failed, "true");
  // Written before the exit, so the PR still gets its infra-status comment.
  assert.equal(result.outputs.failure_class, "rate-limit");
  assert.match(result.stdout, /::error::Claude security review exited with:/u);
});

// The free-text SDK fields stay off this public repo's logs even on the path that
// now fails the job.
test("failing closed does not start publishing the model-authored result", () => {
  const result = reportOutcome({
    outcome: "failure",
    executionFileContents: rateLimitedExecutionFile(),
  });
  assert.doesNotMatch(result.stdout, /must never be published/u);
  for (const value of Object.values(result.outputs)) {
    assert.doesNotMatch(value, /must never be published/u);
  }
});

test("a completed review still passes", () => {
  const result = reportOutcome({ outcome: "success" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.outputs.review_failed, "false");
});

// A missing execution file must not become a second failure mode: the class
// degrades to `other` and the job still fails closed on the same signal.
test("an unreadable execution file still fails closed", () => {
  const result = reportOutcome({ outcome: "failure" });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.outputs.review_failed, "true");
  assert.equal(result.outputs.failure_class, "other");
});

// Everything below pins the three no-verdict paths that must NOT reach the
// failing step. Each is the reason the mapping keys on review_failed rather than
// on "no verdict was produced".
test("fork PRs skip the job instead of failing closed forever", () => {
  const jobCondition = workflow.slice(
    workflow.indexOf("  security-review:"),
    workflow.indexOf("      - name: Reject privileged triggers"),
  );

  // A fork run gets no secrets, so no number of retries can make it pass.
  assert.match(
    jobCondition,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u,
    "the job must skip fork PRs; without this the fail-closed mapping pins every fork PR red",
  );
  // Without this disjunct the empty head.repo on a non-PR event reads as a fork
  // and would skip every workflow_dispatch / schedule invocation.
  assert.match(
    jobCondition,
    /github\.event\.pull_request\.number == ''/u,
    "the fork guard must not skip non-pull_request events",
  );
  assert.match(
    jobCondition,
    /needs\.changes\.outputs\.relevant != 'false'/u,
    "out-of-scope PRs must still skip at job level",
  );
  assert.match(
    jobCondition,
    /contains\(format\(',\{0\},', inputs\.skip-actors\)/u,
    "the skip-actors exception is operator-ratified (ADR 0002) and must stay job-level",
  );
});

test("a superseded head reports nothing, so it cannot fail closed", () => {
  const step = stepSource("Report review outcome");
  assert.match(
    step,
    /^ {8}if: always\(\) && steps\.freshness\.outputs\.superseded != 'true'$/mu,
    "a retired run must skip the outcome step, leaving review_failed unset",
  );
});

// Actions cannot loop a `uses:` step, so the retry is a verbatim copy of the
// first attempt. Divergence between the two would mean the retry reviews under
// different rules than the attempt it replaces — asserted, not trusted.
test("the review retry is configured identically to the first attempt", () => {
  // A step's source runs up to the next `- name:`, which drags in that step's
  // leading comment block — trailing blanks and comments are trimmed so the
  // comparison is over inputs only.
  const withBlock = (stepName) => {
    const step = stepSource(stepName);
    const start = step.indexOf("        with:\n");
    assert.notEqual(start, -1, `${stepName} has no with: block`);
    const lines = step.slice(start).split("\n");
    while (
      lines.length > 0 &&
      /^\s*(#.*)?$/u.test(lines[lines.length - 1] ?? "")
    ) {
      lines.pop();
    }
    return lines.join("\n");
  };

  assert.equal(
    withBlock("Claude security review (retry)"),
    withBlock("Claude security review"),
    "the retry's inputs have drifted from the first attempt's",
  );

  const retry = stepSource("Claude security review (retry)");
  assert.match(
    retry,
    /^ {8}continue-on-error: true$/mu,
    "the retry must not fail the job itself; the outcome step owns the red",
  );
  assert.match(
    retry,
    /steps\.claude-review\.outcome == 'failure'/u,
    "the retry must run only after a failed first attempt",
  );
  assert.match(
    retry,
    /steps\.freshness\.outputs\.superseded != 'true'/u,
    "a superseded run must not spend a retry",
  );

  // Same pin, or the retry is a different action than the one that was reviewed.
  const pin = /uses: (anthropics\/claude-code-action@[0-9a-f]{40})/u;
  assert.equal(
    retry.match(pin)?.[1],
    stepSource("Claude security review").match(pin)?.[1],
    "the retry must pin the same action SHA as the first attempt",
  );

  assert.match(
    stepSource("Back off before the review retry"),
    /^ {8}run: sleep \d+$/mu,
    "the retry must back off rather than immediately re-hammering a rate-limited API",
  );
});

test("the outcome step reads the resolved attempt, not just the first one", () => {
  const step = stepSource("Report review outcome");
  assert.match(
    step,
    /^ {10}REVIEW_OUTCOME: \$\{\{ steps\.attempt\.outputs\.outcome \}\}$/mu,
    "reading steps.claude-review directly would ignore a successful retry",
  );
  assert.match(
    step,
    /^ {10}EXECUTION_FILE: \$\{\{ steps\.attempt\.outputs\.execution_file \}\}$/mu,
    "the classified payload must come from the attempt that actually ran last",
  );
});
