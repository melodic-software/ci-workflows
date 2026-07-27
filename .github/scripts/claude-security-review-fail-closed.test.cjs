"use strict";

// The security lane's required check certifies EXECUTION, so "in scope and could
// not run" must conclude failure — `neutral` and `skipped` both satisfy a
// required check and cannot express it (#266). The classification itself lives
// in the claude-lane-outcome composite (its corpus runs in
// .github/actions/claude-lane-outcome/classify.test.cjs); what this workflow
// owns — and what these tests pin — is the wiring around it: the retry gate
// that decides whether a second attempt is safe (zero assistant turns) and
// useful (not auth-class), the resolve step that picks the effective attempt,
// the outcome composite reading that attempt, and the fail-closed step that
// raises the red on the one signal that means "in scope and did not run".

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

// The resolve step decides what the outcome composite sees, so a bug here
// reddens every CLEAN review — the widest blast radius in this workflow.
function resolveAttempt({ first, firstFile, retry, retryFile }) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "security-review-attempt-"),
  );
  try {
    const githubOutput = path.join(directory, "github-output");
    fs.writeFileSync(githubOutput, "");
    const result = spawnSync(
      "bash",
      ["-c", runScript("Resolve the effective review attempt")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_OUTCOME: first,
          FIRST_FILE: firstFile,
          RETRY_OUTCOME: retry,
          RETRY_FILE: retryFile,
          GITHUB_OUTPUT: githubOutput,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return Object.fromEntries(
      fs
        .readFileSync(githubOutput, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("a clean first attempt resolves to itself when the retry is skipped", () => {
  // Actions sets a skipped step's outcome to the literal "skipped"; resolving
  // that as the effective outcome would fail every clean review closed.
  for (const skipped of ["skipped", ""]) {
    const resolved = resolveAttempt({
      first: "success",
      firstFile: "/tmp/first.json",
      retry: skipped,
      retryFile: "",
    });
    assert.equal(
      resolved.outcome,
      "success",
      `retry outcome ${skipped || "(empty)"}`,
    );
    assert.equal(resolved.execution_file, "/tmp/first.json");
  }
});

test("a successful retry supersedes the failed first attempt", () => {
  const resolved = resolveAttempt({
    first: "failure",
    firstFile: "/tmp/first.json",
    retry: "success",
    retryFile: "/tmp/retry.json",
  });
  assert.equal(resolved.outcome, "success");
  // The first attempt's payload would classify a failure that no longer applies.
  assert.equal(resolved.execution_file, "/tmp/retry.json");
});

test("both attempts failing resolves to the retry's payload", () => {
  const resolved = resolveAttempt({
    first: "failure",
    firstFile: "/tmp/first.json",
    retry: "failure",
    retryFile: "/tmp/retry.json",
  });
  assert.equal(resolved.outcome, "failure");
  assert.equal(resolved.execution_file, "/tmp/retry.json");
});

test("the outcome composite reads the resolved attempt, not just the first one", () => {
  const step = stepSource("Report review outcome");
  assert.match(
    step,
    /uses: melodic-software\/ci-workflows\/\.github\/actions\/claude-lane-outcome@[0-9a-f]{40}/u,
    "the outcome step must be the pinned claude-lane-outcome composite",
  );
  assert.match(
    step,
    /^ {10}outcome: \$\{\{ steps\.attempt\.outputs\.outcome \}\}$/mu,
    "reading steps.claude-review directly would ignore a successful retry",
  );
  assert.match(
    step,
    /^ {10}execution-file: \$\{\{ steps\.attempt\.outputs\.execution_file \}\}$/mu,
    "the classified payload must come from the attempt that actually ran last",
  );
  // No continue-on-error: if the composite itself crashes before producing a
  // verdict, the job must go red (closed), not silently green.
  assert.doesNotMatch(
    step,
    /continue-on-error/u,
    "a crashed outcome composite must fail the job, not pass through",
  );
});

test("an in-scope non-run fails the job through the fail-closed step", () => {
  const step = stepSource("Fail closed on an in-scope non-run");

  // The red is raised deliberately, on the one signal that means "in scope
  // and did not run": the outcome composite recorded a failure AND this is a
  // pull_request run (only a pull_request run gates a merge — the action
  // rejects merge_group and, with track_progress on, every non-PR event, so
  // reddening those would wedge a consumer's merge queue on a cause no head
  // change can fix; they keep the historical pass-through by skipping this
  // step). always() keeps the step reachable after the failed review step.
  assert.match(
    step,
    /^ {8}if: >-\n {10}always\(\) && steps\.review-outcome\.outputs\.review-failed == 'true' &&\n {10}github\.event\.pull_request\.number != ''$/mu,
    "the fail-closed condition must key on review-failed and pull_request presence exactly",
  );
  assert.match(step, /^ {10}exit 1$/mu, "the step must conclude failure");
  assert.doesNotMatch(
    step,
    /continue-on-error/u,
    "continue-on-error here would revert #266 wholesale",
  );
});

// Everything below pins the three no-verdict paths that must NOT reach the
// failing step. Each is the reason the mapping keys on review-failed rather
// than on "no verdict was produced".
test("fork PRs skip the job instead of failing closed forever", () => {
  const jobCondition = workflow.slice(
    workflow.indexOf("  security-review:"),
    workflow.indexOf("      - name: Reject privileged triggers"),
  );

  // A fork run gets no secrets, so no number of retries can make it pass. The
  // two halves are asserted as ONE clause on purpose: the fork test scoped to
  // pull_request is a security control, not a style choice. Unscoped, it also
  // matches a fork PR arriving via pull_request_target or workflow_run and
  // would skip the job before `Reject privileged triggers` could hard-fail it,
  // turning a consumer's dangerous misconfiguration into a green check.
  assert.match(
    jobCondition,
    /\(github\.event_name != 'pull_request'\s+\|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository\)/u,
    "the job must skip fork PRs, and the fork test must stay scoped to pull_request so privileged triggers still reach the tripwire",
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
    "a retired run must skip the outcome step, leaving review-failed unset",
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
    "the retry must not fail the job itself; the fail-closed step owns the red",
  );
  assert.match(
    retry,
    /^ {8}if: steps\.retry-gate\.outputs\.retry == 'true'$/mu,
    "the retry must run only when the gate elected to retry",
  );

  // Same pin, or the retry is a different action than the one that was reviewed.
  const pin = /uses: (anthropics\/claude-code-action@[0-9a-f]{40})/u;
  assert.equal(
    retry.match(pin)?.[1],
    stepSource("Claude security review").match(pin)?.[1],
    "the retry must pin the same action SHA as the first attempt",
  );
});

test("the retry gate keys on a failed, current, PR-scoped first attempt", () => {
  const gate = stepSource("Decide whether to retry the review");

  // The gate — not the retry step — owns the chain: a retry is considered
  // only after a failed first attempt, on a still-current head, on a
  // pull_request run (the events the action rejects outright fail for
  // reasons no retry clears).
  assert.match(
    gate,
    /steps\.claude-review\.outcome == 'failure'/u,
    "the gate must consider a retry only after a failed first attempt",
  );
  assert.match(
    gate,
    /steps\.freshness\.outputs\.superseded != 'true'/u,
    "a superseded run must not spend a retry",
  );
  assert.match(
    gate,
    /github\.event\.pull_request\.number != ''/u,
    "the retry must stay PR-scoped",
  );

  // Zero assistant turns is the artifact-safety condition: nothing
  // review-shaped was posted, so attempt 2 cannot duplicate inline comments.
  assert.match(
    gate,
    /\(entry\) => entry\?\.type === "assistant"/u,
    "the gate must refuse to retry once assistant turns were spent",
  );

  // The auth exclusion mirrors classify.cjs's auth class type-for-type; a
  // retry cannot clear a credential death.
  for (const errorType of [
    "authentication_error",
    "billing_error",
    "permission_error",
  ]) {
    assert.ok(
      gate.includes(`"type":"${errorType}"`),
      `the gate must exclude ${errorType} failures from retry`,
    );
  }
});

test("the backoff is jittered and gated on the retry decision", () => {
  const backoff = stepSource("Back off before the review retry");
  assert.match(
    backoff,
    /^ {8}if: steps\.retry-gate\.outputs\.retry == 'true'$/mu,
    "backing off without a retry decision would only delay the verdict",
  );
  assert.match(
    backoff,
    /^ {8}run: sleep "\$\(\(RETRY_DELAY_SECONDS \+ RANDOM % 30\)\)"$/mu,
    "the retry must back off with jitter rather than re-hammering a contended seat in lockstep",
  );
  assert.match(
    backoff,
    /^ {10}RETRY_DELAY_SECONDS: \$\{\{ inputs\.retry-delay-seconds \}\}$/mu,
    "the base delay must ride the retry-delay-seconds input",
  );
});
