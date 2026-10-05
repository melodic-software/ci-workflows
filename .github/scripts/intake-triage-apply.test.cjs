"use strict";

// The intake lane's apply step decides what reaches the issue. These tests
// run the step's own script against a mock GitHub client: an API error is an
// infrastructure failure the status step reports, so nothing is applied,
// while any other error subtype escalates to a person.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(__dirname, "..", "workflows", "intake-triage.yml"),
    "utf8",
  ),
);
const applyStep = workflow.jobs.claude.steps.find(
  (step) => step.name === "Apply the triage",
);

const ESCALATION_LABEL = "needs-human";

async function apply(resultMessage) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "intake-apply-"));
  const executionFile = path.join(directory, "execution.json");
  fs.writeFileSync(executionFile, JSON.stringify([resultMessage]));
  const env = {
    STRUCTURED_OUTPUT: "",
    EXECUTION_FILE: executionFile,
    ALLOWED: JSON.stringify(["bug"]),
    ESCALATION_LABEL,
    ISSUE_NUMBER: "7",
    CLI_VERSION: "",
    CLI_PUBLISHED: "",
  };
  const original = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  const labels = [];
  const comments = [];
  const failed = [];
  try {
    const github = {
      paginate: async () => [],
      rest: {
        issues: {
          listComments: () => {},
          createComment: async ({ body }) => comments.push(body),
          updateComment: async ({ body }) => comments.push(body),
          addLabels: async (request) => labels.push(...request.labels),
        },
      },
    };
    const core = {
      summary: { addRaw: () => ({ write: async () => {} }) },
      setFailed: (message) => failed.push(message),
    };
    const context = { repo: { owner: "o", repo: "r" } };
    await new AsyncFunction(
      "github",
      "context",
      "core",
      "require",
      "process",
      applyStep.with.script,
    )(github, context, core, require, process);
    return { labels, comments, failed };
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("an API error is an infrastructure failure, not an escalation", async () => {
  const { labels, comments, failed } = await apply({
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 1,
    api_error_status: 429,
  });
  assert.deepEqual(labels, []);
  assert.deepEqual(comments, []);
  assert.deepEqual(failed, []);
});

test("an execution error or max turns escalates to a person", async () => {
  // Issue text can force either, so neither may leave the issue unlabeled.
  for (const subtype of ["error_during_execution", "error_max_turns"]) {
    const { labels, comments } = await apply({
      type: "result",
      subtype,
      is_error: true,
      num_turns: 16,
    });
    assert.deepEqual(labels, [ESCALATION_LABEL], subtype);
    assert.equal(comments.length, 1, subtype);
    assert.match(comments[0], /handed this issue to a maintainer/u, subtype);
  }
});
