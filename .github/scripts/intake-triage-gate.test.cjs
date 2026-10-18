"use strict";

// The intake lane's author gate: a run starts only for an issue its sender
// opened and wrote, when that sender's id is in allowed-author-ids (a person)
// or allowed-bot-sender-ids (a bot). Everyone else's issue waits for a
// person, so a stranger opening an issue spends nothing, and the skipped job
// reports why.

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

const gate = (github, ids = "", authorIds = "", issueNumber = "") =>
  Boolean(
    evaluate(job.if, {
      github,
      inputs: {
        "allowed-bot-sender-ids": ids,
        "allowed-author-ids": authorIds,
        "issue-number": issueNumber,
      },
    }),
  );
const kyle = { id: 153232337, login: "kyle-sexton" };
const bots = (github, ids = "") =>
  evaluate(allowedBots, { github, inputs: { "allowed-bot-sender-ids": ids } });

// A workflow_dispatch run: the actor is whoever sent the dispatch.
const dispatch = (actor, actorId) => ({
  actor,
  actor_id: actorId === undefined ? undefined : String(actorId),
  event_name: "workflow_dispatch",
  event: { inputs: {}, sender: { login: actor, id: actorId } },
});
const actionsBot = 41898282;

// GitHub's author_association values, from the REST and webhook payloads.
// By default the sender opened the issue, so the sender is its author.
const issueEvent = (
  actor,
  authorAssociation,
  sender,
  { action = "opened", author = sender } = {},
) => ({
  actor,
  event_name: "issues",
  event: {
    action,
    issue: {
      author_association: authorAssociation,
      user: { login: author?.login ?? actor, id: author?.id },
    },
    ...(sender && { sender }),
  },
});
const lanesApp = { id: 222, login: "lanes-app[bot]" };

test("the id-list and skipped-label inputs are optional strings defaulting to empty", () => {
  for (const name of [
    "allowed-bot-sender-ids",
    "allowed-author-ids",
    "skipped-label",
  ]) {
    const input = workflow.on.workflow_call.inputs[name];
    assert.equal(input.type, "string", name);
    assert.equal(input.default, "", name);
    assert.equal(input.required, undefined, name);
  }
});

test("a listed author starts a run whatever author_association the payload reports", () => {
  // A private org member reads CONTRIBUTOR in a webhook payload.
  for (const association of ["CONTRIBUTOR", "MEMBER", "OWNER", "NONE"]) {
    const event = issueEvent("kyle-sexton", association, kyle);
    for (const ids of ["153232337", "1,153232337", "153232337,2"]) {
      assert.equal(gate(event, "", ids), true, `${association} ${ids}`);
    }
    assert.equal(bots(event), "", association);
  }
});

test("an unlisted author waits for a person, OWNER and MEMBER included", () => {
  for (const association of [
    "OWNER",
    "MEMBER",
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
    assert.equal(gate(event, "9", "153232337"), false, association);
  }
  // 15323233 is a prefix of a listed id; only whole ids match.
  const prefix = issueEvent("near", "NONE", { id: 15323233, login: "near" });
  assert.equal(gate(prefix, "", "153232337"), false);
});

test("a malformed author list admits no one", () => {
  const event = issueEvent("kyle-sexton", "CONTRIBUTOR", kyle);
  for (const ids of ["153232337,", ",153232337", "1,,153232337", ","]) {
    assert.equal(gate(event, "", ids), false, ids);
  }
});

test("a listed person acting on an issue someone else wrote starts nothing", () => {
  const event = issueEvent("kyle-sexton", "CONTRIBUTOR", kyle, {
    author: { id: 9, login: "stranger" },
  });
  assert.equal(gate(event, "", "153232337"), false);
});

test("a person's id in the bot list does not admit them", () => {
  const event = issueEvent("kyle-sexton", "MEMBER", kyle);
  assert.equal(gate(event, "153232337", ""), false);
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
    const unlisted = issueEvent("other[bot]", "NONE", {
      id,
      login: "other[bot]",
    });
    assert.equal(gate(unlisted, "111,222"), false, String(id));
    assert.equal(bots(unlisted, "111,222"), "", String(id));
  }
});

test("only the opened action starts a run, for a listed person or bot", () => {
  for (const action of ["edited", "reopened", "labeled", "transferred"]) {
    assert.equal(
      gate(
        issueEvent("kyle-sexton", "MEMBER", kyle, { action }),
        "",
        "153232337",
      ),
      false,
      action,
    );
    assert.equal(
      gate(issueEvent("lanes-app[bot]", "NONE", lanesApp, { action }), "222"),
      false,
      action,
    );
  }
});

test("a listed bot acting on an issue someone else wrote starts nothing", () => {
  const stranger = { id: 9, login: "stranger" };
  const onStrangersIssue = issueEvent("lanes-app[bot]", "NONE", lanesApp, {
    author: stranger,
  });
  assert.equal(gate(onStrangersIssue, "222"), false);
  assert.equal(bots(onStrangersIssue, "222"), "");
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

test("an event other than issues or workflow_dispatch still reaches the reject step", () => {
  const push = { actor: "stranger", event_name: "push", event: {} };
  assert.equal(gate(push), true);
  const [reject] = job.steps;
  assert.equal(
    reject.name,
    "Reject events other than issues and workflow_dispatch",
  );
  assert.equal(
    reject.if,
    "github.event_name != 'issues' && github.event_name != 'workflow_dispatch'",
  );
});

test("a dispatch starts a run when its actor's id is listed", () => {
  assert.equal(
    gate(dispatch("kyle-sexton", kyle.id), "", "153232337", "12"),
    true,
  );
  assert.equal(bots(dispatch("kyle-sexton", kyle.id), "153232337"), "");
  const sweep = dispatch("github-actions[bot]", actionsBot);
  assert.equal(gate(sweep, "41898282", "", "12"), true);
  assert.equal(bots(sweep, "41898282"), "github-actions[bot]");
});

test("a dispatch by an unlisted actor, or with no issue number, starts nothing", () => {
  assert.equal(
    gate(dispatch("stranger", 9), "41898282", "153232337", "12"),
    false,
  );
  assert.equal(bots(dispatch("stranger[bot]", 9), "41898282"), "");
  // A person's id in the bot list, or a bot's id in the person list, does not admit.
  assert.equal(
    gate(dispatch("kyle-sexton", kyle.id), "153232337", "", "12"),
    false,
  );
  assert.equal(
    gate(dispatch("github-actions[bot]", actionsBot), "", "41898282", "12"),
    false,
  );
  assert.equal(
    gate(dispatch("kyle-sexton", kyle.id), "", "153232337", ""),
    false,
  );
  assert.equal(
    gate(dispatch("kyle-sexton", undefined), "", "153232337", "12"),
    false,
  );
  for (const ids of ["153232337,", ",153232337", "1,,153232337"]) {
    assert.equal(
      gate(dispatch("kyle-sexton", kyle.id), "", ids, "12"),
      false,
      ids,
    );
  }
});

test("the issue comes from the API by a validated number", () => {
  const resolve = job.steps.find((step) => step.id === "issue");
  assert.equal(
    resolve.env.REQUESTED,
    "${{ github.event_name == 'issues' && github.event.issue.number || inputs.issue-number }}",
  );
  assert.match(resolve.with.script, /\^\[1-9\]\[0-9\]\{0,9\}\$/u);
  assert.match(resolve.with.script, /issue\.pull_request/u);
  const text = JSON.stringify(job.steps);
  assert.doesNotMatch(
    text,
    /github\.event\.issue\.(number|node_id)\b(?! \|\| inputs)/u,
  );
});

test("a gated-out opened issue runs the skipped job, which may apply a label", () => {
  const skipped = workflow.jobs.skipped;
  assert.equal(skipped.name, "claude-intake-triage-skipped");
  assert.equal(skipped.needs, "claude");
  // Only the claude job's own if can skip it, so skipped means gated out.
  assert.match(skipped.if, /always\(\) && needs\.claude\.result == 'skipped'/u);
  assert.match(
    skipped.if,
    /github\.event_name == 'issues' && github\.event\.action == 'opened'/u,
  );
  assert.match(skipped.if, /\|\| github\.event_name == 'workflow_dispatch'/u);
  assert.deepEqual(skipped.permissions, { issues: "write" });
  const env = skipped.steps[0].env;
  assert.equal(env.SKIPPED_LABEL, "${{ inputs.skipped-label }}");
});
