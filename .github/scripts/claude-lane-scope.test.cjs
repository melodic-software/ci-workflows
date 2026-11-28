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
const path = require("node:path");
const test = require("node:test");

const { CAPTURE, pullRequestPage } = require("./scope-graphql-fake.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const workflowsDir = path.join(__dirname, "..", "workflows");

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

async function runScript(script, values, github, requireFn = require) {
  const outputs = {};
  const messages = [];
  const secrets = [];
  const core = {
    setSecret: (value) => secrets.push(value),
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
      requireFn,
      {
        paginate: async (method, params) => (await method(params)).data,
        hook: { after: () => {}, error: () => {}, wrap: () => {} },
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
  return { outputs, messages, secrets };
}

async function runScope(
  lane,
  {
    env,
    prFiles,
    compares = {},
    fail = false,
    comments = [],
    liveHead = HEAD,
    graphqlAnswer,
    graphqlFail = false,
    git = () => {
      throw new Error("git was not expected");
    },
  },
) {
  const directory = makeTemporaryDirectory("scope-");
  const diffFile = path.join(directory, "state", "incremental.diff");
  let listedComments = 0;
  const gitCalls = [];
  const gitOptions = [];
  const requireFn = (name) =>
    name === "node:child_process"
      ? {
          execFileSync: (command, args, options) => {
            assert.equal(command, "git");
            gitCalls.push(args);
            gitOptions.push(options);
            return git(args);
          },
        }
      : require(name);
  const allCompares = {
    [`main...${HEAD}`]: { merge_base_commit: { sha: MB_OLD } },
    ...compares,
  };
  const graphqlCursors = [];
  const github = {
    // pr-review-cli's scope step reads the head and comments here.
    graphql: async (query, { owner, repo, number, cursor }) => {
      assert.deepEqual([owner, repo, number], ["o", "r", 7]);
      assert.match(query, /comments\(first: 100, after: \$cursor\)/u);
      graphqlCursors.push(cursor);
      if (graphqlFail) throw new Error("graphql failed");
      return (
        graphqlAnswer ??
        pullRequestPage(
          { head: liveHead, changedFiles: prFiles.length, comments },
          cursor,
        )
      );
    },
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
        get: async ({ pull_number }) => {
          assert.equal(pull_number, 7);
          return { data: { head: { sha: liveHead } } };
        },
      },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          assert.ok(basehead in allCompares, `unexpected compare ${basehead}`);
          return { data: allCompares[basehead] };
        },
      },
    },
  };
  const { outputs, messages, secrets } = await runScript(
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
      GIT_TOKEN: "job-token",
      GITHUB_SERVER_URL: "https://github.com",
      ...env,
    },
    github,
    requireFn,
  );
  const diff = fs.existsSync(diffFile)
    ? fs.readFileSync(diffFile, "utf8")
    : undefined;
  return {
    outputs,
    messages,
    secrets,
    diff,
    listedComments,
    graphqlCursors,
    gitCalls,
    gitOptions,
  };
}

// The base did not move between the last review and the head.
const unmovedBase = (since) => ({
  [`${LAST}...${HEAD}`]: { status: "ahead", files: since },
  [`main...${LAST}`]: { merge_base_commit: { sha: MB_OLD } },
  [`main...${HEAD}`]: { merge_base_commit: { sha: MB_OLD } },
});

// Two callers on one pull request write one marker key, so a docs-only skip by
// a legacy caller must not read as pr-review-cli.yml's review of that head.
{
  const cliScopeStep = stepNamed(
    Object.values(load("pr-review-cli.yml").jobs).find((job) =>
      job.steps?.some((step) => step.name === "Scope the review"),
    ),
    "Scope the review",
  );
  assert.equal(cliScopeStep.uses, "$/.github/actions/resolve-review-scope");
  const cliActionDir = path.join(
    __dirname,
    "..",
    "actions",
    "resolve-review-scope",
  );
  const cliScript = parseWorkflow(
    fs.readFileSync(path.join(cliActionDir, "action.yml"), "utf8"),
  ).runs.steps[0].with.script;
  const cliLane = { lane: "claude-review", script: cliScript };
  const OWN = ".github/workflows/review.yml";
  const cliMarker = (sha, caller, id = 41) => ({
    id,
    user: { login: BOT },
    body: [
      `<!-- claude-lane-reviewed-head lane=claude-review sha=${sha} -->`,
      `<!-- claude-lane-reviewed-base ref=main merge-base=${MB_OLD} caller=${caller} -->`,
      "**claude-review** reviewed it.",
      "",
      "Earlier summary.",
    ].join("\n"),
  });
  const legacyMarker = (sha, id = 42) => ({
    id,
    user: { login: BOT },
    body: `<!-- claude-lane-reviewed-head lane=claude-review sha=${sha} -->\n**claude-review** needs no new review of \`${sha}\`: every file in scope matches docs-only-paths.`,
  });
  // The environment pr-review-cli.yml's scope step runs with, in a new directory.
  const cliEnv = () => {
    const directory = makeTemporaryDirectory("scope-cli-");
    return {
      ACTION_PATH: cliActionDir,
      GITHUB_WORKFLOW_REF: `o/r/${OWN}@refs/pull/7/merge`,
      FILE_LIST: path.join(directory, "files.txt"),
      DATA_LIST: path.join(directory, "data.txt"),
      RUNNER_TEMP: directory,
    };
  };
  const scopeCli = (comments, compares = {}) =>
    runScope(cliLane, {
      env: cliEnv(),
      prFiles: [file("src/a.js")],
      comments,
      compares,
    });
  const changed = unmovedBase([
    file("src/a.js", { patch: "@@ -1 +1 @@\n-x\n+y", changes: 2 }),
  ]);

  test("pr-review-cli: an output style is an agent instruction, never docs-only", async () => {
    const env = {
      ...cliEnv(),
      DOCS_ONLY_PATHS: "**/README.md",
      EVENT_ACTION: "opened",
    };
    const decide = async (filenames) =>
      (
        await runScope(cliLane, {
          env,
          prFiles: filenames.map((name) => file(name)),
        })
      ).outputs.review;
    assert.equal(await decide(["plugins/x/README.md"]), "false");
    assert.equal(await decide(["plugins/x/output-styles/README.md"]), "true");
  });

  test("pr-review-cli: a newer legacy marker at the head neither skips nor narrows the review", async () => {
    const { outputs } = await scopeCli(
      [cliMarker(LAST, OWN), legacyMarker(HEAD)],
      changed,
    );
    assert.equal(outputs.review, "true");
    assert.equal(outputs.scope, "incremental");
    assert.equal(outputs.since, LAST);
    assert.equal(outputs["marker-id"], "41");
  });

  test("pr-review-cli: a legacy marker alone means a whole review", async () => {
    const { outputs } = await scopeCli([legacyMarker(HEAD)]);
    assert.equal(outputs.review, "true");
    assert.equal(outputs.scope, "whole");
    assert.equal(outputs["marker-id"], undefined);
  });

  test("pr-review-cli: another caller's marker at the head means a whole review", async () => {
    const { outputs } = await scopeCli([
      cliMarker(HEAD, ".github/workflows/other.yml"),
    ]);
    assert.equal(outputs.review, "true");
    assert.equal(outputs.scope, "whole");
    assert.equal(outputs["marker-id"], undefined);
  });

  test("pr-review-cli: its own marker at the head still skips", async () => {
    const { outputs } = await scopeCli([cliMarker(HEAD, OWN)], {
      [`main...${HEAD}`]: { merge_base_commit: { sha: MB_OLD } },
    });
    assert.equal(outputs.review, "false");
    assert.equal(outputs.skip, "no-change");
    assert.equal(outputs["last-summary"], "Earlier summary.");
  });

  test("pr-review-cli: the captured GraphQL answer's own marker at its head skips", async () => {
    const pull = CAPTURE.body.data.repository.pullRequest;
    const { outputs, listedComments, graphqlCursors } = await runScope(
      cliLane,
      {
        env: {
          ...cliEnv(),
          HEAD_SHA: pull.headRefOid,
          GITHUB_WORKFLOW_REF:
            "melodic-software/claude-code-plugins/.github/workflows/pr-review-hosted.yml@refs/pull/19249/merge",
        },
        prFiles: [file("src/a.js")],
        graphqlAnswer: CAPTURE.body.data,
        compares: {
          [`main...${pull.headRefOid}`]: { merge_base_commit: { sha: MB_OLD } },
        },
      },
    );
    assert.equal(outputs.review, "false");
    assert.equal(outputs.skip, "no-change");
    assert.equal(outputs["marker-id"], "7182838683");
    assert.equal(JSON.parse(outputs["pr-files"]).changed, 4);
    assert.equal(listedComments, 0);
    assert.deepEqual(graphqlCursors, [null]);
  });

  test("pr-review-cli: every page of comments is read, and the newest marker wins", async () => {
    const filler = Array.from({ length: 230 }, (_, i) => ({
      id: 100 + i,
      user: { login: "kyle-sexton" },
      body: "A comment.",
    }));
    const { outputs, graphqlCursors } = await scopeCli(
      [
        cliMarker(HEAD, OWN, 41),
        ...filler.slice(0, 150),
        cliMarker(LAST, OWN, 43),
        ...filler.slice(150),
      ],
      changed,
    );
    assert.deepEqual(graphqlCursors, [null, "100", "200"]);
    assert.equal(outputs["marker-id"], "43");
    assert.equal(outputs.scope, "incremental");
    assert.equal(outputs.since, LAST);
  });

  test("pr-review-cli: a marker from a user named github-actions or from another bot records no review", async () => {
    const forged = (login) => ({ ...cliMarker(HEAD, OWN), user: { login } });
    for (const login of ["github-actions", "other[bot]"]) {
      const { outputs } = await scopeCli([forged(login)]);
      assert.equal(outputs.scope, "whole", login);
      assert.equal(outputs["marker-id"], undefined, login);
    }
  });

  test("pr-review-cli: a moved head skips nothing and passes no file list", async () => {
    const { outputs, messages } = await runScope(cliLane, {
      env: cliEnv(),
      prFiles: [file("src/a.js")],
      comments: [cliMarker(HEAD, OWN)],
      liveHead: MB_NEW,
    });
    assert.equal(outputs.review, "true");
    assert.equal(outputs["pr-files"], undefined);
    assert.ok(
      messages.includes(
        `The pull request's head moved to ${MB_NEW}; this run skips nothing.`,
      ),
    );
  });

  test("pr-review-cli: a failed file list still reads the marker, so the review updates the one comment", async () => {
    const { outputs, messages } = await runScope(cliLane, {
      env: cliEnv(),
      prFiles: [],
      fail: true,
      comments: [cliMarker(LAST, OWN)],
    });
    assert.equal(outputs.review, "true");
    assert.equal(outputs.scope, "whole");
    assert.equal(outputs["marker-id"], "41");
    assert.ok(
      messages.some((message) => /^warning: Scoping failed/u.test(message)),
    );
  });

  test("pr-review-cli: a failed GraphQL read reviews the whole pull request", async () => {
    const { outputs, graphqlCursors } = await runScope(cliLane, {
      env: cliEnv(),
      prFiles: [file("src/a.js")],
      comments: [cliMarker(HEAD, OWN)],
      graphqlFail: true,
    });
    assert.equal(outputs.review, "true");
    assert.equal(outputs.scope, "whole");
    assert.equal(outputs["marker-id"], undefined);
    assert.equal(graphqlCursors.length, 1);
  });
}
