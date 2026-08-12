"use strict";

// Incremental relevance gating (#259): on synchronize, the changes job lists
// files changed since the last-reviewed head (marker comment) rather than the
// whole PR, so a docs-only push after a security review does not re-burn a
// full pass. These tests EXECUTE the List changed files github-script body
// against mocked Octokit calls — a regex over the YAML cannot tell a reachable
// incremental branch from an unreachable one.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const workflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "claude-security-review.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");

function listChangedFilesScript() {
  const start = workflow.indexOf("      - name: List changed files\n");
  assert.notEqual(start, -1, "List changed files step not found");
  const rest = workflow.slice(start + 1);
  const next = rest.indexOf("\n      - name: ");
  const step = next === -1 ? rest : rest.slice(0, next);
  const marker = "          script: |\n";
  const scriptStart = step.indexOf(marker);
  assert.notEqual(scriptStart, -1, "List changed files has no literal script");
  const lines = step.slice(scriptStart + marker.length).split("\n");
  const end = lines.findIndex(
    (line) => line !== "" && !line.startsWith("            "),
  );
  const body = (end === -1 ? lines : lines.slice(0, end)).join("\n");
  assert.doesNotMatch(
    body,
    /\$\{\{/u,
    "the listing script interpolates a github expression, so executing it here would not match CI",
  );
  return body
    .split("\n")
    .map((line) => (line.startsWith("            ") ? line.slice(12) : line))
    .join("\n");
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HEAD_C = "cccccccccccccccccccccccccccccccccccccccc";

async function runListing({
  action = "synchronize",
  headSha = HEAD_B,
  comments = [],
  prFiles = [],
  compareFiles = null,
  compareError = null,
  listFilesError = null,
}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "security-review-incremental-"),
  );
  const outputs = {};
  const warnings = [];
  const infos = [];
  const core = {
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    warning: (message) => warnings.push(message),
    info: (message) => infos.push(message),
  };
  const github = {
    paginate: async (fn, _params) => {
      if (fn === github.rest.issues.listComments) {
        return comments;
      }
      if (fn === github.rest.pulls.listFiles) {
        if (listFilesError) throw listFilesError;
        return prFiles;
      }
      throw new Error(`unexpected paginate target: ${fn?.name ?? fn}`);
    },
    rest: {
      issues: {
        listComments: () => {},
      },
      pulls: {
        listFiles: () => {},
      },
      repos: {
        compareCommitsWithBasehead: async () => {
          if (compareError) throw compareError;
          return { data: { files: compareFiles ?? [] } };
        },
        getContent: async () => {
          throw new Error("paths-file fetch not under test");
        },
      },
    },
  };
  const context = {
    repo: { owner: "melodic-software", repo: "consumer" },
    payload: {
      action,
      pull_request: {
        number: 42,
        head: { sha: headSha },
        base: { ref: "main" },
      },
    },
  };
  const previousTemp = process.env.RUNNER_TEMP;
  const previousPaths = process.env.PATHS_INPUT;
  const previousPathsFile = process.env.PATHS_FILE;
  process.env.RUNNER_TEMP = directory;
  process.env.PATHS_INPUT = ".github/**\n";
  process.env.PATHS_FILE = "";
  try {
    const run = new AsyncFunction(
      "core",
      "github",
      "context",
      "require",
      listChangedFilesScript(),
    );
    await run(core, github, context, require);
  } finally {
    if (previousTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousTemp;
    if (previousPaths === undefined) delete process.env.PATHS_INPUT;
    else process.env.PATHS_INPUT = previousPaths;
    if (previousPathsFile === undefined) delete process.env.PATHS_FILE;
    else process.env.PATHS_FILE = previousPathsFile;
  }

  let names = [];
  if (outputs.failed === "false" && outputs.path) {
    const raw = fs.readFileSync(outputs.path, "utf8");
    names = raw === "" ? [] : raw.replace(/\n$/u, "").split("\n");
  }
  fs.rmSync(directory, { recursive: true, force: true });
  return { outputs, names, warnings, infos };
}

function lastHeadComment(sha, { author = "github-actions[bot]" } = {}) {
  return {
    id: 1,
    user: { login: author },
    body:
      `<!-- claude-security-review-last-head:${sha} -->\n` +
      `Last security-reviewed head: \`${sha}\`.`,
  };
}

test("synchronize with a prior reviewed head lists only the incremental delta", async () => {
  const { outputs, names, infos } = await runListing({
    action: "synchronize",
    headSha: HEAD_B,
    comments: [lastHeadComment(HEAD_A)],
    prFiles: [
      { filename: ".github/workflows/ci.yml" },
      { filename: "docs/readme.md" },
    ],
    compareFiles: [{ filename: "docs/readme.md" }],
  });
  assert.equal(outputs.failed, "false");
  assert.deepEqual(names, ["docs/readme.md"]);
  assert.match(
    infos.join("\n"),
    /Incremental relevance/u,
    "the operator log must record that the listing was incremental",
  );
});

test("synchronize without a prior marker falls back to the whole-PR listing", async () => {
  const { outputs, names } = await runListing({
    action: "synchronize",
    headSha: HEAD_B,
    comments: [],
    prFiles: [
      { filename: ".github/workflows/ci.yml" },
      { filename: "docs/readme.md" },
    ],
    compareFiles: [{ filename: "docs/only.md" }],
  });
  assert.equal(outputs.failed, "false");
  assert.deepEqual(names, [".github/workflows/ci.yml", "docs/readme.md"]);
});

test("opened events always use the whole-PR listing even with a marker", async () => {
  const { outputs, names, infos } = await runListing({
    action: "opened",
    headSha: HEAD_B,
    comments: [lastHeadComment(HEAD_A)],
    prFiles: [{ filename: ".github/workflows/ci.yml" }],
    compareFiles: [{ filename: "docs/readme.md" }],
  });
  assert.equal(outputs.failed, "false");
  assert.deepEqual(names, [".github/workflows/ci.yml"]);
  assert.doesNotMatch(infos.join("\n"), /Incremental relevance/u);
});

test("a compare fault fails open to the whole-PR listing", async () => {
  const { outputs, names, warnings } = await runListing({
    action: "synchronize",
    headSha: HEAD_B,
    comments: [lastHeadComment(HEAD_A)],
    prFiles: [{ filename: ".github/workflows/ci.yml" }],
    compareError: new Error("Not Found"),
  });
  assert.equal(outputs.failed, "false");
  assert.deepEqual(names, [".github/workflows/ci.yml"]);
  assert.match(warnings.join("\n"), /Incremental compare/u);
});

test("an already-reviewed head yields an empty incremental listing", async () => {
  const { outputs, names } = await runListing({
    action: "synchronize",
    headSha: HEAD_A,
    comments: [lastHeadComment(HEAD_A)],
    prFiles: [{ filename: ".github/workflows/ci.yml" }],
    compareFiles: [{ filename: "docs/readme.md" }],
  });
  assert.equal(outputs.failed, "false");
  assert.deepEqual(names, []);
});

test("a spoofed last-head comment from a non-bot author is ignored", async () => {
  const { outputs, names } = await runListing({
    action: "synchronize",
    headSha: HEAD_B,
    comments: [lastHeadComment(HEAD_A, { author: "attacker" })],
    prFiles: [{ filename: ".github/workflows/ci.yml" }],
    compareFiles: [{ filename: "docs/readme.md" }],
  });
  assert.equal(outputs.failed, "false");
  assert.deepEqual(names, [".github/workflows/ci.yml"]);
});

test("a 300-file compare cap fails open to the whole-PR listing", async () => {
  const compareFiles = Array.from({ length: 300 }, (_, i) => ({
    filename: `docs/f${i}.md`,
  }));
  const { outputs, names, warnings } = await runListing({
    action: "synchronize",
    headSha: HEAD_C,
    comments: [lastHeadComment(HEAD_A)],
    prFiles: [{ filename: ".github/workflows/ci.yml" }],
    compareFiles,
  });
  assert.equal(outputs.failed, "false");
  assert.deepEqual(names, [".github/workflows/ci.yml"]);
  assert.match(warnings.join("\n"), /300-file API cap/u);
});

test("renames include the previous filename in the incremental listing", async () => {
  const { outputs, names } = await runListing({
    action: "synchronize",
    headSha: HEAD_B,
    comments: [lastHeadComment(HEAD_A)],
    prFiles: [],
    compareFiles: [
      {
        filename: ".github/workflows/new.yml",
        previous_filename: ".github/workflows/old.yml",
      },
    ],
  });
  assert.equal(outputs.failed, "false");
  assert.deepEqual(names, [
    ".github/workflows/new.yml",
    ".github/workflows/old.yml",
  ]);
});
