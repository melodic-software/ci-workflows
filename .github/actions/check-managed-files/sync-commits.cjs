"use strict";

// Sync-mode commit checks: every PR commit is the sync App's and verified, and
// the head subject names a standards SHA reachable from standards main. Sets
// the `sha` output only when every check passes.

const SYNC_BOT = "melodic-standards-sync[bot]";
const SYNC_SUBJECT = /^chore: sync standards components \(([0-9a-f]{40})\)$/u;
// pulls/{n}/commits lists at most 250 commits, so a list that long may be cut.
const COMMIT_LIST_CAP = 250;
const RERUN =
  "Re-run the standards sync to regenerate this PR; do not hand-edit a sync PR.";

async function reachableFromMain(github, sha) {
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    owner: "melodic-software",
    repo: "standards",
    basehead: `${sha}...main`,
  });
  return (
    (data.status === "ahead" || data.status === "identical") &&
    data.merge_base_commit?.sha === sha
  );
}

function checkCommits(commits, headSha, problems) {
  if (commits.length === 0) problems.push("the PR lists no commits");
  if (commits.length >= COMMIT_LIST_CAP) {
    problems.push(
      `the PR lists ${commits.length} commits, the API cap, so the list may be incomplete`,
    );
  }
  for (const commit of commits) {
    const login = commit.author?.login ?? "(no GitHub account)";
    const verified = commit.commit?.verification?.verified === true;
    if (login !== SYNC_BOT || !verified) {
      problems.push(
        `commit ${commit.sha}: author ${login}, signature ${verified ? "verified" : "unverified"}`,
      );
    }
  }
  const head = commits.at(-1);
  if (!head) return "";
  if (head.sha !== headSha) {
    problems.push(
      `the last listed commit ${head.sha} is not the checked head ${headSha}`,
    );
  }
  const subject = (head.commit?.message ?? "").split("\n")[0];
  const match = SYNC_SUBJECT.exec(subject);
  if (match) return match[1];
  problems.push(
    `head commit ${head.sha} subject names no 40-hex standards SHA: ${JSON.stringify(subject)}`,
  );
  return "";
}

module.exports = async function verifySyncCommits({
  github,
  core,
  owner,
  repo,
  pullNumber,
  headSha,
}) {
  const problems = [];
  let sha = "";
  try {
    const commits = await github.paginate(github.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    sha = checkCommits(commits, headSha, problems);
  } catch (error) {
    problems.push(`could not list the PR's commits: ${error.message}`);
  }
  if (sha) {
    try {
      if (!(await reachableFromMain(github, sha))) {
        problems.push(`standards@${sha} is not reachable from standards main`);
      }
    } catch (error) {
      problems.push(
        `could not compare standards@${sha} with standards main: ${error.message}`,
      );
    }
  }
  if (problems.length > 0) {
    const source = sha ? `standards@${sha}` : "any standards SHA";
    for (const problem of problems) core.error(problem);
    core.setFailed(
      `Sync PR does not verify against ${source} (${problems.length} problem(s) above). ${RERUN}`,
    );
    return "";
  }
  core.setOutput("sha", sha);
  return sha;
};
