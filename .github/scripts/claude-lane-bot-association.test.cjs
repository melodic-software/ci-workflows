"use strict";

// Job-level defence-in-depth (#443): bot actors other than dependabot[bot]
// require the PR author's association to be OWNER, MEMBER, or COLLABORATOR.
// Pins the clause on both review lanes' main attempt jobs (retry is in-job).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const workflowsDir = path.join(repositoryRoot, ".github", "workflows");

const BOT_GUARD = /!endsWith\(github\.actor, '\[bot\]'\)/u;
const DEPENDABOT_EXEMPT = /github\.actor == 'dependabot\[bot\]'/u;
const AUTHOR_ASSOCIATION =
  /contains\(format\(',\{0\},', 'OWNER,MEMBER,COLLABORATOR'\), format\(',\{0\},', github\.event\.pull_request\.author_association\)\)/u;

function reviewJobCondition(fileName, jobName) {
  const workflow = fs.readFileSync(
    path.join(workflowsDir, fileName),
    "utf8",
  );
  const start = workflow.indexOf(`  ${jobName}:`);
  assert.notEqual(start, -1, `${fileName} must declare job ${jobName}`);
  const slice = workflow.slice(start);
  const end = slice.indexOf("      - name: Reject privileged triggers");
  assert.notEqual(end, -1, `${fileName} ${jobName} job must reach the tripwire step`);
  return slice.slice(0, end);
}

for (const { file, job } of [
  { file: "claude-review.yml", job: "review" },
  { file: "claude-security-review.yml", job: "security-review" },
]) {
  test(`${file}: ${job} job gates bot actors on PR author association (#443)`, () => {
    const jobCondition = reviewJobCondition(file, job);
    assert.match(jobCondition, BOT_GUARD);
    assert.match(jobCondition, DEPENDABOT_EXEMPT);
    assert.match(jobCondition, AUTHOR_ASSOCIATION);
  });
}
