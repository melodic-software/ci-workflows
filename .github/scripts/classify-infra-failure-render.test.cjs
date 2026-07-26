"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const consumers = ["claude-review.yml", "claude-security-review.yml"];

function workflowSource(name) {
  return fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", name),
    "utf8",
  );
}

test("both review reusables embed the classifier generated from one source", () => {
  const renderer = path.join(__dirname, "render-classify-infra-failure.cjs");
  const result = spawnSync(process.execPath, [renderer, "--check"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  for (const name of consumers) {
    assert.equal(
      workflowSource(name).match(
        /Source: \.github\/scripts\/classify-infra-failure\.sh/gu,
      )?.length,
      1,
      `${name} must embed the generated block exactly once`,
    );
  }
});

// The annotation is the surface a receiver polls through the check-run API, so
// the class term's shape is a contract, not a formatting choice.
test("each review job emits the class as a bare term in its infra-failure annotation", () => {
  for (const name of consumers) {
    assert.match(
      workflowSource(name),
      /^ {10}echo "::error::Claude (security )?review exited with: \$REVIEW_OUTCOME class=\$failure_class" \\$/mu,
      `${name} must carry the class as a bare class=<token> term`,
    );
  }
});

test("each marker-managed infra-status comment carries the class", () => {
  for (const name of consumers) {
    const source = workflowSource(name);
    assert.match(
      source,
      /^ {10}REVIEW_CLASS: \$\{\{ steps\.review-outcome\.outputs\.failure_class \}\}$/mu,
      `${name} must pass the class into the comment step`,
    );
    assert.match(
      source,
      /^ {14}`> - Failure class: \\`\$\{process\.env\.REVIEW_CLASS\}\\``,$/mu,
      `${name} must render the class as a comment field`,
    );
  }
});

function stepSource(workflow, stepName) {
  const start = workflow.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(start, -1, `step not found: ${stepName}`);
  const rest = workflow.slice(start + 1);
  const next = rest.indexOf("\n      - name: ");
  return next === -1 ? rest : rest.slice(0, next);
}

// The two lanes diverge here, and the difference is the whole point (#266,
// adjudicated; narrowing the #228 non-goal). Infra pass-through is ratified for
// the ADVISORY lane: `review / review` gates nothing whether it is green or red,
// so reddening it on an Anthropic-side blip buys no safety and costs noise —
// an infra failure is not a code-quality signal.
//
// That rationale reasons from merge-irrelevance, so it does not transfer to the
// SECURITY lane, whose check is required precisely to prove a pass ran. There,
// passing on an infra failure certifies an execution that did not happen; it is
// asserted to fail closed by claude-security-review-fail-closed.test.cjs, which
// replays a rate-limited payload through the real outcome step.
//
// Both directions are pinned, because both are one edit away from silently
// inverting across every consumer repo.
test("an infrastructure failure never fails the ADVISORY review job", () => {
  const name = "claude-review.yml";
  const source = workflowSource(name);

  // The action exits nonzero on infra errors; continue-on-error is what keeps
  // that off the check's conclusion.
  assert.match(
    stepSource(source, "Claude review"),
    /^ {8}continue-on-error: true$/mu,
    `${name} must keep continue-on-error on the action step`,
  );

  // The outcome step reports the failure; it must not become the failure.
  const outcome = stepSource(source, "Report review outcome");
  const exits = [...outcome.matchAll(/^\s*exit\s+(\d+)\s*$/gmu)].map(
    (match) => match[1],
  );
  assert.ok(
    exits.length > 0,
    `${name}: expected the outcome step to exit explicitly`,
  );
  for (const code of exits) {
    assert.equal(
      code,
      "0",
      `${name}: the advisory lane's outcome step must not exit nonzero on an infra failure (found exit ${code}). If this lane is being promoted to a required check, that is a posture change needing its own ratification — see #266.`,
    );
  }
});

// Applies to BOTH lanes: whatever a lane's conclusion policy is, the steps that
// merely annotate the PR must never be what decides it. These are
// actions/github-script steps, so a shell `exit` check would never fire on them.
// Two mechanisms can fail a JS step: an explicit failure call, and an unhandled
// rejection — every one of these steps awaits GitHub API calls that can reject
// for reasons unrelated to the code under review, and github-script turns a
// rejection into a failed step on its own. Only continue-on-error covers that
// second path, so it is asserted rather than assumed.
test("the comment steps never decide either lane's conclusion", () => {
  for (const name of consumers) {
    const source = workflowSource(name);
    for (const step of [
      "Comment on genuine review failure",
      "Clear stale failure comment after successful review",
    ]) {
      const body = stepSource(source, step);
      assert.match(
        body,
        /^ {8}uses: actions\/github-script@/mu,
        `${name}: "${step}" is no longer a github-script step; this assertion must be rewritten for its new failure mechanism`,
      );
      assert.match(
        body,
        /^ {8}continue-on-error: true$/mu,
        `${name}: "${step}" awaits GitHub API calls; without continue-on-error a rejected call fails the job`,
      );
      assert.doesNotMatch(
        body,
        /\bcore\.setFailed\s*\(/u,
        `${name}: "${step}" must not fail the job`,
      );
      assert.doesNotMatch(
        body,
        /\bprocess\.exit\s*\(/u,
        `${name}: "${step}" must not fail the job`,
      );
    }
  }
});

// The whole point of the projection is that the two free-text fields are read
// inside the generated block and never emitted. A future edit that echoes
// either one, or projects it into the detail JSON, must fail here.
test("neither reusable emits the model-authored result or the raw error stacks", () => {
  for (const name of consumers) {
    const source = workflowSource(name);
    const emissions = [
      ...source.matchAll(/^ {10,}(echo .*|.*\$\{process\.env\..*)$/gmu),
    ].map((match) => match[0]);
    for (const line of emissions) {
      assert.doesNotMatch(
        line,
        /\$\{?(last\.)?(result|errors)\b/u,
        `${name} emits a free-text SDK field: ${line.trim()}`,
      );
    }
    assert.doesNotMatch(
      source,
      /^ {12,}result: \$last\.result,?$/mu,
      `${name} must not project the model-authored result field`,
    );
    assert.doesNotMatch(
      source,
      /^ {12,}errors: \$last\.errors,?$/mu,
      `${name} must not project the raw error stacks`,
    );
  }
});
