"use strict";

// The intake lane's author gate: a run starts only for an issue whose author
// is an OWNER or MEMBER, or a bot whose event sender id is listed in
// allowed-bot-sender-ids. Everyone else's issue waits for a person, so a
// stranger opening an issue spends nothing.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { evaluate } = require("./actions-expression.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(__dirname, "..", "workflows", "intake-triage.yml"),
    "utf8",
  ),
);
const job = workflow.jobs.claude;
const allowedBots = job.steps.find((step) =>
  step.uses?.startsWith("anthropics/claude-code-action@"),
).with.allowed_bots;

const gate = (github, ids = "") =>
  Boolean(
    evaluate(job.if, { github, inputs: { "allowed-bot-sender-ids": ids } }),
  );
const bots = (github, ids = "") =>
  evaluate(allowedBots, { github, inputs: { "allowed-bot-sender-ids": ids } });

// GitHub's author_association values, from the REST and webhook payloads.
const issueEvent = (actor, authorAssociation, sender) => ({
  actor,
  event_name: "issues",
  event: {
    issue: { author_association: authorAssociation, user: { login: actor } },
    ...(sender && { sender }),
  },
});
const lanesApp = { id: 222, login: "lanes-app[bot]" };

test("allowed-bot-sender-ids is an optional string defaulting to empty", () => {
  const input = workflow.on.workflow_call.inputs["allowed-bot-sender-ids"];
  assert.equal(input.type, "string");
  assert.equal(input.default, "");
  assert.equal(input.required, undefined);
});

test("an OWNER or MEMBER author starts a run, and no bot is allowed", () => {
  for (const association of ["OWNER", "MEMBER"]) {
    const event = issueEvent("octocat", association, {
      id: 583231,
      login: "octocat",
    });
    assert.equal(gate(event), true, association);
    assert.equal(gate(event, "222"), true, association);
    assert.equal(bots(event), "", association);
  }
});

test("any other author waits for a person", () => {
  for (const association of [
    "COLLABORATOR",
    "CONTRIBUTOR",
    "FIRST_TIMER",
    "FIRST_TIME_CONTRIBUTOR",
    "MANNEQUIN",
    "NONE",
  ]) {
    const event = issueEvent("stranger", association, {
      id: 9,
      login: "stranger",
    });
    assert.equal(gate(event), false, association);
    assert.equal(gate(event, "9"), false, association);
  }
});

test("a bot starts a run only when its sender id is listed, and only its login is allowed", () => {
  const listed = issueEvent("lanes-app[bot]", "NONE", lanesApp);
  assert.equal(gate(listed), false);
  for (const ids of ["222", "111,222", "222,333"]) {
    assert.equal(gate(listed, ids), true, ids);
    assert.equal(bots(listed, ids), "lanes-app[bot]", ids);
  }
  // 22 and 2222 contain or are contained in 222 as text; only whole ids match.
  for (const id of [22, 2222]) {
    const unlisted = issueEvent("other[bot]", "NONE", { id, login: "other[bot]" });
    assert.equal(gate(unlisted, "111,222"), false, String(id));
    assert.equal(bots(unlisted, "111,222"), "", String(id));
  }
});

test("a bot's MEMBER association does not stand in for the id list", () => {
  const memberBot = issueEvent("lanes-app[bot]", "MEMBER", lanesApp);
  assert.equal(gate(memberBot, ""), false);
});

test("a malformed id list or a missing sender admits no bot", () => {
  const listed = issueEvent("lanes-app[bot]", "NONE", lanesApp);
  for (const ids of ["222,", ",222", "111,,222", ","]) {
    assert.equal(gate(listed, ids), false, ids);
    assert.equal(bots(listed, ids), "", ids);
  }
  const senderless = issueEvent("lanes-app[bot]", "NONE", undefined);
  assert.equal(gate(senderless, "222"), false);
});

test("a non-issues event still reaches the reject step", () => {
  const push = { actor: "stranger", event_name: "push", event: {} };
  assert.equal(gate(push), true);
  const [reject] = job.steps;
  assert.equal(reject.name, "Reject events other than issues");
  assert.equal(reject.if, "github.event_name != 'issues'");
});
