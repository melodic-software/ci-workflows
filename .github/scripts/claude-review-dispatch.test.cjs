"use strict";

// Contract for workflow_dispatch re-review (ci-workflows#254): the canonical
// caller exposes a PR-number dispatch input, the reusable resolves PR/head
// via API when pull_request context is absent, and marker/count/freshness
// paths consume that resolved context rather than github.event.pull_request.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const repositoryRoot = path.join(__dirname, "..", "..");
const callerSource = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "claude-review-self.yml"),
  "utf8",
);
const reusableSource = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "claude-review.yml"),
  "utf8",
);
const freshnessSource = fs.readFileSync(
  path.join(
    repositoryRoot,
    ".github",
    "actions",
    "claude-lane-freshness",
    "action.yml",
  ),
  "utf8",
);
const markerSource = fs.readFileSync(
  path.join(
    repositoryRoot,
    ".github",
    "actions",
    "claude-lane-marker-comment",
    "action.yml",
  ),
  "utf8",
);

function stepSource(workflow, stepName) {
  const start = workflow.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(start, -1, `step not found: ${stepName}`);
  const rest = workflow.slice(start + 1);
  const next = rest.indexOf("\n      - name: ");
  return next === -1 ? rest : rest.slice(0, next);
}

test("canonical caller exposes workflow_dispatch with pr-number", () => {
  const caller = parseWorkflow(callerSource);
  assert.ok(caller.on.pull_request, "pull_request trigger must remain");
  assert.deepEqual(caller.on.pull_request.types, [
    "opened",
    "ready_for_review",
    "reopened",
  ]);
  assert.equal(caller.on.pull_request.types.includes("synchronize"), false);
  assert.ok(caller.on.workflow_dispatch, "workflow_dispatch entry required");
  assert.equal(caller.on.workflow_dispatch.inputs["pr-number"].required, true);
  assert.equal(caller.on.workflow_dispatch.inputs["pr-number"].type, "string");
  assert.match(
    callerSource,
    /^ {6}pr-number: \$\{\{ inputs\.pr-number \}\}$/mu,
  );
  assert.match(
    callerSource,
    /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| inputs\.pr-number \|\| github\.run_id \}\}/u,
  );
});

test("reusable accepts pr-number and resolves PR context before freshness", () => {
  const reusable = parseWorkflow(reusableSource);
  assert.equal(reusable.on.workflow_call.inputs["pr-number"].default, "");
  assert.match(reusableSource, /^ {6}- name: Resolve PR context$/mu);
  assert.match(reusableSource, /^ {8}id: resolve-pr$/mu);

  const resolveIdx = reusableSource.indexOf(
    "      - name: Resolve PR context\n",
  );
  const freshnessIdx = reusableSource.indexOf(
    "      - name: Check whether this head is still current\n",
  );
  assert.ok(resolveIdx !== -1 && freshnessIdx !== -1);
  assert.ok(
    resolveIdx < freshnessIdx,
    "resolve-pr must run before the freshness guard",
  );

  const resolve = stepSource(reusableSource, "Resolve PR context");
  assert.match(resolve, /PR_NUMBER_INPUT: \$\{\{ inputs\.pr-number \}\}/u);
  assert.match(resolve, /context\.payload\.pull_request/u);
  assert.match(resolve, /github\.rest\.pulls\.get/u);
  assert.match(resolve, /core\.setOutput\("head-sha"/u);
});

test("prompts and checkout consume resolved PR outputs, not event-only fields", () => {
  assert.match(
    reusableSource,
    /PR NUMBER: \$\{\{ steps\.resolve-pr\.outputs\.number \}\}/u,
  );
  assert.match(
    reusableSource,
    /HEAD SHA: \$\{\{ steps\.resolve-pr\.outputs\.head-sha \}\}/u,
  );
  const checkout = stepSource(reusableSource, "Check out");
  assert.match(
    checkout,
    /^ {10}ref: \$\{\{ steps\.resolve-pr\.outputs\.head-sha \}\}$/mu,
  );
  // Review attempt prompts must not hard-depend on event.pull_request for
  // number/head (concurrency may still reference them as fallbacks).
  const first = stepSource(reusableSource, "Claude review");
  assert.doesNotMatch(
    first,
    /github\.event\.pull_request\.(number|head\.sha)/u,
  );
});

test("marker comments receive pull-number and advertise dispatch re-review", () => {
  const failure = stepSource(
    reusableSource,
    "Comment on genuine review failure",
  );
  const clear = stepSource(
    reusableSource,
    "Clear stale failure comment after successful review",
  );
  for (const step of [failure, clear]) {
    assert.match(
      step,
      /^ {10}pull-number: \$\{\{ steps\.resolve-pr\.outputs\.number \}\}$/mu,
    );
    assert.match(step, /claude-lane-marker-comment@[0-9a-f]{40}/u);
  }
  assert.match(failure, /workflow_dispatch this workflow with the PR number/u);
});

test("freshness and marker composites declare optional pull-number inputs", () => {
  assert.match(freshnessSource, /^ {2}pull-number:/mu);
  assert.match(freshnessSource, /^ {2}head-sha:/mu);
  assert.match(markerSource, /^ {2}pull-number:/mu);
  assert.match(
    freshnessSource,
    /inputs\.pull-number != '' \|\| github\.event\.pull_request\.number != ''/u,
  );
});

test("dispatch compose grants gh delivery tools instead of inline MCP", () => {
  const compose = stepSource(reusableSource, "Compose Claude CLI arguments");
  assert.match(compose, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  assert.match(compose, /mcp__github_inline_comment__create_inline_comment/u);
  assert.match(compose, /Bash\(gh pr comment:\*\)/u);
  assert.match(compose, /Bash\(gh pr review:\*\)/u);
  assert.match(compose, /\[ "\$EVENT_NAME" = "pull_request" \]/u);
});
