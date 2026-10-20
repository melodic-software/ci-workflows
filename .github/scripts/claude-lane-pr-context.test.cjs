"use strict";

// The code-review lane's PR-context file: a same-repository closing issue
// keeps its title and body only when author-trust trusts its author; any
// other gets a placeholder, and a cross-repository one is written as its
// repository and number alone. The fetch, trust and render run blocks are
// expression-free shell, so they are executed here against a stub gh.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const root = path.join(__dirname, "..");
const workflow = parseWorkflow(
  fs.readFileSync(path.join(root, "workflows", "pr-review.yml"), "utf8"),
);
const steps = workflow.jobs.claude.steps;
const step = (id) => {
  const found = steps.find((s) => s?.id === id);
  assert.ok(found, `${id} step not found`);
  return found;
};
const trustAction = parseWorkflow(
  fs.readFileSync(
    path.join(root, "actions", "author-trust", "action.yml"),
    "utf8",
  ),
);
const trustRun = trustAction.runs.steps.find((s) => s.id === "trust").run;

const KYLE = 153232337;
const BOT = 41898282;
const STRANGER = 999;

// GitHub runs a `shell: bash` step as `bash --noprofile --norc -eo pipefail`.
function run(script, env, directory) {
  const output = path.join(directory, `output-${Math.random()}`);
  fs.writeFileSync(output, "");
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}/bin:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
        ...env,
      },
    },
  );
  const outputs = Object.fromEntries(
    fs
      .readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  return { result, outputs };
}

function trust(actors, authorIds = "", botIds = "") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "author-trust-"));
  try {
    const { result, outputs } = run(
      trustRun,
      { ACTORS: actors, AUTHOR_IDS: authorIds, BOT_IDS: botIds },
      directory,
    );
    return {
      status: result.status,
      trusted: outputs.trusted && JSON.parse(outputs.trusted),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const issue = (
  number,
  author,
  { repository = "melodic-software/demo", comments = [] } = {},
) => ({
  number,
  title: `TITLE-${number}`,
  body: `BODY-${number}`,
  author,
  repository: { nameWithOwner: repository },
  comments: { nodes: comments },
});
const user = (id) => ({
  __typename: "User",
  login: `user${id}`,
  databaseId: id,
});
const bot = (id) => ({ __typename: "Bot", login: `bot${id}`, databaseId: id });

// Runs fetch, author-trust and render as the job does and returns the file.
function context(
  issues,
  { authorIds = "", botIds = "", trustFails = false } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pr-context-"));
  try {
    const response = {
      data: {
        repository: {
          pullRequest: {
            number: 5,
            title: "PR-TITLE",
            body: "PR-BODY line one\nline two",
            closingIssuesReferences: { nodes: issues },
          },
        },
      },
    };
    fs.mkdirSync(path.join(directory, "bin"));
    fs.writeFileSync(
      path.join(directory, "response.json"),
      JSON.stringify(response),
    );
    fs.writeFileSync(
      path.join(directory, "bin", "gh"),
      `#!/bin/sh\ncat "${path.join(directory, "response.json")}"\n`,
      { mode: 0o755 },
    );
    const fetch = run(
      step("pr-context-fetch").run,
      {
        GH_TOKEN: "x",
        OWNER: "melodic-software",
        REPO_NAME: "demo",
        PR_NUMBER: "5",
      },
      directory,
    );
    assert.equal(fetch.result.status, 0, fetch.result.stderr);
    const checked = run(
      trustRun,
      { ACTORS: fetch.outputs.actors, AUTHOR_IDS: authorIds, BOT_IDS: botIds },
      directory,
    );
    assert.equal(checked.result.status, 0, checked.result.stderr);
    const render = run(
      step("pr-context").run,
      {
        REPOSITORY: "melodic-software/demo",
        TRUSTED: trustFails ? "" : checked.outputs.trusted,
        CONTEXT_FILE: ".claude-lane/pr-context.md",
      },
      directory,
    );
    assert.equal(render.result.status, 0, render.result.stderr);
    return fs.readFileSync(
      path.join(directory, ".claude-lane", "pr-context.md"),
      "utf8",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const PLACEHOLDER =
  "Title and body omitted: the author is not in allowed-author-ids or allowed-bot-sender-ids.";

test("pr-review.yml: the trust step runs author-trust between fetch and render", () => {
  const ids = steps.map((s) => s?.id);
  const at = (id) => ids.indexOf(id);
  assert.ok(at("pr-context-fetch") < at("pr-context-trust"));
  assert.ok(at("pr-context-trust") < at("pr-context"));
  const trustStep = step("pr-context-trust");
  assert.equal(trustStep.uses, "$/.github/actions/author-trust");
  assert.equal(
    trustStep.with["allowed-author-ids"],
    `\${{ inputs.allowed-author-ids }}`,
  );
  assert.equal(
    trustStep.with["allowed-bot-sender-ids"],
    `\${{ inputs.allowed-bot-sender-ids }}`,
  );
  assert.equal(
    workflow.on.workflow_call.inputs["allowed-author-ids"].default,
    "",
  );
});

test("a same-repository closing issue by a trusted author keeps its title and body", () => {
  const file = context([issue(7, user(KYLE))], { authorIds: `1,${KYLE}` });
  assert.match(file, /^## Closing issue melodic-software\/demo#7: TITLE-7$/mu);
  assert.match(file, /^BODY-7$/mu);
  assert.ok(!file.includes(PLACEHOLDER));
});

test("a same-repository closing issue by an untrusted author gets the placeholder", () => {
  const file = context([issue(8, user(STRANGER))], { authorIds: String(KYLE) });
  assert.match(file, /^## Closing issue melodic-software\/demo#8$/mu);
  assert.ok(file.includes(PLACEHOLDER));
  assert.ok(!file.includes("TITLE-8"));
  assert.ok(!file.includes("BODY-8"));
});

test("a bot is trusted through allowed-bot-sender-ids", () => {
  const file = context([issue(9, bot(BOT))], { botIds: String(BOT) });
  assert.match(file, /^## Closing issue melodic-software\/demo#9: TITLE-9$/mu);
});

test("a deleted author, or a trust check that failed, trusts no one", () => {
  for (const file of [
    context([issue(10, null)], { authorIds: String(KYLE) }),
    context([issue(10, user(KYLE))], {
      authorIds: String(KYLE),
      trustFails: true,
    }),
  ]) {
    assert.ok(file.includes(PLACEHOLDER));
    assert.ok(!file.includes("TITLE-10"));
    assert.ok(!file.includes("BODY-10"));
  }
});

test("a cross-repository closing issue is its repository and number only", () => {
  const comment = {
    body: "COMMENT-TEXT",
    authorAssociation: "OWNER",
    author: { login: "kyle" },
  };
  const file = context(
    [
      issue(11, user(KYLE), {
        repository: "melodic-software/other",
        comments: [comment],
      }),
    ],
    { authorIds: String(KYLE) },
  );
  assert.match(file, /^## Closing issue melodic-software\/other#11$/mu);
  for (const text of ["TITLE-11", "BODY-11", "COMMENT-TEXT", PLACEHOLDER]) {
    assert.ok(!file.includes(text), text);
  }
});

test("the pull request's own title and body are written unchanged", () => {
  const file = context([issue(12, user(STRANGER))]);
  assert.match(file, /^## Pull request #5: PR-TITLE$/mu);
  assert.ok(file.includes("PR-BODY line one\nline two"));
});

test("the existing comment filter still applies to a same-repository issue", () => {
  const comments = [
    {
      body: "MEMBER-NOTE",
      authorAssociation: "MEMBER",
      author: { login: "m" },
    },
    {
      body: "STRANGER-NOTE",
      authorAssociation: "NONE",
      author: { login: "s" },
    },
  ];
  const file = context([issue(13, user(STRANGER), { comments })]);
  assert.ok(file.includes("MEMBER-NOTE"));
  assert.ok(!file.includes("STRANGER-NOTE"));
});

test("author-trust: each type is checked only against its own list", () => {
  const actors = JSON.stringify([
    { type: "User", id: KYLE },
    { type: "Bot", id: BOT },
    { type: "User", id: BOT },
    { type: "Bot", id: KYLE },
    { type: "Organization", id: KYLE },
    { type: "User", id: null },
    null,
  ]);
  const { status, trusted } = trust(actors, String(KYLE), String(BOT));
  assert.equal(status, 0);
  assert.deepEqual(trusted, [`Bot:${BOT}`, `User:${KYLE}`]);
});

test("author-trust: an empty or malformed list trusts no one", () => {
  const actors = JSON.stringify([{ type: "User", id: KYLE }]);
  for (const list of ["", `,${KYLE}`, `${KYLE},`, `1,,${KYLE}`]) {
    assert.deepEqual(trust(actors, list).trusted, [], list);
  }
  assert.deepEqual(trust(actors, `${KYLE}0`).trusted, []);
});

test("author-trust: input that is not a JSON array fails the step", () => {
  for (const actors of ["not json", "{}", ""]) {
    assert.notEqual(trust(actors, String(KYLE)).status, 0, actors);
  }
});
