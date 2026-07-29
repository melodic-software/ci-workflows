"use strict";

// The retry gate is the only thing standing between a sporadic infrastructure
// failure and a lane that silently loses its review, so these tests EXECUTE the
// gate's `script:` body against realistic execution-file payloads rather than
// pattern-matching the YAML. A regex over the source cannot tell a reachable
// branch from an unreachable one, which is exactly how the 429 path came to be
// dead: the turn-count guard returned before `api_error_status` was ever read,
// and every regex assertion about the auth predicate still passed.
//
// The payload shapes below are the real wire shapes. An Anthropic API error
// does not end the stream quietly — Claude Code emits a SYNTHETIC assistant
// turn carrying the error as ordinary text (`message.model` is the literal
// `<synthetic>`, plus `error`, `isApiErrorMessage`, and `apiErrorStatus`), and
// only then the result entry. So "an assistant entry exists" is not evidence
// that any work happened, and the gate counts real turns instead.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");

const lanes = [
  {
    workflow: "claude-review.yml",
    step: "Decide whether to retry the review",
    deletesTrackingComment: true,
  },
  {
    workflow: "claude-security-review.yml",
    step: "Decide whether to retry the review",
    deletesTrackingComment: true,
  },
  {
    workflow: "claude-e2e-verify.yml",
    step: "Decide whether to retry the verification",
    deletesTrackingComment: false,
  },
];

// github-script bodies are plain JS with no ${{ }} interpolation, which is what
// makes executing one here faithful rather than an approximation.
function gateScript(workflowName, stepName) {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", workflowName),
    "utf8",
  );
  const start = workflow.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(start, -1, `${workflowName}: step not found: ${stepName}`);
  const rest = workflow.slice(start + 1);
  const next = rest.indexOf("\n      - name: ");
  const step = next === -1 ? rest : rest.slice(0, next);

  const marker = "          script: |\n";
  const scriptStart = step.indexOf(marker);
  assert.notEqual(
    scriptStart,
    -1,
    `${workflowName}: ${stepName} has no literal script block`,
  );
  const lines = step.slice(scriptStart + marker.length).split("\n");
  const end = lines.findIndex(
    (line) => line !== "" && !line.startsWith("            "),
  );
  const body = (end === -1 ? lines : lines.slice(0, end)).join("\n");
  assert.doesNotMatch(
    body,
    /\$\{\{/u,
    `${workflowName}: the gate script interpolates a github expression, so executing it here would not match CI`,
  );
  return body
    .split("\n")
    .map((line) => (line.startsWith("            ") ? line.slice(12) : line))
    .join("\n");
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Returns the gate's decision plus everything it told the operator, so a test
// can assert WHY it decided, not just what it decided.
async function runGate(lane, { executionFile, comments = [] }) {
  const notices = [];
  const deleted = [];
  const outputs = {};
  const core = {
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    notice: (message) => notices.push(message),
    info: () => {},
    warning: (message) => notices.push(message),
  };
  const github = {
    paginate: async () => comments,
    rest: {
      issues: {
        listComments: () => {},
        deleteComment: async ({ comment_id }) => deleted.push(comment_id),
      },
    },
  };
  const context = {
    repo: { owner: "melodic-software", repo: "consumer" },
    runId: 424242,
    payload: { pull_request: { number: 7 } },
  };

  const previous = process.env.EXECUTION_FILE;
  process.env.EXECUTION_FILE = executionFile;
  try {
    const run = new AsyncFunction(
      "core",
      "github",
      "context",
      "require",
      gateScript(lane.workflow, lane.step),
    );
    await run(core, github, context, require);
  } finally {
    if (previous === undefined) delete process.env.EXECUTION_FILE;
    else process.env.EXECUTION_FILE = previous;
  }
  return { retry: outputs.retry, notices, deleted };
}

function withPayload(payload, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "retry-gate-"));
  try {
    const file = path.join(directory, "claude-execution-output.json");
    if (payload !== undefined) {
      fs.writeFileSync(
        file,
        typeof payload === "string" ? payload : JSON.stringify(payload),
      );
    }
    return body(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// The shape observed on every rate-limited attempt: the run died on its first
// API call, so `total_cost_usd` is 0 and the only assistant entry is the
// synthetic error turn. Nothing review-shaped was posted, so attempt 2 cannot
// duplicate anything.
const syntheticErrorTurn = (status) => ({
  type: "assistant",
  message: {
    model: "<synthetic>",
    content: [
      {
        type: "text",
        text: "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
      },
    ],
  },
  error: "rate_limit",
  isApiErrorMessage: true,
  apiErrorStatus: status,
});

const rateLimitedFirstCall = [
  { type: "system", subtype: "init", session_id: "s" },
  { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
  syntheticErrorTurn(429),
  {
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 1,
    duration_ms: 480,
    total_cost_usd: 0,
    api_error_status: 429,
  },
];

// A real turn that called a tool — the case the artifact-safety condition
// exists for. The run still ended on a 429, so the failure class alone cannot
// distinguish it from the payload above; only the turn count can.
const rateLimitedMidReview = [
  { type: "system", subtype: "init", session_id: "s" },
  {
    type: "assistant",
    message: {
      model: "claude-opus-4-5-20260514",
      content: [
        { type: "tool_use", id: "t1", name: "mcp__github__create_review", input: {} },
      ],
      usage: { input_tokens: 12043, output_tokens: 318 },
    },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1" }] },
  },
  syntheticErrorTurn(429),
  {
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 4,
    duration_ms: 96421,
    total_cost_usd: 0.4212,
    api_error_status: 429,
  },
];

for (const lane of lanes) {
  const label = lane.workflow.replace(/\.yml$/u, "");

  test(`${label}: a 429 on the first API call retries`, async () => {
    const result = await withPayload(rateLimitedFirstCall, (file) =>
      runGate(lane, { executionFile: file }),
    );
    assert.equal(
      result.retry,
      "true",
      `the gate declined the dominant failure class: ${result.notices.join(" | ")}`,
    );
  });

  test(`${label}: a 429 after real work does not retry`, async () => {
    const result = await withPayload(rateLimitedMidReview, (file) =>
      runGate(lane, { executionFile: file }),
    );
    assert.equal(result.retry, "false");
    assert.match(
      result.notices.join("\n"),
      /recorded 1 assistant turn\(s\) of real work/u,
      "the refusal must name the real-work count, not the failure class",
    );
  });

  // Every auth status, from both the result entry and the synthetic turn. A
  // retry cannot clear a credential death, so it must never be spent on one.
  for (const status of [401, 402, 403]) {
    test(`${label}: an auth-class ${status} on the result entry does not retry`, async () => {
      const payload = [
        { type: "system", subtype: "init" },
        syntheticErrorTurn(status),
        {
          type: "result",
          subtype: "success",
          is_error: true,
          num_turns: 1,
          total_cost_usd: 0,
          api_error_status: status,
        },
      ];
      const result = await withPayload(payload, (file) =>
        runGate(lane, { executionFile: file }),
      );
      assert.equal(result.retry, "false");
      assert.match(result.notices.join("\n"), /auth-class failure/u);
    });

    // The hole that discounting synthetic turns would otherwise open: the
    // action has a write path that saves the file with NO result entry, so the
    // auth evidence exists only on the synthetic turn.
    test(`${label}: an auth-class ${status} with no result entry does not retry`, async () => {
      const payload = [
        { type: "system", subtype: "init" },
        syntheticErrorTurn(status),
      ];
      const result = await withPayload(payload, (file) =>
        runGate(lane, { executionFile: file }),
      );
      assert.equal(
        result.retry,
        "false",
        "an auth failure recorded only on a synthetic turn must still block the retry",
      );
      assert.match(result.notices.join("\n"), /auth-class failure/u);
    });
  }

  // The status is BOTH a synthetic-turn marker and, when no result entry was
  // written, the only auth signal available. A payload that keeps the other
  // markers but drops the status would discount the turn and blind the auth
  // check in one move, so an unreadable class must refuse rather than default.
  test(`${label}: a synthetic turn with no readable status does not retry`, async () => {
    const payload = [
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "API Error: 401" }],
        },
        error: "auth_error",
      },
    ];
    const result = await withPayload(payload, (file) =>
      runGate(lane, { executionFile: file }),
    );
    assert.equal(
      result.retry,
      "false",
      "a failure whose class cannot be read may be an auth failure",
    );
    assert.match(result.notices.join("\n"), /no failure class could be read/u);
  });

  // Proves zero turns and nothing else. The gate needs both halves.
  test(`${label}: an empty execution array does not retry`, async () => {
    const result = await withPayload([], (file) =>
      runGate(lane, { executionFile: file }),
    );
    assert.equal(result.retry, "false");
    assert.match(result.notices.join("\n"), /no failure class could be read/u);
  });

  test(`${label}: an auth-class error variant does not retry`, async () => {
    // The error subtypes carry `errors[]` instead of `api_error_status`, so the
    // substring pass is the only evidence available.
    const payload = [
      { type: "system", subtype: "init" },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 0,
        errors: [
          'Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        ],
      },
    ];
    const result = await withPayload(payload, (file) =>
      runGate(lane, { executionFile: file }),
    );
    assert.equal(result.retry, "false");
    assert.match(result.notices.join("\n"), /auth-class failure/u);
  });

  // A missing or unparsable file proves nothing. A hard kill (step timeout,
  // OOM) can lose the file AFTER turns were already spent, so absence of
  // evidence must never be read as evidence of zero turns.
  test(`${label}: a missing execution file does not retry`, async () => {
    const result = await withPayload(undefined, (file) =>
      runGate(lane, { executionFile: file }),
    );
    assert.equal(result.retry, "false");
    assert.match(result.notices.join("\n"), /no parseable execution file/u);
  });

  test(`${label}: an unparsable execution file does not retry`, async () => {
    const result = await withPayload("{ this is not json", (file) =>
      runGate(lane, { executionFile: file }),
    );
    assert.equal(result.retry, "false");
    assert.match(result.notices.join("\n"), /no parseable execution file/u);
  });

  test(`${label}: a non-array execution file does not retry`, async () => {
    const result = await withPayload({ type: "result" }, (file) =>
      runGate(lane, { executionFile: file }),
    );
    assert.equal(result.retry, "false");
    assert.match(result.notices.join("\n"), /no parseable execution file/u);
  });

  test(`${label}: an unset execution file path does not retry`, async () => {
    const result = await runGate(lane, { executionFile: "" });
    assert.equal(result.retry, "false");
    assert.match(result.notices.join("\n"), /no parseable execution file/u);
  });

  if (lane.deletesTrackingComment) {
    // track_progress posts its tracking comment before the first assistant
    // turn, so a retried attempt strands an orphan it will not adopt. Scoped by
    // author AND this run's URL: nothing else this run posted exists yet.
    test(`${label}: retrying deletes this run's orphan tracking comment`, async () => {
      const comments = [
        { id: 1, user: { login: "claude[bot]" }, body: "…/actions/runs/424242" },
        { id: 2, user: { login: "claude[bot]" }, body: "…/actions/runs/999" },
        { id: 3, user: { login: "someone" }, body: "…/actions/runs/424242" },
      ];
      const result = await withPayload(rateLimitedFirstCall, (file) =>
        runGate(lane, { executionFile: file, comments }),
      );
      assert.equal(result.retry, "true");
      assert.deepEqual(
        result.deleted,
        [1],
        "only this run's own tracking comment may be deleted",
      );
    });
  }
}

// Actions cannot share code between reusable workflows, so each lane carries
// its own copy of the decision. Divergence would mean one lane retries a
// payload another refuses — asserted, not trusted. Scoped to the decision
// logic: each lane words its own refusal notice for the artifact it posts
// (inline review comments vs a single findings comment), and that copy is
// allowed to differ.
// The evidence guard is its own region: leaving it out is what let the e2e lane
// diverge into retrying on an unprovable file while its siblings refused.
const decisionRegions = [
  ["the evidence guard", "let entries;", "core.notice("],
  ["the real-work count", "const isSyntheticErrorTurn", "if (realTurns > 0) {"],
  ["the auth predicate", "const last = entries.length", "if (auth) {"],
];

test("all three lanes decide from byte-identical logic", () => {
  for (const [label, from, to] of decisionRegions) {
    const regions = lanes.map((lane) => {
      const script = gateScript(lane.workflow, lane.step);
      const start = script.indexOf(from);
      assert.notEqual(start, -1, `${lane.workflow}: ${label} not found`);
      const end = script.indexOf(to, start);
      assert.notEqual(end, -1, `${lane.workflow}: ${label} has no end`);
      return script.slice(start, end);
    });
    for (const [index, region] of regions.entries()) {
      assert.equal(
        region,
        regions[0],
        `${lanes[index].workflow}: ${label} has drifted from its siblings'`,
      );
    }
  }
});
