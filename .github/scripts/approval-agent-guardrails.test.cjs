"use strict";

// Contract + unit tests for Approval Agent live APPROVE path (ci-workflows#256).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");
const {
  DEFAULT_PROTECTED_PATHS,
  parseProtectedPaths,
  findProtectedPathHits,
  checkIdentitySeparation,
  checkHumanRiskFindings,
  botLoginFromAppSlug,
  evaluateApproval,
  parseBooleanInput,
} = require("./approval-agent-guardrails.cjs");

const repositoryRoot = path.join(__dirname, "..", "..");
const reusableSource = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "approval-agent.yml"),
  "utf8",
);
const callerSource = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "approval-agent-self.yml"),
  "utf8",
);

test("default protected paths cover workflow, script, and ADR", () => {
  assert.ok(
    DEFAULT_PROTECTED_PATHS.includes(".github/workflows/approval-agent.yml"),
  );
  assert.ok(
    DEFAULT_PROTECTED_PATHS.includes(
      ".github/workflows/approval-agent-self.yml",
    ),
  );
  assert.ok(
    DEFAULT_PROTECTED_PATHS.includes(
      ".github/scripts/approval-agent-guardrails.cjs",
    ),
  );
  assert.ok(
    DEFAULT_PROTECTED_PATHS.includes(
      "docs/topics/claude-review-lanes/approval-agent-ADR.md",
    ),
  );
});

test("parseProtectedPaths falls back to defaults on empty input", () => {
  assert.deepEqual(parseProtectedPaths(""), [...DEFAULT_PROTECTED_PATHS]);
  assert.deepEqual(parseProtectedPaths(null), [...DEFAULT_PROTECTED_PATHS]);
  assert.deepEqual(parseProtectedPaths("  a.yml , b.yml\nc.yml  "), [
    "a.yml",
    "b.yml",
    "c.yml",
  ]);
});

test("findProtectedPathHits matches exact and directory-prefix paths", () => {
  const exact = findProtectedPathHits(
    ["README.md", ".github/workflows/approval-agent.yml"],
    DEFAULT_PROTECTED_PATHS,
  );
  assert.equal(exact.blocked, true);
  assert.deepEqual(exact.matches, [".github/workflows/approval-agent.yml"]);

  const prefix = findProtectedPathHits(
    ["docs/topics/claude-review-lanes/approval-agent-ADR.md"],
    ["docs/topics/claude-review-lanes/"],
  );
  assert.equal(prefix.blocked, true);

  const clean = findProtectedPathHits(["README.md"], DEFAULT_PROTECTED_PATHS);
  assert.equal(clean.blocked, false);
  assert.deepEqual(clean.matches, []);
});

test("identity separation refuses author or last-pusher match", () => {
  assert.equal(
    checkIdentitySeparation({
      approverLogin: "melodic-ai[bot]",
      authorLogin: "alice",
      lastPusherLogin: "bob",
    }).ok,
    true,
  );
  assert.match(
    checkIdentitySeparation({
      approverLogin: "Alice",
      authorLogin: "alice",
      lastPusherLogin: "bob",
    }).reason,
    /matches PR author/u,
  );
  assert.match(
    checkIdentitySeparation({
      approverLogin: "melodic-ai[bot]",
      authorLogin: "alice",
      lastPusherLogin: "Melodic-AI[bot]",
    }).reason,
    /matches last pusher/u,
  );
  assert.match(
    checkIdentitySeparation({
      approverLogin: "",
      authorLogin: "alice",
      lastPusherLogin: "bob",
    }).reason,
    /approver identity is empty/u,
  );
});

test("human-risk findings respect refuse toggle and empty JSON arrays", () => {
  assert.equal(
    checkHumanRiskFindings({
      findingsRaw: "",
      refuseOnHumanRisk: true,
    }).blocked,
    false,
  );
  assert.equal(
    checkHumanRiskFindings({
      findingsRaw: "[]",
      refuseOnHumanRisk: true,
    }).blocked,
    false,
  );
  assert.equal(
    checkHumanRiskFindings({
      findingsRaw: '["needs human"]',
      refuseOnHumanRisk: true,
    }).blocked,
    true,
  );
  assert.equal(
    checkHumanRiskFindings({
      findingsRaw: "CRITICAL: auth bypass",
      refuseOnHumanRisk: true,
    }).blocked,
    true,
  );
  assert.equal(
    checkHumanRiskFindings({
      findingsRaw: "CRITICAL: auth bypass",
      refuseOnHumanRisk: false,
    }).blocked,
    false,
  );
});

test("botLoginFromAppSlug appends [bot] once", () => {
  assert.equal(botLoginFromAppSlug("melodic-ai"), "melodic-ai[bot]");
  assert.equal(botLoginFromAppSlug("Melodic-AI[bot]"), "melodic-ai[bot]");
  assert.equal(botLoginFromAppSlug(""), "");
});

test("evaluateApproval defaults to comment; approve is opt-in", () => {
  const base = {
    changedPaths: ["README.md"],
    approverLogin: "melodic-ai[bot]",
    authorLogin: "alice",
    lastPusherLogin: "bob",
    findingsRaw: "",
    refuseOnHumanRisk: true,
  };
  assert.equal(
    evaluateApproval({ ...base, enableApprove: false }).decision,
    "comment",
  );
  assert.equal(
    evaluateApproval({ ...base, enableApprove: true }).decision,
    "approve",
  );
  assert.equal(
    evaluateApproval({
      ...base,
      enableApprove: true,
      changedPaths: [".github/workflows/approval-agent.yml"],
    }).decision,
    "refuse",
  );
  assert.equal(
    evaluateApproval({
      ...base,
      enableApprove: true,
      findingsRaw: "needs human",
    }).decision,
    "refuse",
  );
  assert.equal(
    evaluateApproval({
      ...base,
      enableApprove: true,
      authorLogin: "melodic-ai[bot]",
    }).decision,
    "refuse",
  );
});

test("parseBooleanInput treats Actions string booleans", () => {
  assert.equal(parseBooleanInput("true", false), true);
  assert.equal(parseBooleanInput("false", true), false);
  assert.equal(parseBooleanInput("", true), true);
  assert.equal(parseBooleanInput(undefined, false), false);
});

test("reusable workflow defaults enable-approve to false and wires secrets", () => {
  const reusable = parseWorkflow(reusableSource);
  assert.equal(
    reusable.on.workflow_call.inputs["enable-approve"].default,
    false,
  );
  assert.equal(
    reusable.on.workflow_call.inputs["refuse-on-human-risk"].default,
    true,
  );
  assert.equal(
    reusable.on.workflow_call.inputs["human-risk-findings"].default,
    "",
  );
  assert.ok(reusable.on.workflow_call.secrets["app-id"]);
  assert.equal(reusable.on.workflow_call.secrets["app-id"].required, false);
  assert.ok(reusable.on.workflow_call.secrets["app-private-key"]);
  assert.equal(
    reusable.on.workflow_call.secrets["app-private-key"].required,
    false,
  );
  assert.match(reusableSource, /approval-agent-guardrails\.cjs/u);
  assert.match(reusableSource, /repository: melodic-software\/ci-workflows/u);
  assert.match(reusableSource, /ref: \$\{\{ github\.job_workflow_sha \}\}/u);
  assert.match(reusableSource, /event: reviewEvent/u);
  assert.match(reusableSource, /"APPROVE"/u);
  assert.match(reusableSource, /create-github-app-token@/u);
  // Default path remains safe: APPROVE only after enable-approve + guardrails.
  assert.match(
    reusableSource,
    /ENABLE_APPROVE: \$\{\{ inputs\.enable-approve \}\}/u,
  );
});

test("self caller stays workflow_dispatch-only and does not auto-enable approve", () => {
  const caller = parseWorkflow(callerSource);
  assert.deepEqual(Object.keys(caller.on), ["workflow_dispatch"]);
  assert.equal(caller.on.pull_request, undefined);
  assert.equal(caller.on.pull_request_target, undefined);
  assert.equal(caller.on.merge_group, undefined);
  assert.equal(
    caller.on.workflow_dispatch.inputs["enable-approve"].default,
    false,
  );
  assert.match(
    callerSource,
    /^ {6}enable-approve: \$\{\{ inputs\.enable-approve \}\}$/mu,
  );
  assert.match(
    callerSource,
    /^ {6}app-id: \$\{\{ secrets\.MELODIC_APP_ID \}\}$/mu,
  );
  assert.match(
    callerSource,
    /^ {6}app-private-key: \$\{\{ secrets\.MELODIC_PRIVATE_KEY \}\}$/mu,
  );
});
