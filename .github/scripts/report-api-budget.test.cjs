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
const { readingLine, recordReading, watch } = require(
  path.join(ACTION_DIR, "api-budget.cjs"),
);
const WORKFLOW = parseWorkflow(
  fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "pr-review-cli.yml"),
    "utf8",
  ),
);

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
    `200 1000 988 12 ${RESET} core\n`,
  );
  assert.equal(
    readingLine(304, {
      "x-ratelimit-limit": "1000",
      "x-ratelimit-used": "12",
      "x-ratelimit-resource": "Core!",
    }),
    "304 1000 na 12 na na\n",
  );
  assert.equal(readingLine(200, undefined), "200 na na na na na\n");
});

test("recordReading appends one line per response and needs a token name and RUNNER_TEMP", () => {
  const dir = makeTemporaryDirectory("api-budget-");
  record(dir, { used: 1 }, { used: 2 });
  recordReading({ token: "Bad Name", dir, status: 200, headers: {} });
  recordReading({ token: "lanes-app", dir: "", status: 200, headers: {} });
  assert.equal(
    state(dir),
    `200 1000 999 1 ${RESET} core\n200 1000 998 2 ${RESET} core\n`,
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
    hooks.after[0][1]({ status: 200, headers: octokitHeaders({ used: 5 }) });
    const refused = Object.assign(new Error("rate limited"), {
      status: 403,
      response: { status: 403, headers: octokitHeaders({ used: 1000 }) },
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
    `200 1000 995 5 ${RESET} core\n403 1000 0 1000 ${RESET} core\n`,
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
  assert.equal(state(dir), `200 1000 880 120 ${RESET} core\n`);
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
  assert.equal(out, `${NOTICE}${graphql}\n${NOTICE}${core}\n`);
  assert.equal(
    summary,
    `api-budget: ${graphql}\napi-budget: ${core}\ngithub-token-cost=29\n`,
  );
  assert.equal(output, "costs=github-token-cost=29\n");
});

test("the action writes nothing for a job that made no request, and never fails", () => {
  const dir = makeTemporaryDirectory("api-budget-none-");
  const { out, summary, output } = runAction(dir, {
    responses: path.join(dir, "missing.http"),
  });
  assert.deepEqual([out, summary, output], ["", "", ""]);
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
  ].join("\n");
  assert.doesNotMatch(
    sources,
    /(?:gh api|request\(|fetch\()[^\n]*rate_limit|rateLimit\.get/u,
  );
});

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
    const ok = { status: 200, headers: octokitHeaders({ used: 5 }) };
    const refused = Object.assign(new Error("rate limited"), {
      status: 429,
      response: {
        status: 429,
        headers: {
          ...octokitHeaders({ used: 9 }),
          "x-ratelimit-resource": "Bad!",
        },
      },
    });
    // An error whose status is only on its response, as a wrapper may build one.
    const bare = Object.assign(new Error("rate limited"), {
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
      readingLine(200, ok.headers) +
        readingLine(429, refused.response.headers) +
        readingLine(403, bare.response.headers),
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
