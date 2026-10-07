"use strict";

// PR commit identity checks. In both modes the PR lists at least one commit,
// its last listed commit is the checked head, and every commit was committed
// by GitHub with a valid signature. GitHub's signature vouches for the
// committer, so the author fields alone prove nothing.
//
// Sync mode, a second layer behind the content check: every commit was
// authored by the sync App (login and noreply email) and committed by web-flow.
// Dependabot mode, the only way to skip the guard: every commit was authored by
// Dependabot and committed by web-flow, matched by account id as
// pr-automerge-dependabot does.

const SYNC_BOT = "melodic-standards-sync[bot]";
const SYNC_BOT_EMAIL =
  "300666570+melodic-standards-sync[bot]@users.noreply.github.com";
const GITHUB_COMMITTER = "web-flow";
const DEPENDABOT_ID = 49699333;
const WEB_FLOW_ID = 19864447;
// pulls/{n}/commits lists at most 250 commits, so a list that long may be cut.
const COMMIT_LIST_CAP = 250;
const RERUN =
  "Re-run the standards sync to regenerate this PR; do not hand-edit a sync PR.";

function signatureProblems(commit) {
  const verification = commit.commit?.verification ?? {};
  if (verification.verified === true && verification.reason === "valid") {
    return [];
  }
  return [
    `signature verified=${verification.verified === true}, reason ${verification.reason ?? "(none)"}`,
  ];
}

function syncCommitProblems(commit) {
  const author = commit.author?.login ?? "(no GitHub account)";
  const email = commit.commit?.author?.email ?? "(none)";
  const committer = commit.committer?.login ?? "(no GitHub account)";
  const found = [];
  if (author !== SYNC_BOT) found.push(`author ${author}, not ${SYNC_BOT}`);
  if (email !== SYNC_BOT_EMAIL) found.push(`author email ${email}`);
  if (committer !== GITHUB_COMMITTER) {
    found.push(`committer ${committer}, not ${GITHUB_COMMITTER}`);
  }
  found.push(...signatureProblems(commit));
  return found;
}

function dependabotCommitProblems(commit) {
  const author = commit.author?.id ?? "(no GitHub account)";
  const committer = commit.committer?.id ?? "(no GitHub account)";
  const found = [];
  if (author !== DEPENDABOT_ID) {
    found.push(`author id ${author}, not ${DEPENDABOT_ID} (dependabot[bot])`);
  }
  if (committer !== WEB_FLOW_ID) {
    found.push(`committer id ${committer}, not ${WEB_FLOW_ID} (web-flow)`);
  }
  found.push(...signatureProblems(commit));
  return found;
}

function checkCommits(commits, headSha, commitProblems) {
  if (commits.length === 0) return ["the PR lists no commits"];
  const problems = [];
  if (commits.length >= COMMIT_LIST_CAP) {
    problems.push(
      `the PR lists ${commits.length} commits, the API cap, so the list may be incomplete`,
    );
  }
  for (const commit of commits) {
    for (const problem of commitProblems(commit)) {
      problems.push(`commit ${commit.sha}: ${problem}`);
    }
  }
  const head = commits.at(-1);
  if (head.sha !== headSha) {
    problems.push(
      `the last listed commit ${head.sha} is not the checked head ${headSha}`,
    );
  }
  return problems;
}

async function listProblems(
  { github, owner, repo, pullNumber, headSha },
  commitProblems,
) {
  try {
    const commits = await github.paginate(github.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    return checkCommits(commits, headSha, commitProblems);
  } catch (error) {
    return [`could not list the PR's commits: ${error.message}`];
  }
}

module.exports = async function verifySyncCommits(args) {
  const problems = await listProblems(args, syncCommitProblems);
  if (problems.length === 0) return true;
  for (const problem of problems) args.core.error(problem);
  args.core.setFailed(
    `Sync PR commits are not all the sync App's (${problems.length} problem(s) above). ${RERUN}`,
  );
  return false;
};

// A Dependabot-opened PR skips the guard only when every commit is a verified
// Dependabot commit. Anything else, a commit someone pushed to the dependabot/*
// branch or an unreadable commit list, is held to the hand-edit check.
module.exports.dependabotMode = async function dependabotMode(args) {
  const problems = await listProblems(args, dependabotCommitProblems);
  if (problems.length === 0) {
    args.core.info("Every PR commit is a verified Dependabot commit: skip.");
    return "skip";
  }
  for (const problem of problems) args.core.warning(problem);
  args.core.info(
    "Not every PR commit is a verified Dependabot commit: checking for managed-file hand-edits.",
  );
  return "hand-edit";
};
