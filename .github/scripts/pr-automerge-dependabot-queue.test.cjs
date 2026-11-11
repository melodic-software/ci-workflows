"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const actionDir = path.join(__dirname, "..", "actions", "automerge-dependabot");
const { POLICY_PATH, parseCommitMetadata } = require(
  path.join(actionDir, "gate.cjs"),
);
const { runQueue } = require(path.join(actionDir, "queue.cjs"));
const workflowsDir = path.join(__dirname, "..", "workflows");
const queueWorkflow = parseWorkflow(
  fs.readFileSync(
    path.join(workflowsDir, "pr-automerge-dependabot-queue.yml"),
    "utf8",
  ),
);
const reusable = parseWorkflow(
  fs.readFileSync(
    path.join(workflowsDir, "pr-automerge-dependabot.yml"),
    "utf8",
  ),
);

const DEPENDABOT_ID = 49699333;
const WEB_FLOW_ID = 19864447;
const HEAD = "a".repeat(40);

// Commit messages, titles and branches of ci-workflows #989 (one update) and
// #997 (a group), read with `gh api repos/melodic-software/ci-workflows/pulls/<n>`
// and `.../pulls/<n>/commits`.
const SINGLE_MESSAGE = `build: bump actions/setup-dotnet in /.github/actions/dotnet-format

Bumps [actions/setup-dotnet](https://github.com/actions/setup-dotnet) from 6.0.0 to 6.1.0.
- [Release notes](https://github.com/actions/setup-dotnet/releases)
- [Commits](https://github.com/actions/setup-dotnet/compare/a98b56852c35b8e3190ac28c8c2271da59106c68...0f4a354dd5547a28c70b7853dbd95d5b67886e73)

---
updated-dependencies:
- dependency-name: actions/setup-dotnet
  dependency-version: 6.1.0
  dependency-type: direct:production
  update-type: version-update:semver-minor
...

Signed-off-by: dependabot[bot] <support@github.com>`;
const SINGLE_BRANCH =
  "dependabot/github_actions/dot-github/actions/dotnet-format/actions/setup-dotnet-6.1.0";
const SINGLE_TITLE =
  "build: bump actions/setup-dotnet from 6.0.0 to 6.1.0 in /.github/actions/dotnet-format";

const GROUP_MESSAGE = `build: bump the vendor-actions group across 2 directories with 1 update

Bumps the vendor-actions group with 1 update in the /.github/actions/dotnet-build directory: [actions/setup-dotnet](https://github.com/actions/setup-dotnet).
Bumps the vendor-actions group with 1 update in the /.github/actions/dotnet-format directory: [actions/setup-dotnet](https://github.com/actions/setup-dotnet).


Updates \`actions/setup-dotnet\` from 6.0.0 to 6.1.0
- [Release notes](https://github.com/actions/setup-dotnet/releases)

Updates \`actions/setup-dotnet\` from 6.0.0 to 6.1.0
- [Release notes](https://github.com/actions/setup-dotnet/releases)

---
updated-dependencies:
- dependency-name: actions/setup-dotnet
  dependency-version: 6.1.0
  dependency-type: direct:production
  update-type: version-update:semver-minor
  dependency-group: vendor-actions
- dependency-name: actions/setup-dotnet
  dependency-version: 6.1.0
  dependency-type: direct:production
  update-type: version-update:semver-minor
  dependency-group: vendor-actions
...

Signed-off-by: dependabot[bot] <support@github.com>`;
const GROUP_BRANCH =
  "dependabot/github_actions/dot-github/actions/dotnet-build/vendor-actions-90ffc3a31d";
const GROUP_TITLE =
  "build: bump the vendor-actions group across 2 directories with 1 update";
const GROUP_BODY =
  "Updates `actions/setup-dotnet` from 6.0.0 to 6.1.0\nUpdates `actions/setup-dotnet` from 6.0.0 to 6.1.0";

const SETUP_DOTNET = {
  dependencyName: "actions/setup-dotnet",
  updateType: "version-update:semver-minor",
  packageEcosystem: "github_actions",
  prevVersion: "6.0.0",
  newVersion: "6.1.0",
};

// The error an App token without workflows permission gets, as quoted in
// https://github.com/cli/cli/issues/11493.
const MISSING_WORKFLOWS_ERROR =
  "Pull request refusing to allow a GitHub App to create or update workflow `.github/workflows/release.yml` without `workflows` permission (enablePullRequestAutoMerge)";

test("parseCommitMetadata reads a single update's versions from the Bumps line", () => {
  assert.deepEqual(parseCommitMetadata(SINGLE_MESSAGE, SINGLE_BRANCH), [
    SETUP_DOTNET,
  ]);
});

test("parseCommitMetadata reads a group's versions from its Updates lines", () => {
  assert.deepEqual(parseCommitMetadata(GROUP_MESSAGE, GROUP_BRANCH), [
    SETUP_DOTNET,
    SETUP_DOTNET,
  ]);
});

test("parseCommitMetadata takes the ecosystem from the branch name", () => {
  const [update] = parseCommitMetadata(
    SINGLE_MESSAGE,
    "dependabot/npm_and_yarn/lefthook-2.1.0",
  );
  assert.equal(update.packageEcosystem, "npm_and_yarn");
});

test("parseCommitMetadata computes the update type when the metadata has none", () => {
  const [update] = parseCommitMetadata(
    SINGLE_MESSAGE.replace("  update-type: version-update:semver-minor\n", "")
      .replace("from 6.0.0 to 6.1.0.", "from 6.0.0 to 7.0.0.")
      .replace("dependency-version: 6.1.0", "dependency-version: 7.0.0"),
    SINGLE_BRANCH,
  );
  assert.equal(update.updateType, "version-update:semver-major");
});

for (const [label, message, branch] of [
  [
    "no metadata block",
    "build: bump x\n\nBumps x from 1.0.0 to 1.0.1.",
    SINGLE_BRANCH,
  ],
  [
    "a branch outside dependabot/",
    SINGLE_MESSAGE,
    "feature/setup-dotnet-6.1.0",
  ],
  [
    "an unknown line in the block",
    SINGLE_MESSAGE.replace(
      "  update-type:",
      "  nested:\n    key: value\n  update-type:",
    ),
    SINGLE_BRANCH,
  ],
  [
    "an unknown key",
    SINGLE_MESSAGE.replace("  update-type:", "  extra-key: x\n  update-type:"),
    SINGLE_BRANCH,
  ],
  [
    "a repeated key in one entry",
    SINGLE_MESSAGE.replace(
      "  update-type:",
      "  dependency-name: actions/other\n  update-type:",
    ),
    SINGLE_BRANCH,
  ],
  [
    "a block that does not open with updated-dependencies",
    SINGLE_MESSAGE.replace("updated-dependencies:", "other-dependencies:"),
    SINGLE_BRANCH,
  ],
]) {
  test(`parseCommitMetadata returns null for ${label}`, () => {
    assert.equal(parseCommitMetadata(message, branch), null);
  });
}

const dependabotCommit = (message, sha = HEAD) => ({
  sha,
  author: { id: DEPENDABOT_ID },
  committer: { id: WEB_FLOW_ID },
  commit: { message, verification: { verified: true, reason: "valid" } },
});

const dependabotPull = (number, overrides = {}) => ({
  number,
  node_id: `PR_${number}`,
  user: { id: DEPENDABOT_ID },
  title: GROUP_TITLE,
  body: GROUP_BODY,
  head: { sha: HEAD, ref: GROUP_BRANCH },
  auto_merge: null,
  ...overrides,
});

const success = { id: 2, status: "completed", conclusion: "success" };

async function runWithFakes({
  pulls = [dependabotPull(7)],
  commits = {},
  checkRuns = {},
  inQueue = {},
  appErrors = {},
  listError = null,
  // The synced policy in the checked-out workspace; absent unless given.
  policy = undefined,
} = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "queue-workspace-"));
  if (policy !== undefined) {
    const policyFile = path.join(workspace, POLICY_PATH);
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, policy);
  }
  const reads = [];
  const appCalls = [];
  const notices = [];
  const warnings = [];
  const github = {
    rest: {
      pulls: { list: Symbol("list"), listCommits: Symbol("listCommits") },
      checks: { listForRef: Symbol("listForRef") },
    },
    paginate: async (route, params) => {
      reads.push({ route, params });
      if (route === github.rest.pulls.list) {
        if (listError) throw listError;
        assert.equal(params.state, "open");
        return pulls;
      }
      if (route === github.rest.pulls.listCommits)
        return commits[params.pull_number] ?? [dependabotCommit(GROUP_MESSAGE)];
      if (route === github.rest.checks.listForRef) {
        assert.equal(params.check_name, "ci-status");
        assert.equal(params.ref, HEAD);
        return checkRuns[params.ref] ?? [success];
      }
      throw new Error("unexpected read");
    },
    graphql: async (query, variables) => {
      assert.match(query, /isInMergeQueue/u);
      return {
        repository: {
          pullRequest: { isInMergeQueue: inQueue[variables.number] ?? false },
        },
      };
    },
  };
  const app = {
    graphql: async (query, variables) => {
      const mutation =
        /(enablePullRequestAutoMerge|enqueuePullRequest|disablePullRequestAutoMerge)/u.exec(
          query,
        )[1];
      appCalls.push({ mutation, variables, query });
      const error = appErrors[`${variables.id}:${mutation}`];
      if (error) throw new Error(error);
      return {};
    },
  };
  const core = {
    notice: (message) => notices.push(message),
    warning: (message) => warnings.push(message),
    info: () => {},
  };
  const counts = await runQueue({
    github,
    app,
    context: { repo: { owner: "melodic-software", repo: "ci-workflows" } },
    core,
    env: {
      APP_SLUG: "melodic-release",
      GITHUB_WORKSPACE: workspace,
      PUBLISHER_ALLOWLIST: '["actions/*","github/*","anthropics/*"]',
      PACKAGE_AUTO_MERGE: "true",
      REVIEW_ONLY_DEPENDENCIES: "[]",
    },
  });
  fs.rmSync(workspace, { recursive: true, force: true });
  return { counts, reads, appCalls, notices, warnings };
}

test("the workspace's synced policy sets the publishers the queue arms", async () => {
  const { counts, notices } = await runWithFakes({
    policy: JSON.stringify({
      autoMerge: { publishers: { "github/*": { tier: "auto" } } },
    }),
  });
  assert.deepEqual(counts, { queued: 0, skipped: 1, failed: 0 });
  assert.match(
    notices[0],
    /actions\/setup-dotnet is not an allowlisted publisher/u,
  );
});

test("an unreadable synced policy leaves every pull request alone", async () => {
  const { counts, appCalls, notices } = await runWithFakes({
    pulls: [dependabotPull(7), dependabotPull(8)],
    policy: "{",
  });
  assert.deepEqual(counts, { queued: 0, skipped: 2, failed: 0 });
  assert.deepEqual(appCalls, []);
  assert.match(
    notices[0],
    /#7 left alone: .*is not a readable dependabot policy/u,
  );
});

test("an in-tier group with a green ci-status is queued at its head with the App token", async () => {
  const { counts, appCalls, warnings } = await runWithFakes();
  assert.deepEqual(counts, { queued: 1, skipped: 0, failed: 0 });
  assert.deepEqual(warnings, []);
  assert.equal(appCalls.length, 1);
  assert.equal(appCalls[0].mutation, "enablePullRequestAutoMerge");
  assert.deepEqual(appCalls[0].variables, { id: "PR_7", head: HEAD });
  assert.doesNotMatch(
    appCalls[0].query,
    /mergeMethod/u,
    "the queue sets the method",
  );
});

test("a single update whose title names its versions is queued", async () => {
  const { counts } = await runWithFakes({
    pulls: [
      dependabotPull(9, {
        title: SINGLE_TITLE,
        body: "",
        head: { sha: HEAD, ref: SINGLE_BRANCH },
      }),
    ],
    commits: { 9: [dependabotCommit(SINGLE_MESSAGE)] },
  });
  assert.equal(counts.queued, 1);
});

test("only pull requests authored by Dependabot's account id are considered", async () => {
  const { reads, appCalls } = await runWithFakes({
    pulls: [
      dependabotPull(5, { user: { id: 12345, login: "dependabot[bot]" } }),
      dependabotPull(7),
    ],
  });
  const commitReads = reads.filter((read) => read.params.pull_number);
  assert.deepEqual(
    commitReads.map((read) => read.params.pull_number),
    [7],
  );
  assert.deepEqual(
    appCalls.map((call) => call.variables.id),
    ["PR_7"],
  );
});

test("an out-of-tier pull request is left alone and noted", async () => {
  const message = GROUP_MESSAGE.replaceAll(
    "actions/setup-dotnet",
    "docker/login-action",
  );
  const { counts, appCalls, notices } = await runWithFakes({
    pulls: [
      dependabotPull(7, {
        body: GROUP_BODY.replaceAll(
          "actions/setup-dotnet",
          "docker/login-action",
        ),
      }),
    ],
    commits: { 7: [dependabotCommit(message)] },
  });
  assert.deepEqual(counts, { queued: 0, skipped: 1, failed: 0 });
  assert.equal(appCalls.length, 0);
  assert.match(
    notices[0],
    /#7 left alone: docker\/login-action is not an allowlisted publisher/u,
  );
});

test("a pull request whose head commit is not Dependabot's is left alone", async () => {
  const forged = {
    ...dependabotCommit(GROUP_MESSAGE),
    committer: { id: 12345 },
  };
  const { appCalls, notices } = await runWithFakes({
    commits: { 7: [forged] },
  });
  assert.equal(appCalls.length, 0);
  assert.match(notices[0], /is not a verified Dependabot commit/u);
});

test("an armed pull request whose new head fails the gate is disarmed, not armed", async () => {
  const forged = {
    ...dependabotCommit(GROUP_MESSAGE),
    committer: { id: 12345 },
  };
  const { counts, appCalls } = await runWithFakes({
    pulls: [
      dependabotPull(7, {
        auto_merge: { enabled_by: { login: "melodic-release[bot]" } },
      }),
    ],
    commits: { 7: [forged] },
  });
  assert.deepEqual(counts, { queued: 0, skipped: 1, failed: 0 });
  assert.deepEqual(
    appCalls.map((call) => [call.mutation, call.variables.id]),
    [["disablePullRequestAutoMerge", "PR_7"]],
  );
});

test("an armed pull request without readable metadata is disarmed", async () => {
  const { appCalls } = await runWithFakes({
    pulls: [
      dependabotPull(7, {
        auto_merge: { enabled_by: { login: "melodic-release[bot]" } },
      }),
    ],
    commits: { 7: [dependabotCommit("build: bump x")] },
  });
  assert.deepEqual(
    appCalls.map((call) => call.mutation),
    ["disablePullRequestAutoMerge"],
  );
});

test("a failed disarm of a gate-failing pull request warns and counts as failed", async () => {
  const forged = {
    ...dependabotCommit(GROUP_MESSAGE),
    committer: { id: 12345 },
  };
  const { counts, warnings } = await runWithFakes({
    pulls: [
      dependabotPull(7, {
        auto_merge: { enabled_by: { login: "melodic-release[bot]" } },
      }),
    ],
    commits: { 7: [forged] },
    appErrors: { "PR_7:disablePullRequestAutoMerge": "boom" },
  });
  assert.deepEqual(counts, { queued: 0, skipped: 0, failed: 1 });
  assert.match(
    warnings[0],
    /^Could not disarm #7, which fails the gate: boom$/u,
  );
});

test("a head commit without readable metadata is left alone", async () => {
  const { appCalls, notices } = await runWithFakes({
    commits: { 7: [dependabotCommit("build: bump x")] },
  });
  assert.equal(appCalls.length, 0);
  assert.match(notices[0], /no readable Dependabot metadata/u);
});

for (const [label, runs, shown] of [
  [
    "failed",
    [{ id: 2, status: "completed", conclusion: "failure" }],
    "failure",
  ],
  [
    "in progress",
    [{ id: 2, status: "in_progress", conclusion: null }],
    "in_progress",
  ],
  ["missing", [], "missing"],
  [
    "failed after an earlier success",
    [success, { id: 3, status: "completed", conclusion: "failure" }],
    "failure",
  ],
]) {
  test(`a ci-status that is ${label} on the head skips the pull request`, async () => {
    const { counts, appCalls, notices } = await runWithFakes({
      checkRuns: { [HEAD]: runs },
    });
    assert.deepEqual(counts, { queued: 0, skipped: 1, failed: 0 });
    assert.equal(appCalls.length, 0);
    assert.match(
      notices[0],
      new RegExp(`#7 not queued yet: ci-status on ${HEAD} is ${shown}`, "u"),
    );
  });
}

test("a pull request already in the merge queue is skipped", async () => {
  const { counts, appCalls } = await runWithFakes({ inQueue: { 7: true } });
  assert.equal(counts.skipped, 1);
  assert.equal(appCalls.length, 0);
});

test("a pull request the App already armed is skipped", async () => {
  const { appCalls } = await runWithFakes({
    pulls: [
      dependabotPull(7, {
        auto_merge: { enabled_by: { login: "melodic-release[bot]" } },
      }),
    ],
  });
  assert.equal(appCalls.length, 0);
});

test("a GITHUB_TOKEN arm is replaced by the App's", async () => {
  const { counts, appCalls } = await runWithFakes({
    pulls: [
      dependabotPull(7, {
        auto_merge: { enabled_by: { login: "github-actions[bot]" } },
      }),
    ],
  });
  assert.equal(counts.queued, 1);
  assert.deepEqual(
    appCalls.map((call) => call.mutation),
    ["disablePullRequestAutoMerge", "enablePullRequestAutoMerge"],
  );
});

test("an already-mergeable pull request is enqueued directly", async () => {
  const { counts, appCalls } = await runWithFakes({
    appErrors: {
      "PR_7:enablePullRequestAutoMerge": "Pull request is in clean status",
    },
  });
  assert.equal(counts.queued, 1);
  assert.deepEqual(
    appCalls.map((call) => call.mutation),
    ["enablePullRequestAutoMerge", "enqueuePullRequest"],
  );
  assert.deepEqual(appCalls[1].variables, { id: "PR_7", head: HEAD });
});

test("a refusal for missing workflows permission warns and the next pull request is still queued", async () => {
  const { counts, warnings, appCalls } = await runWithFakes({
    pulls: [dependabotPull(7), dependabotPull(8)],
    appErrors: { "PR_7:enablePullRequestAutoMerge": MISSING_WORKFLOWS_ERROR },
  });
  assert.deepEqual(counts, { queued: 1, skipped: 0, failed: 1 });
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /^melodic-release lacks workflows: write, so #7 was not queued/u,
  );
  assert.deepEqual(
    appCalls.map((call) => call.variables.id),
    ["PR_7", "PR_8"],
  );
});

test("any other arm failure warns without the permission message", async () => {
  const { counts, warnings } = await runWithFakes({
    appErrors: { "PR_7:enablePullRequestAutoMerge": "Head sha did not match" },
  });
  assert.equal(counts.failed, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Could not queue #7: Head sha did not match$/u);
});

test("a failed listing warns and does not throw", async () => {
  const { counts, warnings } = await runWithFakes({
    listError: new Error("boom"),
  });
  assert.deepEqual(counts, { queued: 0, skipped: 0, failed: 0 });
  assert.match(warnings[0], /Could not list open pull requests: boom/u);
});

const job = queueWorkflow.jobs["automerge-dependabot-prs"];
const step = (name) => job.steps.find((candidate) => candidate.name === name);

test("the queue runs on a schedule and on dispatch, on main only", () => {
  assert.deepEqual(Object.keys(queueWorkflow.on).sort(), [
    "schedule",
    "workflow_dispatch",
  ]);
  assert.equal(job.if, `\${{ github.ref == 'refs/heads/main' }}`);
  assert.equal(queueWorkflow.concurrency["cancel-in-progress"], false);
});

test("the job token holds only the reads the queue makes", () => {
  assert.deepEqual(queueWorkflow.permissions, {});
  assert.deepEqual(job.permissions, {
    contents: "read",
    "pull-requests": "read",
    checks: "read",
  });
});

test("the App token is minted as release-tag.yml mints it, with workflows write", () => {
  assert.equal(job.environment.name, "plugin-release");
  const mint = step("Mint the release App token");
  assert.equal(mint["continue-on-error"], true);
  assert.equal(
    mint.with["client-id"],
    `\${{ vars.PLUGIN_RELEASE_APP_CLIENT_ID }}`,
  );
  assert.equal(
    mint.with["private-key"],
    `\${{ secrets.PLUGIN_RELEASE_APP_PRIVATE_KEY }}`,
  );
  assert.equal(mint.with["permission-contents"], "write");
  assert.equal(mint.with["permission-pull-requests"], "write");
  assert.equal(mint.with["permission-workflows"], "write");
  const release = parseWorkflow(
    fs.readFileSync(path.join(workflowsDir, "release-tag.yml"), "utf8"),
  ).jobs.tag;
  assert.equal(release.environment, job.environment.name);
  const releaseMint = release.steps.find(
    (candidate) => candidate.uses === mint.uses,
  );
  assert.ok(releaseMint, "both mint with the same pinned action");
  assert.equal(releaseMint.with["client-id"], mint.with["client-id"]);
  assert.equal(releaseMint.with["private-key"], mint.with["private-key"]);
});

test("a failed mint warns and the queue step never fails the job", () => {
  assert.equal(
    step("Warn that no token was minted").if,
    `\${{ steps.app-token.outcome != 'success' }}`,
  );
  assert.match(
    step("Warn that no token was minted").run,
    /::warning::.*melodic-release lacks workflows: write/u,
  );
  const queue = step("Queue in-tier Dependabot pull requests");
  assert.equal(queue["continue-on-error"], true);
  assert.equal(queue.if, `\${{ steps.app-token.outcome == 'success' }}`);
});

test("the queue's tier inputs are the reusable's defaults", () => {
  const env = step("Queue in-tier Dependabot pull requests").env;
  const inputs = reusable.on.workflow_call.inputs;
  assert.equal(env.PUBLISHER_ALLOWLIST, inputs["publisher-allowlist"].default);
  assert.equal(
    env.PACKAGE_AUTO_MERGE,
    String(inputs["package-auto-merge"].default),
  );
  assert.equal(
    env.REVIEW_ONLY_DEPENDENCIES,
    inputs["review-only-dependencies"].default,
  );
});

test("both tokens' API calls are logged", () => {
  const queue = step("Queue in-tier Dependabot pull requests");
  assert.match(queue.with.script, /budget\.watch\(github, "github-token"\)/u);
  assert.match(queue.with.script, /budget\.watch\(app, "release-app-token"\)/u);
  const log = step("Log the API budget");
  assert.equal(log.uses, "$/.github/actions/report-api-budget");
  assert.deepEqual(log.with.tokens.split(" "), [
    "github-token",
    "release-app-token",
  ]);
});
