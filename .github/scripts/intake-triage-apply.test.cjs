"use strict";

// The intake lane's compose and apply steps decide what reaches the issue.
// These tests run the steps' own scripts against a mock GitHub client: an API
// error is an infrastructure failure the status step reports, so nothing is
// applied, while any other error subtype escalates to a person. A run that
// was not escalated sets the Issue Type and, with exactly one priority label,
// removes the triage floor label (ci-workflows#662).

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
const step = (name) => workflow.jobs.claude.steps.find((s) => s.name === name);
const applyStep = step("Apply the triage");
const composeStep = step("Resolve labels and compose Claude CLI arguments");

const ESCALATION_LABEL = "needs-human";
const FLOOR_LABEL = "needs-triage";
const TYPES = { Bug: "IT_bug", Task: "IT_task" };
const SUCCESS = { type: "result", subtype: "success", num_turns: 3 };

async function runScript(script, env, github) {
  const original = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  const failed = [];
  const warnings = [];
  const outputs = {};
  try {
    const core = {
      summary: { addRaw: () => ({ write: async () => {} }) },
      setFailed: (message) => failed.push(message),
      warning: (message) => warnings.push(message),
      setOutput: (key, value) => {
        outputs[key] = value;
      },
    };
    const context = { repo: { owner: "o", repo: "r" } };
    await new AsyncFunction(
      "github",
      "context",
      "core",
      "require",
      "process",
      script,
    )(github, context, core, require, process);
    return { failed, warnings, outputs };
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// keptType is the type GitHub reports after the mutation; it defaults to the
// requested one, and null models a change GitHub dropped.
async function apply(
  resultMessage,
  {
    output,
    keptType,
    floorLabel = FLOOR_LABEL,
    allowed = ["bug", "priority: high", "priority: low"],
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "intake-apply-"));
  const executionFile = path.join(directory, "execution.json");
  fs.writeFileSync(executionFile, JSON.stringify([resultMessage]));
  const labels = [];
  const removed = [];
  const typeCalls = [];
  const comments = [];
  const github = {
    paginate: async () => [],
    graphql: async (_query, variables) => {
      typeCalls.push(variables);
      const name =
        keptType === undefined
          ? Object.keys(TYPES).find((key) => TYPES[key] === variables.type)
          : keptType;
      return {
        updateIssue: { issue: { issueType: name ? { name } : null } },
      };
    },
    rest: {
      issues: {
        listComments: () => {},
        createComment: async ({ body }) => comments.push(body),
        updateComment: async ({ body }) => comments.push(body),
        addLabels: async (request) => labels.push(...request.labels),
        removeLabel: async ({ name }) => removed.push(name),
      },
    },
  };
  try {
    const { failed, warnings } = await runScript(
      applyStep.with.script,
      {
        STRUCTURED_OUTPUT: output ? JSON.stringify(output) : "",
        EXECUTION_FILE: executionFile,
        ALLOWED: JSON.stringify(allowed),
        TYPES: JSON.stringify(TYPES),
        ESCALATION_LABEL,
        FLOOR_LABEL: floorLabel,
        ISSUE_NUMBER: "7",
        ISSUE_NODE_ID: "I_node7",
        CLI_VERSION: "",
        CLI_PUBLISHED: "",
      },
      github,
    );
    return { labels, removed, typeCalls, comments, failed, warnings };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const triaged = (overrides) => ({
  labels: ["priority: high"],
  comment: "Looks like a bug in the parser.",
  needs_human: false,
  reason: "Reproducible crash.",
  type: "Bug",
  ...overrides,
});

test("an API error is an infrastructure failure, not an escalation", async () => {
  const { labels, comments, failed, typeCalls, removed } = await apply({
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 1,
    api_error_status: 429,
  });
  assert.deepEqual(labels, []);
  assert.deepEqual(comments, []);
  assert.deepEqual(failed, []);
  assert.deepEqual(typeCalls, []);
  assert.deepEqual(removed, []);
});

test("an execution error or max turns escalates to a person", async () => {
  // Issue text can force either, so neither may leave the issue unlabeled.
  for (const subtype of ["error_during_execution", "error_max_turns"]) {
    const { labels, comments, removed } = await apply({
      type: "result",
      subtype,
      is_error: true,
      num_turns: 16,
    });
    assert.deepEqual(labels, [ESCALATION_LABEL], subtype);
    assert.equal(comments.length, 1, subtype);
    assert.match(comments[0], /handed this issue to a maintainer/u, subtype);
    assert.deepEqual(removed, [], subtype);
  }
});

test("a confident run sets the type and removes the floor label", async () => {
  const { labels, typeCalls, removed, failed } = await apply(SUCCESS, {
    output: triaged(),
  });
  assert.deepEqual(labels, ["priority: high"]);
  assert.deepEqual(typeCalls, [{ id: "I_node7", type: "IT_bug" }]);
  assert.deepEqual(removed, [FLOOR_LABEL]);
  assert.deepEqual(failed, []);
});

test("an escalated run sets no type and keeps the floor label", async () => {
  const { labels, typeCalls, removed } = await apply(SUCCESS, {
    output: triaged({ needs_human: true }),
  });
  assert.deepEqual(labels, [ESCALATION_LABEL]);
  assert.deepEqual(typeCalls, []);
  assert.deepEqual(removed, []);
});

test("a type GitHub dropped keeps the floor label and warns", async () => {
  const { typeCalls, removed, warnings } = await apply(SUCCESS, {
    output: triaged(),
    keptType: null,
  });
  assert.equal(typeCalls.length, 1);
  assert.deepEqual(removed, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /did not keep Issue Type 'Bug'/u);
});

test("the floor label stays without exactly one priority label", async () => {
  for (const labels of [["bug"], ["priority: high", "priority: low"]]) {
    const { typeCalls, removed } = await apply(SUCCESS, {
      output: triaged({ labels }),
    });
    assert.equal(typeCalls.length, 1, labels.join(","));
    assert.deepEqual(removed, [], labels.join(","));
  }
});

test("a status or security label keeps the floor label", async () => {
  for (const extra of ["status: needs-info", "area: security"]) {
    const { labels, typeCalls, removed } = await apply(SUCCESS, {
      output: triaged({ labels: ["priority: high", extra] }),
      allowed: ["priority: high", extra],
    });
    assert.ok(labels.includes(extra), extra);
    assert.equal(typeCalls.length, 1, extra);
    assert.deepEqual(removed, [], extra);
  }
});

test("an errored run with structured output sets no type", async () => {
  const { typeCalls, removed } = await apply(
    { type: "result", subtype: "success", is_error: true, num_turns: 3 },
    { output: triaged() },
  );
  assert.deepEqual(typeCalls, []);
  assert.deepEqual(removed, []);
});

test("type none sets nothing and keeps the floor label", async () => {
  const { typeCalls, removed } = await apply(SUCCESS, {
    output: triaged({ type: "none" }),
  });
  assert.deepEqual(typeCalls, []);
  assert.deepEqual(removed, []);
});

test("an empty floor-label never removes a label", async () => {
  const { typeCalls, removed } = await apply(SUCCESS, {
    output: triaged(),
    floorLabel: "",
  });
  assert.equal(typeCalls.length, 1);
  assert.deepEqual(removed, []);
});

async function compose(graphql) {
  const { outputs, warnings } = await runScript(
    composeStep.with.script,
    {
      ALLOWED_LABELS: "priority: high\n",
      ESCALATION_LABEL,
      BASE_ARGS: "--max-turns 15",
    },
    {
      paginate: async () => [{ name: "priority: high" }, { name: ESCALATION_LABEL }],
      graphql,
      rest: { issues: { listLabelsForRepo: () => {} } },
    },
  );
  const schema = JSON.parse(/--json-schema '(.*)'$/u.exec(outputs.args)[1]);
  return { outputs, warnings, schema };
}

test("compose offers the enabled Issue Types plus none", async () => {
  const { outputs, schema } = await compose(async () => ({
    repository: {
      issueTypes: {
        nodes: [
          { id: "IT_bug", name: "Bug", isEnabled: true },
          { id: "IT_old", name: "Epic", isEnabled: false },
          { id: "IT_task", name: "Task", isEnabled: true },
        ],
      },
    },
  }));
  assert.deepEqual(schema.properties.type.enum, ["Bug", "Task", "none"]);
  assert.ok(schema.required.includes("type"));
  assert.deepEqual(JSON.parse(outputs.types), TYPES);
  assert.match(outputs["type-instruction"], /one of Bug, Task/u);
});

test("compose leaves the type out when Issue Types are unreadable", async () => {
  const { outputs, warnings, schema } = await compose(async () => {
    throw new Error("Resource not accessible by integration");
  });
  assert.equal(schema.properties.type, undefined);
  assert.ok(!schema.required.includes("type"));
  assert.equal(outputs.types, "{}");
  assert.equal(outputs["type-instruction"], "");
  assert.equal(warnings.length, 1);
});
