"use strict";

// Sync-mode commit checks, a second layer behind the content check: the PR
// lists at least one commit, its last listed commit is the checked head, and
// every commit was authored by the sync App and committed by GitHub with a
// valid signature. GitHub's signature vouches for the committer, so the
// author fields alone prove nothing; all five fields must match.

const SYNC_BOT = "melodic-standards-sync[bot]";
const SYNC_BOT_EMAIL =
  "300666570+melodic-standards-sync[bot]@users.noreply.github.com";
const GITHUB_COMMITTER = "web-flow";
// pulls/{n}/commits lists at most 250 commits, so a list that long may be cut.
const COMMIT_LIST_CAP = 250;
const RERUN =
  "Re-run the standards sync to regenerate this PR; do not hand-edit a sync PR.";

function commitProblems(commit) {
  const author = commit.author?.login ?? "(no GitHub account)";
  const email = commit.commit?.author?.email ?? "(none)";
  const committer = commit.committer?.login ?? "(no GitHub account)";
  const verification = commit.commit?.verification ?? {};
  const found = [];
  if (author !== SYNC_BOT) found.push(`author ${author}, not ${SYNC_BOT}`);
  if (email !== SYNC_BOT_EMAIL) found.push(`author email ${email}`);
  if (committer !== GITHUB_COMMITTER) {
    found.push(`committer ${committer}, not ${GITHUB_COMMITTER}`);
  }
  if (verification.verified !== true || verification.reason !== "valid") {
    found.push(
      `signature verified=${verification.verified === true}, reason ${verification.reason ?? "(none)"}`,
    );
  }
  return found.map((problem) => `commit ${commit.sha}: ${problem}`);
}

function checkCommits(commits, headSha) {
  if (commits.length === 0) return ["the PR lists no commits"];
  const problems = [];
  if (commits.length >= COMMIT_LIST_CAP) {
    problems.push(
      `the PR lists ${commits.length} commits, the API cap, so the list may be incomplete`,
    );
  }
  for (const commit of commits) problems.push(...commitProblems(commit));
  const head = commits.at(-1);
  if (head.sha !== headSha) {
    problems.push(
      `the last listed commit ${head.sha} is not the checked head ${headSha}`,
    );
  }
  return problems;
}

module.exports = async function verifySyncCommits({
  github,
  core,
  owner,
  repo,
  pullNumber,
  headSha,
}) {
  let problems;
  try {
    const commits = await github.paginate(github.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    problems = checkCommits(commits, headSha);
  } catch (error) {
    problems = [`could not list the PR's commits: ${error.message}`];
  }
  if (problems.length === 0) return true;
  for (const problem of problems) core.error(problem);
  core.setFailed(
    `Sync PR commits are not all the sync App's (${problems.length} problem(s) above). ${RERUN}`,
  );
  return false;
};
