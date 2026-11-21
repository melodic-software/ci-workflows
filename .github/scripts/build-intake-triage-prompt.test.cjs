"use strict";

// Unit tests for the build-intake-triage-prompt module and its wiring in
// intake-triage.yml's three model legs.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildPrompt,
  filterIssueTypes,
  isAdmissionLabel,
  parseClaudeArgs,
  resolveCliVersion,
  resolveLabels,
  run,
} = require("../actions/build-intake-triage-prompt/compose.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const WORKFLOW_FILE = path.join(
  __dirname,
  "..",
  "workflows",
  "intake-triage.yml",
);
const ACTION_FILE = path.join(
  __dirname,
  "..",
  "actions",
  "build-intake-triage-prompt",
  "action.yml",
);

test("parseClaudeArgs defaults to sonnet, medium, 30 and honors repeated or quoted flags", () => {
  assert.deepEqual(parseClaudeArgs(""), {
    ok: true,
    run: { model: "sonnet", effort: "medium", "max-turns": "30" },
  });
  assert.deepEqual(
    parseClaudeArgs(
      "--model \"claude-sonnet-5\" --effort=high --max-turns 10 --max-turns='25'",
    ),
    {
      ok: true,
      run: { model: "claude-sonnet-5", effort: "high", "max-turns": "25" },
    },
  );
  assert.equal(
    parseClaudeArgs("--permission-mode bypassPermissions").ok,
    false,
  );
  assert.equal(parseClaudeArgs("--model").ok, false);
  assert.equal(parseClaudeArgs("--max-turns 0").ok, false);
  assert.equal(parseClaudeArgs("positional").ok, false);
});

test("resolveCliVersion maps stable and bundled to latest and rejects malformed versions", () => {
  assert.deepEqual(resolveCliVersion("latest"), {
    ok: true,
    cliVersion: "latest",
    warning: undefined,
  });
  assert.deepEqual(resolveCliVersion("2.1.330"), {
    ok: true,
    cliVersion: "2.1.330",
    warning: undefined,
  });
  for (const legacy of ["stable", "bundled"]) {
    const res = resolveCliVersion(legacy);
    assert.equal(res.ok, true);
    assert.equal(res.cliVersion, "latest");
    assert.match(res.warning, new RegExp(legacy, "u"));
  }
  assert.equal(resolveCliVersion("v2.1.0").ok, false);
  assert.equal(resolveCliVersion("next").ok, false);
});

test("resolveLabels filters missing, single-quoted and admission labels while honoring priority-field-id", () => {
  assert.equal(isAdmissionLabel("agent-ready"), true);
  assert.equal(isAdmissionLabel("provenance: untrusted"), true);
  assert.equal(isAdmissionLabel("work-class: bug"), true);
  assert.equal(isAdmissionLabel("bug"), false);

  const live = new Set([
    "needs-human",
    "needs-triage",
    "bug",
    "it's-quoted",
    "agent-ready",
    "work-class: small",
  ]);
  const res = resolveLabels({
    live,
    allowedLabels:
      "bug\nbug\npriority: high\nmissing-label\nit's-quoted\nagent-ready\nwork-class: small\n",
    escalationLabel: "needs-human",
    floorLabel: "needs-triage",
    priorityFieldId: "PVTF_123",
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.allowed, ["bug", "priority: high"]);
  assert.equal(res.floor, "needs-triage");
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /missing-label/u);

  // Without priorityFieldId, a missing priority label is skipped and warned.
  const noField = resolveLabels({
    live,
    allowedLabels: "priority: high\n",
    escalationLabel: "needs-human",
    floorLabel: "absent-floor",
    priorityFieldId: "",
  });
  assert.equal(noField.ok, true);
  assert.deepEqual(noField.allowed, []);
  assert.equal(noField.floor, "");
  assert.equal(noField.warnings.length, 2);

  // Missing or admission escalation label fails closed.
  assert.equal(
    resolveLabels({
      live,
      allowedLabels: "",
      escalationLabel: "does-not-exist",
      floorLabel: "",
      priorityFieldId: "",
    }).ok,
    false,
  );
  assert.equal(
    resolveLabels({
      live,
      allowedLabels: "",
      escalationLabel: "agent-ready",
      floorLabel: "",
      priorityFieldId: "",
    }).ok,
    false,
  );
});

test("filterIssueTypes keeps enabled non-quoted non-none types only", () => {
  assert.deepEqual(
    filterIssueTypes([
      { id: "1", name: "Bug", isEnabled: true },
      { id: "2", name: "Disabled", isEnabled: false },
      { id: "3", name: "None", isEnabled: true },
      { id: "4", name: "none ", isEnabled: true },
      { id: "5", name: "Can't", isEnabled: true },
      { id: "6", name: "Feature", isEnabled: true },
    ]),
    [
      { id: "1", name: "Bug", isEnabled: true },
      { id: "6", name: "Feature", isEnabled: true },
    ],
  );
});

test("run writes prompt.md, degrades gracefully on Issue Types GraphQL failure, and sets all outputs", async () => {
  const dir = makeTemporaryDirectory("intake-compose-unit-");
  const outputs = {};
  const warnings = [];
  const failed = [];
  await run({
    github: {
      paginate: async () => [{ name: "needs-human" }, { name: "bug" }],
      graphql: async () => {
        throw new Error("graphql unavailable");
      },
      rest: { issues: { listLabelsForRepo: () => {} } },
    },
    context: { repo: { owner: "o", repo: "r" } },
    core: {
      setOutput: (k, v) => {
        outputs[k] = v;
      },
      warning: (m) => warnings.push(m),
      setFailed: (m) => failed.push(m),
    },
    env: {
      ALLOWED_LABELS: "bug\n",
      ESCALATION_LABEL: "needs-human",
      FLOOR_LABEL: "",
      PRIORITY_FIELD_ID: "",
      BASE_ARGS: "--model sonnet --effort low --max-turns 12",
      CLI_VERSION: "latest",
      REPOSITORY: "o/r",
      ISSUE_NUMBER: "42",
      ISSUE_FILE: "/tmp/issue.json",
      OPEN_ISSUES_FILE: "/tmp/open.txt",
      DUPLICATE_LIMIT: "20",
      MERGED_PULLS_FILE: "/tmp/merged.txt",
      MERGED_LIMIT: "10",
      INSTRUCTIONS: "Extra guidance.",
      RUNNER_TEMP: dir,
    },
  });
  assert.deepEqual(failed, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Issue Types unreadable/u);
  assert.deepEqual(JSON.parse(outputs.allowed), ["bug"]);
  assert.deepEqual(JSON.parse(outputs.types), {});
  assert.deepEqual(JSON.parse(outputs["type-names"]), []);
  assert.equal(outputs["type-instruction"], "");
  assert.equal(outputs.model, "sonnet");
  assert.equal(outputs.effort, "low");
  assert.equal(outputs["max-turns"], "12");
  assert.equal(outputs["cli-version"], "latest");
  assert.match(outputs["started-at"], /^\d+$/u);
  const prompt = fs.readFileSync(outputs["prompt-file"], "utf8");
  assert.equal(
    prompt,
    buildPrompt({
      repository: "o/r",
      issueNumber: "42",
      issueFile: "/tmp/issue.json",
      openIssuesFile: "/tmp/open.txt",
      duplicateLimit: "20",
      mergedPullsFile: "/tmp/merged.txt",
      mergedLimit: "10",
      allowed: ["bug"],
      typeInstruction: "",
      instructions: "Extra guidance.",
    }),
  );
});

test("intake-triage.yml wires build-intake-triage-prompt in every leg and declares every referenced output", () => {
  const workflowText = fs.readFileSync(WORKFLOW_FILE, "utf8");
  const workflow = parseWorkflow(workflowText);
  const action = parseWorkflow(fs.readFileSync(ACTION_FILE, "utf8"));
  const declared = new Set(Object.keys(action.outputs ?? {}));

  for (const jobName of ["claude", "triage-subscription", "triage-fallback"]) {
    const compose = workflow.jobs[jobName].steps.find(
      (s) => s.id === "compose",
    );
    assert.equal(
      compose?.uses,
      "$/.github/actions/build-intake-triage-prompt",
      jobName,
    );
  }
  const referenced = new Set(
    [...workflowText.matchAll(/steps\.compose\.outputs\.([a-z0-9_-]+)/gu)].map(
      (m) => m[1],
    ),
  );
  assert.ok(referenced.size > 0);
  for (const output of referenced) {
    assert.ok(
      declared.has(output),
      `build-intake-triage-prompt/action.yml must declare output '${output}'`,
    );
  }
});
