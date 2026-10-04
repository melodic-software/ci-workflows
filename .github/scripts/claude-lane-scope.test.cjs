"use strict";

// Both Claude lanes scope each review: the whole pull request on open, reopen
// and ready, only the files changed since the lane's last completed review on
// a later push, and no review when nothing in scope changed or every file in
// scope is documentation. The last reviewed head travels in a marker comment
// the lane's job token writes on the PR. These tests pin the wiring and run
// the inline github-script steps against a mocked API for every branch of
// that decision.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const workflowsDir = path.join(__dirname, "..", "workflows");

const lanes = [
  { file: "claude-review.yml", job: "review", lane: "claude-review" },
  {
    file: "claude-security-review.yml",
    job: "security-review",
    lane: "claude-security-review",
  },
];

const load = (file) =>
  parseWorkflow(fs.readFileSync(path.join(workflowsDir, file), "utf8"));
const stepNamed = (job, name) => job.steps.find((step) => step.name === name);

const HEAD = "a".repeat(40);
const LAST = "b".repeat(40);
const MB_OLD = "c".repeat(40);
const MB_NEW = "d".repeat(40);
const BOT = "github-actions[bot]";

const file = (filename, extra = {}) => ({
  filename,
  status: "modified",
  ...extra,
});

async function runScript(script, values, github) {
  const outputs = {};
  const messages = [];
  const core = {
    setOutput: (key, value) => {
      outputs[key] = value;
    },
    info: (message) => messages.push(message),
    warning: (message) => messages.push(`warning: ${message}`),
  };
  const saved = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    await new AsyncFunction("require", "github", "context", "core", script)(
      require,
      {
        paginate: async (method, params) => (await method(params)).data,
        ...github,
      },
      { repo: { owner: "o", repo: "r" } },
      core,
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { outputs, messages };
}

// Runs a lane's record step and returns the comment call it made.
async function record(lane, { sha = HEAD, markerId = "" } = {}) {
  const calls = [];
  const capture = (kind) => async (params) => {
    calls.push({ kind, ...params });
    return { data: {} };
  };
  await runScript(
    lane.recordScript,
    { LANE: lane.lane, PR_NUMBER: "7", HEAD_SHA: sha, MARKER_ID: markerId },
    {
      rest: {
        issues: {
          createComment: capture("create"),
          updateComment: capture("update"),
        },
      },
    },
  );
  assert.equal(calls.length, 1);
  return calls[0];
}

// The marker comment the lane's own record step writes for `sha`.
async function markerFor(lane, sha, { id = 41, login = BOT } = {}) {
  const { body } = await record(lane, { sha });
  return { id, user: { login }, body };
}

async function runScope(
  lane,
  { env, prFiles, compares = {}, fail = false, comments = [] },
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scope-"));
  const diffFile = path.join(directory, "state", "incremental.diff");
  let listedComments = 0;
  const github = {
    rest: {
      issues: {
        listComments: async ({ issue_number }) => {
          assert.equal(issue_number, 7);
          listedComments += 1;
          return { data: comments };
        },
      },
      pulls: {
        listFiles: async () => {
          if (fail) throw new Error("listFiles failed");
          return { data: prFiles };
        },
      },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          assert.ok(basehead in compares, `unexpected compare ${basehead}`);
          return { data: compares[basehead] };
        },
      },
    },
  };
  const { outputs, messages } = await runScript(
    lane.script,
    {
      LANE: lane.lane,
      INCREMENTAL: "true",
      DOCS_ONLY_PATHS: "",
      EVENT_ACTION: "synchronize",
      PR_NUMBER: "7",
      HEAD_SHA: HEAD,
      BASE_REF: "main",
      DIFF_FILE: diffFile,
      ...env,
    },
    github,
  );
  const diff = fs.existsSync(diffFile)
    ? fs.readFileSync(diffFile, "utf8")
    : undefined;
  return { outputs, messages, diff, listedComments };
}

// The base did not move between the last review and the head.
const unmovedBase = (since) => ({
  [`${LAST}...${HEAD}`]: { status: "ahead", files: since },
  [`main...${LAST}`]: { merge_base_commit: { sha: MB_OLD } },
  [`main...${HEAD}`]: { merge_base_commit: { sha: MB_OLD } },
});

const [codeLane, securityLane] = lanes.map((lane) => {
  const workflow = load(lane.file);
  const job = workflow.jobs[lane.job];
  return {
    ...lane,
    workflow,
    job,
    script: stepNamed(job, "Scope the review").with.script,
    recordScript: stepNamed(job, "Record the reviewed head").with.script,
  };
});

test("both lanes run the same scope and record scripts", () => {
  assert.equal(codeLane.script, securityLane.script);
  assert.equal(codeLane.recordScript, securityLane.recordScript);
  for (const script of [codeLane.script, codeLane.recordScript]) {
    assert.doesNotMatch(script, /\$\{\{/u);
  }
});

test("each review step leaves its job the measured overhead", () => {
  for (const [lane, step, job] of [
    [codeLane, 11, 13],
    [securityLane, 10, 12],
  ]) {
    const claudeStep = lane.job.steps.find(
      (candidate) => candidate.id === "claude-review",
    );
    assert.equal(claudeStep["timeout-minutes"], step, lane.file);
    assert.equal(lane.job["timeout-minutes"], job, lane.file);
  }
});

for (const lane of [codeLane, securityLane]) {
  const { job, workflow } = lane;

  test(`${lane.file}: the job timeout is 16 minutes or less and outlasts the review step`, () => {
    const claudeStep = job.steps.find((step) =>
      String(step.uses ?? "").startsWith("anthropics/claude-code-action@"),
    );
    assert.ok(job["timeout-minutes"] <= 16);
    assert.ok(claudeStep["timeout-minutes"] < job["timeout-minutes"]);
  });

  test(`${lane.file}: the scope step reads every value through env and fails open`, () => {
    const scope = stepNamed(job, "Scope the review");
    assert.equal(scope.id, "scope");
    assert.equal(scope["continue-on-error"], true);
    assert.match(scope.uses, /^actions\/github-script@[0-9a-f]{40}$/u);
    assert.equal(scope.env.LANE, lane.lane);
    assert.equal(scope.env.INCREMENTAL, `\${{ inputs.incremental-review }}`);
    assert.equal(scope.env.DOCS_ONLY_PATHS, `\${{ inputs.docs-only-paths }}`);
    assert.equal(scope.env.EVENT_ACTION, `\${{ github.event.action }}`);
    assert.equal(
      scope.env.HEAD_SHA,
      `\${{ github.event.pull_request.head.sha }}`,
    );
    assert.equal(
      workflow.on.workflow_call.inputs["incremental-review"].default,
      true,
    );
  });

  test(`${lane.file}: the reviewed head lives in the lane's PR comment, never the Actions cache`, () => {
    const save = stepNamed(job, "Record the reviewed head");
    assert.match(save.uses, /^actions\/github-script@[0-9a-f]{40}$/u);
    assert.equal(save["continue-on-error"], true);
    assert.equal(save.env.LANE, lane.lane);
    assert.equal(save.env.MARKER_ID, `\${{ steps.scope.outputs.marker-id }}`);
    assert.equal(
      save.env.HEAD_SHA,
      `\${{ github.event.pull_request.head.sha }}`,
    );
    assert.match(save.if, /steps\.scope\.outputs\.record == 'true'/u);
    assert.match(
      save.if,
      /steps\.review-outcome\.outputs\.review-ran == 'true'/u,
    );
    assert.ok(
      job.steps.every(
        (step) => !String(step.uses ?? "").startsWith("actions/cache"),
      ),
    );
    assert.deepEqual(job.permissions, {
      contents: "read",
      "pull-requests": "write",
      "id-token": "write",
    });
  });

  test(`${lane.file}: a not-needed review skips every review step and the prompt carries the scope note`, () => {
    for (const name of [
      "Compose Claude CLI arguments",
      "Report review outcome",
    ]) {
      assert.equal(
        stepNamed(job, name).if,
        "steps.scope.outputs.review != 'false'",
      );
    }
    const claudeStep = job.steps.find((step) => step.id === "claude-review");
    assert.equal(claudeStep.if, "steps.scope.outputs.review != 'false'");
    assert.match(
      claudeStep.with.prompt,
      /^\$\{\{ steps\.scope\.outputs\.note \}\}$/mu,
    );
  });

  test(`${lane.file}: the record step creates the marker once, then updates it`, async () => {
    const created = await record(lane);
    assert.equal(created.kind, "create");
    assert.equal(created.issue_number, 7);
    assert.match(
      created.body,
      new RegExp(
        `^<!-- claude-lane-reviewed-head lane=${lane.lane} sha=a{40} -->\n`,
        "u",
      ),
    );
    const updated = await record(lane, { markerId: "41" });
    assert.equal(updated.kind, "update");
    assert.equal(updated.comment_id, 41);
  });

  test(`${lane.file}: a push reads back the head its own record step wrote`, async () => {
    const result = await runScope(lane, {
      prFiles: [file("src/a.js")],
      compares: unmovedBase([file("src/a.js", { patch: "@@ -1 +1 @@" })]),
      comments: [await markerFor(lane, LAST)],
    });
    assert.equal(result.outputs["marker-id"], "41");
    assert.match(result.outputs.note, /last reviewed b{40}/u);
  });
}

test("a marker from another author or another lane is ignored", async () => {
  for (const comments of [
    [await markerFor(codeLane, LAST, { login: "someone" })],
    [await markerFor(securityLane, LAST)],
  ]) {
    const result = await runScope(codeLane, {
      prFiles: [file("src/a.js")],
      comments,
    });
    assert.equal(result.outputs.review, "true");
    assert.equal(result.outputs.note, undefined);
    assert.equal(result.outputs["marker-id"], undefined);
  }
});

test("the newest of several markers wins", async () => {
  const older = await markerFor(codeLane, "e".repeat(40), { id: 40 });
  const newer = await markerFor(codeLane, LAST, { id: 42 });
  const result = await runScope(codeLane, {
    prFiles: [file("src/a.js")],
    compares: unmovedBase([file("src/a.js")]),
    comments: [older, newer],
  });
  assert.equal(result.outputs["marker-id"], "42");
  assert.match(result.outputs.note, /last reviewed b{40}/u);
});

test("opened, reopened and ready_for_review review the whole pull request and record the head", async () => {
  for (const action of ["opened", "reopened", "ready_for_review"]) {
    const result = await runScope(codeLane, {
      env: { EVENT_ACTION: action },
      prFiles: [file("src/a.js")],
      comments: [await markerFor(codeLane, LAST)],
    });
    assert.equal(result.outputs.review, "true");
    assert.equal(result.outputs.note, undefined);
    assert.equal(result.outputs.record, "true");
    assert.equal(result.outputs["marker-id"], "41");
  }
});

test("a push with no recorded review reviews the whole pull request", async () => {
  const result = await runScope(codeLane, {
    prFiles: [file("src/a.js")],
  });
  assert.equal(result.outputs.review, "true");
  assert.equal(result.outputs.note, undefined);
  assert.ok(
    result.messages.some((message) =>
      /no earlier review is recorded/u.test(message),
    ),
  );
});

test("a push reviews only the pull request's files changed since the last review", async () => {
  const result = await runScope(codeLane, {
    prFiles: [
      file("src/a.js"),
      file("src/b.js"),
      file("src/new.js", { previous_filename: "src/old.js" }),
    ],
    compares: unmovedBase([
      file("src/a.js", { patch: "@@ -1 +1 @@\n-x\n+y" }),
      file("src/old.js"),
      file("unrelated.txt"),
    ]),
    comments: [await markerFor(codeLane, LAST)],
  });
  assert.equal(result.outputs.review, "true");
  assert.match(
    result.outputs.note,
    /^REVIEW SCOPE: incremental\. This lane last reviewed b{40}\./mu,
  );
  assert.match(result.outputs.note, /^- src\/a\.js$/mu);
  assert.match(result.outputs.note, /^- src\/new\.js$/mu);
  assert.doesNotMatch(result.outputs.note, /src\/b\.js|unrelated/u);
  assert.match(
    result.diff,
    /^diff --git a\/src\/a\.js b\/src\/a\.js\nstatus: modified\n@@ -1 \+1 @@/mu,
  );
  assert.match(result.diff, /no patch from the API/u);
  assert.equal(result.outputs.record, "true");
});

test("a push that changes no file of the pull request is not reviewed again", async () => {
  const result = await runScope(codeLane, {
    prFiles: [file("src/a.js")],
    compares: unmovedBase([file("elsewhere.js")]),
    comments: [await markerFor(codeLane, LAST)],
  });
  assert.equal(result.outputs.review, "false");
  assert.match(
    result.outputs["skip-reason"],
    /no file of this pull request changed since the review of b{40}/u,
  );
});

test("a re-run of a head already reviewed is not reviewed again", async () => {
  const result = await runScope(codeLane, {
    prFiles: [file("src/a.js")],
    comments: [await markerFor(codeLane, HEAD)],
  });
  assert.equal(result.outputs.review, "false");
});

test("a base merge that changed a file of the pull request forces a whole review", async () => {
  const result = await runScope(codeLane, {
    prFiles: [file("src/a.js"), file("src/b.js")],
    compares: {
      [`${LAST}...${HEAD}`]: {
        status: "ahead",
        files: [file("src/a.js"), file("src/b.js")],
      },
      [`main...${LAST}`]: { merge_base_commit: { sha: MB_OLD } },
      [`main...${HEAD}`]: { merge_base_commit: { sha: MB_NEW } },
      [`${MB_OLD}...${MB_NEW}`]: {
        files: [file("src/b.js"), file("other.js")],
      },
    },
    comments: [await markerFor(codeLane, LAST)],
  });
  assert.equal(result.outputs.review, "true");
  assert.equal(result.outputs.note, undefined);
  assert.ok(
    result.messages.some((message) =>
      /base-branch merge .* changed a file this pull request changes/u.test(
        message,
      ),
    ),
  );
});

test("a base merge of 300 or more files forces a whole review and says so", async () => {
  const result = await runScope(codeLane, {
    prFiles: [file("src/a.js")],
    compares: {
      [`${LAST}...${HEAD}`]: { status: "ahead", files: [file("src/a.js")] },
      [`main...${LAST}`]: { merge_base_commit: { sha: MB_OLD } },
      [`main...${HEAD}`]: { merge_base_commit: { sha: MB_NEW } },
      [`${MB_OLD}...${MB_NEW}`]: {
        files: Array.from({ length: 300 }, (_, i) => file(`base${i}`)),
      },
    },
    comments: [await markerFor(codeLane, LAST)],
  });
  assert.equal(result.outputs.note, undefined);
  assert.ok(
    result.messages.some((message) =>
      /changed 300 or more files/u.test(message),
    ),
  );
});

test("a base merge that changed only other files keeps the review incremental", async () => {
  const result = await runScope(codeLane, {
    prFiles: [file("src/a.js"), file("src/b.js")],
    compares: {
      [`${LAST}...${HEAD}`]: {
        status: "ahead",
        files: [file("src/a.js"), file("other.js")],
      },
      [`main...${LAST}`]: { merge_base_commit: { sha: MB_OLD } },
      [`main...${HEAD}`]: { merge_base_commit: { sha: MB_NEW } },
      [`${MB_OLD}...${MB_NEW}`]: { files: [file("other.js")] },
    },
    comments: [await markerFor(codeLane, LAST)],
  });
  assert.match(result.outputs.note, /^- src\/a\.js$/mu);
  assert.doesNotMatch(result.outputs.note, /src\/b\.js|other\.js/u);
});

test("a rewritten history or 300 or more changed files forces a whole review", async () => {
  for (const [since, reason] of [
    [{ status: "diverged", files: [] }, /is not an ancestor/u],
    [
      {
        status: "ahead",
        files: Array.from({ length: 300 }, (_, i) => file(`f${i}`)),
      },
      /300 or more files changed since/u,
    ],
  ]) {
    const result = await runScope(codeLane, {
      prFiles: [file("src/a.js")],
      compares: { [`${LAST}...${HEAD}`]: since },
      comments: [await markerFor(codeLane, LAST)],
    });
    assert.equal(result.outputs.review, "true");
    assert.equal(result.outputs.note, undefined);
    assert.ok(result.messages.some((message) => reason.test(message)));
  }
});

test("a changed file the API returns no patch for forces a whole review", async () => {
  const result = await runScope(codeLane, {
    prFiles: [file("src/a.js"), file("img.png"), file("src/c.js")],
    compares: unmovedBase([
      file("img.png", { changes: 0 }),
      file("src/c.js", { changes: 0, previous_filename: "src/b.js" }),
      file("src/a.js", { changes: 4000 }),
    ]),
    comments: [await markerFor(codeLane, LAST)],
  });
  assert.equal(result.outputs.note, undefined);
  assert.ok(
    result.messages.some((message) => /no patch for src\/a\.js/u.test(message)),
  );
});

test("a binary or pure-rename change without a patch stays incremental", async () => {
  const result = await runScope(codeLane, {
    prFiles: [file("img.png"), file("src/c.js")],
    compares: unmovedBase([
      file("img.png", { changes: 0 }),
      file("src/c.js", { changes: 0, previous_filename: "src/b.js" }),
    ]),
    comments: [await markerFor(codeLane, LAST)],
  });
  assert.match(result.outputs.note, /^- img\.png$/mu);
  assert.match(result.diff, /no patch from the API/u);
});

test("299 changed files still review incrementally", async () => {
  const since = Array.from({ length: 299 }, (_, i) => file(`f${i}`));
  const result = await runScope(codeLane, {
    prFiles: [file("f0")],
    compares: unmovedBase(since),
    comments: [await markerFor(codeLane, LAST)],
  });
  assert.match(result.outputs.note, /^- f0$/mu);
});

test("an API failure reviews the whole pull request with a warning", async () => {
  const result = await runScope(codeLane, {
    prFiles: [],
    fail: true,
    comments: [await markerFor(codeLane, LAST)],
  });
  assert.equal(result.outputs.review, "true");
  assert.ok(
    result.messages.some((message) =>
      /^warning: Scoping failed/u.test(message),
    ),
  );
  assert.equal(result.outputs.record, "true");
});

test("incremental-review false neither reads, narrows nor records", async () => {
  const result = await runScope(codeLane, {
    env: { INCREMENTAL: "false" },
    prFiles: [file("src/a.js")],
    comments: [await markerFor(codeLane, LAST)],
  });
  assert.equal(result.outputs.review, "true");
  assert.equal(result.outputs.record, undefined);
  assert.equal(result.listedComments, 0);
});

test("the security lane's default docs-only paths skip documentation, not code or agent instructions", async () => {
  const docs =
    securityLane.workflow.on.workflow_call.inputs["docs-only-paths"].default;
  assert.equal(
    codeLane.workflow.on.workflow_call.inputs["docs-only-paths"].default,
    "",
  );
  const decide = async (filenames) =>
    (
      await runScope(securityLane, {
        env: { DOCS_ONLY_PATHS: docs, EVENT_ACTION: "opened" },
        prFiles: filenames.map((name) => file(name)),
      })
    ).outputs;
  const skipped = await decide([
    "README.md",
    "plugins/x/README.md",
    "plugins/x/CHANGELOG.md",
    "docs/adr/0001-a.md",
    "docs/guide.md",
  ]);
  assert.equal(skipped.review, "false");
  assert.equal(
    skipped["skip-reason"],
    "every file in scope matches docs-only-paths",
  );
  for (const filenames of [
    ["docs/guide.md", "src/a.js"],
    ["plugins/x/skills/y/SKILL.md"],
    ["CLAUDE.md"],
    ["docs/records.json"],
    ["plugins/docs/notes.md"],
  ]) {
    assert.equal(
      (await decide(filenames)).review,
      "true",
      filenames.join(", "),
    );
  }
});

test("a caller's wider docs-only-paths never skips agent instructions", async () => {
  const decide = async (filenames) =>
    (
      await runScope(securityLane, {
        env: { DOCS_ONLY_PATHS: "**/*.md", EVENT_ACTION: "opened" },
        prFiles: filenames.map((name) => file(name)),
      })
    ).outputs.review;
  assert.equal(await decide(["README.md", "docs/a.md"]), "false");
  for (const name of [
    "CLAUDE.md",
    "CLAUDE.local.md",
    "GEMINI.md",
    "sub/AGENTS.md",
    "plugins/x/skills/y/SKILL.md",
    "plugins/x/skills/y/reference/notes.md",
    ".claude/rules/a.md",
    "plugins/x/agents/a.md",
    "plugins/x/commands/c.md",
    ".github/copilot-instructions.md",
  ]) {
    assert.equal(await decide(["README.md", name]), "true", name);
  }
});

test("a rename into the documentation paths still reviews the source it came from", async () => {
  const result = await runScope(securityLane, {
    env: { DOCS_ONLY_PATHS: "docs/**/*.md", EVENT_ACTION: "opened" },
    prFiles: [file("docs/moved.md", { previous_filename: "src/run.sh" })],
  });
  assert.equal(result.outputs.review, "true");
});
