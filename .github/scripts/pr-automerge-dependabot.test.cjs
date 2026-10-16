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
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflowLines = workflowText.split(/\r?\n/u);
const stepIndex = (name) =>
  workflowLines.findIndex((line) => line.includes(`- name: ${name}`));
const gateStepIndex = stepIndex("Gate auto-merge");
const armStepIndex = stepIndex("Arm or disarm auto-merge");

// Same inline-script extraction standards-sync-automerge-arm.test.cjs uses:
// the reusable runs in the caller's repository with no checkout, so the gate
// and the arm live in github-script bodies and the test runs them directly.
function extractScript(startIndex) {
  assert.notEqual(startIndex, -1, "step must exist");
  const scriptIndex = workflowLines.findIndex(
    (line, index) => index > startIndex && /^ {10}script: \|$/u.test(line),
  );
  assert.notEqual(scriptIndex, -1, "script block must exist");
  const body = [];
  for (let index = scriptIndex + 1; index < workflowLines.length; index += 1) {
    const line = workflowLines[index];
    if (line.length > 0 && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return body.join("\n");
}

function stepEnv(name, startIndex = gateStepIndex) {
  const line = workflowLines
    .slice(startIndex)
    .find((candidate) => candidate.trim().startsWith(`${name}:`));
  assert.ok(line, `${name} must be set on the step`);
  return line
    .trim()
    .slice(name.length + 1)
    .trim()
    .replace(/^'(.*)'$/u, "$1");
}

// The text of one top-level job, from its key to the next job key.
function jobBlock(name) {
  const start = workflowLines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `job ${name} must exist`);
  const end = workflowLines.findIndex(
    (line, index) => index > start && /^ {2}\S[^:]*:$/u.test(line),
  );
  return workflowLines.slice(start, end === -1 ? undefined : end).join("\n");
}

const gateScript = extractScript(gateStepIndex);
const armScript = extractScript(armStepIndex);
const DEPENDABOT_ID = 49699333;
const HEAD = "a".repeat(40);

// The shape of a real Dependabot commit, read live from
// `gh api repos/melodic-software/medley/pulls/2094/commits` and
// ci-workflows PRs #651, #655 and #674: author dependabot[bot] (49699333),
// committer web-flow (19864447), verified with reason "valid".
const WEB_FLOW_ID = 19864447;
const dependabotCommit = (sha = HEAD) => ({
  sha,
  author: { id: DEPENDABOT_ID },
  committer: { id: WEB_FLOW_ID },
  commit: { verification: { verified: true, reason: "valid" } },
});
const foreignHead = { ...dependabotCommit(), author: { id: 12345 } };

const update = (
  dependencyName,
  updateType,
  packageEcosystem = "github_actions",
) => ({
  dependencyName,
  updateType,
  packageEcosystem,
});

async function runGate({
  updates = [update("actions/checkout", "version-update:semver-patch")],
  authorId = DEPENDABOT_ID,
  commits = [dependabotCommit()],
  autoMerge = null,
  senderId = DEPENDABOT_ID,
  metadataOutcome = "success",
  metadataJson = JSON.stringify(updates),
} = {}) {
  const graphqlCalls = [];
  const notices = [];
  const outputs = {};
  const env = {
    UPDATED_DEPENDENCIES_JSON: metadataJson,
    PUBLISHER_ALLOWLIST: stepEnv("PUBLISHER_ALLOWLIST"),
    SENDER_ID: String(senderId),
    METADATA_OUTCOME: metadataOutcome,
  };
  const original = { ...process.env };
  const restore = (keys) => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  };
  Object.assign(process.env, env);
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
      setOutput: (name, value) => {
        outputs[name] = value;
      },
    };
    await new AsyncFunction("github", "context", "core", gateScript)(
      github,
      context,
      core,
    );
    restore(Object.keys(env));
    // The arm job's `if:` runs it only for arm or disarm.
    if (["arm", "disarm"].includes(outputs.decision)) {
      const armEnv = {
        DECISION: outputs.decision,
        HEAD_SHA: outputs["head-sha"],
      };
      Object.assign(process.env, armEnv);
      env.DECISION = armEnv.DECISION;
      env.HEAD_SHA = armEnv.HEAD_SHA;
      await new AsyncFunction("github", "context", "core", armScript)(
        github,
        context,
        core,
      );
    }
  } finally {
    restore(Object.keys(env));
  }
  const armCalls = graphqlCalls.filter((call) =>
    /enablePullRequestAutoMerge/u.test(call.query),
  );
  const disarmCalls = graphqlCalls.filter((call) =>
    /disablePullRequestAutoMerge/u.test(call.query),
  );
  return { armCalls, disarmCalls, notices, outputs };
}

function assertSkipped(result, reason) {
  assert.equal(result.armCalls.length, 0);
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0], reason);
}

test("the allowlist matches standards dependabot-policy autoMerge.publisherAllowlist", () => {
  assert.deepEqual(JSON.parse(stepEnv("PUBLISHER_ALLOWLIST")), [
    "actions/*",
    "github/*",
    "anthropics/*",
  ]);
});

test("the job runs only on pull_request events authored by Dependabot's account id", () => {
  const job = workflowLines.indexOf("  gate:");
  const ifLine = workflowLines
    .slice(job, job + 4)
    .find((line) => line.trim().startsWith("if:"));
  assert.match(ifLine, /github\.event_name == 'pull_request'/u);
  assert.match(ifLine, /github\.event\.pull_request\.user\.id == 49699333/u);
});

test("the sender and metadata outcome come from the event and the metadata step", () => {
  assert.equal(stepEnv("SENDER_ID"), `\${{ github.event.sender.id }}`);
  assert.equal(stepEnv("METADATA_OUTCOME"), `\${{ steps.metadata.outcome }}`);
});

test("PR-derived values reach the scripts through env, never an expression", () => {
  assert.doesNotMatch(gateScript, /\$\{\{/u);
  assert.doesNotMatch(armScript, /\$\{\{/u);
});

test("the workflow holds exactly one PUBLISHER_ALLOWLIST, the standards lockstep anchor", () => {
  // standards components/dependabot-policy/automerge-lockstep.mjs fails
  // unless exactly one step env across all jobs sets PUBLISHER_ALLOWLIST.
  assert.equal(workflowText.match(/^ +PUBLISHER_ALLOWLIST:/gmu)?.length, 1);
});

test("the gate job reads with pull-requests read and never sees the App secrets", () => {
  const gate = jobBlock("gate");
  assert.match(
    gate,
    /^ {4}permissions:\n {6}pull-requests: read\b[^\n]*\n {4}outputs:/mu,
  );
  assert.doesNotMatch(gate, /secrets\./u);
  assert.doesNotMatch(gate, /actions\/checkout/u);
  assert.match(gate, /decision: \$\{\{ steps\.gate\.outputs\.decision \}\}/u);
  assert.match(gate, /head-sha: \$\{\{ steps\.gate\.outputs\.head-sha \}\}/u);
});

test("the arm job runs only for arm or disarm, after the gate", () => {
  const arm = jobBlock("arm");
  assert.match(arm, /^ {4}needs: gate$/mu);
  assert.match(
    arm,
    /^ {4}if: \$\{\{ needs\.gate\.outputs\.decision == 'arm' \|\| needs\.gate\.outputs\.decision == 'disarm' \}\}$/mu,
  );
  assert.doesNotMatch(arm, /actions\/checkout/u);
});

test("the App token is minted only when both App secrets are set, scoped to this repository", () => {
  const arm = jobBlock("arm");
  assert.match(
    arm,
    /HAS_AUTOMERGE_APP: \$\{\{ secrets\.AUTOMERGE_APP_CLIENT_ID != '' && secrets\.AUTOMERGE_APP_PRIVATE_KEY != '' \}\}/u,
  );
  assert.match(arm, /if: \$\{\{ env\.HAS_AUTOMERGE_APP == 'true' \}\}/u);
  assert.match(
    arm,
    /repositories: \$\{\{ github\.event\.repository\.name \}\}/u,
  );
  assert.match(arm, /permission-contents: write/u);
  assert.match(arm, /permission-pull-requests: write/u);
  assert.match(
    arm,
    /github-token: \$\{\{ steps\.app\.outputs\.token \|\| github\.token \}\}/u,
  );
  // Same pin as the repository's other App-token mint.
  const pin = /actions\/create-github-app-token@([0-9a-f]{40}) # (v\S+)/u;
  const other = fs.readFileSync(
    path.join(__dirname, "..", "workflows", "maintenance-sync-standards.yml"),
    "utf8",
  );
  assert.deepEqual(pin.exec(arm)?.slice(1), pin.exec(other)?.slice(1));
});

test("the arm and disarm read the decision and head from the gate outputs", () => {
  assert.equal(
    stepEnv("DECISION", armStepIndex),
    `\${{ needs.gate.outputs.decision }}`,
  );
  assert.equal(
    stepEnv("HEAD_SHA", armStepIndex),
    `\${{ needs.gate.outputs.head-sha }}`,
  );
});

test("a passing gate outputs arm and the verified head", async () => {
  const { outputs } = await runGate();
  assert.deepEqual(outputs, { decision: "arm", "head-sha": HEAD });
});

test("a failing gate on an unarmed PR outputs none", async () => {
  const { outputs } = await runGate({ authorId: 12345 });
  assert.equal(outputs.decision, "none");
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
    await runGate({
      updates: [update("actions/checkout", "version-update:semver-major")],
    }),
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
    await runGate({
      updates: [update("docker/login-action", "version-update:semver-patch")],
    }),
    /docker\/login-action is not an allowlisted publisher/u,
  );
});

test("a publisher whose name only contains an allowlisted owner is skipped", async () => {
  assertSkipped(
    await runGate({
      updates: [update("evil-actions/checkout", "version-update:semver-patch")],
    }),
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
  assertSkipped(
    await runGate({ authorId: 12345 }),
    /the PR author is not Dependabot/u,
  );
});

test("an event sent by anyone but Dependabot is skipped", async () => {
  assertSkipped(
    await runGate({ senderId: 12345 }),
    /this event was not sent by Dependabot/u,
  );
});

test("a foreign head commit is skipped", async () => {
  assertSkipped(
    await runGate({ commits: [dependabotCommit("b".repeat(40)), foreignHead] }),
    new RegExp(`commit ${HEAD} is not a verified Dependabot commit`, "u"),
  );
});

test("a forged Dependabot author with the pusher's own signature is skipped", async () => {
  const forged = { ...dependabotCommit(), committer: { id: 12345 } };
  assertSkipped(
    await runGate({ commits: [forged] }),
    /is not a verified Dependabot commit/u,
  );
});

test("an unsigned commit claiming Dependabot authorship is skipped", async () => {
  const unsigned = {
    ...dependabotCommit(),
    commit: { verification: { verified: false, reason: "unsigned" } },
  };
  assertSkipped(
    await runGate({ commits: [unsigned] }),
    /is not a verified Dependabot commit/u,
  );
});

test("a verified commit whose reason is not valid is skipped", async () => {
  const odd = {
    ...dependabotCommit(),
    commit: { verification: { verified: true, reason: "unknown_key" } },
  };
  assertSkipped(
    await runGate({ commits: [odd] }),
    /is not a verified Dependabot commit/u,
  );
});

test("a publisher spelled in another case stays rejected", async () => {
  assertSkipped(
    await runGate({
      updates: [update("Actions/checkout", "version-update:semver-patch")],
    }),
    /Actions\/checkout is not an allowlisted publisher/u,
  );
});

test("empty metadata is skipped", async () => {
  assertSkipped(
    await runGate({ metadataJson: "" }),
    /the Dependabot metadata is not valid JSON/u,
  );
});

test("invalid metadata is skipped", async () => {
  assertSkipped(
    await runGate({ metadataJson: "{not json" }),
    /the Dependabot metadata is not valid JSON/u,
  );
});

test("a failed metadata fetch on an armed PR is skipped and disarmed", async () => {
  const result = await runGate({
    metadataOutcome: "failure",
    metadataJson: "",
    autoMerge: { merge_method: "squash" },
  });
  assert.equal(result.armCalls.length, 0);
  assert.match(result.notices[0], /fetching the Dependabot metadata failed/u);
  assert.equal(result.disarmCalls.length, 1);
});

test("the gate step runs after a failed metadata fetch", () => {
  const metadata = workflowLines.findIndex((line) =>
    line.includes("- name: Fetch Dependabot metadata"),
  );
  assert.ok(
    workflowLines
      .slice(metadata, gateStepIndex)
      .some((line) => line.trim() === "continue-on-error: true"),
  );
  assert.equal(
    workflowLines[gateStepIndex + 2].trim(),
    `if: \${{ !cancelled() }}`,
  );
});

test("a head that moved after the event is skipped", async () => {
  assertSkipped(
    await runGate({ commits: [dependabotCommit("c".repeat(40))] }),
    /the PR head moved after this event/u,
  );
});

test("a non-actions ecosystem is skipped", async () => {
  assertSkipped(
    await runGate({
      updates: [
        update(
          "actions/checkout",
          "version-update:semver-patch",
          "npm_and_yarn",
        ),
      ],
    }),
    /actions\/checkout is not a GitHub Actions update/u,
  );
});

test("a skipped PR armed on an earlier head is disarmed", async () => {
  const result = await runGate({
    commits: [foreignHead],
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
