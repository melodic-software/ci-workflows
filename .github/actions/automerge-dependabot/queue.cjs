"use strict";

// The scheduled path: queue each open Dependabot pull request that passes
// gate.cjs's gate and whose head has a green ci-status. A GITHUB_TOKEN arm
// never enters a merge queue, so the arm uses the melodic-release App token
// (`app`); every read uses the job token (`github`), since the App holds no
// checks permission. Out-of-tier pull requests are left alone and noted.
// Nothing here throws: one pull request's failure is a warning and the next
// one is still tried, so this job never blocks anything.

const { DEPENDABOT_ID, gateFailure, parseCommitMetadata } = require(
  "./gate.cjs",
);

const CI_STATUS = "ci-status";
const MISSING_WORKFLOWS = /without `?workflows`? permission/iu;
const ALREADY_MERGEABLE = /is in (clean|unstable) status/iu;

// Without a merge method: the merge queue sets it.
const ARM = `mutation($id: ID!, $head: GitObjectID!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, expectedHeadOid: $head}) {
    clientMutationId
  }
}`;
const ENQUEUE = `mutation($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head}) {
    clientMutationId
  }
}`;
const DISARM = `mutation($id: ID!) {
  disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId }
}`;
const QUEUE_STATE = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { isInMergeQueue }
  }
}`;

// The App's bot login, as REST writes it (`<slug>[bot]`).
const isApp = (login, appSlug) =>
  String(login ?? "").replace(/\[bot\]$/u, "") === appSlug;

async function latestCiStatus(github, repo, sha) {
  const runs = await github.paginate(github.rest.checks.listForRef, {
    ...repo,
    ref: sha,
    check_name: CI_STATUS,
    filter: "latest",
    per_page: 100,
  });
  return runs.reduce((newest, run) => (newest?.id > run.id ? newest : run), null);
}

function warnArmFailure(core, pr, error) {
  if (MISSING_WORKFLOWS.test(error.message)) {
    core.warning(
      `melodic-release lacks workflows: write, so #${pr.number} was not queued: it changes a workflow file. Enable workflows: write on the melodic-release App and accept it on the installation. (${error.message})`,
    );
  } else {
    core.warning(`Could not queue #${pr.number}: ${error.message}`);
  }
}

// Returns what happened to one pull request: queued, skipped or failed.
async function queueOne({ github, app, repo, core, pr, inputs, appSlug }) {
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    ...repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const updates = parseCommitMetadata(commits.at(-1)?.commit?.message, pr.head.ref);
  if (updates === null) {
    core.notice(`#${pr.number} left alone: its head commit carries no readable Dependabot metadata.`);
    return "skipped";
  }
  const reason = await gateFailure({ pr, updates, listCommits: async () => commits, inputs });
  if (reason) {
    core.notice(`#${pr.number} left alone: ${reason}.`);
    return "skipped";
  }
  const ci = await latestCiStatus(github, repo, pr.head.sha);
  if (ci?.status !== "completed" || ci.conclusion !== "success") {
    core.notice(
      `#${pr.number} not queued yet: ${CI_STATUS} on ${pr.head.sha} is ${ci ? (ci.conclusion ?? ci.status) : "missing"}.`,
    );
    return "skipped";
  }
  const state = await github.graphql(QUEUE_STATE, { ...repo, number: pr.number });
  if (state?.repository?.pullRequest?.isInMergeQueue) {
    core.info(`#${pr.number} is already in the merge queue.`);
    return "skipped";
  }
  if (pr.auto_merge && isApp(pr.auto_merge.enabled_by?.login, appSlug)) {
    core.info(`#${pr.number} is already armed by ${appSlug}.`);
    return "skipped";
  }
  try {
    // An arm by another actor (a GITHUB_TOKEN arm never enqueues) is
    // replaced by the App's.
    if (pr.auto_merge) await app.graphql(DISARM, { id: pr.node_id });
    const variables = { id: pr.node_id, head: pr.head.sha };
    try {
      await app.graphql(ARM, variables);
    } catch (error) {
      if (!ALREADY_MERGEABLE.test(error.message)) throw error;
      await app.graphql(ENQUEUE, variables);
    }
  } catch (error) {
    warnArmFailure(core, pr, error);
    return "failed";
  }
  core.info(`Queued #${pr.number} at ${pr.head.sha}.`);
  return "queued";
}

async function runQueue({ github, app, context, core, env }) {
  const repo = context.repo;
  const inputs = {
    publisherAllowlist: env.PUBLISHER_ALLOWLIST,
    packageAutoMerge: env.PACKAGE_AUTO_MERGE,
    reviewOnly: env.REVIEW_ONLY_DEPENDENCIES,
  };
  const counts = { queued: 0, skipped: 0, failed: 0 };
  let pulls;
  try {
    pulls = await github.paginate(github.rest.pulls.list, {
      ...repo,
      state: "open",
      per_page: 100,
    });
  } catch (error) {
    core.warning(`Could not list open pull requests: ${error.message}`);
    return counts;
  }
  for (const pr of pulls.filter((pull) => pull.user?.id === DEPENDABOT_ID)) {
    try {
      counts[await queueOne({ github, app, repo, core, pr, inputs, appSlug: env.APP_SLUG })] += 1;
    } catch (error) {
      core.warning(`Could not check #${pr.number}: ${error.message}`);
      counts.failed += 1;
    }
  }
  core.notice(
    `Dependabot queue: ${counts.queued} queued, ${counts.skipped} skipped, ${counts.failed} failed.`,
  );
  return counts;
}

module.exports = { runQueue };
