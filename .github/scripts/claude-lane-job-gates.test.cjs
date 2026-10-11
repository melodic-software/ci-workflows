"use strict";

// Job-level gates on both review lanes: bot actors skip unless the event
// sender's id is in allowed-bot-sender-ids, draft PRs and fork PRs skip, and
// privileged triggers still reach the tripwire because the draft and fork
// tests are scoped to pull_request.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsDir = path.join(__dirname, "..", "workflows");

// Evaluates the subset of the Actions expression language these gates use:
// context paths (a missing property is null), string literals, ! && || == !=
// and parentheses, and the case-insensitive contains/startsWith/endsWith plus
// format.
const str = (value) =>
  value === null || value === undefined ? "" : String(value);
const functions = {
  contains: (haystack, needle) =>
    str(haystack).toLowerCase().includes(str(needle).toLowerCase()),
  startsWith: (text, prefix) =>
    str(text).toLowerCase().startsWith(str(prefix).toLowerCase()),
  endsWith: (text, suffix) =>
    str(text).toLowerCase().endsWith(str(suffix).toLowerCase()),
  format: (template, ...args) =>
    template.replace(/\{(\d+)\}/gu, (_, i) => str(args[Number(i)])),
};
const evaluate = (expression, contexts) => {
  const body = expression
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1")
    .replace(
      /\b(github|inputs)((?:\.[A-Za-z_][\w-]*)+)/gu,
      (_, root, rest) =>
        `${root}${rest
          .slice(1)
          .split(".")
          .map((key) => `?.[${JSON.stringify(key)}]`)
          .join("")}`,
    );
  const run = new Function(
    ...Object.keys(functions),
    "github",
    "inputs",
    `return (${body}) ?? null;`,
  );
  return run(...Object.values(functions), contexts.github, contexts.inputs);
};

const LISTED_ID = 222;
const pullRequestEvent = (
  actor,
  sender,
  { draft = false, fork = false } = {},
) => ({
  actor,
  repository: "melodic-software/example",
  event_name: "pull_request",
  event: {
    ...(sender && { sender }),
    pull_request: {
      draft,
      head: {
        repo: {
          full_name: fork ? "someone/example" : "melodic-software/example",
        },
      },
    },
  },
});
const lanesApp = { id: LISTED_ID, login: "lanes-app[bot]" };

for (const { file, job } of [
  { file: "pr-review.yml", job: "claude" },
  { file: "pr-review-security.yml", job: "claude" },
]) {
  const workflow = parseWorkflow(
    fs.readFileSync(path.join(workflowsDir, file), "utf8"),
  );
  const reviewJob = workflow.jobs[job];
  const allowedBots = reviewJob.steps.find((step) =>
    step.uses?.startsWith("anthropics/claude-code-action@"),
  ).with.allowed_bots;
  // A job `if:` runs the job when its result is truthy.
  const gate = (github, ids) =>
    Boolean(
      evaluate(reviewJob.if, {
        github,
        inputs: { "allowed-bot-sender-ids": ids },
      }),
    );
  const bots = (github, ids) =>
    evaluate(allowedBots, {
      github,
      inputs: { "allowed-bot-sender-ids": ids },
    });

  test(`${file}: allowed-bot-sender-ids is an optional string defaulting to empty`, () => {
    const input = workflow.on.workflow_call.inputs["allowed-bot-sender-ids"];
    assert.equal(input.type, "string");
    assert.equal(input.default, "");
    assert.equal(input.required, undefined);
  });

  test(`${file}: ${job} skips every bot actor when no sender id is listed`, () => {
    assert.equal(
      gate(
        pullRequestEvent("dependabot[bot]", {
          id: 49699333,
          login: "dependabot[bot]",
        }),
        "",
      ),
      false,
    );
    assert.equal(gate(pullRequestEvent("lanes-app[bot]", lanesApp), ""), false);
    assert.equal(bots(pullRequestEvent("lanes-app[bot]", lanesApp), ""), "");
    assert.doesNotMatch(reviewJob.if, /author_association|skip-actors/u);
    assert.equal(workflow.on.workflow_call.inputs["skip-actors"], undefined);
    assert.equal(workflow.on.workflow_call.inputs["allowed-bots"], undefined);
  });

  test(`${file}: ${job} reviews a human actor whatever the list holds`, () => {
    for (const ids of ["", "111,222"]) {
      const human = pullRequestEvent("octocat", {
        id: 583231,
        login: "octocat",
      });
      assert.equal(gate(human, ids), true);
      assert.equal(bots(human, ids), "");
    }
  });

  test(`${file}: ${job} admits only a bot whose sender id is listed, and allows only its login`, () => {
    const listed = pullRequestEvent("lanes-app[bot]", lanesApp);
    for (const ids of ["222", "111,222", "222,333"]) {
      assert.equal(gate(listed, ids), true, ids);
      assert.equal(bots(listed, ids), "lanes-app[bot]", ids);
    }
    // 22 and 2222 contain or are contained in 222 as text; only whole ids match.
    for (const sender of [
      { id: 22, login: "other[bot]" },
      { id: 2222, login: "other[bot]" },
    ]) {
      const unlisted = pullRequestEvent("other[bot]", sender);
      assert.equal(gate(unlisted, "111,222"), false, String(sender.id));
      assert.equal(bots(unlisted, "111,222"), "", String(sender.id));
    }
  });

  test(`${file}: ${job} admits no bot on an event without a sender (R3-13)`, () => {
    const senderless = pullRequestEvent("lanes-app[bot]", undefined);
    for (const ids of ["", "222", "222,", ",222", "111,,222"]) {
      assert.equal(gate(senderless, ids), false, ids);
      assert.equal(bots(senderless, ids), "", ids);
    }
  });

  test(`${file}: ${job} admits no bot when the id list is malformed`, () => {
    const listed = pullRequestEvent("lanes-app[bot]", lanesApp);
    for (const ids of ["222,", ",222", "111,,222", ","]) {
      assert.equal(gate(listed, ids), false, ids);
      assert.equal(bots(listed, ids), "", ids);
    }
  });

  test(`${file}: ${job} still skips a listed bot's draft or fork PR`, () => {
    assert.equal(
      gate(
        pullRequestEvent("lanes-app[bot]", lanesApp, { draft: true }),
        "222",
      ),
      false,
    );
    assert.equal(
      gate(pullRequestEvent("lanes-app[bot]", lanesApp, { fork: true }), "222"),
      false,
    );
  });

  test(`${file}: ${job} skips draft and fork PRs, scoped to pull_request`, () => {
    assert.match(
      reviewJob.if,
      /\(github\.event_name != 'pull_request'\s+\|\| github\.event\.pull_request\.draft == false\)/u,
    );
    assert.match(
      reviewJob.if,
      /\(github\.event_name != 'pull_request'\s+\|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository\)/u,
    );
  });

  test(`${file}: the privileged-trigger tripwire is the first step`, () => {
    const [reject] = reviewJob.steps;
    assert.equal(reject.name, "Reject privileged triggers");
    assert.equal(
      reject.if,
      "github.event_name == 'pull_request_target' || github.event_name == 'workflow_run'",
    );
    assert.match(reject.run, /exit 1/u);
  });
}
