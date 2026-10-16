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
  let summary = "";
  try {
    const core = {
      summary: {
        addRaw: (text) => {
          summary = text;
          return { write: async () => {} };
        },
      },
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
    return { failed, warnings, outputs, summary };
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
    escalationLabel = ESCALATION_LABEL,
    allowed = ["bug", "priority: high", "priority: low"],
    labelsFail = false,
    typeFails = false,
    floorDeleted = false,
    floorAbsent = false,
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
      if (typeFails) throw new Error("type write failed");
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
        addLabels: async (request) => {
          if (labelsFail) throw new Error("label write failed");
          labels.push(...request.labels);
        },
        removeLabel: async ({ name }) => {
          if (floorAbsent)
            throw Object.assign(new Error("Not Found"), { status: 404 });
          removed.push(name);
        },
        getLabel: async () => {
          if (floorDeleted)
            throw Object.assign(new Error("Not Found"), { status: 404 });
          return {};
        },
      },
    },
  };
  try {
    const { failed, warnings, summary } = await runScript(
      applyStep.with.script,
      {
        STRUCTURED_OUTPUT: output ? JSON.stringify(output) : "",
        EXECUTION_FILE: executionFile,
        ALLOWED: JSON.stringify(allowed),
        TYPES: JSON.stringify(TYPES),
        CLASSES: JSON.stringify([
          "work-class: scoped",
          "work-class: structural",
        ]),
        ESCALATION_LABEL: escalationLabel,
        FLOOR_LABEL: floorLabel,
        ISSUE_NUMBER: "7",
        ISSUE_NODE_ID: "I_node7",
        CLI_VERSION: "",
        CLI_PUBLISHED: "",
      },
      github,
    );
    return { labels, removed, typeCalls, comments, failed, warnings, summary };
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
    assert.deepEqual(labels, [ESCALATION_LABEL, FLOOR_LABEL], subtype);
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

test("a usable escalated triage sets the type, proposes the class and removes the floor", async () => {
  // apply-outcome.md: the human-gated role label replaces the raw marker, and
  // a lane barred from stamping a class proposes it in the comment.
  const { labels, typeCalls, removed, comments } = await apply(SUCCESS, {
    output: triaged({
      needs_human: true,
      proposed_class: "work-class: scoped",
    }),
  });
  assert.deepEqual(labels, [ESCALATION_LABEL]);
  assert.deepEqual(typeCalls, [{ id: "I_node7", type: "IT_bug" }]);
  assert.deepEqual(removed, [FLOOR_LABEL]);
  // The class an escalated run chose may have been steered by the issue
  // text, so the proposal line a rule evaluator reads records none.
  assert.equal(comments[0].split("\n")[1], "Proposed work class: none");
  assert.match(comments[0], /\nUnconfirmed model suggestion: work-class: scoped\n/u);
  assert.doesNotMatch(comments[0], /Looks like a bug/u);
});

test("an escalated triage with no type keeps the floor and proposes nothing", async () => {
  const { labels, typeCalls, removed, comments } = await apply(SUCCESS, {
    output: triaged({
      needs_human: true,
      type: "none",
      proposed_class: "work-class: scoped",
    }),
  });
  assert.deepEqual(labels, [ESCALATION_LABEL, FLOOR_LABEL]);
  assert.deepEqual(typeCalls, []);
  assert.deepEqual(removed, []);
  assert.equal(comments[0].split("\n")[1], "Proposed work class: none");
  assert.doesNotMatch(comments[0], /work-class: scoped/u);
});

test("a confident run proposes the class on the comment's second line", async () => {
  // The proposal is recorded on every run, not only on escalation, so a rule
  // evaluator has a durable record to read.
  const { labels, comments } = await apply(SUCCESS, {
    output: triaged({ proposed_class: "work-class: structural" }),
  });
  assert.deepEqual(labels, ["priority: high"]);
  const lines = comments[0].split("\n");
  assert.equal(lines[0], "<!-- claude-lane intake-triage -->");
  assert.equal(lines[1], "Proposed work class: work-class: structural");
  assert.match(comments[0], /Looks like a bug in the parser\./u);
});

test("model text never takes the proposal line", async () => {
  // The model's comment comes after the line this script writes, so a
  // proposal the model types into its comment is never read as the lane's.
  const { comments } = await apply(SUCCESS, {
    output: triaged({
      comment: "Proposed work class: work-class: scoped",
      proposed_class: "none",
    }),
  });
  assert.equal(comments[0].split("\n")[1], "Proposed work class: none");
});

test("a run with no comment and no class still rewrites the proposal line", async () => {
  // A rerun must replace an earlier run's proposal, even when it says nothing.
  const { comments } = await apply(SUCCESS, {
    output: triaged({ comment: "", proposed_class: "none" }),
  });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].split("\n")[1], "Proposed work class: none");
});

test("a confident run with no class still records none", async () => {
  const { comments } = await apply(SUCCESS, { output: triaged() });
  assert.equal(comments[0].split("\n")[1], "Proposed work class: none");
});

test("a permission denial keeps the floor even with a typed output", async () => {
  const { labels, typeCalls, removed } = await apply(
    { ...SUCCESS, permission_denials: [{ tool_name: "Bash" }] },
    { output: triaged() },
  );
  assert.deepEqual(labels, [ESCALATION_LABEL, FLOOR_LABEL]);
  assert.deepEqual(typeCalls, []);
  assert.deepEqual(removed, []);
});

test("a class outside the repository's work classes is not proposed", async () => {
  const { comments } = await apply(SUCCESS, {
    output: triaged({ needs_human: true, proposed_class: "agent-ready" }),
  });
  assert.equal(comments[0].split("\n")[1], "Proposed work class: none");
  assert.doesNotMatch(comments[0], /agent-ready/u);
});

test("a confident run never applies a work class or agent-ready, even when allowed", async () => {
  const { labels } = await apply(SUCCESS, {
    output: triaged({
      labels: ["priority: high", "work-class: scoped", "agent-ready"],
      proposed_class: "work-class: scoped",
    }),
    allowed: ["priority: high", "work-class: scoped", "agent-ready"],
  });
  assert.deepEqual(labels, ["priority: high"]);
});

test("a floor label the run applied as its escalation label stays", async () => {
  const { labels, removed } = await apply(SUCCESS, {
    output: triaged({ needs_human: true }),
    escalationLabel: FLOOR_LABEL,
  });
  assert.deepEqual(labels, [FLOOR_LABEL]);
  assert.deepEqual(removed, []);
});

test("a failed label write on an escalation sets no type and keeps the floor", async () => {
  const { typeCalls, removed, failed } = await apply(SUCCESS, {
    output: triaged({ needs_human: true }),
    labelsFail: true,
  });
  assert.deepEqual(typeCalls, []);
  assert.deepEqual(removed, []);
  assert.equal(failed.length, 1);
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
  // The floor labeler skips an issue that already has a priority, so when it
  // lands after the lane the lane must have put the floor on itself.
  const { labels, typeCalls, removed } = await apply(SUCCESS, {
    output: triaged({ type: "none" }),
  });
  assert.deepEqual(typeCalls, []);
  assert.deepEqual(removed, []);
  assert.deepEqual(labels, ["priority: high", FLOOR_LABEL]);
});

test("a failed type write still adds the floor and fails the job", async () => {
  // Two priorities is not routed, so a late floor labeler would skip it.
  const { labels, failed } = await apply(SUCCESS, {
    output: triaged({ labels: ["priority: high", "priority: low"] }),
    typeFails: true,
  });
  assert.deepEqual(labels, ["priority: high", "priority: low", FLOOR_LABEL]);
  assert.equal(failed.length, 1);
});

test("a floor label deleted since compose is not created", async () => {
  const { labels, warnings, failed } = await apply(SUCCESS, {
    output: triaged({ type: "none" }),
    floorDeleted: true,
  });
  assert.deepEqual(labels, ["priority: high"]);
  assert.ok(warnings.some((w) => /no longer exists/u.test(w)));
  assert.deepEqual(failed, []);
});

test("a floor already gone is not reported as removed", async () => {
  const removedRun = await apply(SUCCESS, { output: triaged() });
  assert.match(removedRun.summary, /- Floor label: removed/u);
  const goneRun = await apply(SUCCESS, {
    output: triaged(),
    floorAbsent: true,
  });
  assert.match(goneRun.summary, /- Floor label: unchanged/u);
  assert.deepEqual(goneRun.labels, ["priority: high"]);
  assert.deepEqual(goneRun.failed, []);
});

test("an infrastructure failure leaves the floor to the labeler", async () => {
  const { labels } = await apply({ ...SUCCESS, is_error: true });
  assert.deepEqual(labels, []);
});

test("an empty floor-label never removes a label", async () => {
  const { typeCalls, removed } = await apply(SUCCESS, {
    output: triaged(),
    floorLabel: "",
  });
  assert.equal(typeCalls.length, 1);
  assert.deepEqual(removed, []);
});

async function compose(graphql, env = {}) {
  const { outputs, warnings } = await runScript(
    composeStep.with.script,
    {
      ALLOWED_LABELS: "priority: high\n",
      ESCALATION_LABEL,
      BASE_ARGS: "--max-turns 15",
      ...env,
    },
    {
      paginate: async () => [
        { name: "priority: high" },
        { name: ESCALATION_LABEL },
        { name: "work-class: scoped" },
        { name: "agent-ready" },
        { name: FLOOR_LABEL },
      ],
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
  assert.deepEqual(schema.properties.proposed_class.enum, [
    "work-class: scoped",
    "none",
  ]);
  assert.deepEqual(JSON.parse(outputs.classes), ["work-class: scoped"]);
  assert.match(
    outputs["type-instruction"],
    /proposed_class: .*one of work-class: scoped/u,
  );
});

test("compose drops an Issue Type that collides with the none sentinel", async () => {
  const { outputs, schema } = await compose(async () => ({
    repository: {
      issueTypes: {
        nodes: [
          { id: "IT_bug", name: "Bug", isEnabled: true },
          { id: "IT_none", name: "None", isEnabled: true },
          { id: "IT_none2", name: "none", isEnabled: true },
        ],
      },
    },
  }));
  assert.deepEqual(schema.properties.type.enum, ["Bug", "none"]);
  assert.deepEqual(JSON.parse(outputs.types), { Bug: "IT_bug" });
});

test("compose turns floor handling off for a floor label the repository lacks", async () => {
  const graphql = async () => ({ repository: null });
  const present = await compose(graphql, { FLOOR_LABEL });
  assert.equal(present.outputs.floor, FLOOR_LABEL);
  const absent = await compose(graphql, { FLOOR_LABEL: "triage-me" });
  assert.equal(absent.outputs.floor, "");
  assert.ok(absent.warnings.some((w) => /triage-me/u.test(w)));
});

test("compose rejects an admission label as the floor label", async () => {
  for (const floor of ["agent-ready", "work-class: scoped"]) {
    const { failed, outputs } = await runScript(
      composeStep.with.script,
      {
        ALLOWED_LABELS: "",
        ESCALATION_LABEL,
        FLOOR_LABEL: floor,
        BASE_ARGS: "",
      },
      {
        paginate: async () => [{ name: ESCALATION_LABEL }, { name: floor }],
        graphql: async () => ({ repository: null }),
        rest: { issues: { listLabelsForRepo: () => {} } },
      },
    );
    assert.equal(failed.length, 1, floor);
    assert.equal(outputs.floor, undefined, floor);
  }
});

test("compose never offers admission labels to the model", async () => {
  const { outputs } = await compose(async () => ({ repository: null }), {
    ALLOWED_LABELS: "priority: high\nwork-class: scoped\nagent-ready\n",
  });
  assert.deepEqual(JSON.parse(outputs.allowed), ["priority: high"]);
});

test("compose leaves the type out when Issue Types are unreadable", async () => {
  const { outputs, warnings, schema } = await compose(async () => {
    throw new Error("Resource not accessible by integration");
  });
  assert.equal(schema.properties.type, undefined);
  assert.ok(!schema.required.includes("type"));
  assert.equal(outputs.types, "{}");
  assert.doesNotMatch(outputs["type-instruction"], /type: the issue's kind/u);
  assert.equal(warnings.length, 1);
});
