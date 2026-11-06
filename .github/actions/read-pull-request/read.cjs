// pr-review-cli's pull-request job, for a workflow_run caller. No model runs
// here. A workflow_run event carries no pull_request, so the caller names the
// pull request and head; this step reads the pull request once and outputs
// the facts the lane's gates check from that read, never from the caller.
//
// Env: PR_NUMBER, HEAD_SHA (required), BASE_SHA, EVENT_ACTION (optional).
// A malformed value throws before any request. proceed is `true` only when
// the pull request's head is HEAD_SHA; a moved head logs a notice and the
// lane skips, since the new head's own run reviews it. A BASE_SHA that is
// not the pull request's base only logs a notice: the read base picks the
// trusted-actor list, and a base can move under an open pull request.
"use strict";

const NUMBER = /^[1-9][0-9]{0,9}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const ACTION = /^[a-z_]{1,40}$/u;

const text = (value) => (typeof value === "string" ? value : "");

async function run({ github, context, core, env = process.env }) {
  const number = String(env.PR_NUMBER ?? "");
  const head = String(env.HEAD_SHA ?? "");
  const base = String(env.BASE_SHA ?? "");
  const action = String(env.EVENT_ACTION ?? "");
  if (!NUMBER.test(number)) throw new Error("pr-number is not a pull request number");
  if (!SHA.test(head)) throw new Error("head-sha is not a full lower-case commit sha");
  if (base !== "" && !SHA.test(base)) throw new Error("base-sha is not a full lower-case commit sha");
  if (action !== "" && !ACTION.test(action)) throw new Error("event-action is not a pull_request action name");

  const { owner, repo } = context.repo;
  const pull = (await github.rest.pulls.get({ owner, repo, pull_number: Number(number) })).data;
  if (String(pull?.number) !== number) throw new Error(`the read returned no pull request #${number}`);
  const facts = {
    number,
    state: text(pull.state),
    draft: pull.draft === true ? "true" : pull.draft === false ? "false" : "",
    "head-repo": text(pull.head?.repo?.full_name),
    author: text(pull.user?.login),
    "head-sha": text(pull.head?.sha),
    "head-ref": text(pull.head?.ref),
    "base-sha": text(pull.base?.sha),
    "base-ref": text(pull.base?.ref),
    action,
  };
  for (const [name, value] of Object.entries(facts)) core.setOutput(name, value);

  if (base !== "" && base !== facts["base-sha"])
    core.notice(`base-sha ${base} is not pull request #${number}'s base ${facts["base-sha"]}; the lane uses the pull request's base`);
  const proceed = facts["head-sha"] === head;
  if (!proceed)
    core.notice(`pull request #${number}'s head moved from ${head} to ${facts["head-sha"] || "none"}; this run skips the review, and the new head's run reviews it`);
  core.setOutput("proceed", proceed ? "true" : "false");
  return facts;
}

module.exports = { run };
