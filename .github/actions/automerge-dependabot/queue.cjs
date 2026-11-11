"use strict";

// The scheduled path: queue each open Dependabot pull request that passes
// gate.cjs's gate and whose head has a green ci-status. A GITHUB_TOKEN arm
// never enters a merge queue, so the arm uses the melodic-release App token
// (`app`); every read uses the job token (`github`), since the App holds no
// checks permission. Out-of-tier pull requests are left alone and noted, and
// disarmed if an earlier head was armed.
// Nothing here throws: one pull request's failure is a warning and the next
// one is still tried, so this job never blocks anything.

const fs = require("node:fs");
const path = require("node:path");
const {
  DEPENDABOT_ID,
  POLICY_PATH,
  gateFailure,
  parseCommitMetadata,
  resolvePolicyInputs,
} = require("./gate.cjs");

// The synced policy in the checked-out default branch: { text }, with text
// undefined when the repository has no copy, or { failure }.
function readWorkspacePolicy(workspace) {
  try {
    return { text: fs.readFileSync(path.join(workspace, POLICY_PATH), "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return { text: undefined };
    return { failure: `${POLICY_PATH} could not be read: ${error.message}` };
  }
}

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
async function queueOne({ github, app, repo, core, pr, inputs, policyFailure, appSlug }) {
  const disarm = () => app.graphql(DISARM, { id: pr.node_id });
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    ...repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const updates = parseCommitMetadata(commits.at(-1)?.commit?.message, pr.head.ref);
  let reason = policyFailure;
  if (!reason) {
    reason =
      updates === null
        ? "its head commit carries no readable Dependabot metadata"
        : await gateFailure({ pr, updates, listCommits: async () => commits, inputs });
  }
  if (reason) {
    core.notice(`#${pr.number} left alone: ${reason}.`);
    // GitHub keeps auto-merge on when a user with write access pushes to
    // the branch, so an arm made on an earlier head that passed the gate
    // would otherwise merge this one.
    if (pr.auto_merge) {
      try {
        await disarm();
        core.notice(`Disarmed the auto-merge armed on an earlier head of #${pr.number}.`);
      } catch (error) {
        core.warning(`Could not disarm #${pr.number}, which fails the gate: ${error.message}`);
        return "failed";
      }
    }
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
    if (pr.auto_merge) await disarm();
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
  const policy = readWorkspacePolicy(env.GITHUB_WORKSPACE);
  const callerInputs = {
    publisherAllowlist: env.PUBLISHER_ALLOWLIST,
    packageAutoMerge: env.PACKAGE_AUTO_MERGE,
    reviewOnly: env.REVIEW_ONLY_DEPENDENCIES,
  };
  const resolved = policy.failure
    ? { failure: policy.failure }
    : resolvePolicyInputs(callerInputs, policy.text, `${repo.owner}/${repo.repo}`);
  const policyFailure = resolved.failure ?? "";
  const inputs = resolved.inputs ?? callerInputs;
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
      counts[
        await queueOne({ github, app, repo, core, pr, inputs, policyFailure, appSlug: env.APP_SLUG })
      ] += 1;
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
