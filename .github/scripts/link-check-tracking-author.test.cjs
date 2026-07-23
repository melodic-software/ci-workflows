"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const workflowPath = path.join(
  __dirname,
  "..",
  "workflows",
  "link-check.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");

// Same inline-script extraction technique the standards-sync github-script
// tests use: pull the "Find existing tracking issue" step's body out of the
// YAML by name and run it directly against mock issues.
function extractLookupScript() {
  const lines = workflow.split(/\r?\n/u);
  const stepIndex = lines.findIndex((line) =>
    line.includes("- name: Find existing tracking issue"),
  );
  assert.notEqual(stepIndex, -1, "lookup step must exist");
  const scriptIndex = lines.findIndex(
    (line, index) => index > stepIndex && /^ {10}script: \|$/u.test(line),
  );
  assert.notEqual(scriptIndex, -1, "lookup script block must exist");
  const body = [];
  for (let index = scriptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return body.join("\n");
}

const lookupScript = extractLookupScript();

const ISSUE_TITLE = "Link checker report";
const ISSUE_LABELS = "automated, link-check";
const ISSUE_AUTHOR_LOGIN = "github-actions[bot]";

function markerFor(title) {
  const reportKey = crypto
    .createHash("sha256")
    .update(title, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `<!-- ci-workflows:link-check:v1:active:${reportKey} -->`;
}

const MARKER = markerFor(ISSUE_TITLE);

// A tracking issue as GitHub's REST API returns it. Defaults describe the
// legitimate case: authored by the workflow's own bot identity.
function issue({
  number = 1,
  body = "",
  title = "unrelated",
  login = ISSUE_AUTHOR_LOGIN,
  type = "Bot",
  pullRequest = false,
} = {}) {
  return {
    number,
    body,
    title,
    user: { login, type },
    ...(pullRequest ? { pull_request: {} } : {}),
  };
}

async function runLookup(openIssues) {
  const keys = ["ISSUE_TITLE", "ISSUE_LABELS", "ISSUE_AUTHOR_LOGIN"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { ISSUE_TITLE, ISSUE_LABELS, ISSUE_AUTHOR_LOGIN });
  const outputs = {};
  let failedWith = null;
  try {
    const github = {
      // The author filter under test is applied in JS after this fetch, so the
      // mock returns the supplied issues verbatim (the real label filter is a
      // separate, already-tested constraint).
      paginate: async () => openIssues,
      rest: { issues: { listForRepo: {} } },
    };
    const core = {
      setOutput: (key, value) => (outputs[key] = value),
      setFailed: (message) => (failedWith = message),
    };
    const context = { repo: { owner: "melodic-software", repo: "example" } };
    const execute = new AsyncFunction(
      "github",
      "core",
      "context",
      "require",
      "process",
      lookupScript,
    );
    await execute(github, core, context, require, process);
    return { outputs, failedWith };
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test("a marker match authored by the workflow's own bot identity is adopted", async () => {
  const { outputs, failedWith } = await runLookup([
    issue({ number: 42, body: `prefix ${MARKER} suffix` }),
  ]);
  assert.equal(failedWith, null);
  assert.equal(outputs["issue-number"], "42");
});

test("a decoy carrying the marker but authored by a user is not adopted", async () => {
  const { outputs, failedWith } = await runLookup([
    issue({
      number: 99,
      body: `prefix ${MARKER} suffix`,
      login: "attacker",
      type: "User",
    }),
  ]);
  assert.equal(failedWith, null);
  assert.equal(outputs["issue-number"], "");
});

test("a decoy carrying the marker but authored by a different bot is not adopted", async () => {
  const { outputs, failedWith } = await runLookup([
    issue({
      number: 77,
      body: `prefix ${MARKER} suffix`,
      login: "dependabot[bot]",
      type: "Bot",
    }),
  ]);
  assert.equal(failedWith, null);
  assert.equal(outputs["issue-number"], "");
});

test("a title-fallback decoy authored by a user is not adopted", async () => {
  const { outputs, failedWith } = await runLookup([
    issue({
      number: 55,
      body: "no marker here",
      title: ISSUE_TITLE,
      login: "attacker",
      type: "User",
    }),
  ]);
  assert.equal(failedWith, null);
  assert.equal(outputs["issue-number"], "");
});

test("a title-fallback match authored by the own bot identity is adopted", async () => {
  const { outputs, failedWith } = await runLookup([
    issue({ number: 7, body: "no marker here", title: ISSUE_TITLE }),
  ]);
  assert.equal(failedWith, null);
  assert.equal(outputs["issue-number"], "7");
});

test("a decoy cannot trip the fail-closed ambiguity guard to suppress a real report", async () => {
  // A real bot-authored marker issue plus a user decoy carrying the same
  // marker: without the author filter the duplicate would fail the lookup
  // closed and drop the real report. The decoy is filtered out first, so the
  // one legitimate issue is still adopted.
  const { outputs, failedWith } = await runLookup([
    issue({ number: 10, body: MARKER }),
    issue({ number: 11, body: MARKER, login: "attacker", type: "User" }),
  ]);
  assert.equal(failedWith, null);
  assert.equal(outputs["issue-number"], "10");
});

test("two genuinely own-authored marker matches still fail closed", async () => {
  const { outputs, failedWith } = await runLookup([
    issue({ number: 1, body: MARKER }),
    issue({ number: 2, body: MARKER }),
  ]);
  assert.match(failedWith ?? "", /reconcile them manually/u);
  assert.equal(outputs["issue-number"], undefined);
});

test("a pull request authored by the own bot identity is never adopted", async () => {
  const { outputs, failedWith } = await runLookup([
    issue({ number: 9, body: MARKER, pullRequest: true }),
  ]);
  assert.equal(failedWith, null);
  assert.equal(outputs["issue-number"], "");
});
