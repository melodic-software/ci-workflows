"use strict";

// check-trust-paths posts `ci-status` on the head SHA: `failure` when a
// listed agent App touched a pull request that changes a privileged path, or
// when the data that decides it is incomplete; `success` otherwise. Its
// config is read at the default branch's last commit, not the pull
// request's recorded base, and commits and activity are read only once a
// path matched. Activity is paged newest first only back to the pull
// request's window, and only entries that pushed one of its commits count.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ACTIVITY_PAGE,
  CLOCK_SKEW_MS,
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
  parseConfig,
  run,
  windowStart,
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

// The pull request opens at OPENED; its commits are made at OPENED; pushes
// default to a minute later.
const OPENED = "2026-10-29T17:00:00Z";
const at = (minutes) =>
  new Date(Date.parse(OPENED) + minutes * 60 * 1000).toISOString();
const commit = (
  sha,
  author,
  committer,
  email = PERSON_MAIL,
  date = OPENED,
) => ({
  sha,
  author: author === null ? null : { login: author },
  committer: committer === null ? null : { login: committer },
  commit: { author: { email }, committer: { email, date } },
});
const ZERO = "0".repeat(40);
const push = (
  login,
  after = HEAD,
  type = "push",
  timestamp = at(1),
  before = ZERO,
) => ({
  activity_type: type,
  before,
  after,
  timestamp,
  actor: { login },
});
const sha = (index) => index.toString(16).padStart(40, "e");
// `count` entries newest first, a minute apart, from `newest` minutes after
// OPENED, each a push of another commit by `login`.
const history = (count, newest, login = "octocat") =>
  Array.from({ length: count }, (_, index) =>
    push(login, sha(index), "push", at(newest - index)),
  );
const complete = (entries) => ({ entries, complete: true });
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
  created_at: OPENED,
  head: { sha: HEAD },
  user: { login: "octocat" },
  ...extra,
});
const decideWith = ({ pr: prExtra, activity, ...extra } = {}) =>
  decide({
    config: parseConfig(JSON.stringify(CONFIG)),
    files: [file(".github/workflows/ci.yml")],
    commits: [commit(HEAD, "octocat", "web-flow")],
    activity:
      activity === undefined
        ? complete([push("octocat")])
        : Array.isArray(activity)
          ? complete(activity)
          : activity,
    ...extra,
    pr: pr(prExtra),
  });

test("the window opens at the earliest of the pull request and its committer dates, less the skew margin", () => {
  const start = (created, ...dates) =>
    windowStart({
      pr: { created_at: created },
      commits: dates.map((date) =>
        commit(HEAD, "octocat", "web-flow", PERSON_MAIL, date),
      ),
    });
  assert.equal(start(at(5), at(2), at(9)), Date.parse(at(2)) - CLOCK_SKEW_MS);
  assert.equal(start(at(1), at(2)), Date.parse(at(1)) - CLOCK_SKEW_MS);
  assert.ok(Number.isNaN(start(undefined, at(2))));
  assert.ok(Number.isNaN(start(at(1), null)));
  assert.ok(Number.isNaN(start(at(1), "not a date")));
});

test("decide counts only activity in the window that pushed one of the pull request's commits", () => {
  // An App's push older than the window, on a reused branch, passes.
  assert.equal(
    decideWith({
      activity: [push("octocat"), push(APP, SHA_C, "push", at(-30))],
    }).state,
    "success",
  );
  // An App's push of the head inside the skew margin holds.
  assert.equal(
    decideWith({ activity: [push(APP, HEAD, "push", at(-2))] }).state,
    "failure",
  );
  // An App's push in the window whose commit a later push rewrote away holds.
  const stray = decideWith({
    activity: [push("octocat"), push(APP, SHA_C, "push", at(0))],
  });
  assert.equal(stray.state, "failure");
  assert.equal(stray.description, HOLD);
  assert.match(stray.detail, /not a commit of this pull request/u);
  // An App's branch deletion adds nothing.
  assert.equal(
    decideWith({
      activity: [
        push("octocat"),
        push(APP, "0".repeat(40), "branch_deletion", at(0)),
      ],
    }).state,
    "success",
  );
});

test("decide follows the head's history back through a rewrite to an App's push of any age", () => {
  // The App pushed SHA_C long before; a person force-pushed it away, keeping
  // its content, then opened the pull request.
  const rewrite = push("octocat", HEAD, "force_push", at(1), SHA_C);
  const held = decideWith({
    activity: [rewrite, push(APP, SHA_C, "push", at(-600))],
  });
  assert.equal(held.state, "failure");
  assert.equal(held.description, HOLD);
  assert.match(held.detail, /in the head's history/u);
  // The same chain through a person's push, back to a branch creation, passes.
  assert.equal(
    decideWith({
      activity: [
        rewrite,
        push("octocat", SHA_C, "push", at(-600), BASE),
        push("octocat", BASE, "branch_creation", at(-700)),
        push(APP, MAIN, "push", at(-800)),
      ],
    }).state,
    "success",
  );
  // A traced SHA whose push is not listed fails closed.
  const open = decideWith({ activity: [rewrite] });
  assert.equal(open.state, "failure");
  assert.match(open.detail, /reaches a branch creation/u);
  // A traced entry with no before fails closed.
  assert.equal(
    decideWith({
      activity: [
        rewrite,
        { ...push("octocat", SHA_C, "push", at(-600)), before: undefined },
      ],
    }).state,
    "failure",
  );
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
  // Incomplete commits or activity hold whoever touched it.
  for (const extra of [
    { pr: { commits: 2 } },
    { pr: { commits: MAX_COMMITS + 1 } },
    { pr: { commits: undefined } },
    { activity: null },
    { activity: { entries: [push("octocat")], complete: false } },
    { pr: { created_at: undefined } },
    { commits: [commit(HEAD, "octocat", "web-flow", PERSON_MAIL, null)] },
    { activity: [{ ...push("octocat"), timestamp: undefined }] },
    { activity: [{ ...push("octocat"), after: undefined }] },
  ])
    assert.equal(decideWith(extra).state, "failure", JSON.stringify(extra));
  // A field missing on an entry older than the window does not matter.
  assert.equal(
    decideWith({
      activity: [
        push("octocat"),
        { ...push("octocat", SHA_C, "push", at(-30)), after: undefined },
      ],
    }).state,
    "success",
  );
});

test("a status description fits GitHub's 140 characters", () => {
  assert.equal(clip("x".repeat(140)).length, 140);
  assert.equal(clip("x".repeat(200)).length, 140);
  for (const text of [HOLD]) assert.ok(text.length <= 140);
});

// `activity` is served newest first in pages of ACTIVITY_PAGE, each but the
// last with a Link header naming the next page.
function fakeGithub({ config = CONFIG, files, commits, activity, fail = {} }) {
  const calls = [];
  const statuses = [];
  const paginate = async (method, params) => (await method(params)).data;
  paginate.iterator = async function* (route, params) {
    assert.equal(route, "GET /repos/{owner}/{repo}/activity");
    for (let offset = 0; ; offset += params.per_page) {
      calls.push(["activity", params]);
      if (fail.activity) throw new Error("HTTP 502");
      const more = offset + params.per_page < activity.length;
      yield {
        data: activity.slice(offset, offset + params.per_page),
        headers: more
          ? { link: `<https://api.github.com/x?after=c${offset}>; rel="next"` }
          : {},
      };
      if (!more) return;
    }
  };
  const github = {
    calls,
    statuses,
    paginate,
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
      created_at: OPENED,
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

test("run pages past a reused branch's history to the window and passes when no App pushed", async () => {
  // 150 entries: the newest 2 push this pull request's commits; the rest
  // predate it, and some of those are an App's.
  const activity = [
    push("octocat", HEAD, "push", at(3)),
    push("octocat", SHA_C, "branch_creation", at(2)),
    ...history(148, -60).map((entry, index) =>
      index % 3 === 0 ? { ...entry, actor: { login: APP } } : entry,
    ),
  ];
  const github = fakeGithub({
    files: [file("CODEOWNERS")],
    commits: [
      commit(SHA_C, "octocat", "web-flow"),
      commit(HEAD, "octocat", "web-flow"),
    ],
    activity,
  });
  const ctx = context();
  ctx.payload.pull_request.commits = 2;
  const verdict = await run({ github, context: ctx, core: core(), env });
  assert.equal(verdict.state, "success", verdict.detail);
  assert.equal(github.calls.filter(([name]) => name === "activity").length, 1);
});

test("run holds an App's push of one of the pull request's commits on page 2", async () => {
  // A pull request opened long after its commits, on a busy branch: its
  // window reaches past the first page.
  const activity = history(150, 200);
  activity[120] = push(APP, SHA_C, "push", activity[120].timestamp);
  const github = fakeGithub({
    files: [file("CODEOWNERS")],
    commits: [
      commit(SHA_C, "octocat", "web-flow"),
      commit(HEAD, "octocat", "web-flow"),
    ],
    activity,
  });
  const ctx = context();
  ctx.payload.pull_request.commits = 2;
  ctx.payload.pull_request.created_at = at(500);
  const verdict = await run({ github, context: ctx, core: core(), env });
  assert.equal(verdict.state, "failure");
  assert.equal(verdict.description, HOLD);
  assert.match(
    verdict.detail,
    new RegExp(
      `${APP.replace(/[[\]]/gu, "\\$&")} push ${SHA_C.slice(0, 12)}`,
      "u",
    ),
  );
  assert.equal(github.calls.filter(([name]) => name === "activity").length, 2);
});

test("run reads past the window to trace a rewrite, and holds an App's push found on page 3", async () => {
  const activity = [
    push("octocat", HEAD, "force_push", at(1), SHA_C),
    ...history(250, -60),
  ];
  activity[230] = push(APP, SHA_C, "push", activity[230].timestamp);
  const github = fakeGithub({
    files: [file("CODEOWNERS")],
    commits: [commit(HEAD, "octocat", "web-flow")],
    activity,
  });
  const verdict = await run({ github, context: context(), core: core(), env });
  assert.equal(verdict.state, "failure");
  assert.equal(verdict.description, HOLD);
  assert.equal(github.calls.filter(([name]) => name === "activity").length, 3);
});

test("run fails closed when the window is still open after the page cap", async () => {
  const github = fakeGithub({
    files: [file("CODEOWNERS")],
    commits: [commit(HEAD, "octocat", "web-flow")],
    activity: history(ACTIVITY_PAGE * MAX_ACTIVITY_PAGES + 1, 5000),
  });
  const verdict = await run({ github, context: context(), core: core(), env });
  assert.equal(verdict.state, "failure");
  assert.match(
    verdict.detail,
    new RegExp(`in ${MAX_ACTIVITY_PAGES} pages of ${ACTIVITY_PAGE}`, "u"),
  );
  assert.equal(
    github.calls.filter(([name]) => name === "activity").length,
    MAX_ACTIVITY_PAGES,
  );
  // Exactly the cap, with no next page, is complete.
  const full = fakeGithub({
    files: [file("CODEOWNERS")],
    commits: [commit(HEAD, "octocat", "web-flow")],
    activity: history(ACTIVITY_PAGE * MAX_ACTIVITY_PAGES, 5000),
  });
  assert.equal(
    (await run({ github: full, context: context(), core: core(), env })).state,
    "success",
  );
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
