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

// `activity` is one page, or `pages` several, each { data, link }. `prior` is
// the head SHA's latest ci-status state before the run, if any.
function fakeGithub({
  config = CONFIG,
  files,
  commits,
  activity,
  pages,
  prior,
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
        getCombinedStatusForRef: async () => ({
          data: {
            statuses: [
              { context: "other", state: "failure" },
              ...(prior ? [{ context: "ci-status", state: prior }] : []),
            ],
          },
        }),
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

test("run reads the config at the default branch's last commit and posts a hold as failure on the head", async () => {
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
    [[HEAD, "failure", "ci-status"]],
  );
  assert.equal(github.statuses[0].description, HOLD);
  assert.equal(
    github.statuses[0].target_url,
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
    assert.deepEqual(github.statuses, []);
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
    assert.deepEqual(github.statuses, []);
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
  assert.deepEqual(github.statuses, []);
});

test("a pass posts no status, so the ci-status check run alone decides the required check", async () => {
  for (const prior of [undefined, "success", "pending"]) {
    const github = fakeGithub({ files: [file("README.md")], commits: [], activity: [], prior });
    const verdict = await run({ github, context: context(), core: core(), env });
    assert.equal(verdict.state, "success");
    assert.deepEqual(github.statuses, [], String(prior));
  }
});

test("a pass clears this check's own earlier failure or error on the same SHA", async () => {
  for (const prior of ["failure", "error"]) {
    const github = fakeGithub({ files: [file("README.md")], commits: [], activity: [], prior });
    await run({ github, context: context(), core: core(), env });
    assert.deepEqual(
      github.statuses.map(({ sha, state, context: name }) => [sha, state, name]),
      [[HEAD, "success", "ci-status"]],
      prior,
    );
  }
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
    assert.deepEqual(github.statuses, [], label);
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
