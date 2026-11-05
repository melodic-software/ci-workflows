"use strict";

// report-api-budget: the job-end api-budget notice from the rate-limit readings
// a job's own API responses left, in the line the hub collector reads. The
// readings come from Octokit's request hooks (api-budget.cjs, and the scope
// step's inline copy) and from `gh api -i` output files; nothing reads
// GET /rate_limit.

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const ROOT = path.join(__dirname, "..", "..");
const ACTION_DIR = path.join(ROOT, ".github", "actions", "report-api-budget");
const LIB = path.join(ACTION_DIR, "api-budget.bash");
const ACTION_TEXT = fs.readFileSync(
  path.join(ACTION_DIR, "action.yml"),
  "utf8",
);
const ACTION = parseWorkflow(ACTION_TEXT);
const {
  PLACEHOLDERS,
  REST_PATH_WORDS,
  readingLine,
  recordReading,
  routeOf,
  routeOk,
  watch,
} = require(path.join(ACTION_DIR, "api-budget.cjs"));
const WORKFLOW = parseWorkflow(
  fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "pr-review-cli.yml"),
    "utf8",
  ),
);
const INTAKE_TEXT = fs.readFileSync(
  path.join(ROOT, ".github", "workflows", "intake-triage.yml"),
  "utf8",
);
const INTAKE = parseWorkflow(INTAKE_TEXT);

const RUNNER = {
  GITHUB_WORKFLOW_REF:
    "melodic-software/ci-workflows/.github/workflows/pr-review-cli.yml@refs/tags/v0.65.2",
  GITHUB_JOB: "status",
  GITHUB_RUN_ID: "39931677333",
  GITHUB_RUN_ATTEMPT: "2",
};
const WHERE =
  "workflow=.github/workflows/pr-review-cli.yml job=status run=39931677333 attempt=2";
const NOTICE = "::notice title=api-budget::";
const CALLS = "::notice title=api-calls::";
const ROUTES = "::notice title=api-routes::";
const RESET = 1792748042;

// A `gh api -i` header block, CRLF header lines as gh prints them.
const head = ({ status = 200, used, reset = RESET, resource = "core" }) =>
  `HTTP/2.0 ${status} OK\r\nContent-Type: application/json\r\nX-Ratelimit-Limit: 1000\r\n` +
  `X-Ratelimit-Remaining: ${1000 - used}\r\nX-Ratelimit-Reset: ${reset}\r\nX-Ratelimit-Resource: ${resource}\r\n` +
  `X-Ratelimit-Used: ${used}\r\n\r\n`;
// The same reading as Octokit hands a hook: lower-case keys, string values.
const octokitHeaders = ({ used, reset = RESET, resource = "core" }) => ({
  "content-type": "application/json",
  "x-ratelimit-limit": "1000",
  "x-ratelimit-remaining": String(1000 - used),
  "x-ratelimit-reset": String(reset),
  "x-ratelimit-resource": resource,
  "x-ratelimit-used": String(used),
});

function bash(dir, script, { input = "", env = {} } = {}) {
  const result = spawnSync("bash", ["-c", `. "${LIB}"\n${script}`], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, RUNNER_TEMP: dir, ...RUNNER, ...env },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}
const state = (dir, token = "github-token") =>
  fs.readFileSync(path.join(dir, "api-budget", token), "utf8");
function record(dir, ...readings) {
  for (const r of readings) {
    recordReading({
      token: "github-token",
      dir,
      status: r.status ?? 200,
      headers: octokitHeaders(r),
    });
  }
}

// The action's one step, run as shipped.
function runAction(dir, { tokens = "github-token", responses = "" } = {}) {
  fs.writeFileSync(path.join(dir, "summary"), "");
  fs.writeFileSync(path.join(dir, "output"), "");
  const out = execFileSync("bash", ["-c", ACTION.runs.steps[0].run], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...RUNNER,
      RUNNER_TEMP: dir,
      GITHUB_ACTION_PATH: ACTION_DIR,
      GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
      GITHUB_OUTPUT: path.join(dir, "output"),
      TOKENS: tokens,
      RESPONSES: responses,
    },
  });
  return {
    out,
    summary: fs.readFileSync(path.join(dir, "summary"), "utf8"),
    output: fs.readFileSync(path.join(dir, "output"), "utf8"),
  };
}

test("readingLine takes Octokit's plain header object, na for a missing or malformed value", () => {
  assert.equal(
    readingLine(200, octokitHeaders({ used: 12 })),
    `200 1000 988 12 ${RESET} core other\n`,
  );
  assert.equal(
    readingLine(200, octokitHeaders({ used: 12 }), "repos/{repo}/pulls/{n}"),
    `200 1000 988 12 ${RESET} core repos/{repo}/pulls/{n}\n`,
  );
  // A route not in routeOf's shape is never written.
  assert.equal(
    readingLine(200, octokitHeaders({ used: 12 }), "repos/o/r"),
    `200 1000 988 12 ${RESET} core other\n`,
  );
  assert.equal(
    readingLine(304, {
      "x-ratelimit-limit": "1000",
      "x-ratelimit-used": "12",
      "x-ratelimit-resource": "Core!",
    }),
    "304 1000 na 12 na na other\n",
  );
  assert.equal(readingLine(200, undefined), "200 na na na na na other\n");
});

test("recordReading appends one line per response and needs a token name and RUNNER_TEMP", () => {
  const dir = makeTemporaryDirectory("api-budget-");
  record(dir, { used: 1 }, { used: 2 });
  recordReading({ token: "Bad Name", dir, status: 200, headers: {} });
  recordReading({ token: "lanes-app", dir: "", status: 200, headers: {} });
  assert.equal(
    state(dir),
    `200 1000 999 1 ${RESET} core other\n200 1000 998 2 ${RESET} core other\n`,
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, "api-budget")), [
    "github-token",
  ]);
});

test("watch records every response and refusal of one Octokit client and rethrows the error", async () => {
  const dir = makeTemporaryDirectory("api-budget-watch-");
  const hooks = { after: [], error: [] };
  const github = {
    hook: {
      after: (name, fn) => hooks.after.push([name, fn]),
      error: (name, fn) => hooks.error.push([name, fn]),
    },
  };
  await withRunnerTemp(dir, () => watch(github, "github-token"));
  assert.deepEqual(
    [...hooks.after, ...hooks.error].map(([name]) => name),
    ["request", "request"],
  );
  await withRunnerTemp(dir, async () => {
    hooks.after[0][1]({
      status: 200,
      url: "https://api.github.com/repos/o/r/issues/7/comments?per_page=100",
      headers: octokitHeaders({ used: 5 }),
    });
    const refused = Object.assign(new Error("rate limited"), {
      status: 403,
      response: {
        status: 403,
        url: "https://api.github.com/repos/o/r/pulls/7",
        headers: octokitHeaders({ used: 1000 }),
      },
    });
    assert.throws(
      () => hooks.error[0][1](refused),
      (e) => e === refused,
    );
    // An error with no response (a network failure) is rethrown, unread.
    const network = new Error("socket hang up");
    assert.throws(
      () => hooks.error[0][1](network),
      (e) => e === network,
    );
  });
  assert.equal(
    state(dir),
    `200 1000 995 5 ${RESET} core repos/{repo}/issues/{n}/comments\n` +
      `403 1000 0 1000 ${RESET} core repos/{repo}/pulls/{n}\n`,
  );
});

async function withRunnerTemp(dir, fn) {
  const saved = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = saved;
  }
}

test("api_budget_read reads only the leading header block and passes the body through unchanged", () => {
  const dir = makeTemporaryDirectory("api-budget-read-");
  const body = "keep1\nHTTP/1.1 200 x\nflagged()\n\nafter\n";
  const file = path.join(dir, "r.http");
  fs.writeFileSync(file, head({ used: 120 }) + body);
  assert.equal(
    bash(dir, `api_budget_read github-token "${file}"`).stdout,
    body,
  );
  assert.equal(state(dir), `200 1000 880 120 ${RESET} core other\n`);
  // A route given is kept when it is in the route's shape, else other.
  fs.writeFileSync(file, head({ used: 121 }) + body);
  bash(dir, `api_budget_read github-token "${file}" 'repos/{repo}/pulls/{n}'`);
  fs.writeFileSync(file, head({ used: 122 }) + body);
  bash(dir, `api_budget_read github-token "${file}" repos/o/r`);
  assert.deepEqual(state(dir).split("\n").slice(1, 3), [
    `200 1000 879 121 ${RESET} core repos/{repo}/pulls/{n}`,
    `200 1000 878 122 ${RESET} core other`,
  ]);
  fs.writeFileSync(file, "[1]\n");
  assert.equal(
    bash(dir, `api_budget_read lanes-app "${file}"`).stdout,
    "[1]\n",
  );
  assert.equal(fs.existsSync(path.join(dir, "api-budget", "lanes-app")), false);
});

test("api_budget_emit writes the last reading of each resource, core last, cost since the first with the same reset", () => {
  const dir = makeTemporaryDirectory("api-budget-emit-");
  record(
    dir,
    { used: 13 },
    { used: 4, resource: "graphql" },
    { used: 100, reset: RESET + 60 },
    { used: 9, resource: "graphql" },
    { used: 328, reset: RESET + 60 },
  );
  assert.equal(
    bash(dir, "api_budget_emit github-token").stdout,
    `${NOTICE}token=github-token ${WHERE} limit=1000 remaining=991 used=9 reset=${RESET} resource=graphql cost=5\n` +
      `${NOTICE}token=github-token ${WHERE} limit=1000 remaining=672 used=328 reset=${RESET + 60} resource=core cost=228\n`,
  );
});

test("api_budget_emit writes a line for each refused reading, cost=na with no earlier reading in the window", () => {
  const dir = makeTemporaryDirectory("api-budget-refused-");
  record(
    dir,
    { used: 900 },
    { status: 403, used: 1000 },
    { used: 3, reset: RESET + 3600 },
  );
  const lines = bash(dir, "api_budget_emit github-token")
    .stdout.split("\n")
    .filter(Boolean);
  assert.deepEqual(
    lines.map((line) => line.slice(line.indexOf(" used="))),
    [
      ` used=1000 reset=${RESET} resource=core cost=100`,
      ` used=3 reset=${RESET + 3600} resource=core cost=na`,
    ],
  );
});

test("the action reads the named gh api -i files, then emits each token with the summary and costs output", () => {
  const dir = makeTemporaryDirectory("api-budget-action-");
  record(dir, { used: 13 }, { used: 41 });
  fs.writeFileSync(
    path.join(dir, "compare.http"),
    `${head({ used: 42 })}${"d".repeat(40)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "pr-context.json.http"),
    `${head({ used: 7, resource: "graphql" })}{"data":{}}\n`,
  );
  const { out, summary, output } = runAction(dir, {
    tokens: "lanes-app\ngithub-token",
    responses: `${path.join(dir, "compare.http")}\n${path.join(dir, "missing.http")} ${path.join(dir, "pr-context.json.http")}`,
  });
  const graphql = `token=github-token ${WHERE} limit=1000 remaining=993 used=7 reset=${RESET} resource=graphql cost=na`;
  const core = `token=github-token ${WHERE} limit=1000 remaining=958 used=42 reset=${RESET} resource=core cost=29`;
  // Two Octokit readings and two response files; missing.http is no request.
  const lanes = "lanes-app=0 not-modified=0 graphql=0";
  const job = "github-token=4 not-modified=0 graphql=1";
  // The counting lines first, as claude-code-plugins' log-api-budget writes
  // them: each token's api-calls, then the api-routes, then api-budget.
  const routes = ["lanes-app rest=0", "github-token other=4 rest=0"];
  assert.equal(
    out,
    `${CALLS}${lanes}\n${CALLS}${job}\n${ROUTES}${routes[0]}\n${ROUTES}${routes[1]}\n${NOTICE}${graphql}\n${NOTICE}${core}\n`,
  );
  assert.equal(
    summary,
    `api-calls ${lanes}\napi-calls ${job}\napi-routes ${routes[0]}\napi-routes ${routes[1]}\napi-budget: ${graphql}\napi-budget: ${core}\ngithub-token-cost=29\n`,
  );
  assert.equal(output, "costs=github-token-cost=29\n");
});

test("the action counts a 304 as not-modified, not as a request", () => {
  const dir = makeTemporaryDirectory("api-budget-304-");
  record(dir, { used: 5 }, { status: 304, used: 5 }, { used: 6 });
  assert.match(
    runAction(dir).out,
    /^::notice title=api-calls::github-token=2 not-modified=1 graphql=0$/mu,
  );
});

test("the action writes only zero api-calls and api-routes lines for a job that made no request, and never fails", () => {
  const dir = makeTemporaryDirectory("api-budget-none-");
  const { out, summary, output } = runAction(dir, {
    responses: path.join(dir, "missing.http"),
  });
  const zero = "github-token=0 not-modified=0 graphql=0";
  assert.deepEqual(
    [out, summary, output],
    [
      `${CALLS}${zero}\n${ROUTES}github-token rest=0\n`,
      `api-calls ${zero}\napi-routes github-token rest=0\n`,
      "",
    ],
  );
});

test("nothing in the action or the workflow reads GET /rate_limit", () => {
  const sources = [
    ACTION_TEXT,
    fs.readFileSync(LIB, "utf8"),
    fs.readFileSync(path.join(ACTION_DIR, "api-budget.cjs"), "utf8"),
    fs.readFileSync(
      path.join(ROOT, ".github", "workflows", "pr-review-cli.yml"),
      "utf8",
    ),
    INTAKE_TEXT,
  ].join("\n");
  assert.doesNotMatch(
    sources,
    /(?:gh api|request\(|fetch\()[^\n]*rate_limit|rateLimit\.get/u,
  );
});

// The URLs the recorder parity tests send, each with its own route.
const URLS = {
  ok: "https://api.github.com/repos/o/r/issues/7/comments?per_page=100",
  refused: "https://api.github.com/repos/o/r/compare/main...abc1234",
  bare: "https://api.github.com/graphql",
};

// The scope step is inline, so it cannot load api-budget.cjs: its recorder
// must write the line api-budget.cjs writes, for a response and a refusal.
for (const job of ["review-key", "review-subscription"]) {
  test(`${job}: the scope step records each response as api-budget.cjs does`, async () => {
    const dir = makeTemporaryDirectory("api-budget-scope-");
    const hooks = { after: [], error: [] };
    const github = {
      hook: {
        after: (name, fn) => hooks.after.push([name, fn]),
        error: (name, fn) => hooks.error.push([name, fn]),
      },
      paginate: async () => {
        throw new Error("no API in this test");
      },
      rest: new Proxy(
        {},
        { get: () => new Proxy({}, { get: () => async () => ({}) }) },
      ),
    };
    const core = new Proxy({}, { get: () => () => {} });
    const script = WORKFLOW.jobs[job].steps.find((s) => s.id === "scope").with
      .script;
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await withRunnerTemp(dir, () =>
      new AsyncFunction("require", "github", "context", "core", script)(
        require,
        github,
        { repo: { owner: "o", repo: "r" } },
        core,
      ),
    );
    assert.equal(hooks.after.length, 1, "one after hook");
    assert.equal(hooks.error.length, 1, "one error hook");
    const ok = {
      status: 200,
      url: URLS.ok,
      headers: octokitHeaders({ used: 5 }),
    };
    const refused = Object.assign(new Error("rate limited"), {
      status: 429,
      response: {
        status: 429,
        url: URLS.refused,
        headers: {
          ...octokitHeaders({ used: 9 }),
          "x-ratelimit-resource": "Bad!",
        },
      },
    });
    // An error whose status is only on its response, as a wrapper may build
    // one, and whose URL is only on its request.
    const bare = Object.assign(new Error("rate limited"), {
      request: { url: URLS.bare },
      response: { status: 403, headers: octokitHeaders({ used: 10 }) },
    });
    await withRunnerTemp(dir, () => {
      hooks.after[0][1](ok);
      for (const error of [refused, bare])
        assert.throws(
          () => hooks.error[0][1](error, { method: "GET", url: "/x" }),
          (e) => e === error,
        );
    });
    assert.equal(
      state(dir),
      readingLine(200, ok.headers, routeOf(URLS.ok)) +
        readingLine(429, refused.response.headers, routeOf(URLS.refused)) +
        readingLine(403, bare.response.headers, routeOf(URLS.bare)),
    );
  });
}

// Each job that spends the job token ends with the notice, whatever failed.
test("every pr-review-cli job ends by logging the job token's budget", () => {
  for (const [name, job] of Object.entries(WORKFLOW.jobs)) {
    const last = job.steps.at(-1);
    assert.equal(last.uses, "$/.github/actions/report-api-budget", name);
    assert.equal(last.if, "always()", name);
    assert.equal(last["continue-on-error"], true, name);
    assert.equal(last.with.tokens, "github-token", name);
  }
  for (const job of ["review-key", "review-subscription"]) {
    assert.equal(
      WORKFLOW.jobs[job].steps.at(-1).with.responses,
      `\${{ runner.temp }}/compare.http\n\${{ runner.temp }}/pr-context.json.http\n`,
      job,
    );
  }
});

// The intake jobs that call the API with the job token end with the notice.
// The status job holds no permission and makes no request, so it has none.
test("every intake-triage job that calls the API ends by logging the job token's budget", () => {
  const callers = ["check-key-credit", "claude", "subscription", "fallback", "apply", "skipped"];
  assert.deepEqual(
    Object.keys(INTAKE.jobs).sort(),
    [...callers, "status"].sort(),
  );
  for (const name of callers) {
    const last = INTAKE.jobs[name].steps.at(-1);
    assert.equal(last.name, "Log the API budget", name);
    assert.equal(last.uses, "$/.github/actions/report-api-budget", name);
    assert.equal(last.if, "always()", name);
    assert.equal(last["continue-on-error"], true, name);
    assert.equal(last.with.tokens, "github-token", name);
    assert.equal(last.with.responses, undefined, name);
  }
  const { status } = INTAKE.jobs;
  assert.deepEqual(status.permissions, {});
  assert.equal(
    status.steps.some((s) => s.uses || s.with),
    false,
    "the status job runs only a shell step",
  );
});

// Each intake script step that calls the API opens with the scope step's
// recorder, so its requests reach the notice; it cannot load api-budget.cjs.
const API_CALL = /github\.(rest|graphql|paginate|request)\b/u;
const intakeRecorders = Object.entries(INTAKE.jobs).flatMap(
  ([job, { steps }]) =>
    steps
      .filter((s) => API_CALL.test(s.with?.script ?? ""))
      .map((s) => {
        const script = s.with.script;
        const end = script.indexOf(
          "\n});\n",
          script.indexOf("github.hook.error"),
        );
        return {
          where: `${job}: ${s.name}`,
          recorder: end < 0 ? "" : script.slice(0, end + 4),
        };
      }),
);

test("every intake-triage API step opens with one shared recorder", () => {
  assert.equal(intakeRecorders.length, 11);
  for (const { where, recorder } of intakeRecorders) {
    assert.match(recorder, /^\/\/ Each response's rate-limit reading/u, where);
    assert.equal(recorder, intakeRecorders[0].recorder, where);
  }
});

test("the intake recorder records each response and refusal as api-budget.cjs does", async () => {
  const dir = makeTemporaryDirectory("api-budget-intake-");
  const hooks = { after: [], error: [] };
  const github = {
    hook: {
      after: (name, fn) => hooks.after.push([name, fn]),
      error: (name, fn) => hooks.error.push([name, fn]),
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction("require", "github", intakeRecorders[0].recorder)(
    require,
    github,
  );
  assert.deepEqual(
    [hooks.after.map(([n]) => n), hooks.error.map(([n]) => n)],
    [["request"], ["request"]],
  );
  const ok = {
    status: 200,
    url: URLS.ok,
    headers: octokitHeaders({ used: 5 }),
  };
  const refused = Object.assign(new Error("rate limited"), {
    status: 429,
    response: {
      status: 429,
      url: URLS.refused,
      headers: octokitHeaders({ used: 9 }),
    },
  });
  const bare = Object.assign(new Error("not found"), {
    request: { url: URLS.bare },
    response: { status: 404, headers: octokitHeaders({ used: 10 }) },
  });
  const offline = new Error("socket hang up");
  await withRunnerTemp(dir, () => {
    hooks.after[0][1](ok);
    for (const error of [refused, bare, offline])
      assert.throws(
        () => hooks.error[0][1](error),
        (e) => e === error,
      );
  });
  assert.equal(
    state(dir),
    readingLine(200, ok.headers, routeOf(URLS.ok)) +
      readingLine(429, refused.response.headers, routeOf(URLS.refused)) +
      readingLine(404, bare.response.headers, routeOf(URLS.bare)),
  );
});

// publish-review and apply-review-hold record through api-budget.cjs.
for (const action of ["publish-review", "apply-review-hold"]) {
  test(`${action} watches its Octokit client before it runs`, () => {
    const script = parseWorkflow(
      fs.readFileSync(
        path.join(ROOT, ".github", "actions", action, "action.yml"),
        "utf8",
      ),
    ).runs.steps[0].with.script;
    assert.match(
      script,
      /require\(path\.join\(process\.env\.ACTION_PATH, "\.\.", "report-api-budget", "api-budget\.cjs"\)\)\.watch\(github, "github-token"\);\n[^\n]*\nawait run\(/u,
    );
  });
}

// URL or path, route and the names in the input no route may carry, tab
// separated (the names comma separated, "-" for none): the routes
// in claude-code-plugins' .github/actions/log-api-budget/rate-guard.vectors.json,
// whose routeOf and API_BUDGET_ROUTE these ports keep.
const ROUTE_VECTORS =
  `https://api.github.com/repos/melodic-software/claude-code-plugins/issues/42/comments?per_page=100&page=2	repos/{repo}/issues/{n}/comments	melodic,claude-code-plugins,per_page,page=2
repos/{owner}/{repo}/pulls/7/files	repos/{repo}/pulls/{n}/files	{owner}
/repos/o/r/commits/0123456789abcdef0123456789abcdef01234567/check-runs	repos/{repo}/commits/{sha}/check-runs	0123456789abcdef
repos/o/r/actions/runs/39931677333/attempts/2/jobs	repos/{repo}/actions/runs/{n}/attempts/{n}/jobs	39931677333
https://api.github.com/graphql	graphql	-
https://ghe.example/api/graphql	graphql	ghe.example
https://ghe.example/api/v3/repos/o/r/labels/needs-human	repos/{repo}/labels/{x}	ghe.example,needs-human
user/github_pat_abc	user/{x}	github_pat_abc
repos/o/r/git/ref/heads/feature/fix-it	repos/{repo}/git/ref/{x}/{x}/{x}	feature,fix-it
repos/o/r/branches/main/protection	repos/{repo}/branches/{x}/protection	main
users/SomeLogin/repos	users/{x}/repos	SomeLogin
repos/o/r/actions/workflows/pr-verify.yml/runs	repos/{repo}/actions/workflows/{x}/runs	pr-verify
repos/o/r/issues/1/comments#frag	repos/{repo}/issues/{n}/comments	frag
repos/o/r/hello world	repos/{repo}/{x}	hello
/repos/o/r/rules/branches/stale-feature-name	repos/{repo}/rules/branches/{x}	stale-feature-name
repos/o/r/branches/feat/secret-topic/protection	repos/{repo}/branches/{x}/{x}/protection	feat,secret-topic
repos/o/r/commits/release-candidate/status	repos/{repo}/commits/{x}/status	release-candidate
repos/o/r/git/trees/main?recursive=1	repos/{repo}/git/trees/{x}	main,recursive
repos/o/r/labels/area/ci	repos/{repo}/labels/{x}/{x}	area,ci
repos/o/r/actions/runners/build-box-seven	repos/{repo}/actions/{x}/{x}	runners,build-box-seven
repos/someowner	repos/{x}	someowner
applications/Iv1abcdef/token	{x}/{x}/{x}	applications,Iv1abcdef,token
https://github.com/someowner/somerepo/pull/5	other	someowner,somerepo,github.com
https://uploads.github.com/repos/o/r/releases/9/assets?name=secret-asset.zip	repos/{repo}/releases/{n}/{x}	secret-asset,assets
rate_limit	rate_limit	-
https://api.github.com/	other	-
repos/o/r/issues/issues/issues/issues/issues/issues/issues/issues/issues/issues/issues/issues/comments	other	-
repos/o/r/commits/ABCDEF0123/statuses	repos/{repo}/commits/{sha}/statuses	ABCDEF0123
repos/o/r/actions/workflows/pr-require-checks.yml/runs?event=workflow_dispatch&branch=main&per_page=20	repos/{repo}/actions/workflows/{x}/runs	pr-require-checks,event,main
repos/o/r/merge-async	repos/{repo}/{x}	merge-async`
    .split("\n")
    .map((row) => row.split("\t"))
    .map(([url, route, names]) => [
      url,
      route,
      names && names !== "-" ? names.split(",") : [],
    ])
    .concat([["", "other", []]]);

// Each inline recorder's `budget` function, cut from its step's script.
const inlineRecorders = [
  ...["review-key", "review-subscription", "review-fallback"].map((job) => ({
    where: job,
    script: WORKFLOW.jobs[job].steps.find((s) => s.id === "scope").with.script,
  })),
  ...intakeRecorders.map(({ where, recorder }) => ({
    where,
    script: recorder,
  })),
].map(({ where, script }) => ({
  where,
  budget: new Function(
    "require",
    `${script.slice(0, script.indexOf("github.hook.after"))}return budget;`,
  )(require),
}));

test("routeOf, the shell's api_route and every inline recorder template each request path alike, leaking nothing", async () => {
  const urls = ROUTE_VECTORS.map(([url]) => url);
  const routes = ROUTE_VECTORS.map(([, route]) => route);
  assert.deepEqual(urls.map(routeOf), routes);
  const dir = makeTemporaryDirectory("api-budget-routes-");
  const shell = bash(dir, `awk "$API_BUDGET_ROUTE"' { print api_route($0) }'`, {
    input: `${urls.join("\n")}\n`,
  });
  assert.deepEqual(shell.stdout.split("\n").slice(0, -1), routes, shell.stderr);
  assert.equal(inlineRecorders.length, 3 + 11);
  for (const { where, budget } of inlineRecorders) {
    const out = makeTemporaryDirectory("api-budget-inline-");
    await withRunnerTemp(out, () => {
      for (const url of urls) budget(200, {}, url);
    });
    assert.deepEqual(
      state(out)
        .split("\n")
        .slice(0, -1)
        .map((line) => line.split(" ")[6]),
      routes,
      where,
    );
  }
  ROUTE_VECTORS.forEach(([url, route, names]) => {
    assert.ok(routeOk(route), `${url} -> ${route}`);
    for (const name of names)
      assert.ok(!route.includes(name), `${url} leaks ${name}`);
  });
});

test("api-budget.bash's route word list is api-budget.cjs's REST_PATH_WORDS", () => {
  const dir = makeTemporaryDirectory("api-budget-words-");
  const keys = bash(
    dir,
    `awk "$API_BUDGET_ROUTE"' BEGIN { api_words(); for (k in API_WORD) print k }'`,
  );
  assert.deepEqual(
    keys.stdout.split("\n").filter(Boolean).sort(),
    [...REST_PATH_WORDS, ...PLACEHOLDERS].sort(),
  );
});

// [count, line] rows in a token's readings file, in the order given.
const routeLines = (dir, rows) => {
  fs.mkdirSync(path.join(dir, "api-budget"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "api-budget", "github-token"),
    rows.flatMap(([n, line]) => Array(n).fill(`${line}\n`)).join(""),
  );
};

test("api_budget_emit_routes counts N by route, most first, 304s left out, a line with no route as other", () => {
  const dir = makeTemporaryDirectory("api-budget-emit-routes-");
  routeLines(dir, [
    [2, `200 1000 990 10 ${RESET} core repos/{repo}/pulls/{n}`],
    [3, `200 1000 990 10 ${RESET} core repos/{repo}/issues/{n}/comments`],
    [2, `200 1000 990 10 ${RESET} graphql graphql`],
    [1, `304 1000 990 10 ${RESET} core repos/{repo}/pulls/{n}`],
    // A six-field reading, and one whose route is out of shape.
    [2, `200 1000 990 10 ${RESET} core`],
    [1, `200 1000 990 10 ${RESET} core repos/o/r`],
  ]);
  assert.equal(
    bash(dir, "api_budget_emit_routes github-token").stdout,
    `${ROUTES}github-token other=3 repos/{repo}/issues/{n}/comments=3 graphql=2 repos/{repo}/pulls/{n}=2 rest=0\n`,
  );
  // The routes sum to api-calls' N.
  assert.match(
    bash(dir, "api_budget_emit_calls github-token").stdout,
    /github-token=10 not-modified=1 /u,
  );
  assert.equal(
    bash(dir, "api_budget_emit_routes lanes-app").stdout,
    `${ROUTES}lanes-app rest=0\n`,
  );
});

test("api_budget_emit_routes names at most 15 routes in at most 1000 bytes and sums the rest", () => {
  const dir = makeTemporaryDirectory("api-budget-emit-routes-cap-");
  const words = [...REST_PATH_WORDS]
    .filter((w) => !/^(api|v3|repos)$/u.test(w))
    .slice(0, 20);
  routeLines(
    dir,
    words.map((w, i) => [30 - i, `200 na na na na core repos/{repo}/${w}`]),
  );
  const shown = words.slice(0, 15).map((w, i) => `repos/{repo}/${w}=${30 - i}`);
  assert.equal(
    bash(dir, "api_budget_emit_routes github-token").stdout,
    `${ROUTES}github-token ${shown.join(" ")} rest=${15 + 14 + 13 + 12 + 11}\n`,
  );
  // Long routes stop at the byte cap before 15, and the rest holds the others.
  // Each route near the 80-character route limit.
  const long = (w) =>
    `repos/{repo}/${w}/${"{n}/".repeat(Math.floor((66 - 2 * w.length) / 4))}${w}`;
  routeLines(
    dir,
    words.map((w, i) => [30 - i, `200 na na na na core ${long(w)}`]),
  );
  const capped = bash(dir, "api_budget_emit_routes github-token").stdout;
  assert.ok(capped.length <= 1001, capped.length);
  const named = [...capped.matchAll(/ (\S+)=(\d+)/gu)].filter(
    ([, route]) => route !== "rest",
  );
  assert.ok(named.length < 15, named.length);
  assert.deepEqual(
    named.map(([, route]) => route),
    words.slice(0, named.length).map(long),
  );
  const rest = Number(/ rest=(\d+)\n$/u.exec(capped)[1]);
  assert.equal(
    named.reduce((sum, [, , n]) => sum + Number(n), 0) + rest,
    words.reduce((sum, _, i) => sum + 30 - i, 0),
  );
});

test("api_budget_emit reads readings with a route as it reads those without", () => {
  const dir = makeTemporaryDirectory("api-budget-emit-route-");
  routeLines(dir, [
    [1, `200 1000 990 10 ${RESET} core`],
    [1, `200 1000 980 20 ${RESET} core repos/{repo}/pulls/{n}`],
  ]);
  assert.equal(
    bash(dir, "api_budget_emit github-token").stdout,
    `${NOTICE}token=github-token ${WHERE} limit=1000 remaining=980 used=20 reset=${RESET} resource=core cost=10\n`,
  );
});
