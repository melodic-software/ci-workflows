"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const workflowPath = path.join(
  __dirname,
  "..",
  "workflows",
  "pr-automerge-dependabot.yml",
);
const workflowLines = fs.readFileSync(workflowPath, "utf8").split(/\r?\n/u);
const gateStepIndex = workflowLines.findIndex((line) =>
  line.includes("- name: Gate and arm auto-merge"),
);

// Same inline-script extraction standards-sync-automerge-arm.test.cjs uses:
// the reusable runs in the caller's repository with no checkout, so the gate
// lives in the github-script body and the test runs that body directly.
function extractGateScript() {
  assert.notEqual(gateStepIndex, -1, "gate step must exist");
  const scriptIndex = workflowLines.findIndex(
    (line, index) => index > gateStepIndex && /^ {10}script: \|$/u.test(line),
  );
  assert.notEqual(scriptIndex, -1, "gate script block must exist");
  const body = [];
  for (let index = scriptIndex + 1; index < workflowLines.length; index += 1) {
    const line = workflowLines[index];
    if (line.length > 0 && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return body.join("\n");
}

function stepEnv(name) {
  const line = workflowLines
    .slice(gateStepIndex)
    .find((candidate) => candidate.trim().startsWith(`${name}:`));
  assert.ok(line, `${name} must be set on the gate step`);
  return line.trim().slice(name.length + 1).trim().replace(/^'(.*)'$/u, "$1");
}

const gateScript = extractGateScript();
const DEPENDABOT_ID = 49699333;
const HEAD = "a".repeat(40);

const dependabotCommit = (sha = HEAD) => ({
  sha,
  author: { id: DEPENDABOT_ID },
  commit: { verification: { verified: true } },
});

const update = (dependencyName, updateType, packageEcosystem = "github_actions") => ({
  dependencyName,
  updateType,
  packageEcosystem,
});

async function runGate({
  updates = [update("actions/checkout", "version-update:semver-patch")],
  authorId = DEPENDABOT_ID,
  commits = [dependabotCommit()],
  autoMerge = null,
} = {}) {
  const graphqlCalls = [];
  const notices = [];
  const original = { ...process.env };
  process.env.UPDATED_DEPENDENCIES_JSON = JSON.stringify(updates);
  process.env.PUBLISHER_ALLOWLIST = stepEnv("PUBLISHER_ALLOWLIST");
  try {
    const github = {
      rest: { pulls: { listCommits: Symbol("listCommits") } },
      paginate: async (route, params) => {
        assert.equal(route, github.rest.pulls.listCommits);
        assert.equal(params.pull_number, 7);
        return commits;
      },
      graphql: async (query, variables) => {
        graphqlCalls.push({ query, variables });
        return {};
      },
    };
    const context = {
      repo: { owner: "melodic-software", repo: "medley" },
      payload: {
        pull_request: {
          number: 7,
          node_id: "PR_node",
          user: { id: authorId },
          head: { sha: HEAD },
          auto_merge: autoMerge,
        },
      },
    };
    const core = {
      notice: (message) => notices.push(message),
      info: () => {},
    };
    await new AsyncFunction("github", "context", "core", gateScript)(
      github,
      context,
      core,
    );
  } finally {
    for (const key of ["UPDATED_DEPENDENCIES_JSON", "PUBLISHER_ALLOWLIST"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
  const armCalls = graphqlCalls.filter((call) => /enablePullRequestAutoMerge/u.test(call.query));
  const disarmCalls = graphqlCalls.filter((call) => /disablePullRequestAutoMerge/u.test(call.query));
  return { armCalls, disarmCalls, notices };
}

function assertSkipped(result, reason) {
  assert.equal(result.armCalls.length, 0);
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0], reason);
}

test("the allowlist matches standards dependabot-policy autoMerge.publisherAllowlist", () => {
  assert.deepEqual(JSON.parse((stepEnv("PUBLISHER_ALLOWLIST"))), [
    "actions/*",
    "github/*",
    "anthropics/*",
  ]);
});

test("the job runs only on pull_request events authored by Dependabot's account id", () => {
  const job = workflowLines.findIndex((line) => line === "  enable-auto-merge:");
  const ifLine = workflowLines.slice(job, job + 4).find((line) => line.trim().startsWith("if:"));
  assert.match(ifLine, /github\.event_name == 'pull_request'/u);
  assert.match(ifLine, /github\.event\.pull_request\.user\.id == 49699333/u);
});

test("PR-derived values reach the script through env, never an expression", () => {
  assert.doesNotMatch(gateScript, /\$\{\{/u);
});

test("a vendor patch is armed for squash at the verified head", async () => {
  const { armCalls, notices } = await runGate();
  assert.equal(notices.length, 0);
  assert.equal(armCalls.length, 1);
  assert.match(armCalls[0].query, /mergeMethod: SQUASH/u);
  assert.match(armCalls[0].query, /expectedHeadOid: \$head/u);
  assert.deepEqual(armCalls[0].variables, { id: "PR_node", head: HEAD });
});

test("a grouped vendor minor across every publisher is armed", async () => {
  const { armCalls } = await runGate({
    updates: [
      update("actions/setup-node", "version-update:semver-minor"),
      update("github/codeql-action", "version-update:semver-patch"),
      update("anthropics/claude-code-action", "version-update:semver-minor"),
    ],
  });
  assert.equal(armCalls.length, 1);
});

test("a vendor major is skipped", async () => {
  assertSkipped(
    await runGate({ updates: [update("actions/checkout", "version-update:semver-major")] }),
    /actions\/checkout is not a patch or minor update/u,
  );
});

test("a vendor update with no computable update type is skipped", async () => {
  assertSkipped(
    await runGate({ updates: [update("actions/checkout", undefined)] }),
    /not a patch or minor update/u,
  );
});

test("a community patch is skipped", async () => {
  assertSkipped(
    await runGate({ updates: [update("docker/login-action", "version-update:semver-patch")] }),
    /docker\/login-action is not an allowlisted publisher/u,
  );
});

test("a publisher whose name only contains an allowlisted owner is skipped", async () => {
  assertSkipped(
    await runGate({ updates: [update("evil-actions/checkout", "version-update:semver-patch")] }),
    /evil-actions\/checkout is not an allowlisted publisher/u,
  );
});

test("a mixed vendor and community group is skipped", async () => {
  assertSkipped(
    await runGate({
      updates: [
        update("actions/checkout", "version-update:semver-patch"),
        update("docker/build-push-action", "version-update:semver-patch"),
      ],
    }),
    /docker\/build-push-action is not an allowlisted publisher/u,
  );
});

test("a vendor group with one major bump is skipped", async () => {
  assertSkipped(
    await runGate({
      updates: [
        update("actions/checkout", "version-update:semver-patch"),
        update("actions/upload-artifact", "version-update:semver-major"),
      ],
    }),
    /actions\/upload-artifact is not a patch or minor update/u,
  );
});

test("a non-Dependabot author is skipped", async () => {
  assertSkipped(await runGate({ authorId: 12345 }), /the PR author is not Dependabot/u);
});

test("a foreign head commit is skipped", async () => {
  const foreign = { sha: HEAD, author: { id: 12345 }, commit: { verification: { verified: true } } };
  assertSkipped(
    await runGate({ commits: [dependabotCommit("b".repeat(40)), foreign] }),
    new RegExp(`commit ${HEAD} is not a verified Dependabot commit`, "u"),
  );
});

test("an unsigned commit claiming Dependabot authorship is skipped", async () => {
  const unsigned = { ...dependabotCommit(), commit: { verification: { verified: false } } };
  assertSkipped(await runGate({ commits: [unsigned] }), /is not a verified Dependabot commit/u);
});

test("a head that moved after the event is skipped", async () => {
  assertSkipped(
    await runGate({ commits: [dependabotCommit("c".repeat(40))] }),
    /the PR head moved after this event/u,
  );
});

test("a non-actions ecosystem is skipped", async () => {
  assertSkipped(
    await runGate({ updates: [update("actions/checkout", "version-update:semver-patch", "npm_and_yarn")] }),
    /actions\/checkout is not a GitHub Actions update/u,
  );
});

test("a skipped PR armed on an earlier head is disarmed", async () => {
  const foreign = { sha: HEAD, author: { id: 12345 }, commit: { verification: { verified: true } } };
  const result = await runGate({
    commits: [foreign],
    autoMerge: { merge_method: "squash" },
  });
  assert.equal(result.armCalls.length, 0);
  assert.equal(result.disarmCalls.length, 1);
  assert.deepEqual(result.disarmCalls[0].variables, { id: "PR_node" });
});

test("a skipped PR that was never armed makes no disarm call", async () => {
  const result = await runGate({ authorId: 12345 });
  assert.equal(result.disarmCalls.length, 0);
});
