"use strict";

// check-trust-paths posts `ci-status` on the head SHA: `failure` when a
// listed agent App touched a pull request that changes a privileged path, or
// when the data that decides it is incomplete; `success` otherwise. Its
// config is read at the default branch's last commit, not the pull
// request's recorded base, and commits and activity are read only once a
// path matched.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ACTIVITY_PAGE,
  HOLD,
  MAX_ACTIVITY_PAGES,
  MAX_COMMITS,
  MAX_FILES,
  callerWorkflowPath,
  clip,
  decide,
  globToRegExp,
  involvement,
  matchedPaths,
  nextCursor,
  parseConfig,
  run,
} = require("../actions/pr-require-checks/check-trust-paths/check.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const APP = "melodic-agent[bot]";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MAIN = "d".repeat(40);
const SHA_C = "c".repeat(40);
const PERSON_MAIL = "583231+octocat@users.noreply.github.com";
const CONFIG = {
  paths: [".github/workflows/**", "CODEOWNERS", "*/CODEOWNERS"],
  apps: [APP],
};

const commit = (sha, author, committer, email = PERSON_MAIL) => ({
  sha,
  author: author === null ? null : { login: author },
  committer: committer === null ? null : { login: committer },
  commit: { author: { email }, committer: { email } },
});
const push = (login, after = HEAD, type = "push") => ({
  activity_type: type,
  after,
  actor: { login },
});
const file = (filename, previous) =>
  previous === undefined
    ? { filename }
    : { filename, previous_filename: previous };

test("the config needs non-empty paths and [bot] apps and no other key", () => {
  assert.deepEqual(
    parseConfig(
      JSON.stringify({ paths: ["a/**"], apps: ["Melodic-Agent[bot]"] }),
    ),
    {
      paths: ["a/**"],
      apps: [APP],
    },
  );
  for (const bad of [
    "",
    "paths: [a]",
    "[]",
    "null",
    JSON.stringify({ paths: ["a"] }),
    JSON.stringify({ apps: [APP] }),
    JSON.stringify({ paths: [], apps: [APP] }),
    JSON.stringify({ paths: ["a"], apps: [] }),
    JSON.stringify({ paths: ["a"], apps: ["melodic-agent"] }),
    JSON.stringify({ paths: ["a"], apps: ["octocat"] }),
    JSON.stringify({ paths: ["a"], apps: APP }),
    JSON.stringify({ paths: [""], apps: [APP] }),
    JSON.stringify({ paths: [" a"], apps: [APP] }),
    JSON.stringify({ paths: [1], apps: [APP] }),
    JSON.stringify({ paths: ["a"], apps: [APP], app: [APP] }),
  ])
    assert.throws(() => parseConfig(bad), Error, bad);
});

test("a glob is a whole-path, case-insensitive match where * crosses /", () => {
  const cases = [
    [".github/workflows/**", ".github/workflows/a.yml", true],
    [".github/workflows/**", ".github/workflows/sub/a.yml", true],
    [".github/workflows/*", ".github/workflows/sub/a.yml", true],
    [".github/workflows/**", ".github/workflowsx/a.yml", false],
    ["CODEOWNERS", "CODEOWNERS", true],
    ["CODEOWNERS", ".github/CODEOWNERS", false],
    ["*/CODEOWNERS", ".github/codeowners", true],
    ["docs/?.md", "docs/a.md", true],
    ["docs/?.md", "docs/ab.md", false],
    ["a.b", "axb", false],
    ["a+(b)", "a+(b)", true],
  ];
  for (const [glob, name, want] of cases)
    assert.equal(globToRegExp(glob).test(name), want, `${glob} ~ ${name}`);
});

test("a renamed file matches on its old path", () => {
  assert.deepEqual(
    matchedPaths(
      [
        file("docs/a.md"),
        file("docs/moved.yml", ".github/workflows/ci.yml"),
        file("CODEOWNERS"),
      ],
      CONFIG.paths,
    ),
    [".github/workflows/ci.yml", "CODEOWNERS"],
  );
  assert.deepEqual(
    matchedPaths([file("README.md"), null, {}], CONFIG.paths),
    [],
  );
});

test("the caller's own workflow path comes from GITHUB_WORKFLOW_REF", () => {
  assert.equal(
    callerWorkflowPath("o/r/.github/workflows/pr-hold.yml@refs/heads/main"),
    ".github/workflows/pr-hold.yml",
  );
  assert.equal(callerWorkflowPath(""), undefined);
  assert.equal(callerWorkflowPath(undefined), undefined);
});

test("an App is involved as author, commit author or committer by login or noreply, or pusher", () => {
  const apps = [APP];
  const none = {
    apps,
    author: "octocat",
    commits: [commit(HEAD, "octocat", "web-flow")],
    activity: [push("octocat")],
  };
  assert.deepEqual(involvement(none), []);
  assert.deepEqual(involvement({ ...none, author: APP }), [`${APP} opened it`]);
  for (const c of [
    commit(SHA_C, "Melodic-Agent[bot]", "web-flow"),
    commit(SHA_C, "octocat", APP),
    commit(SHA_C, null, null, `5519429+${APP}@users.noreply.github.com`),
    commit(SHA_C, null, null, `${APP}@users.noreply.github.com`.toUpperCase()),
  ])
    assert.deepEqual(involvement({ ...none, commits: [c] }), [
      `an agent App authored or committed ${SHA_C.slice(0, 12)}`,
    ]);
  assert.deepEqual(
    involvement({
      ...none,
      commits: [commit(SHA_C, null, null, `x${APP}@users.noreply.github.com`)],
    }),
    [],
  );
  assert.deepEqual(
    involvement({ ...none, activity: [push(APP, SHA_C, "force_push")] }),
    [`${APP} force_push ${SHA_C.slice(0, 12)}`],
  );
});

const pr = (extra = {}) => ({
  changed_files: 1,
  commits: 1,
  user: { login: "octocat" },
  ...extra,
});
const decideWith = ({ pr: prExtra, ...extra } = {}) =>
  decide({
    config: parseConfig(JSON.stringify(CONFIG)),
    files: [file(".github/workflows/ci.yml")],
    commits: [commit(HEAD, "octocat", "web-flow")],
    activity: [push("octocat")],
    ...extra,
    pr: pr(prExtra),
  });

test("decide holds a privileged change an App touched and passes one it did not", () => {
  assert.equal(decideWith().state, "success");
  const held = decideWith({ activity: [push(APP)] });
  assert.equal(held.state, "failure");
  assert.equal(held.description, HOLD);
  assert.match(held.detail, /pushed|push/u);
  assert.equal(decideWith({ pr: { user: { login: APP } } }).state, "failure");
  const unprivileged = decideWith({
    files: [file("README.md")],
    pr: { user: { login: APP } },
    commits: [],
    activity: null,
  });
  assert.deepEqual(unprivileged.state, "success");
  assert.equal(unprivileged.description, "No privileged path changed.");
});

test("decide treats the config and caller workflow paths as privileged", () => {
  const files = [file(".github/trust-path-hold.json")];
  assert.equal(decideWith({ files, activity: [push(APP)] }).state, "success");
  assert.equal(
    decideWith({
      files,
      activity: [push(APP)],
      extraPaths: [".github/trust-path-hold.json"],
    }).state,
    "failure",
  );
});

test("decide fails closed on data that may hide a path, a commit or a push", () => {
  // A short or capped file list counts as a match, so an App's touch holds.
  const short = decideWith({
    files: [file("README.md")],
    pr: { changed_files: 2 },
    activity: [push(APP)],
  });
  assert.equal(short.state, "failure");
  assert.match(short.detail, /files GitHub did not list/u);
  const capped = Array.from({ length: MAX_FILES }, (_, index) =>
    file(`docs/${index}.md`),
  );
  assert.equal(
    decideWith({
      files: capped,
      pr: { changed_files: MAX_FILES },
      activity: [push(APP)],
    }).state,
    "failure",
  );
  // No App on a short list still passes: nothing says an App touched it.
  assert.equal(
    decideWith({ files: [file("README.md")], pr: { changed_files: 2 } }).state,
    "success",
  );
  // Incomplete commits or unread activity hold whoever touched it.
  for (const extra of [
    { pr: { commits: 2 } },
    { pr: { commits: MAX_COMMITS + 1 } },
    { pr: { commits: undefined } },
    { activity: null },
  ])
    assert.equal(decideWith(extra).state, "failure", JSON.stringify(extra));
});

test("decide reads every activity entry, past one page, of a reused branch name", () => {
  // The activity API keeps a branch name's history across deletions, so a
  // branch recreated for each sync passes a page of entries no App made.
  const long = Array.from({ length: ACTIVITY_PAGE + 50 }, (_, index) =>
    push("octocat", HEAD, index % 2 ? "branch_deletion" : "branch_creation"),
  );
  assert.equal(decideWith({ activity: long }).state, "success");
  const late = long.map((entry, index) => (index === 130 ? push(APP) : entry));
  assert.equal(decideWith({ activity: late }).description, HOLD);
});

test("a status description fits GitHub's 140 characters", () => {
  assert.equal(clip("x".repeat(140)).length, 140);
  assert.equal(clip("x".repeat(200)).length, 140);
  const long = decideWith({ activityCapped: true });
  assert.equal(long.state, "failure");
  for (const text of [HOLD, long.description]) assert.ok(text.length <= 140);
});

// `activity` is one page, or `pages` several, each { data, link }.
function fakeGithub({
  config = CONFIG,
  files,
  commits,
  activity,
  pages,
  fail = {},
}) {
  const calls = [];
  const statuses = [];
  const github = {
    calls,
    statuses,
    paginate: async (method, params) => (await method(params)).data,
    request: async (route, params) => {
      calls.push(["activity", params]);
      assert.equal(route, "GET /repos/{owner}/{repo}/activity");
      if (fail.activity) throw new Error("HTTP 502");
      if (!pages) return { data: activity, headers: {} };
      const index =
        params.after === undefined ? 0 : Number(params.after.slice(1));
      const page = pages[index];
      if (page.status)
        throw Object.assign(new Error(`HTTP ${page.status}`), {
          status: page.status,
        });
      return { data: page.data, headers: page.link ? { link: page.link } : {} };
    },
    rest: {
      repos: {
        getContent: async (params) => {
          calls.push(["getContent", params]);
          if (fail.config) throw new Error("HTTP 404");
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(
                typeof config === "string" ? config : JSON.stringify(config),
              ).toString("base64"),
            },
          };
        },
        createCommitStatus: async (params) => {
          statuses.push(params);
        },
      },
      pulls: {
        listFiles: async (params) => {
          calls.push(["listFiles", params]);
          return { data: files };
        },
        listCommits: async (params) => {
          calls.push(["listCommits", params]);
          if (fail.commits) throw new Error("HTTP 502");
          return { data: commits };
        },
      },
    },
  };
  return github;
}

const context = (extra = {}) => ({
  eventName: "pull_request_target",
  repo: { owner: "o", repo: "r" },
  serverUrl: "https://github.com",
  runId: 9,
  sha: MAIN,
  payload: {
    pull_request: {
      number: 7,
      changed_files: 1,
      commits: 1,
      user: { login: "octocat" },
      head: {
        sha: HEAD,
        ref: "feature/x",
        repo: { name: "r", owner: { login: "o" } },
      },
      base: { sha: BASE },
    },
  },
  ...extra,
});
const core = () => {
  const lines = [];
  const outputs = {};
  return {
    lines,
    outputs,
    info: (line) => lines.push(["info", line]),
    error: (line) => lines.push(["error", line]),
    setOutput: (key, value) => {
      outputs[key] = value;
    },
  };
};
const env = {
  CONFIG_PATH: ".github/trust-path-hold.json",
  GITHUB_WORKFLOW_REF: "o/r/.github/workflows/pr-hold.yml@refs/heads/main",
};

test("run reads the config at the default branch's last commit and posts pending, then the verdict, on the head", async () => {
  const github = fakeGithub({
    files: [file(".github/workflows/ci.yml")],
    commits: [commit(HEAD, "octocat", "web-flow")],
    activity: [push(APP)],
  });
  const log = core();
  const verdict = await run({ github, context: context(), core: log, env });
  assert.equal(verdict.state, "failure");
  assert.deepEqual(github.calls[0], [
    "getContent",
    { owner: "o", repo: "r", path: env.CONFIG_PATH, ref: MAIN },
  ]);
  assert.deepEqual(
    github.statuses.map(({ sha, state, context: name }) => [sha, state, name]),
    [
      [HEAD, "pending", "ci-status"],
      [HEAD, "failure", "ci-status"],
    ],
  );
  assert.equal(github.statuses[1].description, HOLD);
  assert.equal(
    github.statuses[1].target_url,
    "https://github.com/o/r/actions/runs/9",
  );
  assert.deepEqual(github.calls.find(([name]) => name === "activity")[1], {
    owner: "o",
    repo: "r",
    ref: "refs/heads/feature/x",
    direction: "desc",
    per_page: ACTIVITY_PAGE,
  });
  assert.equal(log.outputs.state, "failure");
  assert.equal(log.lines[0][0], "error");
});

test("run decides a pull request whose recorded base predates the config", async () => {
  const github = fakeGithub({
    files: [file("README.md")],
    commits: [],
    activity: [],
  });
  const { getContent } = github.rest.repos;
  github.rest.repos.getContent = async (params) => {
    if (params.ref === BASE) throw new Error("HTTP 404");
    return getContent(params);
  };
  const verdict = await run({ github, context: context(), core: core(), env });
  assert.equal(verdict.state, "success");
  assert.equal(github.calls[0][1].ref, MAIN);
});

const nextLink = (index) =>
  `<https://api.github.com/repositories/1/activity?ref=x&per_page=100&after=p${index}>; rel="next"`;
// Pages of `size` entries by `login`, each but the last linking the next.
const activityPages = (count, actorOf = () => "octocat", size = 3) =>
  Array.from({ length: count }, (_, index) => ({
    data: Array.from({ length: size }, () => push(actorOf(index))),
    link: index < count - 1 ? nextLink(index + 1) : undefined,
  }));
const runWithPages = async (pages) => {
  const github = fakeGithub({
    files: [file(".github/workflows/ci.yml")],
    commits: [commit(HEAD, "octocat", "web-flow")],
    pages,
  });
  const verdict = await run({ github, context: context(), core: core(), env });
  return {
    github,
    verdict,
    reads: github.calls.filter(([name]) => name === "activity"),
  };
};

test("the next cursor comes from the rel=next link's after parameter alone", () => {
  assert.equal(nextCursor(undefined), null);
  assert.equal(
    nextCursor('<https://api.github.com/x?before=b>; rel="prev"'),
    null,
  );
  assert.equal(
    nextCursor(
      `<https://api.github.com/x?before=b>; rel="prev", ${nextLink(4)}`,
    ),
    "p4",
  );
  assert.throws(
    () => nextCursor('<https://evil.example/x>; rel="next"'),
    Error,
  );
});

test("run reads a clean multi-page activity to its end with the after cursor", async () => {
  const { verdict, reads } = await runWithPages(activityPages(3));
  assert.equal(verdict.state, "success");
  assert.deepEqual(
    reads.map(([, params]) => params.after),
    [undefined, "p1", "p2"],
  );
});

test("run holds an App entry past the first page and reads no further", async () => {
  const { verdict, reads } = await runWithPages(
    activityPages(5, (index) => (index === 2 ? APP : "octocat")),
  );
  assert.equal(verdict.description, HOLD);
  assert.equal(reads.length, 3);
});

test("run fails closed on activity longer than the page cap", async () => {
  const { verdict, reads } = await runWithPages(
    activityPages(MAX_ACTIVITY_PAGES + 1),
  );
  assert.equal(verdict.state, "failure");
  assert.match(verdict.detail, /activity too long/u);
  assert.equal(reads.length, MAX_ACTIVITY_PAGES);
});

test("only a short activity page ends the history; a full one needs a next cursor", async () => {
  const full = Array.from({ length: ACTIVITY_PAGE }, () => push("octocat"));
  for (const link of [
    undefined,
    '<https://api.github.com/x?before=b>; rel="prev"',
  ]) {
    const github = fakeGithub({
      files: [file(".github/workflows/ci.yml")],
      commits: [commit(HEAD, "octocat", "web-flow")],
      pages: [{ data: full, link }],
    });
    await assert.rejects(
      run({ github, context: context(), core: core(), env }),
      /full but carries no next cursor/u,
      String(link),
    );
    assert.ok(github.statuses.every(({ state }) => state === "pending"));
  }
  const { verdict } = await runWithPages([
    { data: Array.from({ length: ACTIVITY_PAGE - 1 }, () => push("octocat")) },
  ]);
  assert.equal(verdict.state, "success");
});

test("run throws on a non-list activity page or an HTTP error past the first page", async () => {
  for (const bad of [
    { data: { message: "x" } },
    { data: null },
    { status: 409 },
  ]) {
    const pages = activityPages(2);
    pages[1] = bad;
    const github = fakeGithub({
      files: [file(".github/workflows/ci.yml")],
      commits: [commit(HEAD, "octocat", "web-flow")],
      pages,
    });
    await assert.rejects(
      run({ github, context: context(), core: core(), env }),
      Error,
      JSON.stringify(bad),
    );
    assert.ok(github.statuses.every(({ state }) => state === "pending"));
  }
});

test("run reads no commit or activity when no privileged path changed", async () => {
  const github = fakeGithub({
    files: [file("README.md")],
    commits: [],
    activity: [],
  });
  const verdict = await run({ github, context: context(), core: core(), env });
  assert.equal(verdict.state, "success");
  assert.deepEqual(
    github.calls.map(([name]) => name),
    ["getContent", "listFiles"],
  );
  assert.deepEqual(
    github.statuses.map(({ state }) => state),
    ["pending", "success"],
  );
});

test("run holds an App's edit to the caller workflow or the config itself", async () => {
  for (const name of [
    ".github/workflows/pr-hold.yml",
    ".github/trust-path-hold.json",
  ]) {
    const github = fakeGithub({
      config: { paths: ["src/secret/**"], apps: [APP] },
      files: [file(name)],
      commits: [commit(HEAD, APP, "web-flow")],
      activity: [],
    });
    assert.equal(
      (await run({ github, context: context(), core: core(), env })).state,
      "failure",
      name,
    );
  }
});

test("run reads a fork head's activity from the fork, and a deleted fork fails closed", async () => {
  const forked = context();
  forked.payload.pull_request.head.repo = {
    name: "r-fork",
    owner: { login: "someone" },
  };
  const github = fakeGithub({
    files: [file("CODEOWNERS")],
    commits: [commit(HEAD, "someone", "web-flow")],
    activity: [],
  });
  assert.equal(
    (await run({ github, context: forked, core: core(), env })).state,
    "success",
  );
  assert.deepEqual(
    github.calls.find(([name]) => name === "activity")[1].owner,
    "someone",
  );
  forked.payload.pull_request.head.repo = null;
  const gone = fakeGithub({
    files: [file("CODEOWNERS")],
    commits: [commit(HEAD, "someone", "web-flow")],
    activity: [],
  });
  assert.equal(
    (await run({ github: gone, context: forked, core: core(), env })).state,
    "failure",
  );
});

test("run throws, posting no verdict, on an unreadable config or read, or the wrong event", async () => {
  const base = {
    files: [file("CODEOWNERS")],
    commits: [commit(HEAD, "octocat", "web-flow")],
    activity: [],
  };
  for (const [label, options, ctx, runEnv] of [
    ["missing config", { ...base, fail: { config: true } }, context(), env],
    ["malformed config", { ...base, config: "{not json" }, context(), env],
    ["commits", { ...base, fail: { commits: true } }, context(), env],
    ["activity", { ...base, fail: { activity: true } }, context(), env],
    ["event", base, context({ eventName: "pull_request" }), env],
    ["config path", base, context(), { ...env, CONFIG_PATH: "" }],
    ["default-branch SHA", base, context({ sha: undefined }), env],
  ]) {
    const github = fakeGithub(options);
    await assert.rejects(
      run({ github, context: ctx, core: core(), env: runEnv }),
      Error,
      label,
    );
    assert.ok(
      github.statuses.every(({ state }) => state === "pending"),
      `${label} posted ${JSON.stringify(github.statuses)}`,
    );
  }
});

test("the reusable grants only the three permissions, checks out nothing and posts failure when the check does not finish", () => {
  const workflowPath = path.join(
    __dirname,
    "..",
    "workflows",
    "pr-require-checks-trust-paths.yml",
  );
  const source = fs.readFileSync(workflowPath, "utf8");
  assert.doesNotThrow(() => parseWorkflow(source));
  assert.doesNotMatch(source, /actions\/checkout/u);
  assert.doesNotMatch(source, /secrets\./u);
  assert.match(source, /^permissions: \{\}$/mu);
  assert.match(
    source,
    / {4}permissions:\n {6}contents: read #[^\n]*\n {6}pull-requests: read #[^\n]*\n {6}statuses: write #[^\n]*\n {4}steps:/u,
  );
  assert.match(
    source,
    /uses: \$\/\.github\/actions\/pr-require-checks\/check-trust-paths\n/u,
  );
  assert.match(source, /if: \$\{\{ failure\(\) \|\| cancelled\(\) \}\}/u);
  // No ${{ }} expansion inside a script body.
  const scripts = source
    .split(/script: \|\n/u)
    .slice(1)
    .map((rest) => rest.split(/\n(?! {12})/u)[0]);
  assert.ok(scripts.length > 0);
  for (const body of scripts) assert.doesNotMatch(body, /\$\{\{/u);
});

// The job's api-calls notice: every job-token request leaves one rate-limit
// reading, through api-budget.cjs's watch in the check and the fallback's
// inline recorder, and the last step counts them without a request of its own.
const { spawnSync } = require("node:child_process");
const { readingLine } = require("../actions/report-api-budget/api-budget.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");

const ACTIONS = path.join(__dirname, "..", "actions");
const JOB = parseWorkflow(
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "workflows",
      "pr-require-checks-trust-paths.yml",
    ),
    "utf8",
  ),
).jobs["check-trust-paths"];
const scriptOf = (file) =>
  parseWorkflow(fs.readFileSync(file, "utf8")).runs.steps[0];
const CHECK_STEP = scriptOf(
  path.join(ACTIONS, "pr-require-checks", "check-trust-paths", "action.yml"),
);
const LOG_STEP = scriptOf(
  path.join(ACTIONS, "report-api-budget", "action.yml"),
);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const rateLimit = (used) => ({
  "x-ratelimit-limit": "1000",
  "x-ratelimit-remaining": String(1000 - used),
  "x-ratelimit-used": String(used),
  "x-ratelimit-reset": "1792748042",
  "x-ratelimit-resource": "core",
});

// fakeGithub with Octokit's request hooks: each call is one request whose
// response, or refusal, goes through the hooks the step registered.
function hooked(github) {
  const hooks = { after: [], error: [] };
  let used = 0;
  const wrap =
    (fn) =>
    async (...args) => {
      used += 1;
      const headers = rateLimit(used);
      let response;
      try {
        response = await fn(...args);
      } catch (error) {
        error.response = { status: error.status ?? 502, headers };
        for (const hook of hooks.error) await hook(error);
        throw error;
      }
      const full = { status: 200, headers, ...response };
      full.headers = { ...headers, ...response?.headers };
      for (const hook of hooks.after) await hook(full);
      return full;
    };
  github.request = wrap(github.request);
  for (const group of Object.values(github.rest))
    for (const name of Object.keys(group)) group[name] = wrap(group[name]);
  github.hook = {
    after: (_name, fn) => hooks.after.push(fn),
    error: (_name, fn) => hooks.error.push(fn),
  };
  github.used = () => used;
  return github;
}

async function runStep(script, github, dir, stepEnv = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, { RUNNER_TEMP: dir, ...stepEnv });
  try {
    await new AsyncFunction("require", "github", "context", "core", script)(
      require,
      github,
      context(),
      core(),
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

function logBudget(dir) {
  fs.writeFileSync(path.join(dir, "summary"), "");
  fs.writeFileSync(path.join(dir, "output"), "");
  const result = spawnSync("bash", ["-c", LOG_STEP.run], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: dir,
      GITHUB_ACTION_PATH: path.join(ACTIONS, "report-api-budget"),
      GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
      GITHUB_OUTPUT: path.join(dir, "output"),
      TOKENS: JOB.steps.at(-1).with.tokens,
      RESPONSES: "",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split("\n")
    .filter((line) => line.includes("title=api-calls::"));
}

test("the job ends by logging the job token's budget, whatever failed", () => {
  const last = JOB.steps.at(-1);
  assert.equal(last.uses, "$/.github/actions/report-api-budget");
  assert.equal(last.if, "always()");
  assert.equal(last["continue-on-error"], true);
  assert.equal(last.with.tokens, "github-token");
  assert.equal(last.with.responses, undefined);
  assert.match(
    CHECK_STEP.with.script,
    /require\(path\.join\(process\.env\.ACTION_PATH, "\.\.", "\.\.", "report-api-budget", "api-budget\.cjs"\)\)\.watch\(github, "github-token"\);\n[^\n]*\nawait run\(/u,
  );
});

test("the check's requests each leave one reading, and the api-calls notice counts them", async () => {
  const dir = makeTemporaryDirectory("trust-paths-calls-");
  const github = hooked(
    fakeGithub({
      files: [file(".github/workflows/ci.yml")],
      commits: [commit(HEAD, "octocat", "web-flow")],
      activity: [push("octocat")],
    }),
  );
  await runStep(CHECK_STEP.with.script, github, dir, {
    ACTION_PATH: path.join(ACTIONS, "pr-require-checks", "check-trust-paths"),
    CONFIG_PATH: env.CONFIG_PATH,
    GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF,
  });
  // The config, the file list, the commit list, one activity page and the
  // pending and verdict statuses.
  assert.equal(github.used(), 6);
  assert.equal(github.calls.length + github.statuses.length, 6);
  assert.deepEqual(logBudget(dir), [
    "::notice title=api-calls::github-token=6 not-modified=0 graphql=0",
  ]);
});

test("the fallback status records its response and refusal as api-budget.cjs does", async () => {
  const fallback = JOB.steps.find((s) => s.with?.script?.includes("HEAD_SHA"));
  for (const status of [200, 403]) {
    const dir = makeTemporaryDirectory("trust-paths-fallback-");
    const fake = fakeGithub({});
    if (status !== 200)
      fake.rest.repos.createCommitStatus = async () => {
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      };
    const step = runStep(fallback.with.script, hooked(fake), dir, {
      HEAD_SHA: HEAD,
    });
    if (status === 200) await step;
    else await assert.rejects(step, /HTTP 403/u);
    assert.equal(
      fs.readFileSync(path.join(dir, "api-budget", "github-token"), "utf8"),
      readingLine(status, rateLimit(1)),
    );
    assert.deepEqual(logBudget(dir), [
      "::notice title=api-calls::github-token=1 not-modified=0 graphql=0",
    ]);
  }
});
