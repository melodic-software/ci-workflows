"use strict";

// The security lane's required check certifies EXECUTION, and "in scope and
// could not run" is ruled on in two tiers (#266, narrowed by the availability
// amendment in the workflow's POSTURE). Caller drift concludes FAILURE —
// `neutral` and `skipped` both satisfy a required check and cannot express it,
// and the PR that caused it clears it by merging. An external failure concludes
// SUCCESS behind a loud warning annotation, because a required context that
// reddens on a provider outage locks every merge for the length of it. The
// classification itself lives in the claude-lane-outcome composite (its corpus
// runs in .github/actions/claude-lane-outcome/classify.test.cjs); what this
// workflow owns — and what these tests pin — is the wiring around it: the retry
// gate that decides whether a second attempt is safe (zero assistant turns) and
// useful (not auth-class), the resolve step that picks the effective attempt,
// the outcome composite reading that attempt, and the ruling step that maps
// each non-run shape to a conclusion.

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
  // The block ends at the first non-blank line indented shallower than the
  // block body — stepSource alone over-reaches for a job's LAST step, whose
  // "next step" boundary lives in the following job.
  const lines = step.slice(start + marker.length).split("\n");
  const end = lines.findIndex(
    (line) => line !== "" && !line.startsWith("          "),
  );
  const body = (end === -1 ? lines : lines.slice(0, end)).join("\n");
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

test("an in-scope non-run reaches the ruling step on both signals", () => {
  const step = stepSource("Rule on an in-scope non-run");

  // The step is REACHED on the two signals that mean "in scope and did not
  // run": the outcome composite recorded a failure, OR it recorded a green
  // with no execution evidence (review-ran == 'false' — the action skipped
  // itself, so nothing was reviewed and a green would certify an execution
  // that never happened). What each shape then CONCLUDES is the two-tier
  // posture, executed below. Both are AND-ed with pull_request presence (only
  // a pull_request run gates a merge — the action rejects merge_group and,
  // with track_progress on, every non-PR event, so ruling on those would
  // wedge a consumer's merge queue on a cause no head change can fix; they
  // keep the historical pass-through by skipping this step). !cancelled()
  // keeps the step reachable after the failed review step while still
  // skipping it on cancellation — a cancelled run is retired by a newer one
  // and must not raise a red of its own.
  assert.match(
    step,
    /^ {8}if: >-\n {10}!cancelled\(\) && \(steps\.review-outcome\.outputs\.review-failed == 'true' \|\|\n {10}steps\.review-outcome\.outputs\.review-ran == 'false'\) &&\n {10}github\.event\.pull_request\.number != ''$/mu,
    "the condition must key on review-failed OR a no-evidence green, and pull_request presence, exactly",
  );
  assert.doesNotMatch(
    step,
    /continue-on-error/u,
    "continue-on-error here would decouple the conclusion from the ruling entirely",
  );

  // The loud-open tier reports green, so its annotation is the only thing on
  // the check run that says a review was missed. A bare `echo` would print to
  // the log and annotate nothing.
  assert.match(
    step,
    /echo "::warning::/u,
    "the loud-open tier must emit a warning ANNOTATION, not a plain log line",
  );
  // The aggregator extracts `class=<token>` from every annotation on this
  // check run, so a token here would double-count the incident it reports.
  const runBlock = runScript("Rule on an in-scope non-run");
  assert.doesNotMatch(
    runBlock,
    /class=/u,
    "a class= token in this step's output would pollute the incident aggregator's tally",
  );

  // The skip shape gets its own log explanation: no re-run retries a
  // validation skip, so telling the author to re-run would be wrong. The
  // branch must key on BOTH outputs — the composite sets review-ran to
  // "false" on the genuine-failure path too, so branching on it alone would
  // print the skip explanation (and its "a re-run cannot" guidance) for
  // every real infra failure: the inverse of the right remedy. The env
  // wiring and the branch are both pinned so the message cannot silently
  // detach from the signals it explains.
  assert.match(
    step,
    /^ {10}REVIEW_RAN: \$\{\{ steps\.review-outcome\.outputs\.review-ran \}\}$/mu,
    "the run block must read the review-ran output through env, never by interpolation",
  );
  assert.match(
    step,
    /^ {10}REVIEW_FAILED: \$\{\{ steps\.review-outcome\.outputs\.review-failed \}\}$/mu,
    "the run block must read the review-failed output through env, never by interpolation",
  );
  assert.match(
    step,
    /if \[ "\$REVIEW_RAN" = "false" \] && \[ "\$REVIEW_FAILED" != "true" \]/u,
    "only the skip shape — never a genuine failure — may get the merge-the-caller-change explanation",
  );
});

// The ruling run block is expression-free shell, so the branch choosing
// between the two tiers is EXECUTED over every shape rather than
// pattern-matched — a regex cannot prove which message a given output
// combination prints or what it exits with, and printing the skip message for
// a genuine failure was a shipped defect, not a hypothetical.
function runFailClosed({ reviewRan, reviewFailed }) {
  return spawnSync("bash", ["-c", runScript("Rule on an in-scope non-run")], {
    encoding: "utf8",
    env: {
      ...process.env,
      REVIEW_RAN: reviewRan,
      REVIEW_FAILED: reviewFailed,
    },
  });
}

test("caller drift stays fail-closed and keeps its merge-the-change remedy", () => {
  // The one shape enforcement still bites: the PR itself caused it, and
  // merging the PR is what clears it. Softening this to a warning would let a
  // caller edit disable its own required security check.
  const skip = runFailClosed({ reviewRan: "false", reviewFailed: "false" });
  assert.equal(skip.status, 1, "the caller-drift shape must conclude failure");
  assert.match(skip.stdout, /workflow-validation skip/u);
  assert.match(skip.stdout, /a re-run cannot/u);
  assert.doesNotMatch(
    skip.stdout,
    /::warning::/u,
    "the fail-closed tier speaks through its red, not through a loud-open warning",
  );
});

test("an external failure opens loudly instead of blocking the merge", () => {
  // Availability posture: the cause is outside the PR's and the org's
  // control, so the required check must not lock the fleet for the length of
  // the outage. The warning ANNOTATION is what carries the alarm on a check
  // run that now concludes green.
  const failure = runFailClosed({ reviewRan: "false", reviewFailed: "true" });
  assert.equal(
    failure.status,
    0,
    "an external failure must not block the merge",
  );
  assert.match(
    failure.stdout,
    /^::warning::/mu,
    "the annotation prefix is what makes GitHub surface this on the check run",
  );
  assert.match(
    failure.stdout,
    /Merging is deliberately NOT blocked/u,
    "the warning must say the green is deliberate, not incidental",
  );
  assert.match(
    failure.stdout,
    /marker comment/u,
    "the warning must point at where the failure class and remediation live",
  );
  assert.match(
    failure.stdout,
    /Re-run the job/u,
    "an external failure must keep retry-appropriate guidance",
  );
  assert.doesNotMatch(
    failure.stdout,
    /workflow-validation skip/u,
    "an external failure printed the skip explanation — the inverse of its remedy",
  );
});

test("a failure reported without review-ran still opens rather than blocks", () => {
  // The composite pairs review-failed 'true' with review-ran 'false' today,
  // but the step's `if:` admits review-failed 'true' on its own. That shape
  // is an external failure too, so a refactor of the branch condition must
  // not silently redden it.
  const failure = runFailClosed({ reviewRan: "", reviewFailed: "true" });
  assert.equal(failure.status, 0, "an unset review-ran must not block a merge");
  assert.match(failure.stdout, /^::warning::/mu);
});

test("a validation skip cannot clear a prior failure warning", () => {
  // review-failed == 'false' is also true of a validation skip, which
  // reviewed nothing; only review-ran distinguishes a review that happened.
  // A skip clearing the stale marker would erase the record of a failure it
  // did not resolve.
  const step = stepSource(
    "Clear stale failure comment after successful review",
  );
  assert.match(
    step,
    /^ {8}if: "!cancelled\(\) && steps\.review-outcome\.outputs\.review-ran == 'true'"$/mu,
    "the clear-stale step must gate on review-ran, not on not-failed",
  );
});

// Everything below pins the three no-verdict paths that must NOT reach the
// ruling step. Each is the reason the mapping keys on the composite's
// explicit outputs — an empty output matches neither comparison — rather
// than on "no verdict was produced".
test("fork, out-of-scope and skip-actor PRs never reach the ruling step", () => {
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

test("the kill-switches gate the review job only, never the changes job", () => {
  const changesJob = workflow.slice(
    workflow.indexOf("  changes:"),
    workflow.indexOf("  security-review:"),
  );
  const reviewJobCondition = workflow.slice(
    workflow.indexOf("  security-review:"),
    workflow.indexOf("      - name: Reject privileged triggers"),
  );

  // A kill-switched review job is a name-stable SKIP a required-check ruleset
  // reads as success; a switch that also silenced the `changes` relevance job
  // would change the reporting shape rather than just pausing the review.
  for (const clause of [
    "vars.CLAUDE_LANES_DISABLED != 'true'",
    "vars.CLAUDE_SECURITY_REVIEW_DISABLED != 'true'",
  ]) {
    assert.ok(
      reviewJobCondition.includes(clause),
      `the security-review job condition must carry the kill-switch clause ${clause}`,
    );
  }
  assert.doesNotMatch(
    changesJob,
    /vars\.CLAUDE/u,
    "the changes job must never be kill-switch gated",
  );
});

test("the paths file is read from the base branch and its faults fail open", () => {
  // A PR able to influence which paths-file content is evaluated could edit
  // the file to skip its own security review, so the fetch must pin the BASE
  // branch — never the PR head.
  const fetchStep = stepSource("List changed files");
  assert.match(
    fetchStep,
    /ref: context\.payload\.pull_request\.base\.ref/u,
    "the paths file must be fetched at the PR's base ref",
  );
  assert.doesNotMatch(
    fetchStep,
    /pull_request\.head/u,
    "nothing in the fetch step may consult the PR head",
  );

  // Absent (404) or unreadable file → the failed flag, which the filter step
  // must turn into relevant=true (fail open), matching the job's discipline.
  assert.match(
    fetchStep,
    /core\.setOutput\("paths-file-failed", "true"\)/u,
    "a fetch error must raise the paths-file-failed flag, not crash the job",
  );
  const filterStep = stepSource("Determine security relevance");
  assert.match(
    filterStep,
    /if \[ "\$PATHS_FILE_FAILED" = "true" \] \|\| \[ -z "\$PATHS_FILE_PATH" \]; then\n {14}echo "::warning::Could not read paths file '\$PATHS_FILE'; treating PR as security-relevant\."\n {14}echo "relevant=true" >>"\$GITHUB_OUTPUT"/u,
    "an unreadable paths file must fail open to relevant=true with a warning",
  );
});

// The filter's run block is expression-free shell, so the precedence contract
// — explicit `paths` wins, then `paths-file`, then no filter — is executed
// here rather than pattern-matched.
function runFilter({ paths, pathsFile, patterns, changedFiles, fetchFailed }) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "security-review-filter-"),
  );
  try {
    const githubOutput = path.join(directory, "github-output");
    fs.writeFileSync(githubOutput, "");
    const filesListPath = path.join(directory, "changed-files.txt");
    fs.writeFileSync(filesListPath, `${changedFiles.join("\n")}\n`);
    let patternsPath = "";
    if (patterns !== undefined) {
      patternsPath = path.join(directory, "paths-file.txt");
      fs.writeFileSync(patternsPath, patterns);
    }
    const result = spawnSync(
      "bash",
      ["-c", runScript("Determine security relevance")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          EVENT_NAME: "pull_request",
          PATHS: paths,
          PATHS_FILE: pathsFile,
          PATHS_FILE_PATH: patternsPath,
          PATHS_FILE_FAILED: fetchFailed ? "true" : "false",
          FILES_LIST_PATH: filesListPath,
          FILES_LIST_FAILED: "false",
          GITHUB_OUTPUT: githubOutput,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const relevant = fs
      .readFileSync(githubOutput, "utf8")
      .match(/^relevant=(.*)$/mu)?.[1];
    assert.notEqual(relevant, undefined, "the filter must output relevant");
    return relevant;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("an explicit paths input wins over the paths file", () => {
  // The file's patterns would match this PR; the explicit input's do not. If
  // the file were consulted despite a non-empty `paths`, relevant flips true.
  const relevant = runFilter({
    paths: ".github/**\n",
    pathsFile: ".github/claude-security-paths",
    patterns: "docs/**\n",
    changedFiles: ["docs/readme.md"],
    fetchFailed: false,
  });
  assert.equal(relevant, "false");
});

test("the paths file supplies the patterns when the paths input is empty", () => {
  const cases = [
    { changedFiles: [".github/workflows/ci.yml"], expected: "true" },
    { changedFiles: ["docs/readme.md"], expected: "false" },
  ];
  for (const { changedFiles, expected } of cases) {
    const relevant = runFilter({
      paths: "",
      pathsFile: ".github/claude-security-paths",
      patterns: ".github/**\n",
      changedFiles,
      fetchFailed: false,
    });
    assert.equal(relevant, expected, changedFiles.join(","));
  }
});

test("a vacuous paths file fails open to relevant", () => {
  // An existing file whose lines are all comments/blanks yields an empty
  // matcher. Today that lands on the shared no-usable-patterns guard; this
  // pins the outcome so a refactor of that guard cannot silently turn a
  // vacuous file into skip-every-PR.
  const relevant = runFilter({
    paths: "",
    pathsFile: ".github/claude-security-paths",
    patterns: "# nothing here\n\n",
    changedFiles: ["docs/readme.md"],
    fetchFailed: false,
  });
  assert.equal(relevant, "true");
});

test("a failed paths-file fetch fails open to relevant", () => {
  const relevant = runFilter({
    paths: "",
    pathsFile: ".github/claude-security-paths",
    patterns: undefined,
    changedFiles: ["docs/readme.md"],
    fetchFailed: true,
  });
  assert.equal(relevant, "true");
});

test("both pattern inputs empty keeps every call relevant", () => {
  const relevant = runFilter({
    paths: "",
    pathsFile: "",
    patterns: undefined,
    changedFiles: ["docs/readme.md"],
    fetchFailed: false,
  });
  assert.equal(relevant, "true");
});

test("a superseded head reports nothing, so it cannot be ruled on", () => {
  const step = stepSource("Report review outcome");
  // !cancelled() rather than always(): cancellation is the concurrency
  // group's retirement mechanism, so a cancelled run must skip the outcome
  // step exactly like a superseded one.
  assert.match(
    step,
    /^ {8}if: "!cancelled\(\) && steps\.freshness\.outputs\.superseded != 'true'"$/mu,
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
    "the retry must not conclude the job itself; the ruling step owns that",
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

  // Zero turns of REAL work is the artifact-safety condition: nothing
  // review-shaped was posted, so attempt 2 cannot duplicate inline comments.
  // What the gate DECIDES from those payloads is executed, not pattern-matched,
  // in claude-lane-retry-gate.test.cjs — a regex here cannot tell a reachable
  // branch from a dead one, which is how the 429 path went unnoticed.
  assert.match(
    gate,
    /const realTurns = assistantTurns\.filter\(/u,
    "the gate must refuse to retry once turns of real work were spent",
  );

  // The auth exclusion covers classify.cjs's auth class type-for-type; a
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
