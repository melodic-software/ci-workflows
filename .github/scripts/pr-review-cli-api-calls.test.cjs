"use strict";

// The GitHub API requests one pr-review-cli run spends on the job token, in
// the key and status jobs, for each shape of run. Every step that calls the
// API runs as shipped against one counting fake: the scope, full-diff and
// gate steps from the workflow, then publish-review and apply-review-hold
// with the env the workflow passes them, the job outputs evaluated from the
// workflow's own expressions. The pull request's file list and pulls.get are
// each read once per run, but for publish's check that the head has not moved.
// The review reaches the status job as the key job's handoff file: its write
// and check steps run as shipped, and both jobs share one runner.temp here,
// so the file the key job wrote is the file the download would place. The
// artifact upload and download run on the runtime token, not the job token.
// Each job's last step, report-api-budget, reads the rate-limit headers those
// requests returned and spends none of its own.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { evaluate } = require("./actions-expression.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const ROOT = path.join(__dirname, "..", "..");
const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "pr-review-cli.yml"),
    "utf8",
  ),
);
const { "review-key": key, status } = workflow.jobs;
const publishReview = require(
  path.join(ROOT, ".github", "actions", "publish-review", "publish.cjs"),
);
const applyHold = require(
  path.join(ROOT, ".github", "actions", "apply-review-hold", "hold.cjs"),
);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const stepId = (job, id) => job.steps.find((s) => s.id === id);

const HEAD = "a".repeat(40);
const LAST = "b".repeat(40);
const MB_OLD = "c".repeat(40);
const MB_NEW = "d".repeat(40);
const TIP = "e".repeat(40);
const BOT = "github-actions[bot]";
const PATCH = "@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c";
const INPUTS = {
  lane: "code",
  publish: "comments",
  "incremental-review": true,
  "docs-only-paths": "",
  "hold-label": "needs-human",
  "hold-paths": "**/CODEOWNERS\n.github/standards/trusted-actors/**",
};

// One fake API for the whole run: every call counts as `<group>.<method>`,
// a paginated list as one page. Each response carries the job token's
// rate-limit headers, `used` rising by one per request, and goes through the
// request hooks the client's steps registered, as Octokit's does.
function fakeApi({ prFiles, comments = [], compares = {} }) {
  const calls = [];
  const requests = [];
  let hooks = { after: [], error: [] };
  let used = 0;
  const data = {
    "issues.listComments": () => comments,
    "pulls.listFiles": () => prFiles,
    "pulls.get": () => ({ head: { sha: HEAD }, changed_files: prFiles.length }),
    "pulls.listReviewComments": () => [],
    "repos.compareCommitsWithBasehead": ({ basehead }) => {
      assert.ok(basehead in compares, `unexpected compare ${basehead}`);
      return compares[basehead];
    },
    "repos.get": () => ({ default_branch: "main" }),
    "repos.getBranch": () => ({ commit: { sha: TIP } }),
    "repos.getContent": () => ({
      content: Buffer.from(GATE).toString("base64"),
    }),
    "issues.addLabels": () => [],
  };
  const rest = new Proxy(
    {},
    {
      get: (_, group) =>
        new Proxy(
          {},
          {
            get: (__, method) => async (params) => {
              const name = `${group}.${method}`;
              calls.push(name);
              requests.push({ name, params });
              used += 1;
              const response = {
                status: 200,
                headers: rateLimit(used),
                data: (data[name] ?? (() => ({})))(params),
              };
              for (const fn of hooks.after) await fn(response, params);
              return response;
            },
          },
        ),
    },
  );
  return {
    calls,
    requests,
    used: () => used,
    // A new step's client: github-script builds one per step.
    newClient: () => {
      hooks = { after: [], error: [] };
    },
    github: {
      rest,
      hook: {
        after: (_name, fn) => hooks.after.push(fn),
        error: (_name, fn) => hooks.error.push(fn),
      },
      paginate: async (method, params) => (await method(params)).data,
    },
  };
}

const RESET = 1792748042;
const rateLimit = (used) => ({
  "x-ratelimit-limit": "1000",
  "x-ratelimit-remaining": String(1000 - used),
  "x-ratelimit-used": String(used),
  "x-ratelimit-reset": String(RESET),
  "x-ratelimit-resource": "core",
});

// The job-end step, run as shipped: report-api-budget's action against the
// readings this job left. Returns the notice lines and the readings file.
const LOG_ACTION = parseWorkflow(
  fs.readFileSync(
    path.join(ROOT, ".github", "actions", "report-api-budget", "action.yml"),
    "utf8",
  ),
);
function logBudget(job, contexts, dir) {
  const logStep = job.steps.at(-1);
  const readings = path.join(dir, "api-budget", "github-token");
  const lines = fs.existsSync(readings)
    ? fs.readFileSync(readings, "utf8").split("\n").filter(Boolean)
    : [];
  fs.writeFileSync(path.join(dir, "summary"), "");
  fs.writeFileSync(path.join(dir, "output"), "");
  const result = spawnSync("bash", ["-c", LOG_ACTION.runs.steps[0].run], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: dir,
      GITHUB_ACTION_PATH: path.join(
        ROOT,
        ".github",
        "actions",
        "report-api-budget",
      ),
      GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
      GITHUB_OUTPUT: path.join(dir, "output"),
      GITHUB_WORKFLOW_REF: "o/r/.github/workflows/review.yml@refs/pull/7/merge",
      GITHUB_JOB: contexts.github.job,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      TOKENS: render(logStep.with.tokens, contexts),
      RESPONSES: render(logStep.with.responses ?? "", contexts),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  fs.rmSync(path.join(dir, "api-budget"), { recursive: true, force: true });
  return {
    readings: lines,
    notices: result.stdout.split("\n").filter(Boolean),
  };
}

const GATE = "export const findSecret = () => null;\n";

// `${{ ... }}` in a workflow value, rendered against the run's contexts.
function render(value, contexts) {
  return String(value)
    .replace(/\$\{\{ runner\.temp \}\}/gu, contexts.runnerTemp ?? "")
    .replace(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression) => {
      const result = evaluate(expression, contexts);
      return result === null || result === undefined ? "" : String(result);
    });
}
const renderEnv = (s, contexts) =>
  Object.fromEntries(
    Object.entries(s.env ?? {}).map(([k, v]) => [k, render(v, contexts)]),
  );

async function withEnv(values, fn) {
  const saved = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const quietCore = (outputs = {}) => ({
  setOutput: (k, v) => {
    outputs[k] = v;
  },
  setSecret: () => {},
  setFailed: (m) => {
    throw new Error(`setFailed: ${m}`);
  },
  info: () => {},
  notice: () => {},
  warning: () => {},
  summary: { addRaw: () => quietCore().summary, write: async () => {} },
});

// The gate step's git calls: the clone, the tip and the one file.
const fakeGit = (name) =>
  name === "node:child_process"
    ? {
        execFileSync: (command, args) => {
          assert.equal(command, "git");
          if (args.includes("rev-parse")) return `${TIP}\n`;
          if (args.includes("show")) return GATE;
          return "";
        },
      }
    : require(name);

// The full-diff step under a `gh` that counts its calls and a quiet `git`.
function runFullDiff(env, dir) {
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "gh.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash\necho "$*" >> "${log}"\nprintf 'HTTP/2.0 200 OK\\r\\n\\r\\n${MB_OLD}\\n'\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "git"),
    '#!/usr/bin/env bash\n[ "$1" = diff ] && [ "$2" = --name-only ] && echo a.js\nexit 0\n',
    { mode: 0o755 },
  );
  const output = path.join(dir, "full-diff.out");
  const result = spawnSync("bash", ["-e", "-c", stepId(key, "full-diff").run], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: output,
      GITHUB_SERVER_URL: "https://github.com",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

// One run: the requests it spends, by method, with gh calls as `gh api`.
// `secret` stands in for a registered secret's value: the runner drops any
// job output whose value contains it (actions/runner JobExtension.cs compares
// the value with SecretMasker.MaskSecrets(value)). `tamper` rewrites the
// handoff file between the key job and the status job.
async function spend({
  action,
  prFiles,
  comments,
  compares,
  review,
  secret,
  tamper,
}) {
  const dir = makeTemporaryDirectory("pr-review-cli-calls-");
  const api = fakeApi({ prFiles, comments, compares });
  const github = {
    job: "review-key",
    token: "job-token",
    repository: "o/r",
    repository_owner: "o",
    event_name: "pull_request",
    event: {
      action,
      repository: { name: "r" },
      pull_request: {
        number: 7,
        head: { sha: HEAD },
        base: { ref: "main", sha: MB_OLD },
      },
    },
  };
  const contexts = {
    github,
    inputs: INPUTS,
    vars: {},
    secrets: {},
    runnerTemp: dir,
  };

  // The key job: scope, then the full diff when it reviews.
  const scope = stepId(key, "scope");
  const scopeOutputs = {};
  api.newClient();
  await withEnv(
    {
      ...renderEnv(scope, { ...contexts, steps: {} }),
      DIFF_FILE: path.join(dir, "incremental.diff"),
      GITHUB_SERVER_URL: "https://github.com",
      RUNNER_TEMP: dir,
    },
    () =>
      new AsyncFunction(
        "require",
        "github",
        "context",
        "core",
        scope.with.script,
      )(
        require,
        api.github,
        { repo: { owner: "o", repo: "r" } },
        quietCore(scopeOutputs),
      ),
  );
  const gh =
    scopeOutputs.review === "false"
      ? []
      : runFullDiff(
          renderEnv(stepId(key, "full-diff"), {
            ...contexts,
            steps: { scope: { outputs: scopeOutputs } },
          }),
          dir,
        );
  const keySteps = {
    scope: { outputs: scopeOutputs },
    claude: { outputs: {} },
    credential: { outputs: { present: "true" } },
    "review-outcome": { outputs: { "review-failed": "false" } },
    extract: {
      outputs: { verdict: "complete", review: JSON.stringify(review) },
    },
  };
  const handoffStep = stepId(key, "handoff-file");
  const handoffOutputs = {};
  await withEnv(renderEnv(handoffStep, { ...contexts, steps: keySteps }), () =>
    new AsyncFunction("require", "core", handoffStep.with.script)(
      require,
      quietCore(handoffOutputs),
    ),
  );
  keySteps["handoff-file"] = { outputs: handoffOutputs };
  const keyRequests = api.calls.length + gh.length;
  const keyBudget = logBudget(key, contexts, dir);
  const keyOutputs = Object.fromEntries(
    Object.entries(key.outputs)
      .map(([k, v]) => [k, render(v, { ...contexts, steps: keySteps })])
      .filter(([, v]) => !(secret && v.includes(secret))),
  );
  if (tamper) {
    const file = path.join(dir, "review-handoff", "review-key.json");
    fs.writeFileSync(file, tamper(fs.readFileSync(file, "utf8")));
  }

  // The status job: the gate, publish, then the hold.
  github.job = "status";
  const gateStep = stepId(status, "gate");
  const gateOutputs = {};
  api.newClient();
  await withEnv({ RUNNER_TEMP: dir }, () =>
    new AsyncFunction(
      "require",
      "github",
      "context",
      "core",
      gateStep.with.script,
    )(
      fakeGit,
      api.github,
      { repo: { owner: "o", repo: "r" } },
      quietCore(gateOutputs),
    ),
  );
  const statusContexts = {
    ...contexts,
    needs: {
      "review-key": { result: "success", outputs: keyOutputs },
      "review-subscription": { result: "skipped", outputs: {} },
    },
    steps: { gate: { outputs: gateOutputs } },
  };
  const checkStep = stepId(status, "handoffs");
  const handoffs = {};
  const warnings = [];
  await withEnv(renderEnv(checkStep, statusContexts), () =>
    new AsyncFunction("require", "core", checkStep.with.script)(require, {
      ...quietCore(handoffs),
      warning: (message) => warnings.push(message),
    }),
  );
  statusContexts.steps.handoffs = { outputs: handoffs };
  const named = (name) => status.steps.find((s) => s.name === name);
  const runner = (s) => renderEnv(s, statusContexts);
  const context = { repo: { owner: "o", repo: "r" } };
  // Each composite's own github-script step, with the env the workflow
  // passes it.
  const composite = async (s, core) => {
    const action = s.uses.replace(/^\$\//u, "");
    const script = parseWorkflow(
      fs.readFileSync(path.join(ROOT, action, "action.yml"), "utf8"),
    ).runs.steps[0].with.script;
    api.newClient();
    await withEnv(
      { ...runner(s), ACTION_PATH: path.join(ROOT, action), RUNNER_TEMP: dir },
      () =>
        new AsyncFunction("require", "github", "context", "core", script)(
          require,
          api.github,
          context,
          core,
        ),
    );
  };
  await composite(named("Publish the review"), quietCore());
  const holdOutputs = {};
  await composite(stepId(status, "hold"), quietCore(holdOutputs));
  const statusBudget = logBudget(status, statusContexts, dir);

  const counts = {};
  for (const name of [...api.calls, ...gh.map(() => "gh api")])
    counts[name] = (counts[name] ?? 0) + 1;
  const total = api.calls.length + gh.length;
  return {
    counts,
    total,
    keyRequests,
    keyBudget,
    statusBudget,
    hold: holdOutputs.hold,
    keyOutputs,
    warnings,
    requests: api.requests,
  };
}

const INLINE = {
  findings: 1,
  summary: "One finding.",
  comments: [{ path: "a.js", line: 2, side: "RIGHT", body: "Off by one." }],
};
const NONE = { findings: 0, summary: "Nothing found.", comments: [] };
const A = { filename: "a.js", status: "modified", patch: PATCH, changes: 3 };
const CODEOWNERS = {
  filename: "CODEOWNERS",
  status: "modified",
  patch: "@@ -1 +1 @@\n-a\n+b",
  changes: 2,
};
const marker = {
  id: 41,
  user: { login: BOT },
  body: [
    `<!-- claude-lane-reviewed-head lane=claude-review sha=${LAST} -->`,
    `<!-- claude-lane-reviewed-base ref=main merge-base=${MB_OLD} -->`,
    "**claude-review** reviewed it.",
    "",
    "Earlier summary.",
  ].join("\n"),
};

const SHAPES = {
  "a whole review with an inline comment": {
    action: "opened",
    prFiles: [A],
    compares: { [`main...${HEAD}`]: { merge_base_commit: { sha: MB_OLD } } },
    review: INLINE,
  },
  "a whole review with no inline comment": {
    action: "opened",
    prFiles: [A],
    compares: { [`main...${HEAD}`]: { merge_base_commit: { sha: MB_OLD } } },
    review: NONE,
  },
  "an incremental review with an inline comment": {
    action: "synchronize",
    prFiles: [A],
    comments: [marker],
    compares: {
      [`main...${HEAD}`]: { merge_base_commit: { sha: MB_OLD } },
      [`${LAST}...${HEAD}`]: { status: "ahead", files: [A] },
      [`main...${LAST}`]: { merge_base_commit: { sha: MB_OLD } },
    },
    review: INLINE,
  },
  "a no-change skip after a base-branch merge": {
    action: "synchronize",
    prFiles: [A],
    comments: [marker],
    compares: {
      [`main...${HEAD}`]: { merge_base_commit: { sha: MB_NEW } },
      [`${LAST}...${HEAD}`]: {
        status: "ahead",
        files: [{ filename: "z.md", patch: "@@ -1 +1 @@\n-x\n+y", changes: 2 }],
      },
      [`main...${LAST}`]: { merge_base_commit: { sha: MB_OLD } },
      [`${MB_OLD}...${MB_NEW}`]: { files: [{ filename: "z.md" }] },
    },
    review: NONE,
  },
  "a whole review that changes a hold-paths file and holds nothing": {
    action: "opened",
    prFiles: [A, CODEOWNERS],
    compares: { [`main...${HEAD}`]: { merge_base_commit: { sha: MB_OLD } } },
    review: INLINE,
  },
  "a whole review that returns a critical-security hold": {
    action: "opened",
    prFiles: [A, CODEOWNERS],
    compares: { [`main...${HEAD}`]: { merge_base_commit: { sha: MB_OLD } } },
    review: {
      ...INLINE,
      hold: { criteria: ["critical-security"], reason: "A CRITICAL finding." },
    },
  },
};

test("each run shape spends the requests pinned here, reading the file list once", async () => {
  const totals = {};
  for (const [name, shape] of Object.entries(SHAPES)) {
    const { counts, total, hold } = await spend(shape);
    totals[name] = total;
    assert.equal(counts["pulls.listFiles"], 1, `${name}: files`);
    assert.ok((counts["pulls.get"] ?? 0) <= 2, `${name}: pulls.get`);
    assert.equal(
      counts["issues.listComments"] ?? 0,
      hold === "true" ? 2 : 1,
      `${name}: comments`,
    );
    for (const gone of [
      "repos.get",
      "repos.getBranch",
      "repos.getContent",
      "gh api",
    ])
      assert.equal(counts[gone], undefined, `${name}: ${gone}`);
  }
  assert.deepEqual(totals, {
    "a whole review with an inline comment": 8,
    "a whole review with no inline comment": 6,
    "an incremental review with an inline comment": 10,
    "a no-change skip after a base-branch merge": 8,
    "a whole review that changes a hold-paths file and holds nothing": 8,
    "a whole review that returns a critical-security hold": 11,
  });
});

// The api-budget notice reads the headers of the requests above and adds
// none: one reading per job-token request, and the key and status jobs each
// end with one core line whose cost is the rise in used since the job's
// first reading, na when the job made one request, then the api-calls line
// with the job's own request count.
test("each job logs one reading per request it made, its api-budget line and its api-calls count, adding no request", async () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    const { total, keyRequests, keyBudget, statusBudget } = await spend(shape);
    assert.equal(
      keyBudget.readings.length,
      keyRequests,
      `${name}: key readings`,
    );
    assert.equal(
      statusBudget.readings.length,
      total - keyRequests,
      `${name}: status readings`,
    );
    for (const [job, budget, first, last] of [
      ["review-key", keyBudget, 1, keyRequests],
      ["status", statusBudget, keyRequests + 1, total],
    ]) {
      assert.deepEqual(
        budget.notices,
        [
          `::notice title=api-budget::token=github-token workflow=.github/workflows/review.yml job=${job} run=1 attempt=1 ` +
            `limit=1000 remaining=${1000 - last} used=${last} reset=${RESET} resource=core cost=${last === first ? "na" : last - first}`,
          `::notice title=api-calls::github-token=${last - first + 1} not-modified=0 graphql=0`,
        ],
        `${name}: ${job}`,
      );
    }
  }
});

test("a whole review reads pulls.get in scope and once more in publish, and nowhere else", async () => {
  const { counts } = await spend(
    SHAPES["a whole review with an inline comment"],
  );
  assert.deepEqual(counts, {
    "issues.listComments": 1,
    "pulls.listFiles": 1,
    "pulls.get": 2,
    "repos.compareCommitsWithBasehead": 1,
    "pulls.listReviewComments": 1,
    "pulls.createReview": 1,
    "issues.createComment": 1,
  });
});

test("the scope step's hunk ranges give the lines commentableLines reads from the patch", () => {
  const patches = [
    PATCH,
    "@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n@@ -10 +11 @@\n-x\n+y\n\\ No newline at end of file",
    "@@ -0,0 +1,2 @@\n+new\n+file",
    "@@ -1,2 +0,0 @@\n-gone\n-file",
    "@@ -5,3 +5,3 @@ function f() {\n a\n-b\n+c\n d",
  ];
  // The scope step's own extraction, as it writes PR_FILES.
  const script = stepId(key, "scope").with.script;
  const pattern = /matchAll\((\/\^@@[^\n]*?\/gmu)\)/u.exec(script)[1];
  const re = new Function(`return ${pattern};`)();
  for (const patch of patches) {
    const hunks = [...patch.matchAll(re)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(
      publishReview.hunkLines(hunks),
      publishReview.commentableLines(patch),
      patch,
    );
  }
  assert.equal(publishReview.hunkLines(["1,2 x"]), null);
});

test("publish reads the file list itself without a usable scope list", async () => {
  const good = JSON.stringify({
    head: HEAD,
    changed: 1,
    files: [{ n: "a.js", h: ["1,3 1,4"] }],
  });
  for (const [value, usable] of [
    [good, true],
    ["", false],
    ["{not json", false],
    [JSON.stringify({ head: LAST, changed: 1, files: [{ n: "a.js" }] }), false],
    [JSON.stringify({ head: HEAD, changed: -1, files: [] }), false],
    [JSON.stringify({ head: HEAD, changed: 1, files: [{ n: 3 }] }), false],
    [
      JSON.stringify({
        head: HEAD,
        changed: 1,
        files: [{ n: "a.js", h: [1] }],
      }),
      false,
    ],
  ]) {
    assert.equal(
      publishReview.scopedFiles({ HEAD_SHA: HEAD, PR_FILES: value }) !== null,
      usable,
      value,
    );
  }
});

test("the hold reads no file list, with or without the scope list", async () => {
  for (const PR_FILES of [
    "",
    JSON.stringify({ head: HEAD, changed: 3001, files: [{ n: "CODEOWNERS" }] }),
  ]) {
    const api = fakeApi({ prFiles: [{ filename: "CODEOWNERS" }] });
    const outputs = {};
    await applyHold.run({
      github: api.github,
      context: { repo: { owner: "o", repo: "r" } },
      core: quietCore(outputs),
      env: {
        HOLD_LABEL: "needs-human",
        HOLD_PATHS: "**/CODEOWNERS",
        LANE_ID: "claude-review",
        PR_NUMBER: "7",
        HEAD_SHA: HEAD,
        PR_FILES,
        SUB_RESULT: "skipped",
        KEY_PRESENT: "true",
        KEY_FAILED: "false",
        KEY_CLASS: "",
        KEY_VERDICT: "complete",
        KEY_REVIEW: JSON.stringify(NONE),
      },
    });
    assert.equal(outputs.hold, "false");
    assert.deepEqual(api.calls, []);
  }
});

test("the scope step passes on no file list larger than one environment string", async () => {
  const big = Array.from({ length: 3000 }, (_, i) => ({
    filename: `${"d/".repeat(20)}file-${i}.js`,
    patch: PATCH,
  }));
  const outputs = {};
  const api = fakeApi({
    prFiles: big,
    compares: { [`main...${HEAD}`]: { merge_base_commit: { sha: MB_OLD } } },
  });
  const scope = stepId(key, "scope");
  await withEnv(
    {
      LANE: "claude-review",
      INCREMENTAL: "true",
      DOCS_ONLY_PATHS: "",
      EVENT_ACTION: "opened",
      PR_NUMBER: "7",
      HEAD_SHA: HEAD,
      BASE_REF: "main",
      DIFF_FILE: path.join(makeTemporaryDirectory("scope-big-"), "x.diff"),
      GIT_TOKEN: "t",
    },
    () =>
      new AsyncFunction(
        "require",
        "github",
        "context",
        "core",
        scope.with.script,
      )(
        require,
        api.github,
        { repo: { owner: "o", repo: "r" } },
        quietCore(outputs),
      ),
  );
  assert.equal(outputs.review, "true");
  assert.equal(outputs["pr-files"], undefined);
});

test("a review quoting a registered secret's value still reaches publish through the handoff", async () => {
  const secret = "SENTINEL-4711";
  const review = {
    findings: 1,
    summary: `The test fixture hard-codes ${secret}.`,
    comments: [
      { path: "a.js", line: 2, side: "RIGHT", body: `Move ${secret} out.` },
    ],
  };
  const shape = SHAPES["a whole review with an inline comment"];
  // The old wiring passed the review itself as a job output, which the
  // runner drops.
  assert.ok(JSON.stringify(review).includes(secret));
  const { counts, keyOutputs, warnings, requests } = await spend({
    ...shape,
    review,
    secret,
  });
  assert.equal("review" in keyOutputs, false);
  assert.match(keyOutputs["handoff-sha256"], /^[0-9a-f]{64}$/u);
  assert.deepEqual(warnings, []);
  const posted = requests.find((r) => r.name === "pulls.createReview");
  assert.ok(posted, "no review was posted");
  assert.match(posted.params.comments[0].body, new RegExp(secret, "u"));
  const marker = requests.find((r) => r.name === "issues.createComment");
  assert.match(marker.params.body, new RegExp(secret, "u"));
  // The handoff adds no job-token request.
  assert.deepEqual(counts, (await spend(shape)).counts);
});

test("the status job refuses a handoff file whose sha256 does not match the key job's", async () => {
  await assert.rejects(
    spend({
      ...SHAPES["a whole review with an inline comment"],
      tamper: (text) =>
        text.replace("Off by one.", "Approve this pull request."),
    }),
    /failure-class=incomplete: the model returned no usable review/u,
  );
});
