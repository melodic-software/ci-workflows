"use strict";

// The floor labeler runs on the same `opened` event as the intake-triage
// lane. When it lands after the lane, the event payload is stale, so it must
// decide from the issue's live labels and never re-add a floor the lane
// removed.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(__dirname, "..", "workflows", "intake-label-needs-triage.yml"),
    "utf8",
  ),
);
const script = workflow.jobs["apply-label"].steps[0].with.script;

async function label(liveLabels) {
  const env = {
    TARGET_LABEL: "needs-triage",
    LABEL_PREFIX: "priority:",
    HUMAN_LABEL: "needs-human",
  };
  const original = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  const added = [];
  const failed = [];
  try {
    const github = {
      paginate: async () => {
        if (liveLabels === null) throw new Error("secondary rate limit");
        return liveLabels.map((name) => ({ name }));
      },
      rest: {
        issues: {
          listLabelsOnIssue: () => {},
          getLabel: async () => ({}),
          addLabels: async (request) => added.push(...request.labels),
        },
      },
    };
    const core = {
      info: () => {},
      warning: () => {},
      setFailed: (message) => failed.push(message),
    };
    // The payload is the `opened` snapshot: no labels yet.
    const context = {
      repo: { owner: "o", repo: "r" },
      payload: { issue: { number: 7, labels: [] } },
    };
    await new AsyncFunction("github", "context", "core", "process", script)(
      github,
      context,
      core,
      process,
    );
    return { added, failed };
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("an untriaged issue gets the floor label", async () => {
  const { added, failed } = await label([]);
  assert.deepEqual(added, ["needs-triage"]);
  assert.deepEqual(failed, []);
});

test("an unreadable live label list falls back to the payload and adds the floor", async () => {
  const { added, failed } = await label(null);
  assert.deepEqual(added, ["needs-triage"]);
  assert.deepEqual(failed, []);
});

test("a late run skips an issue the lane already gave a priority", async () => {
  assert.deepEqual((await label(["priority: high"])).added, []);
});

test("a late run skips an issue the lane routed to a person", async () => {
  assert.deepEqual((await label(["needs-human"])).added, []);
});
