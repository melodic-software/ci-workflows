"use strict";

// The apply-review-hold action: pr-review-cli's add-only hold step. A fake
// GitHub records every call and throws on any label removal or replacement;
// a stand-in publish gate flags an Anthropic-key shape.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { namesPull, run } = require("../actions/apply-review-hold/hold.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");

const root = makeTemporaryDirectory("apply-review-hold-");
const gate = path.join(root, "publish-gate.mjs");
fs.writeFileSync(
  gate,
  `export const findSecret = (text) =>
  /sk-ant-[A-Za-z0-9_-]{20,}/.test(text)
    ? ["Anthropic key", 1]
    : /password\\s*=\\s*"[^"]{8,}"/.test(text)
      ? ["password or secret assignment", 1]
      : null;
`,
);
// Key-shaped, built at run time so no scanner reads a key in this file.
const FAKE_KEY = ["sk", "ant", "api03", "x".repeat(26)].join("-");
const HEAD = "a".repeat(40);
const OPENED = "2026-10-23T10:00:00Z";
const OWNER_ID = 153232337;
const TRUST_PATHS = [
  ".github/standards/trusted-actors/**",
  ".github/actions/check-trusted-trigger/**",
  "**/CODEOWNERS",
  "**/.gitmodules",
].join("\n");

// This lane's earlier runs, in the REST shapes the hold step reads
// (docs.github.com/en/rest/actions/workflow-runs: workflow_runs[].id,
// head_sha, created_at, head_repository.full_name, and a run's workflow_id,
// path, event, head_branch; /rest/actions/workflow-jobs: jobs[].id, name,
// completed_at; /rest/checks/runs#list-check-run-annotations:
// annotation_level, message; /rest/repos/repos#list-repository-activities:
// after, timestamp). The default is one run at HEAD whose status job
// recorded a cost hold notice at 11:00, before the 12:00 decision, with HEAD
// pushed at 10:45.
const RUN_ID = 99;
const RUN_PATH = ".github/workflows/pr-review-hosted.yml";
const STATUS_JOB = "Publish Review";
const FORMER_NAMES = ["Status", "review-status"];
const STATUS_JOB_LEGACY = FORMER_NAMES.join(",");
const laneRun = ({
  id = 11,
  sha = "a".repeat(40),
  createdAt = "2026-10-23T10:50:00Z",
  repo = "o/r",
} = {}) => ({
  id,
  head_sha: sha,
  created_at: createdAt,
  head_repository: { full_name: repo },
});
const statusJob = ({
  id = 111,
  name = `PR Review / ${STATUS_JOB}`,
  completedAt = "2026-10-23T11:00:00Z",
} = {}) => ({ id, name, completed_at: completedAt });
const notice = ({
  sha = "a".repeat(40),
  lane = "claude-review",
  criteria = "cost",
  level = "notice",
} = {}) => ({
  annotation_level: level,
  message: `claude-lane-hold lane=${lane} sha=${sha} criteria=${criteria} label=needs-human`,
});
const push = (after, timestamp = "2026-10-23T10:45:00Z") => ({
  after,
  timestamp,
});
const laneOf = ({
  current = {},
  runs = [laneRun()],
  jobs = { 11: [statusJob()] },
  annotations = { 111: [notice()] },
  activity = [push("a".repeat(40))],
  link,
} = {}) => ({
  current: {
    id: RUN_ID,
    workflow_id: 5,
    path: RUN_PATH,
    event: "pull_request",
    head_branch: "feat/cost",
    head_repository: { full_name: "o/r" },
    ...current,
  },
  runs,
  jobs,
  annotations,
  activity,
  link,
});

// `comments` are the pull request's (#7); `issueComments` maps another
// issue number to its comments; `pull` is the GraphQL pull request;
// `edited` holds the node ids of edited comments; `failEdited` those whose
// edit read fails; `pullNumbers` the numbers
// that are pull requests, not issues; `misnumbered` the numbers whose read
// answers another number; `compares` maps a basehead to its compare
// response data; `deletions` the created_at of each COMMENT_DELETED_EVENT
// on the pull request, `deletedItems` a raw timelineItems answer in their
// place, and `failDeleted` fails that read. `lane` holds this lane's
// earlier runs (laneOf); `fail.run`, `fail.runs`, `fail.jobs`,
// `fail.annotations` and `fail.activity` fail those reads.
function fakeGithub({
  lane = laneOf(),
  files = [],
  changedFiles,
  comments = [],
  fail = {},
  issueComments = {},
  pull = {
    createdAt: OPENED,
    body: "",
    closingIssuesReferences: { totalCount: 0, nodes: [] },
  },
  edited = new Set(),
  failEdited = new Set(),
  pullNumbers = new Set([7]),
  misnumbered = new Set(),
  compares = {},
  deletions = [],
  deletedItems,
  failDeleted = false,
}) {
  const calls = [];
  const refuse = (name) => () => {
    throw new Error(`${name} must never be called`);
  };
  const github = {
    calls,
    graphql: async (query, variables) => {
      calls.push(["graphql", variables]);
      if (/lastEditedAt/u.test(query) && failEdited.has(variables.id))
        throw new Error("HTTP 502");
      if (/COMMENT_DELETED_EVENT/u.test(query)) {
        if (failDeleted) throw new Error("HTTP 502");
        return {
          repository: {
            pullRequest: {
              timelineItems:
                deletedItems !== undefined
                  ? deletedItems
                  : {
                      filteredCount: deletions.length,
                      nodes: deletions.map((createdAt) => ({ createdAt })),
                    },
            },
          },
        };
      }
      if (/lastEditedAt/u.test(query))
        return {
          node: {
            lastEditedAt: edited.has(variables.id)
              ? "2026-10-24T00:00:00Z"
              : null,
          },
        };
      return { repository: { pullRequest: pull } };
    },
    paginate: async (method, params) => method(params),
    // The activity a page at a time: per_page entries from the `after`
    // cursor, and a Link header with rel="prev" and, while entries remain,
    // rel="next" carrying the next cursor.
    request: async (route, params) => {
      calls.push(["activity", params]);
      if (route !== "GET /repos/{owner}/{repo}/activity")
        throw new Error(`unexpected request ${route}`);
      if (fail.activity)
        throw new Error(
          typeof fail.activity === "string" ? fail.activity : "HTTP 502",
        );
      if (!Array.isArray(lane.activity))
        return { data: lane.activity, headers: {} };
      const start = Number(String(params.after ?? "c0").slice(1));
      const end = start + params.per_page;
      const url = (cursor) =>
        `https://api.github.com/repositories/1/activity?ref=refs%2Fheads%2Ffeat%2Fcost&per_page=100&${cursor}`;
      const links = [`<${url(`before=c${start}`)}>; rel="prev"`];
      if (end < lane.activity.length)
        links.push(`<${url(`after=c${end}`)}>; rel="next"`);
      // `lane.link`, when set, is the Link header verbatim ("" for none).
      return {
        data: lane.activity.slice(start, end),
        headers: { link: lane.link ?? links.join(", ") },
      };
    },
    rest: {
      actions: {
        getWorkflowRun: async (params) => {
          calls.push(["getWorkflowRun", params]);
          if (fail.run) throw new Error("HTTP 502");
          return { data: lane.current };
        },
        listWorkflowRuns: (params) => {
          calls.push(["listWorkflowRuns", params]);
          if (fail.runs) throw new Error("HTTP 502");
          if (params.created === undefined) return lane.runs;
          // A lane listing: the runs created in the range, both ends
          // included, and with per_page 1 the response's total_count.
          const [from, to] = params.created.split("..").map(Date.parse);
          const inRange = lane.runs.filter((r) => {
            const at = Date.parse(r.created_at);
            return at >= from && at <= to;
          });
          return params.per_page === 1
            ? { data: { total_count: inRange.length } }
            : inRange;
        },
        listJobsForWorkflowRun: (params) => {
          calls.push(["listJobs", params]);
          if (fail.jobs) throw new Error("HTTP 502");
          return lane.jobs[params.run_id] ?? [];
        },
      },
      checks: {
        listAnnotations: (params) => {
          calls.push(["listAnnotations", params]);
          if (fail.annotations) throw new Error("HTTP 502");
          return lane.annotations[params.check_run_id] ?? [];
        },
      },
      repos: {
        compareCommitsWithBasehead: async (params) => {
          calls.push(["compare", params]);
          if (fail.compare) throw new Error("HTTP 404");
          // The default answer for HEAD vets the notice run's head: one
          // file, no review-lane workflow.
          const answers = {
            [`main...${HEAD}`]: {
              status: "ahead",
              files: [
                {
                  filename: "src/app.js",
                  status: "modified",
                  patch: "@@ -1 +1 @@\n-a\n+b",
                },
              ],
            },
            ...compares,
          };
          if (!(params.basehead in answers))
            throw new Error(`unexpected compare ${params.basehead}`);
          return { data: answers[params.basehead] };
        },
      },
      pulls: {
        listFiles: (params) => {
          calls.push(["listFiles", params]);
          if (fail.listFiles) throw new Error("HTTP 502");
          return files.map((f) =>
            typeof f === "string" ? { filename: f } : f,
          );
        },
        get: async (params) => {
          calls.push(["get", params]);
          return {
            data: { changed_files: changedFiles ?? files.length, ...lane.pr },
          };
        },
        // A lane run's pull requests from the head branch (laneShape).
        list: (params) => {
          calls.push(["listPulls", params]);
          if (fail.pulls) throw new Error("HTTP 502");
          return lane.pulls ?? [];
        },
      },
      issues: {
        addLabels: async (params) => {
          calls.push(["addLabels", params]);
          if (fail.addLabels)
            throw new Error("HTTP 403 Resource not accessible");
          return { data: [] };
        },
        listComments: (params) => {
          calls.push(["listComments", params]);
          return params.issue_number === 7
            ? comments
            : (issueComments[params.issue_number] ?? []);
        },
        get: async (params) => {
          calls.push(["issues.get", params]);
          if (misnumbered.has(params.issue_number))
            return { data: { number: params.issue_number + 1 } };
          return {
            data: pullNumbers.has(params.issue_number)
              ? { number: params.issue_number, pull_request: {} }
              : { number: params.issue_number },
          };
        },
        createComment: async (params) => {
          calls.push(["createComment", params]);
          if (fail.createComment) throw new Error("HTTP 500");
          return { data: { id: 701, body: params.body } };
        },
        removeLabel: refuse("removeLabel"),
        removeAllLabels: refuse("removeAllLabels"),
        setLabels: refuse("setLabels"),
        deleteLabel: refuse("deleteLabel"),
        updateLabel: refuse("updateLabel"),
      },
    },
  };
  return github;
}

function fakeCore() {
  const core = { outputs: {}, warnings: [], notices: [], infos: [] };
  core.setOutput = (k, v) => {
    core.outputs[k] = v;
  };
  core.warning = (m) => core.warnings.push(m);
  core.notice = (m) => core.notices.push(m);
  core.info = (m) => core.infos.push(m);
  return core;
}

const review = (extra = {}) =>
  JSON.stringify({
    findings: 0,
    coverage: { read: 1, changed: 1 },
    summary: "S",
    comments: [],
    ...extra,
  });

const baseEnv = (extra = {}) => ({
  HOLD_LABEL: "needs-human",
  HOLD_PATHS: TRUST_PATHS,
  LANE_ID: "claude-review",
  STATUS_JOB,
  STATUS_JOB_LEGACY,
  PR_NUMBER: "7",
  HEAD_SHA: HEAD,
  BASE_REF: "main",
  PUBLISH_GATE: gate,
  SUB_RESULT: "skipped",
  KEY_PRESENT: "true",
  KEY_FAILED: "false",
  KEY_CLASS: "",
  KEY_VERDICT: "complete",
  KEY_REVIEW: review(),
  ...extra,
});

async function apply(env, options = {}) {
  const github = fakeGithub(options);
  const core = fakeCore();
  let error;
  try {
    await run({
      github,
      context: { repo: { owner: "o", repo: "r" }, runId: RUN_ID },
      core,
      env,
    });
  } catch (e) {
    error = e;
  }
  const writes = github.calls.filter(([name]) =>
    ["addLabels", "createComment"].includes(name),
  );
  return { github, core, error, writes };
}

test("an empty hold-label does nothing: no read, no write, hold false", async () => {
  const { github, core, error } = await apply(
    baseEnv({
      HOLD_LABEL: "",
      KEY_REVIEW: review({ hold: { criteria: ["cost"], reason: "R" } }),
    }),
    { files: ["CODEOWNERS"] },
  );
  assert.equal(error, undefined);
  assert.deepEqual(github.calls, []);
  assert.deepEqual(core.outputs, { hold: "false", criteria: "" });
});

test("no hold from the review and no matching path writes nothing", async () => {
  const { core, error, writes } = await apply(baseEnv(), {
    files: ["src/a.js", "docs/CODEOWNERS.md"],
  });
  assert.equal(error, undefined);
  assert.deepEqual(writes, []);
  assert.deepEqual(core.outputs, { hold: "false", criteria: "" });
});

test("the review's hold adds the label and one marker comment with the reason", async () => {
  const { core, error, writes } = await apply(
    baseEnv({
      KEY_REVIEW: review({
        hold: {
          criteria: ["critical-security", "cost"],
          reason: "Spends<!-- hidden --> money.",
        },
      }),
    }),
    { files: ["src/a.js"] },
  );
  assert.equal(error, undefined);
  assert.deepEqual(core.outputs, {
    hold: "true",
    criteria: "cost,critical-security",
  });
  assert.deepEqual(writes[0], [
    "addLabels",
    { owner: "o", repo: "r", issue_number: 7, labels: ["needs-human"] },
  ]);
  const body = writes[1][1].body;
  assert.equal(
    body.split("\n")[0],
    `<!-- claude-lane-hold lane=claude-review sha=${HEAD} criteria=cost,critical-security -->`,
  );
  assert.match(body, /Spends money\./u);
  assert.doesNotMatch(body, /hidden/u);
  assert.match(body, /\nclaude-lane: claude-review$/u);
  assert.equal(writes.length, 2);
});

// Owner decision Q52: a trusted path is a reason for extra security
// scrutiny, never a stop by itself. Only the security review's CRITICAL
// finding (critical-security) or a real-charge cost hold stops a pull request.
test("a changed file matching hold-paths holds nothing and reads no file list", async () => {
  for (const [file, failed] of [
    ["CODEOWNERS", false],
    [".github/CODEOWNERS", false],
    ["vendor/x/.gitmodules", false],
    [".github/standards/trusted-actors/trusted-actors.json", false],
    [{ filename: "moved.txt", previous_filename: ".gitmodules" }, false],
    [".github/actions/check-trusted-trigger/action.yml", true],
  ]) {
    const env = failed
      ? baseEnv({ KEY_FAILED: "true", KEY_CLASS: "timeout", KEY_REVIEW: "" })
      : baseEnv({ KEY_REVIEW: review({ hold: undefined }) });
    const { core, error, writes, github } = await apply(env, {
      files: ["src/a.js", file],
    });
    assert.equal(error, undefined, JSON.stringify(file));
    assert.deepEqual(core.outputs, { hold: "false", criteria: "" });
    assert.deepEqual(writes, []);
    assert.deepEqual(github.calls, [], JSON.stringify(file));
  }
});

test("a model trust-gate criterion alone holds nothing; the others still hold", async () => {
  const alone = await apply(
    baseEnv({
      KEY_REVIEW: review({
        hold: { criteria: ["trust-gate"], reason: "Touches CODEOWNERS." },
      }),
    }),
    { files: ["CODEOWNERS"] },
  );
  assert.equal(alone.error, undefined);
  assert.deepEqual(alone.core.outputs, { hold: "false", criteria: "" });
  assert.deepEqual(alone.writes, []);
  assert.match(alone.core.infos.join("\n"), /trust-gate is not a hold/u);
  const security = await apply(
    baseEnv({
      KEY_REVIEW: review({
        hold: { criteria: ["trust-gate", "critical-security"], reason: "R" },
      }),
    }),
    { files: ["CODEOWNERS"] },
  );
  assert.equal(security.core.outputs.criteria, "critical-security");
  assert.match(security.writes[1][1].body, /criteria=critical-security -->/u);
  const binary = await apply(
    baseEnv({
      KEY_REVIEW: review({
        hold: { criteria: ["binary-artifact"], reason: "R" },
      }),
    }),
    { files: ["CODEOWNERS"] },
  );
  assert.equal(binary.core.outputs.criteria, "binary-artifact");
  assert.match(binary.writes[1][1].body, /criteria=binary-artifact -->/u);
  const cost = await apply(
    baseEnv({
      KEY_REVIEW: review({ hold: { criteria: ["cost"], reason: "R" } }),
    }),
    { files: ["CODEOWNERS"] },
  );
  assert.equal(cost.core.outputs.criteria, "cost");
});

test("a file list shorter than the pull request's changed files holds nothing", async () => {
  const { core } = await apply(baseEnv(), {
    files: ["src/a.js"],
    changedFiles: 3001,
  });
  assert.deepEqual(core.outputs, { hold: "false", criteria: "" });
});

test("the subscription leg's review counts when it ran", async () => {
  const { core } = await apply(
    baseEnv({
      SUB_RESULT: "success",
      SUB_PRESENT: "true",
      SUB_FAILED: "false",
      SUB_CLASS: "",
      SUB_VERDICT: "complete",
      SUB_REVIEW: review({ hold: { criteria: ["cost"], reason: "R" } }),
    }),
    { files: ["src/a.js"] },
  );
  assert.equal(core.outputs.criteria, "cost");
});

test("a failed label write fails the step and the marker is still tried", async () => {
  const { error, github } = await apply(
    baseEnv({
      KEY_REVIEW: review({
        hold: { criteria: ["critical-security"], reason: "R" },
      }),
    }),
    {
      fail: { addLabels: true },
    },
  );
  assert.match(error.message, /could not add the needs-human label/u);
  assert.ok(github.calls.some(([name]) => name === "createComment"));
});

test("a failed comment fails the step", async () => {
  const comment = await apply(
    baseEnv({
      KEY_REVIEW: review({
        hold: { criteria: ["critical-security"], reason: "R" },
      }),
    }),
    {
      fail: { createComment: true },
    },
  );
  assert.match(comment.error.message, /could not post the hold comment/u);
});

test("a rerun posts no second marker for the same head and criteria", async () => {
  const marker = `<!-- claude-lane-hold lane=claude-review sha=${HEAD} criteria=critical-security -->`;
  const { writes } = await apply(
    baseEnv({
      KEY_REVIEW: review({
        hold: { criteria: ["critical-security"], reason: "R" },
      }),
    }),
    {
      comments: [
        { user: { login: "someone" }, body: "x" },
        { user: { login: "github-actions[bot]" }, body: `${marker}\nwhy` },
      ],
    },
  );
  assert.deepEqual(
    writes.map(([name]) => name),
    ["addLabels"],
  );
});

test("a credential-shaped reason is withheld but the hold still applies", async () => {
  const { writes, core } = await apply(
    baseEnv({
      KEY_REVIEW: review({ hold: { criteria: ["cost"], reason: FAKE_KEY } }),
    }),
    { files: [] },
  );
  assert.equal(writes[0][0], "addLabels");
  assert.doesNotMatch(writes[1][1].body, /sk-ant/u);
  assert.match(writes[1][1].body, /withheld: Anthropic key/u);
  assert.equal(core.warnings.length, 1);
});

test("the hold step never names a label removal or replacement API", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "actions", "apply-review-hold", "hold.cjs"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /removeLabel|removeAllLabels|setLabels|deleteLabel|updateLabel|\bDELETE\b|\bPUT\b/u,
  );
});

test("a warn-only hit in the reason posts it with a warning", async () => {
  const { writes, core } = await apply(
    baseEnv({
      KEY_REVIEW: review({
        hold: { criteria: ["cost"], reason: 'password = "hunter2hunter2"' },
      }),
    }),
    { files: [] },
  );
  assert.match(writes[1][1].body, /hunter2hunter2/u);
  assert.deepEqual(core.warnings, [
    "claude-review: password or secret assignment in the hold reason; published anyway.",
  ]);
});

// A cost decision binds to the pull request and covers the net diff it was
// made at: the head of this lane's newest cost hold marker before it. It
// carries a line link to its owner-decisions row and the owner's words.
const ROW =
  "https://github.com/melodic-software/architecture/blob/main/docs/owner-decisions.md#L42";
const QUOTE = 'verbatim: "approve the larger runner"';
const recorded = (text) =>
  `**Decision recorded.** Cost: ${text}\n\nRow: ${ROW}\n${QUOTE}`;
const decision = ({
  id = 1,
  userId = OWNER_ID,
  body = recorded("approve the larger runner."),
  createdAt = "2026-10-23T12:00:00Z",
  type = "User",
  app = null,
} = {}) => ({
  id,
  node_id: `IC_${id}`,
  user: { login: userId === OWNER_ID ? "owner" : "someone", id: userId, type },
  performed_via_github_app: app,
  created_at: createdAt,
  body,
});
const costEnv = (criteria = ["cost"], extra = {}) =>
  baseEnv({
    TRUSTED_AUTHOR_IDS: String(OWNER_ID),
    KEY_REVIEW: review({ hold: { criteria, reason: "It adds a schedule." } }),
    ...extra,
  });
// This lane's hold marker, posted by github-actions[bot] before the decision.
const marker = ({
  id = 100,
  sha = HEAD,
  criteria = "cost",
  lane = "claude-review",
  createdAt = "2026-10-23T11:00:00Z",
  login = "github-actions[bot]",
} = {}) => ({
  id,
  node_id: `IC_${id}`,
  user: { login, type: "Bot" },
  created_at: createdAt,
  body: `<!-- claude-lane-hold lane=${lane} sha=${sha} criteria=${criteria} -->\n**${lane}** holds this pull request.`,
});
const refsPull = (body) => ({
  createdAt: OPENED,
  body,
  closingIssuesReferences: { totalCount: 0, nodes: [] },
});

test("a cost decision on the pull request keeps the cost hold from coming back", async () => {
  const { core, error, writes, github } = await apply(costEnv(), {
    comments: [decision()],
  });
  assert.equal(error, undefined);
  assert.equal(core.outputs.hold, "false");
  assert.deepEqual(writes, []);
  // The lookup's reads, the pull request's comments and the decision's edit
  // check, then this lane's earlier runs: the current run (for the
  // workflow and branch), the runs, the vet compare of the run's head, its
  // jobs, the status job's annotations and the branch's push history. The
  // head is the decided head, so no second compare.
  assert.deepEqual(
    github.calls.map(([name]) => name),
    [
      "listComments",
      "graphql",
      "getWorkflowRun",
      "listWorkflowRuns",
      "compare",
      "listJobs",
      "listAnnotations",
      "activity",
    ],
  );
  const read = (name) => github.calls.find(([n]) => n === name)[1];
  assert.deepEqual(read("getWorkflowRun"), {
    owner: "o",
    repo: "r",
    run_id: RUN_ID,
  });
  assert.deepEqual(read("listWorkflowRuns"), {
    owner: "o",
    repo: "r",
    workflow_id: 5,
    event: "pull_request",
    branch: "feat/cost",
    per_page: 100,
  });
  assert.deepEqual(read("listJobs"), {
    owner: "o",
    repo: "r",
    run_id: 11,
    filter: "all",
    per_page: 100,
  });
  assert.deepEqual(read("listAnnotations"), {
    owner: "o",
    repo: "r",
    check_run_id: 111,
    per_page: 100,
  });
  assert.deepEqual(read("activity"), {
    owner: "o",
    repo: "r",
    ref: "refs/heads/feat/cost",
    direction: "desc",
    per_page: 100,
  });
  assert.equal(read("compare").basehead, `main...${HEAD}`);
});

test("a cost decision on the Refs issue that names the pull request keeps the cost hold off", async () => {
  const { core, writes, github } = await apply(costEnv(), {
    pull: refsPull("Refs: #9436\n\n## Summary"),
    issueComments: {
      9436: [decision({ body: recorded("approved for #7.") })],
    },
  });
  assert.equal(core.outputs.hold, "false");
  assert.deepEqual(writes, []);
  assert.deepEqual(
    github.calls.map(([name]) => name),
    [
      "listComments",
      "graphql",
      "issues.get",
      "listComments",
      "graphql",
      "getWorkflowRun",
      "listWorkflowRuns",
      "compare",
      "listJobs",
      "listAnnotations",
      "activity",
    ],
  );
});

test("a cost decision on the closing issue that names the pull request keeps the cost hold off", async () => {
  const { core } = await apply(costEnv(), {
    pull: {
      createdAt: OPENED,
      body: "Closes #9436",
      closingIssuesReferences: {
        totalCount: 1,
        nodes: [{ number: 9436, repository: { nameWithOwner: "O/R" } }],
      },
    },
    issueComments: {
      9436: [decision({ body: recorded("yes, #7.") })],
    },
  });
  assert.equal(core.outputs.hold, "false");
});

test("a cost decision on the Refs issue that names another pull request still holds", async () => {
  const { core, writes } = await apply(costEnv(), {
    pull: refsPull("Refs: #9436"),
    issueComments: {
      9436: [decision({ body: recorded("approved for #70.") })],
    },
  });
  assert.equal(core.outputs.hold, "true");
  assert.equal(core.outputs.criteria, "cost");
  assert.equal(writes.length, 2);
});

test("a cost decision by anyone but a trusted person still holds", async () => {
  for (const comment of [
    decision({ userId: 42 }),
    decision({ type: "Bot" }),
    decision({ app: { slug: "lanes" } }),
  ]) {
    const { core } = await apply(costEnv(), { comments: [comment] });
    assert.equal(core.outputs.hold, "true", JSON.stringify(comment.user));
  }
  // With no trusted ids nobody's decision counts.
  const { core } = await apply(costEnv(["cost"], { TRUSTED_AUTHOR_IDS: "" }), {
    comments: [decision()],
  });
  assert.equal(core.outputs.hold, "true");
});

test("an edited, quoted, older or non-cost decision still holds", async () => {
  for (const [name, options] of [
    ["edited", { comments: [decision()], edited: new Set(["IC_1"]) }],
    ["quoted", { comments: [decision({ body: `> ${recorded("yes")}` })] }],
    [
      "not a cost decision",
      {
        comments: [
          decision({
            body: `**Decision recorded.** Option 2.\n\n${ROW}\n${QUOTE}`,
          }),
        ],
      },
    ],
    [
      "older than the pull request",
      {
        pull: refsPull("Refs: #9436"),
        issueComments: {
          9436: [
            decision({
              body: recorded("#7"),
              createdAt: "2026-10-22T00:00:00Z",
            }),
          ],
        },
      },
    ],
    [
      "a Refs line naming a pull request",
      {
        pull: refsPull("Refs: #9436"),
        pullNumbers: new Set([7, 9436]),
        issueComments: {
          9436: [decision({ body: recorded("#7") })],
        },
      },
    ],
    [
      "a Refs read that answers another number",
      {
        pull: refsPull("Refs: #9436"),
        misnumbered: new Set([9436]),
        issueComments: {
          9436: [decision({ body: recorded("#7") })],
        },
      },
    ],
    [
      "two Refs issues",
      {
        pull: refsPull("Refs: #9436\nRefs: #9437"),
        issueComments: {
          9436: [decision({ body: recorded("#7") })],
        },
      },
    ],
  ]) {
    const { core } = await apply(costEnv(), options);
    assert.equal(core.outputs.hold, "true", name);
  }
});

test("a cost decision counts only with its owner-decisions row and the owner's words", async () => {
  const head = "**Decision recorded.** Cost: approve the larger runner.";
  const pinned = `https://github.com/melodic-software/architecture/blob/${"a".repeat(40)}/docs/owner-decisions.md?plain=1#L7`;
  const counted = await apply(costEnv(), {
    comments: [decision({ body: `${head}\n${pinned}\nverbatim:"yes"` })],
  });
  assert.equal(counted.core.outputs.hold, "false", "both present");
  const row = /lacks a link to its row in the owner-decisions record/u;
  const quote = /lacks the owner's words quoted verbatim/u;
  for (const [name, body, why] of [
    ["row missing", `${head}\n${QUOTE}`, row],
    ["quote missing", `${head}\n${ROW}`, quote],
    ["row in an HTML comment", `${head}\n<!-- ${ROW} -->\n${QUOTE}`, row],
    ["quote in an HTML comment", `${head}\n${ROW}\n<!-- ${QUOTE} -->`, quote],
    ["an empty quote", `${head}\n${ROW}\nverbatim: ""`, quote],
    [
      "a row of another record",
      `${head}\n${ROW.replace("owner-decisions", "decisions")}\n${QUOTE}`,
      row,
    ],
    [
      "a row with no line",
      `${head}\n${ROW.replace("#L42", "")}\n${QUOTE}`,
      row,
    ],
    [
      "both missing",
      head,
      /lacks a link to its row in the owner-decisions record \(.*\) and the owner's words quoted verbatim/u,
    ],
  ]) {
    const { core, github } = await apply(costEnv(), {
      comments: [decision({ body })],
    });
    assert.equal(core.outputs.hold, "true", name);
    assert.match(core.infos.join("\n"), why, name);
    assert.equal(
      github.calls.some(([n]) => n === "getWorkflowRun"),
      false,
      name,
    );
  }
});

test("the newest cost decision lacking a row is not replaced by an older complete one", async () => {
  const { core } = await apply(costEnv(), {
    comments: [
      decision({ id: 1, createdAt: "2026-10-23T12:00:00Z" }),
      decision({
        id: 2,
        createdAt: "2026-10-23T12:30:00Z",
        body: `**Decision recorded.** Cost: yes.\n${QUOTE}`,
      }),
    ],
  });
  assert.equal(core.outputs.hold, "true");
  assert.match(core.infos.join("\n"), /lacks a link to its row/u);
});

test("a carried cost decision leaves only critical-security to hold", async () => {
  const both = await apply(costEnv(["cost", "trust-gate"]), {
    comments: [decision()],
  });
  assert.equal(both.core.outputs.hold, "false");
  const byPath = await apply(costEnv(), {
    comments: [decision()],
    files: ["CODEOWNERS"],
  });
  assert.equal(byPath.core.outputs.hold, "false");
  assert.deepEqual(byPath.writes, []);
  const security = await apply(costEnv(["cost", "critical-security"]), {
    comments: [decision()],
  });
  assert.equal(security.core.outputs.criteria, "critical-security");
});

test("a hold with no cost criterion reads no cost decision", async () => {
  const { github } = await apply(costEnv(["critical-security"]), {
    comments: [decision()],
  });
  assert.ok(!github.calls.some(([name]) => name === "graphql"));
  assert.equal(
    github.calls.filter(([name]) => name === "listComments").length,
    1,
  );
});

// The same cases merge-holds.mjs namesPull reads, so both halves agree.
test("a decision names the pull request as #<number> the way merge-holds reads it", () => {
  for (const [text, named] of [
    ["approved for #7.", true],
    ["#7", true],
    ["(#7)", true],
    ["##7", false],
    ["&#7;", false],
    ["#70", false],
    ["#77", false],
    ["o/r#7", false],
    ["x.#7", false],
    ["x-#7", false],
    ["a#7", false],
    ["_#7", false],
  ])
    assert.equal(namesPull(text, 7), named, text);
});

// #9436, option d: the owner lifted the cost hold at head A (the decided
// head, from this lane's cost marker before the decision); at head B the
// review holds for cost again. The decision carries only when compare
// main...A and main...B list the same files with the same status,
// previous_filename and patch. The fixtures are hand-written compare
// responses in GitHub's shape (docs.github.com/en/rest/commits/commits
// #compare-two-commits: files[].filename, status, previous_filename, patch).
const LATER = "b".repeat(40);
const APP_PATCH =
  "@@ -10,3 +10,4 @@ function main() {\n   start();\n+  log();\n   stop();";
const WORKFLOW_PATCH =
  "@@ -3,3 +3,3 @@ on:\n concurrency:\n-  group: old\n+  group: new";
const prFile = (extra = {}) => ({
  filename: "src/app.js",
  status: "modified",
  sha: "1".repeat(40),
  patch: APP_PATCH,
  ...extra,
});
const workflowFile = (extra = {}) => ({
  filename: ".github/workflows/ci.yml",
  status: "modified",
  sha: "2".repeat(40),
  patch: WORKFLOW_PATCH,
  ...extra,
});
const atDecided = [prFile(), workflowFile()];
const manyFiles = Array.from({ length: 300 }, (_, i) =>
  prFile({ filename: `f${i}.js` }),
);
const carryCase = (laterFiles, options = {}) =>
  apply(costEnv(["cost"], { HEAD_SHA: LATER }), {
    comments: [decision()],
    compares: {
      [`main...${HEAD}`]: { status: "ahead", files: atDecided },
      [`main...${LATER}`]: { status: "ahead", files: laterFiles },
    },
    ...options,
  });
const compares = (github) =>
  github.calls
    .filter(([name]) => name === "compare")
    .map(([, p]) => p.basehead);

test("a base-only merge that leaves the pull request's patches alone carries the decision", async () => {
  // The base changed src/app.js below the hunk, so the blob sha moved and
  // the patch did not.
  const { core, writes, github } = await carryCase([
    prFile({ sha: "3".repeat(40) }),
    workflowFile(),
  ]);
  assert.equal(core.outputs.hold, "false");
  assert.deepEqual(writes, []);
  assert.deepEqual(compares(github), [`main...${HEAD}`, `main...${LATER}`]);
  assert.match(
    core.infos.join("\n"),
    /the recorded cost decision carries \(the net diff against main is the same/u,
  );
});

test("a rebase onto a newer base with the same patches carries the decision", async () => {
  const renamedThen = {
    filename: "lib/b.js",
    previous_filename: "lib/a.js",
    status: "renamed",
    patch: "@@ -1 +1 @@\n-a\n+b",
  };
  const { core } = await apply(costEnv(["cost"], { HEAD_SHA: LATER }), {
    comments: [decision()],
    compares: {
      [`main...${HEAD}`]: { status: "ahead", files: [renamedThen, prFile()] },
      // Listed in another order, with new blob shas: still the same diff.
      [`main...${LATER}`]: {
        status: "ahead",
        files: [
          prFile({ sha: "4".repeat(40) }),
          { ...renamedThen, sha: "5".repeat(40) },
        ],
      },
    },
  });
  assert.equal(core.outputs.hold, "false");
});

test("the #9509 shape, a later cancel-in-progress edit, keeps the cost hold", async () => {
  const { core, writes } = await carryCase([
    prFile(),
    workflowFile({
      patch: `${WORKFLOW_PATCH}\n@@ -5,1 +5,1 @@\n-  cancel-in-progress: false\n+  cancel-in-progress: true`,
    }),
  ]);
  assert.equal(core.outputs.hold, "true");
  assert.equal(core.outputs.criteria, "cost");
  assert.equal(writes.length, 2);
  assert.match(
    core.infos.join("\n"),
    /no recorded cost decision carries \(the net diff against main differs/u,
  );
});

test("a merge that hand-edits the pull request's own lines keeps the cost hold", async () => {
  const { core } = await carryCase([
    prFile({ patch: APP_PATCH.replace("+  log();", "+  log(resolved);") }),
    workflowFile(),
  ]);
  assert.equal(core.outputs.hold, "true");
  assert.match(core.infos.join("\n"), /differs from the decided head/u);
});

test("a base change that shifts a patch's context keeps the cost hold", async () => {
  const { core } = await carryCase([
    prFile({
      patch: APP_PATCH.replace("@@ -10,3 +10,4 @@", "@@ -12,3 +12,4 @@"),
    }),
    workflowFile(),
  ]);
  assert.equal(core.outputs.hold, "true");
  assert.match(core.infos.join("\n"), /differs from the decided head/u);
});

test("an added or dropped file keeps the cost hold", async () => {
  for (const files of [
    [prFile()],
    [...atDecided, prFile({ filename: "src/extra.js" })],
    [prFile({ status: "added" }), workflowFile()],
  ]) {
    const { core } = await carryCase(files);
    assert.equal(
      core.outputs.hold,
      "true",
      JSON.stringify(files.map((f) => f.filename)),
    );
  }
});

test("a file with no patch, or a list of 300 or more files, keeps the cost hold", async () => {
  const binary = {
    filename: "logo.png",
    status: "modified",
    sha: "6".repeat(40),
  };
  for (const [name, then, later] of [
    ["no patch at either head", [...atDecided, binary], [...atDecided, binary]],
    // At the decided head the run's vet stops it first (the
    // "lists 300 files" case below); here only the head lists 300.
    ["300 files at the head", atDecided, manyFiles],
  ]) {
    const { core } = await apply(costEnv(["cost"], { HEAD_SHA: LATER }), {
      comments: [decision()],
      compares: {
        [`main...${HEAD}`]: { status: "ahead", files: then },
        [`main...${LATER}`]: { status: "ahead", files: later },
      },
    });
    assert.equal(core.outputs.hold, "true", name);
    assert.match(
      core.infos.join("\n"),
      /300 or more files, or a file without a patch/u,
      name,
    );
  }
});

test("a failed compare keeps the cost hold", async () => {
  const { core, error, github } = await carryCase(atDecided, {
    fail: { compare: true },
  });
  assert.equal(error, undefined);
  assert.equal(core.outputs.hold, "true");
  assert.equal(compares(github).length, 1);
  assert.match(core.infos.join("\n"), /a read failed/u);
});

// The decided head comes from this lane's own check-run notices, never a
// comment. Any workflow on
// GITHUB_TOKEN posts as github-actions[bot], so a marker comment by that
// login, at any head and any time, decides nothing.
test("a github-actions[bot] marker comment with no notice of this lane keeps the cost hold", async () => {
  const { core, github } = await apply(costEnv(), {
    comments: [marker(), decision()],
    lane: laneOf({ annotations: {} }),
  });
  assert.equal(core.outputs.hold, "true");
  assert.equal(core.outputs.criteria, "cost");
  assert.equal(compares(github).length, 1);
  assert.match(
    core.infos.join("\n"),
    /no recorded cost decision carries \(no cost hold notice of this lane precedes the decision\)/u,
  );
});

test("a newer github-actions[bot] marker naming the head does not replace the notice's decided head", async () => {
  // The notice decided HEAD; the forged marker, newer and before the
  // decision, names LATER, the head now. LATER's net diff differs.
  const { core, github } = await carryCase(
    [prFile({ status: "added" }), workflowFile()],
    {
      comments: [
        marker({ sha: LATER, createdAt: "2026-10-23T11:30:00Z" }),
        decision(),
      ],
    },
  );
  assert.equal(core.outputs.hold, "true");
  assert.deepEqual(compares(github), [`main...${HEAD}`, `main...${LATER}`]);
  assert.match(core.infos.join("\n"), /differs from the decided head a{40}/u);
});

test("the notice fixture carries, and each one-field change to it keeps the cost hold", async () => {
  const carried = await apply(costEnv(), { comments: [decision()] });
  assert.equal(carried.core.outputs.hold, "false");
  assert.match(
    carried.core.infos.join("\n"),
    /the recorded cost decision carries \(the head is the decided head a{40}\)/u,
  );
  const none = /no cost hold notice of this lane precedes the decision/u;
  for (const [name, lane, why] of [
    [
      "a notice naming another head than its run's",
      laneOf({ annotations: { 111: [notice({ sha: LATER })] } }),
      none,
    ],
    [
      "another lane's notice",
      laneOf({
        annotations: { 111: [notice({ lane: "claude-security-review" })] },
      }),
      none,
    ],
    [
      "a notice without cost",
      laneOf({
        annotations: { 111: [notice({ criteria: "critical-security" })] },
      }),
      none,
    ],
    [
      "a warning, not a notice",
      laneOf({ annotations: { 111: [notice({ level: "warning" })] } }),
      none,
    ],
    [
      "a notice with no label= suffix",
      laneOf({
        annotations: {
          111: [
            {
              annotation_level: "notice",
              message: `claude-lane-hold lane=claude-review sha=${HEAD} criteria=cost`,
            },
          ],
        },
      }),
      none,
    ],
    [
      "a status job done after the decision",
      laneOf({
        jobs: { 11: [statusJob({ completedAt: "2026-10-23T12:30:00Z" })] },
      }),
      none,
    ],
    [
      "a job of another name",
      laneOf({ jobs: { 11: [statusJob({ name: "PR Review / Review Key" })] } }),
      none,
    ],
    [
      "a run started after the decision",
      laneOf({ runs: [laneRun({ createdAt: "2026-10-23T12:10:00Z" })] }),
      none,
    ],
    [
      "a run from a fork's same-named branch",
      laneOf({ runs: [laneRun({ repo: "fork/r" })] }),
      none,
    ],
    [
      "a run whose head is not a commit",
      laneOf({ runs: [laneRun({ sha: "main" })] }),
      /a run of this lane has no head commit/u,
    ],
    [
      "this run is not a pull_request run",
      laneOf({ current: { event: "pull_request_target" } }),
      /this run is not a pull_request run of this repository/u,
    ],
    [
      "this run is from a fork",
      laneOf({ current: { head_repository: { full_name: "fork/r" } } }),
      /this run is not a pull_request run of this repository/u,
    ],
    [
      "this run's workflow path is not a workflow file",
      laneOf({ current: { path: "dynamic/pages/pages-build-deployment" } }),
      /this run's workflow or branch is not usable/u,
    ],
    [
      "no push of the decided head before the decision",
      laneOf({ activity: [push(HEAD, "2026-10-23T12:05:00Z")] }),
      /the branch shows no push of a{40} before the decision/u,
    ],
  ]) {
    const { core, error } = await apply(costEnv(), {
      comments: [decision()],
      lane,
    });
    assert.equal(error, undefined, name);
    assert.equal(core.outputs.hold, "true", name);
    assert.match(core.infos.join("\n"), why, name);
  }
});

test("a run whose head changes this lane's workflow, or lists 300 files, carries nothing", async () => {
  for (const [name, files, why] of [
    [
      "the lane workflow",
      [
        prFile(),
        {
          filename: RUN_PATH,
          status: "modified",
          patch: "@@ -1 +1 @@\n-a\n+b",
        },
      ],
      /changes this lane's workflow/u,
    ],
    ["300 files", manyFiles, /lists 300 or more files/u],
    ["no file list", undefined, /lists 300 or more files, or no file list/u],
  ]) {
    const { core } = await apply(costEnv(), {
      comments: [decision()],
      compares: { [`main...${HEAD}`]: { status: "ahead", files } },
    });
    assert.equal(core.outputs.hold, "true", name);
    assert.match(core.infos.join("\n"), why, name);
  }
});

test("two heads noticed at the newest time carry nothing", async () => {
  const other = "c".repeat(40);
  const { core } = await apply(costEnv(), {
    comments: [decision()],
    compares: { [`main...${other}`]: { status: "ahead", files: [prFile()] } },
    lane: laneOf({
      runs: [laneRun(), laneRun({ id: 12, sha: other })],
      jobs: { 11: [statusJob()], 12: [statusJob({ id: 112 })] },
      annotations: { 111: [notice()], 112: [notice({ sha: other })] },
    }),
  });
  assert.equal(core.outputs.hold, "true");
  assert.match(
    core.infos.join("\n"),
    /two heads were noticed at the newest time/u,
  );
});

// claude-code-plugins#10437: deleting the newest head's run would make an
// older notice the decided head, so every head pushed after the decided
// head and before the decision needs a run of this lane.
test("a head pushed after the decided head with no run of this lane carries nothing", async () => {
  const deleted = "c".repeat(40);
  const gap = await apply(costEnv(), {
    comments: [decision()],
    lane: laneOf({
      activity: [push(deleted, "2026-10-23T11:10:00Z"), push(HEAD)],
    }),
  });
  assert.equal(gap.core.outputs.hold, "true");
  assert.match(
    gap.core.infos.join("\n"),
    /c{40} was pushed after the decided head with no run of this lane before the decision/u,
  );
  // With that head's run present (its notice-free status job), it carries.
  const ran = await apply(costEnv(), {
    comments: [decision()],
    compares: { [`main...${deleted}`]: { status: "ahead", files: [prFile()] } },
    lane: laneOf({
      runs: [
        laneRun(),
        laneRun({ id: 12, sha: deleted, createdAt: "2026-10-23T11:15:00Z" }),
      ],
      jobs: {
        11: [statusJob()],
        12: [statusJob({ id: 112, completedAt: "2026-10-23T11:20:00Z" })],
      },
      activity: [push(deleted, "2026-10-23T11:10:00Z"), push(HEAD)],
    }),
  });
  assert.equal(ran.core.outputs.hold, "false");
});

// A branch name reused across deletions: `later` pushes after the 12:00
// decision, HEAD's 10:45 push, then `older` entries from earlier lives of
// the name (deletions and pushes of other commits, no run of this lane).
const reused = (later, older = 0) => [
  ...Array.from({ length: later }, () =>
    push("e".repeat(40), "2026-10-23T12:30:00Z"),
  ),
  push(HEAD),
  ...Array.from({ length: older }, (_, i) =>
    push(i % 2 ? "0".repeat(40) : "f".repeat(40), "2026-10-01T00:00:00Z"),
  ),
];
const activityReads = (github) =>
  github.calls.filter(([name]) => name === "activity").map(([, p]) => p.after);

test("a reused branch's push history is read past one page, by the Link cursor, to the decided head", async () => {
  const { core, github } = await apply(costEnv(), {
    comments: [decision()],
    lane: laneOf({ activity: reused(120, 200) }),
  });
  assert.equal(core.outputs.hold, "false");
  // Page 2 holds the decided push and older entries: page 3 is never read.
  assert.deepEqual(activityReads(github), [undefined, "c100"]);
});

test("push history ending within 20 pages carries; past 20 pages it keeps the cost hold", async () => {
  const full = await apply(costEnv(), {
    comments: [decision()],
    lane: laneOf({ activity: reused(1998) }),
  });
  assert.equal(full.core.outputs.hold, "false");
  assert.equal(activityReads(full.github).length, 20);
  const over = await apply(costEnv(), {
    comments: [decision()],
    lane: laneOf({ activity: reused(2000) }),
  });
  assert.equal(over.core.outputs.hold, "true");
  assert.equal(activityReads(over.github).length, 20);
  assert.match(
    over.core.infos.join("\n"),
    /the branch's push history runs past 20 pages/u,
  );
});

test("only a short page ends the push history; a full page with no next cursor keeps the cost hold", async () => {
  const prev =
    '<https://api.github.com/repositories/1/activity?ref=refs%2Fheads%2Ffeat%2Fcost&per_page=100&before=c0>; rel="prev"';
  for (const [name, lane, hold] of [
    [
      "a full page with no Link",
      laneOf({ activity: reused(99), link: "" }),
      "true",
    ],
    [
      "a full page with only rel=prev",
      laneOf({ activity: reused(99), link: prev }),
      "true",
    ],
    [
      "a short page with no Link",
      laneOf({ activity: reused(98), link: "" }),
      "false",
    ],
  ]) {
    const { core, github } = await apply(costEnv(), {
      comments: [decision()],
      lane,
    });
    assert.equal(core.outputs.hold, hold, name);
    assert.deepEqual(activityReads(github), [undefined], name);
    if (hold === "true")
      assert.match(
        core.infos.join("\n"),
        /the branch's activity page is full but carries no next cursor/u,
        name,
      );
  }
});

test("a 409 or a push history page that is not a list keeps the cost hold", async () => {
  for (const [name, options] of [
    ["409", { fail: { activity: "HTTP 409 Git Repository is empty" } }],
    ["object page", { lane: laneOf({ activity: { message: "Not a list" } }) }],
    ["empty body", { lane: laneOf({ activity: "" }) }],
  ]) {
    const { core, error } = await apply(costEnv(), {
      comments: [decision()],
      ...options,
    });
    assert.equal(error, undefined, name);
    assert.equal(core.outputs.hold, "true", name);
    assert.match(
      core.infos.join("\n"),
      /no recorded cost decision carries \(a read failed\)/u,
      name,
    );
  }
});

test("each failed read keeps the cost hold", async () => {
  for (const name of [
    "run",
    "runs",
    "jobs",
    "annotations",
    "activity",
    "compare",
  ]) {
    const { core, error } = await apply(costEnv(), {
      comments: [decision()],
      fail: { [name]: true },
    });
    assert.equal(error, undefined, name);
    assert.equal(core.outputs.hold, "true", name);
    assert.match(
      core.infos.join("\n"),
      /no recorded cost decision carries \(a read failed\)/u,
      name,
    );
  }
});

test("the decided head is the newest notice of this lane before the newest decision", async () => {
  const older = "c".repeat(40);
  const { core, github } = await carryCase(atDecided, {
    comments: [
      decision({ id: 1, createdAt: "2026-10-23T10:45:00Z" }),
      decision({ id: 2 }),
    ],
    compares: {
      [`main...${HEAD}`]: { status: "ahead", files: atDecided },
      [`main...${LATER}`]: { status: "ahead", files: atDecided },
      [`main...${older}`]: { status: "ahead", files: [prFile()] },
    },
    lane: laneOf({
      runs: [
        laneRun({ id: 10, sha: older, createdAt: "2026-10-23T10:20:00Z" }),
        laneRun(),
        laneRun({ id: 13, sha: older, createdAt: "2026-10-23T11:40:00Z" }),
      ],
      jobs: {
        10: [statusJob({ id: 110, completedAt: "2026-10-23T10:30:00Z" })],
        11: [statusJob()],
        // Done after the newest decision: not read for a notice.
        13: [statusJob({ id: 113, completedAt: "2026-10-23T12:30:00Z" })],
      },
      annotations: {
        110: [notice({ sha: older })],
        111: [notice({ criteria: "cost,critical-security" })],
        113: [notice({ sha: older })],
      },
      activity: [
        push(older, "2026-10-23T11:35:00Z"),
        push(HEAD),
        push(older, "2026-10-23T10:10:00Z"),
      ],
    }),
  });
  assert.equal(core.outputs.hold, "false");
  assert.deepEqual(compares(github), [
    `main...${older}`,
    `main...${HEAD}`,
    `main...${LATER}`,
  ]);
  assert.match(
    core.infos.join("\n"),
    /the net diff against main is the same as at the decided head a{40}/u,
  );
});

test("an unusable base branch name reads no compare and keeps the cost hold", async () => {
  const { core, github } = await apply(
    costEnv(["cost"], { HEAD_SHA: LATER, BASE_REF: "main..x" }),
    { comments: [decision()] },
  );
  assert.equal(core.outputs.hold, "true");
  assert.equal(compares(github).length, 0);
});

test("the carry check reads this lane's runs, its jobs and notices, the push history and at most one compare per head", async () => {
  const { github } = await carryCase(atDecided);
  assert.deepEqual(
    github.calls.map(([name]) => name),
    [
      "listComments",
      "graphql",
      "getWorkflowRun",
      "listWorkflowRuns",
      "compare",
      "listJobs",
      "listAnnotations",
      "activity",
      "compare",
    ],
  );
});

test("an empty STATUS_JOB reads no run and keeps the cost hold", async () => {
  const { core, github } = await apply(costEnv(["cost"], { STATUS_JOB: "" }), {
    comments: [decision()],
  });
  assert.equal(core.outputs.hold, "true");
  assert.ok(!github.calls.some(([name]) => name === "listWorkflowRuns"));
});

// A decision made against a run whose status job carries a former name
// carries through STATUS_JOB_LEGACY, one against a run under the current
// name through STATUS_JOB, and a job that only shares a word with either is
// never read.
test("the cost decision carries from the status job under its current or a former name", async () => {
  for (const [label, name, env, hold] of [
    ["a run after the rename", `PR Review / ${STATUS_JOB}`, {}, "false"],
    [
      "a security lane run after the rename",
      `PR Review Security / ${STATUS_JOB}`,
      {},
      "false",
    ],
    ...FORMER_NAMES.flatMap((former) => [
      [`a run named ${former}`, `PR Review / ${former}`, {}, "false"],
      [
        `a run named ${former}, legacy names unset`,
        `PR Review / ${former}`,
        { STATUS_JOB_LEGACY: "" },
        "true",
      ],
    ]),
    [
      "a run before the caller jobs were named",
      "pr-review / review-status",
      {},
      "false",
    ],
    [
      "one legacy name, as an older caller passes it",
      "PR Review / review-status",
      { STATUS_JOB_LEGACY: "review-status" },
      "false",
    ],
    [
      "a former name the legacy list leaves out",
      "PR Review / Status",
      { STATUS_JOB_LEGACY: "review-status" },
      "true",
    ],
    ["the CI Status job", "CI Status", {}, "true"],
    [
      "a job whose name ends in Status without the separator",
      "PR Review / Review Status",
      {},
      "true",
    ],
  ]) {
    const { core } = await apply(costEnv(["cost"], env), {
      comments: [decision()],
      lane: laneOf({ jobs: { 11: [statusJob({ name })] } }),
    });
    assert.equal(core.outputs.hold, hold, label);
  }
});

test("an unusable STATUS_JOB_LEGACY reads no run and keeps the cost hold", async () => {
  for (const legacy of [
    "review-status\n",
    "Status,review-status\n",
    "Status,",
    ",Status",
    "Status,,review-status",
  ]) {
    const { core, github } = await apply(
      costEnv(["cost"], { STATUS_JOB_LEGACY: legacy }),
      { comments: [decision()] },
    );
    assert.equal(core.outputs.hold, "true", JSON.stringify(legacy));
    assert.ok(
      !github.calls.some(([name]) => name === "listWorkflowRuns"),
      JSON.stringify(legacy),
    );
  }
});

test("the hold comment carries the run's binding above its footer and the run's record lists it; a re-run lists its run's earlier one", async () => {
  const { createHash } = require("node:crypto");
  const read = (file) =>
    fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  const digest = (body) =>
    createHash("sha256").update(body, "utf8").digest("hex");
  const dir = makeTemporaryDirectory("hold-record-");
  const record = path.join(dir, "first.jsonl");
  const env = baseEnv({
    GITHUB_RUN_ID: "4242",
    LANE_RECORD: record,
    KEY_REVIEW: review({ hold: { criteria: ["cost"], reason: "R" } }),
  });
  const { writes, error } = await apply(env);
  assert.equal(error, undefined);
  const body = writes.find(([name]) => name === "createComment")[1].body;
  assert.match(
    body,
    new RegExp(
      `\\nR\\n<!-- claude-lane-run id=4242 sha=${HEAD} -->\\n\\nclaude-lane: claude-review$`,
      "u",
    ),
  );
  assert.deepEqual(read(record), [
    {
      lane: "claude-review",
      pr: 7,
      head: HEAD,
      kind: "issue_comment",
      id: 701,
      sha256: digest(body),
    },
  ]);
  const again = path.join(dir, "second.jsonl");
  const earlier = { id: 701, user: { login: "github-actions[bot]" }, body };
  const rerun = await apply(
    { ...env, LANE_RECORD: again },
    { comments: [earlier] },
  );
  assert.equal(
    rerun.writes.filter(([name]) => name === "createComment").length,
    0,
  );
  assert.deepEqual(read(again), read(record));
  const other = path.join(dir, "third.jsonl");
  await apply(
    { ...env, GITHUB_RUN_ID: "5000", LANE_RECORD: other },
    { comments: [earlier] },
  );
  assert.deepEqual(read(other), []);
});

test("a re-run records only a hold comment word for word its own, never a look-alike bound to its run", async () => {
  const record = path.join(makeTemporaryDirectory("hold-record-"), "r.jsonl");
  const marker = `<!-- claude-lane-hold lane=claude-review sha=${HEAD} criteria=cost -->`;
  const lookalike = {
    id: 9,
    user: { login: "github-actions[bot]" },
    body: `${marker}\nOther text.\n<!-- claude-lane-run id=4242 sha=${HEAD} -->\n\nclaude-lane: claude-review`,
  };
  const { writes } = await apply(
    baseEnv({
      GITHUB_RUN_ID: "4242",
      LANE_RECORD: record,
      KEY_REVIEW: review({ hold: { criteria: ["cost"], reason: "R" } }),
    }),
    { comments: [lookalike] },
  );
  assert.equal(writes.filter(([name]) => name === "createComment").length, 0);
  assert.equal(fs.existsSync(record), false);
});

// claude-code-plugins#17537: the hosted review lanes run as workflow_run
// runs of main's copy, whose jobs attach to main's tip. A lane run binds on
// its own record: its lane file, event workflow_run, branch main and the
// run-name `<name> #<pull request> <head sha>` main's copy computes
// (claude-code-plugins .github/workflows/pr-review-hosted-lane.yml run-name).
const LANE_PATH = ".github/workflows/pr-review-hosted-lane.yml";
const LANE_NAME = "PR Review Hosted Lane";
const SECURITY_PATH = ".github/workflows/pr-review-security-hosted-lane.yml";
const SECURITY_NAME = "PR Review Security Hosted Lane";
const MAIN_TIP = "d".repeat(40);
const DECIDED_AT = "2026-10-23T12:00:00Z";
// A pull request from a branch, in the REST shape the lane path reads
// (docs.github.com/en/rest/pulls/pulls: number, created_at, head.ref,
// head.repo.full_name).
const branchPull = ({
  number = 7,
  ref = "feat/cost",
  repo = "o/r",
  createdAt = OPENED,
} = {}) => ({
  number,
  created_at: createdAt,
  head: { ref, repo: { full_name: repo } },
});
// `fixture` (laneOf, the pull_request shape) as the same lane's workflow_run
// runs: each run becomes the lane run main's copy names for its pull request
// (`prOf`, 7 by default) and head. A pull_request run from another
// repository's same-named branch becomes a lane run naming pull request 99,
// from another branch. The current run names #7 at `head`.
const laneShape = (
  fixture = laneOf(),
  {
    head = HEAD,
    path = LANE_PATH,
    name = LANE_NAME,
    current = {},
    pulls = [branchPull()],
    prOf = () => 7,
  } = {},
) => ({
  ...fixture,
  current: {
    id: RUN_ID,
    workflow_id: 6,
    path,
    event: "workflow_run",
    head_branch: "main",
    head_sha: MAIN_TIP,
    head_repository: { full_name: "o/r" },
    display_title: `${name} #7 ${head}`,
    ...current,
  },
  runs: fixture.runs.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    head_sha: MAIN_TIP,
    head_branch: "main",
    event: "workflow_run",
    path,
    head_repository: { full_name: "o/r" },
    display_title: `${name} #${r.head_repository.full_name === "o/r" ? prOf(r) : 99} ${r.head_sha}`,
  })),
  pr: { number: 7, head: { ref: "feat/cost", repo: { full_name: "o/r" } } },
  pulls,
});
const holdOf = ({ core, error }) => ({
  error: error?.message,
  hold: core.outputs.hold,
  why: core.infos.at(-1),
});
// One case in both run shapes: the pull_request run today, and the same
// lane's workflow_run run.
async function bothShapes(env, options = {}, shape = {}) {
  const pull = await apply(env, options);
  const lane = await apply(env, {
    ...options,
    lane: laneShape(options.lane ?? laneOf(), { head: env.HEAD_SHA, ...shape }),
  });
  return { pull: holdOf(pull), lane: holdOf(lane), laneRun: lane };
}

test("a bound lane run carries the recorded cost decision as a pull_request run does, reading the head branch's runs", async () => {
  const { pull, lane, laneRun } = await bothShapes(costEnv(), {
    comments: [decision()],
  });
  assert.equal(pull.hold, "false");
  assert.deepEqual(lane, pull);
  const { github } = laneRun;
  assert.deepEqual(
    github.calls.map(([name]) => name),
    [
      "listComments",
      "graphql",
      "getWorkflowRun",
      "get",
      "listPulls",
      "listWorkflowRuns",
      "listWorkflowRuns",
      "compare",
      "listJobs",
      "listAnnotations",
      "activity",
    ],
  );
  const read = (name) => github.calls.find(([n]) => n === name)[1];
  assert.deepEqual(read("get"), { owner: "o", repo: "r", pull_number: 7 });
  assert.deepEqual(read("listPulls"), {
    owner: "o",
    repo: "r",
    state: "all",
    head: "o:feat/cost",
    per_page: 100,
  });
  // The count of the range, then its runs.
  const listing = {
    owner: "o",
    repo: "r",
    workflow_id: 6,
    event: "workflow_run",
    branch: "main",
    created: `${OPENED}..${DECIDED_AT}`,
  };
  assert.deepEqual(
    github.calls.filter(([n]) => n === "listWorkflowRuns").map(([, p]) => p),
    [
      { ...listing, per_page: 1 },
      { ...listing, per_page: 100 },
    ],
  );
  assert.equal(read("activity").ref, "refs/heads/feat/cost");
  assert.equal(read("compare").basehead, `main...${HEAD}`);
});

test("the security lane's file binds with its own run-name", async () => {
  const { lane } = await bothShapes(
    costEnv(),
    { comments: [decision()] },
    { path: SECURITY_PATH, name: SECURITY_NAME },
  );
  assert.equal(lane.hold, "false");
  // Its file with the other lane's name binds nothing.
  const crossed = await bothShapes(
    costEnv(),
    { comments: [decision()] },
    { path: SECURITY_PATH, name: LANE_NAME },
  );
  assert.equal(crossed.lane.hold, "true");
});

test("every carry check gives the same hold and reason in both run shapes", async () => {
  const other = "c".repeat(40);
  const cases = [
    ["the notice fixture", costEnv(), { comments: [decision()] }],
    ...[
      laneOf({ annotations: { 111: [notice({ sha: LATER })] } }),
      laneOf({
        annotations: { 111: [notice({ lane: "claude-security-review" })] },
      }),
      laneOf({
        annotations: { 111: [notice({ criteria: "critical-security" })] },
      }),
      laneOf({ annotations: { 111: [notice({ level: "warning" })] } }),
      laneOf({
        jobs: { 11: [statusJob({ completedAt: "2026-10-23T12:30:00Z" })] },
      }),
      laneOf({ jobs: { 11: [statusJob({ name: "PR Review / Review Key" })] } }),
      laneOf({ jobs: { 11: [statusJob({ name: "Status" })] } }),
      laneOf({ runs: [laneRun({ createdAt: "2026-10-23T12:10:00Z" })] }),
      laneOf({ runs: [laneRun({ repo: "fork/r" })] }),
      laneOf({ runs: [laneRun({ sha: "main" })] }),
      laneOf({ activity: [push(HEAD, "2026-10-23T12:05:00Z")] }),
      laneOf({ activity: [push(other, "2026-10-23T11:10:00Z"), push(HEAD)] }),
      laneOf({ activity: reused(120, 200) }),
      laneOf({ activity: { message: "not a list" } }),
    ].map((lane, i) => [
      `lane variant ${i}`,
      costEnv(),
      { comments: [decision()], lane },
    ]),
    [
      "two heads at the newest time",
      costEnv(),
      {
        comments: [decision()],
        compares: {
          [`main...${other}`]: { status: "ahead", files: [prFile()] },
        },
        lane: laneOf({
          runs: [laneRun(), laneRun({ id: 12, sha: other })],
          jobs: { 11: [statusJob()], 12: [statusJob({ id: 112 })] },
          annotations: { 111: [notice()], 112: [notice({ sha: other })] },
        }),
      },
    ],
    [
      "a later head's notice-free run fills the gap",
      costEnv(),
      {
        comments: [decision()],
        compares: {
          [`main...${other}`]: { status: "ahead", files: [prFile()] },
        },
        lane: laneOf({
          runs: [
            laneRun(),
            laneRun({ id: 12, sha: other, createdAt: "2026-10-23T11:15:00Z" }),
          ],
          jobs: {
            11: [statusJob()],
            12: [statusJob({ id: 112, completedAt: "2026-10-23T11:20:00Z" })],
          },
          activity: [push(other, "2026-10-23T11:10:00Z"), push(HEAD)],
        }),
      },
    ],
    [
      "the same net diff at a later head",
      costEnv(["cost"], { HEAD_SHA: LATER }),
      {
        comments: [decision()],
        compares: {
          [`main...${HEAD}`]: { status: "ahead", files: atDecided },
          [`main...${LATER}`]: {
            status: "ahead",
            files: [prFile({ sha: "3".repeat(40) }), workflowFile()],
          },
        },
      },
    ],
    [
      "another net diff at a later head",
      costEnv(["cost"], { HEAD_SHA: LATER }),
      {
        comments: [decision()],
        compares: {
          [`main...${HEAD}`]: { status: "ahead", files: atDecided },
          [`main...${LATER}`]: { status: "ahead", files: [prFile()] },
        },
      },
    ],
    [
      "a head listing 300 files",
      costEnv(),
      {
        comments: [decision()],
        compares: { [`main...${HEAD}`]: { status: "ahead", files: manyFiles } },
      },
    ],
    [
      "a failed compare",
      costEnv(),
      { comments: [decision()], fail: { compare: true } },
    ],
    [
      "a failed run listing",
      costEnv(),
      { comments: [decision()], fail: { runs: true } },
    ],
    [
      "a failed job read",
      costEnv(),
      { comments: [decision()], fail: { jobs: true } },
    ],
    [
      "a failed annotation read",
      costEnv(),
      { comments: [decision()], fail: { annotations: true } },
    ],
    [
      "a failed push history read",
      costEnv(),
      { comments: [decision()], fail: { activity: true } },
    ],
  ];
  for (const [name, env, options] of cases) {
    const { pull, lane } = await bothShapes(env, options);
    assert.deepEqual(lane, pull, name);
  }
});

test("a run of another pull request from the same head branch counts in both run shapes", async () => {
  // Pull request 8 shares feat/cost; its run at `other` noticed a cost hold
  // after HEAD's, so `other` is the decided head and the net diff differs.
  const other = "c".repeat(40);
  const options = {
    comments: [decision()],
    compares: {
      [`main...${other}`]: {
        status: "ahead",
        files: [prFile({ filename: "src/x.js" })],
      },
    },
    lane: laneOf({
      runs: [
        laneRun(),
        laneRun({ id: 12, sha: other, createdAt: "2026-10-23T11:15:00Z" }),
      ],
      jobs: {
        11: [statusJob()],
        12: [statusJob({ id: 112, completedAt: "2026-10-23T11:30:00Z" })],
      },
      annotations: { 111: [notice()], 112: [notice({ sha: other })] },
      activity: [push(other, "2026-10-23T11:10:00Z"), push(HEAD)],
    }),
  };
  const {
    pull,
    lane,
    laneRun: run8,
  } = await bothShapes(costEnv(), options, {
    pulls: [
      branchPull(),
      branchPull({ number: 8, createdAt: "2026-10-22T09:00:00Z" }),
    ],
    prOf: (r) => (r.id === 12 ? 8 : 7),
  });
  assert.equal(pull.hold, "true");
  assert.match(pull.why, /differs from the decided head c{40}/u);
  assert.deepEqual(lane, pull);
  // The listing starts at the older pull request's opening.
  const listed = run8.github.calls.find(([n]) => n === "listWorkflowRuns")[1];
  assert.equal(listed.created, `2026-10-22T09:00:00Z..${DECIDED_AT}`);
});

test("a lane run naming one pull request or head carries no decision for another", async () => {
  for (const [name, shape, why] of [
    [
      "the run names pull request 8, the hold is for 7",
      { current: { display_title: `${LANE_NAME} #8 ${HEAD}` } },
      /this lane run names another pull request or head/u,
    ],
    [
      "the run names head b…, the hold is for a…",
      { current: { display_title: `${LANE_NAME} #7 ${LATER}` } },
      /this lane run names another pull request or head/u,
    ],
    [
      "the only noticing run names pull request 9, from another branch",
      { prOf: () => 9 },
      /no cost hold notice of this lane precedes the decision/u,
    ],
    [
      "pull request 7 is not among the pull requests from its head branch",
      { pulls: [branchPull({ number: 8 })] },
      /the pull requests from the head branch are unreadable/u,
    ],
  ]) {
    const { lane } = await bothShapes(
      costEnv(),
      { comments: [decision()] },
      shape,
    );
    assert.equal(lane.hold, "true", name);
    assert.match(lane.why, why, name);
  }
  // A run naming #7 at LATER whose status job noticed HEAD: the notice names
  // another head than its run's, so it decides nothing.
  const { lane } = await bothShapes(costEnv(), {
    comments: [decision()],
    compares: { [`main...${LATER}`]: { status: "ahead", files: [prFile()] } },
    lane: laneOf({ runs: [laneRun({ sha: LATER })] }),
  });
  assert.equal(lane.hold, "true");
  assert.match(
    lane.why,
    /no cost hold notice of this lane precedes the decision/u,
  );
});

test("a wrong path, event, branch, repository or run-name carries nothing", async () => {
  const bound =
    /this run is not a bound workflow_run lane run of this repository/u;
  for (const [name, shape, why, override = {}] of [
    ["the review workflow's own path", { path: RUN_PATH }, bound],
    [
      "another workflow file",
      { current: { path: ".github/workflows/other.yml" } },
      bound,
    ],
    [
      "a run on another branch",
      { current: { head_branch: "feat/cost" } },
      bound,
    ],
    [
      "a run of a fork",
      { current: { head_repository: { full_name: "fork/r" } } },
      bound,
    ],
    [
      "a workflow_dispatch run",
      { current: { event: "workflow_dispatch" } },
      /this run is not a pull_request run of this repository/u,
    ],
    ["no workflow id", { current: { workflow_id: "6" } }, bound],
    ["no run-name", { current: { display_title: undefined } }, bound],
    [
      "no pull request",
      { current: { display_title: `${LANE_NAME} # ${HEAD}` } },
      bound,
    ],
    ["no head", { current: { display_title: `${LANE_NAME} #7` } }, bound],
    [
      "a short head",
      { current: { display_title: `${LANE_NAME} #7 ${"a".repeat(39)}` } },
      bound,
    ],
    [
      "an upper-case head",
      { current: { display_title: `${LANE_NAME} #7 ${"A".repeat(40)}` } },
      bound,
    ],
    [
      "a leading zero",
      { current: { display_title: `${LANE_NAME} #07 ${HEAD}` } },
      bound,
    ],
    [
      "a trailing space",
      { current: { display_title: `${LANE_NAME} #7 ${HEAD} ` } },
      bound,
    ],
    [
      "another name",
      { current: { display_title: `PR Review Hosted #7 ${HEAD}` } },
      bound,
    ],
    [
      "a prefixed name",
      { current: { display_title: `x ${LANE_NAME} #7 ${HEAD}` } },
      bound,
    ],
    [
      "the pull request's head is a fork's",
      {},
      /the pull request's head is not a usable branch of this repository/u,
      {
        pr: {
          number: 7,
          head: { ref: "feat/cost", repo: { full_name: "fork/r" } },
        },
      },
    ],
    [
      "the pull request read answers another number",
      {},
      /the pull request's head is not a usable branch of this repository/u,
      {
        pr: {
          number: 8,
          head: { ref: "feat/cost", repo: { full_name: "o/r" } },
        },
      },
    ],
    [
      "a pull request from the branch is a fork's",
      { pulls: [branchPull(), branchPull({ number: 8, repo: "fork/r" })] },
      /the pull requests from the head branch are unreadable/u,
    ],
  ]) {
    const lane = { ...laneShape(laneOf(), shape), ...override };
    const { core, error, github } = await apply(costEnv(), {
      comments: [decision()],
      lane,
    });
    assert.equal(error, undefined, name);
    assert.equal(core.outputs.hold, "true", name);
    assert.match(core.infos.at(-1), why, name);
    // No run is listed: the run itself does not bind.
    assert.ok(!github.calls.some(([n]) => n === "listWorkflowRuns"), name);
  }
});

test("a past lane run off the lane's record is not read; one with a run-name naming no head carries nothing", async () => {
  const pastRun = (extra) => {
    const lane = laneShape();
    return { ...lane, runs: [{ ...lane.runs[0], ...extra }] };
  };
  const none = /no cost hold notice of this lane precedes the decision/u;
  for (const [name, lane, why] of [
    [
      "a past run of another event",
      pastRun({ event: "workflow_dispatch" }),
      none,
    ],
    [
      "a past run on another branch",
      pastRun({ head_branch: "feat/cost" }),
      none,
    ],
    ["a past run of another file", pastRun({ path: SECURITY_PATH }), none],
    [
      "a past run of another repository",
      pastRun({ head_repository: { full_name: "fork/r" } }),
      none,
    ],
    [
      "a past run naming no pull request",
      pastRun({ display_title: `${LANE_NAME} # ${HEAD}` }),
      /a run of this lane has no head commit/u,
    ],
    [
      "a past run with no run-name",
      pastRun({ display_title: undefined }),
      /a run of this lane has no head commit/u,
    ],
  ]) {
    const { core, error } = await apply(costEnv(), {
      comments: [decision()],
      lane,
    });
    assert.equal(error, undefined, name);
    assert.equal(core.outputs.hold, "true", name);
    assert.match(core.infos.at(-1), why, name);
  }
});

// `count` lane runs of other pull requests, the k-th created k * `step`
// seconds after `start`, by default the pull request's opening.
const otherRuns = (count, step = 1, start = OPENED) => {
  const lane = laneShape();
  return Array.from({ length: count }, (_, k) => ({
    ...lane.runs[0],
    id: 1000 + k,
    created_at: stamp(Date.parse(start) + k * step * 1000),
    display_title: `${LANE_NAME} #99 ${HEAD}`,
  }));
};
const stamp = (ms) => new Date(ms).toISOString().replace(/\.000Z$/u, "Z");

test("a lane run listing over 1,000 runs is split by time until each part lists every run", async () => {
  const lane = laneShape();
  const runs = [...lane.runs, ...otherRuns(1500)];
  const { core, github } = await apply(costEnv(), {
    comments: [decision()],
    lane: { ...lane, runs },
  });
  assert.equal(core.outputs.hold, "false");
  const listings = github.calls
    .filter(([n]) => n === "listWorkflowRuns")
    .map(([, p]) => p);
  const inRange = ({ created }) => {
    const [from, to] = created.split("..").map(Date.parse);
    return runs.filter(
      (r) => Date.parse(r.created_at) >= from && Date.parse(r.created_at) <= to,
    );
  };
  const pages = listings.filter((p) => p.per_page === 100);
  assert.ok(pages.length > 1);
  for (const p of pages) assert.ok(inRange(p).length < 1000, p.created);
  // The listed ranges cover every run exactly once.
  const listed = pages.flatMap((p) => inRange(p).map((r) => r.id));
  assert.deepEqual(
    [...listed].sort((a, b) => a - b),
    runs.map((r) => r.id).sort((a, b) => a - b),
  );
});

test("a pull request open a week before the decision carries in both run shapes", async () => {
  // About 600 lane runs a day across every pull request, as on
  // claude-code-plugins.
  const opened = stamp(Date.parse(DECIDED_AT) - 7 * 86400000);
  const lane = laneShape(laneOf(), {
    pulls: [branchPull({ createdAt: opened })],
  });
  const pull = await apply(costEnv(), { comments: [decision()] });
  const week = await apply(costEnv(), {
    comments: [decision()],
    lane: { ...lane, runs: [...lane.runs, ...otherRuns(4200, 144, opened)] },
  });
  assert.equal(pull.core.outputs.hold, "false");
  assert.deepEqual(holdOf(week), holdOf(pull));
});

test("a lane run listing it cannot finish carries nothing", async () => {
  const lane = laneShape();
  for (const [name, runs, why] of [
    [
      "1,000 runs in one second",
      otherRuns(1000, 0),
      /this lane started 1000 runs within one second/u,
    ],
  ]) {
    const { core } = await apply(costEnv(), {
      comments: [decision()],
      lane: { ...lane, runs: [...lane.runs, ...runs] },
    });
    assert.equal(core.outputs.hold, "true", name);
    assert.match(core.infos.at(-1), why, name);
  }
  // A branch name first used 40 days before the decision, at 600 lane runs
  // a day: past the request budget.
  const reusedFrom = stamp(Date.parse(DECIDED_AT) - 40 * 86400000);
  const past = await apply(costEnv(), {
    comments: [decision()],
    lane: {
      ...lane,
      pulls: [branchPull({ number: 3, createdAt: reusedFrom }), branchPull()],
      runs: [...lane.runs, ...otherRuns(24000, 144, reusedFrom)],
    },
  });
  assert.equal(past.core.outputs.hold, "true");
  assert.match(
    past.core.infos.at(-1),
    /this lane's runs take more than 200 requests to list/u,
  );
  // 999 in one second list in one range and carry.
  const under = await apply(costEnv(), {
    comments: [decision()],
    lane: { ...lane, runs: [...lane.runs, ...otherRuns(998, 0)] },
  });
  assert.equal(under.core.outputs.hold, "false");
});

test("a lane run whose head changes the lane file, or a failed pull request read, carries nothing", async () => {
  const changed = await apply(costEnv(), {
    comments: [decision()],
    compares: {
      [`main...${HEAD}`]: {
        status: "ahead",
        files: [
          prFile(),
          {
            filename: LANE_PATH,
            status: "modified",
            patch: "@@ -1 +1 @@\n-a\n+b",
          },
        ],
      },
    },
    lane: laneShape(),
  });
  assert.equal(changed.core.outputs.hold, "true");
  assert.match(changed.core.infos.at(-1), /changes this lane's workflow/u);
  const failed = await apply(costEnv(), {
    comments: [decision()],
    fail: { pulls: true },
    lane: laneShape(),
  });
  assert.equal(failed.core.outputs.hold, "true");
  assert.match(failed.core.infos.at(-1), /a read failed/u);
});

test("an unrecorded cost decision still holds in both run shapes", async () => {
  for (const comments of [
    [],
    [decision({ userId: 1 })],
    [decision({ body: "**Decision recorded.** Cost: yes." })],
  ]) {
    const { pull, lane, laneRun } = await bothShapes(costEnv(), { comments });
    assert.equal(pull.hold, "true");
    assert.deepEqual(lane, pull);
    assert.ok(!laneRun.github.calls.some(([n]) => n === "getWorkflowRun"));
    assert.equal(laneRun.writes.filter(([n]) => n === "addLabels").length, 1);
  }
});
