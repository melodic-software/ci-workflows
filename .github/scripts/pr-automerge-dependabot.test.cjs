"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const actionDir = path.join(__dirname, "..", "actions", "automerge-dependabot");
const {
  DEFAULT_PUBLISHER_ALLOWLIST,
  SOURCE_CONTROL_PATH,
  gateFailure,
  resolvePolicyInputs,
  runEvent,
} = require(path.join(actionDir, "gate.cjs"));
// Where the standards sync used to place the policy; no reader takes it now.
const SYNCED_COPY_PATH = ".github/standards/dependabot-policy/policy.json";
const NAMES_STANDARDS = "standards_repository: melodic-software/standards\n";
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
const actionLines = fs
  .readFileSync(path.join(actionDir, "action.yml"), "utf8")
  .split(/\r?\n/u);

// The value of the first `name:` line in `lines`.
function keyValue(lines, name, missing) {
  const line = lines.find((candidate) =>
    candidate.trim().startsWith(`${name}:`),
  );
  assert.ok(line, missing);
  return line
    .trim()
    .slice(name.length + 1)
    .trim();
}

// A `with:` value the reusable passes the gate composite.
const stepInput = (name) =>
  keyValue(
    workflowLines.slice(gateStepIndex),
    name,
    `${name} must be passed to the gate step`,
  );

// The env value the composite's script step reads.
const actionEnv = (name) =>
  keyValue(actionLines, name, `${name} must be set on the composite's step`);

const DEPENDABOT_ID = 49699333;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

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
const NARROWED_ALLOWLIST = '["actions/*","github/*"]';

const update = (
  dependencyName,
  updateType,
  packageEcosystem = "github_actions",
  versions = {},
) => ({
  dependencyName,
  updateType,
  packageEcosystem,
  prevVersion: "1.0.0",
  newVersion: "1.0.1",
  ...versions,
});

// The body shape Dependabot writes for a grouped PR, as on ci-workflows #997.
const updatesBody = (updates) =>
  updates
    .map(
      (u) =>
        `Updates \`${u?.dependencyName}\` from ${u?.prevVersion} to ${u?.newVersion}`,
    )
    .join("\n");

async function runGate({
  armError = null,
  updates = [update("actions/checkout", "version-update:semver-patch")],
  authorId = DEPENDABOT_ID,
  commits = [dependabotCommit()],
  autoMerge = null,
  senderId = DEPENDABOT_ID,
  metadataOutcome = "success",
  metadataJson = JSON.stringify(updates),
  title = "build: bump the vendor-actions group across 1 directory",
  body = Array.isArray(updates) ? updatesBody(updates) : "",
  packageAutoMerge = "true",
  reviewOnly = "[]",
  publisherAllowlist = defaultAllowlist(),
  // The standards policy text.
  policy = policyText(),
  // What the standards read returns: by default `policy`.
  standardsPolicy = { text: policy },
  // The base's docs/conventions/source-control.yaml: absent (404) when null.
  baseSourceControl = NAMES_STANDARDS,
  baseSourceControlError = undefined,
  // A leftover synced copy at the base, which no reader may take.
  baseSyncedCopy = undefined,
  // download-standards' env (RUNNER_TEMP, STANDARDS_URL, STANDARDS_REF) for
  // the real standards read in place of standardsPolicy.
  standardsEnv = undefined,
} = {}) {
  const graphqlCalls = [];
  const policyReads = [];
  const standardsReads = [];
  const notices = [];
  const env = {
    UPDATED_DEPENDENCIES_JSON: metadataJson,
    PUBLISHER_ALLOWLIST: publisherAllowlist,
    SENDER_ID: String(senderId),
    METADATA_OUTCOME: metadataOutcome,
    PACKAGE_AUTO_MERGE: packageAutoMerge,
    REVIEW_ONLY_DEPENDENCIES: reviewOnly,
  };
  const warnings = [];
  const github = {
    rest: {
      pulls: { listCommits: Symbol("listCommits") },
      repos: {
        getContent: async (params) => {
          policyReads.push(params);
          if (baseSourceControlError) throw baseSourceControlError;
          const data = {
            [SOURCE_CONTROL_PATH]: baseSourceControl,
            [SYNCED_COPY_PATH]: baseSyncedCopy,
          }[params.path];
          if (data === undefined || data === null) {
            throw Object.assign(new Error("Not Found"), { status: 404 });
          }
          return { data };
        },
      },
    },
    paginate: async (route, params) => {
      assert.equal(route, github.rest.pulls.listCommits);
      assert.equal(params.pull_number, 7);
      return commits;
    },
    graphql: async (query, variables) => {
      graphqlCalls.push({ query, variables });
      if (armError && /enablePullRequestAutoMerge/u.test(query)) throw armError;
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
        title,
        body,
        head: { sha: HEAD },
        base: { sha: BASE },
        auto_merge: autoMerge,
      },
    },
  };
  const core = {
    notice: (message) => notices.push(message),
    warning: (message) => warnings.push(message),
    info: () => {},
  };
  await runEvent({
    github,
    context,
    core,
    env: { ...env, ...standardsEnv },
    // With standardsEnv, the real download-standards read runs.
    readStandards: standardsEnv
      ? undefined
      : (readEnv) => {
          standardsReads.push(readEnv);
          return standardsPolicy;
        },
  });
  const armCalls = graphqlCalls.filter((call) =>
    /enablePullRequestAutoMerge/u.test(call.query),
  );
  const disarmCalls = graphqlCalls.filter((call) =>
    /disablePullRequestAutoMerge/u.test(call.query),
  );
  return {
    armCalls,
    disarmCalls,
    notices,
    warnings,
    policyReads,
    standardsReads,
  };
}

function assertSkipped(result, reason) {
  assert.equal(result.armCalls.length, 0);
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0], reason);
}

test("the default allowlist matches standards dependabot-policy autoMerge.publisherAllowlist", () => {
  assert.deepEqual(JSON.parse(defaultAllowlist()), [
    "actions/*",
    "github/*",
    "anthropics/*",
  ]);
  assert.equal(
    stepInput("publisher-allowlist"),
    `\${{ inputs.publisher-allowlist }}`,
  );
  assert.equal(
    actionEnv("PUBLISHER_ALLOWLIST"),
    `\${{ inputs.publisher-allowlist }}`,
  );
});

test("a narrowed allowlist skips a publisher it leaves out", async () => {
  assertSkipped(
    await runGate({
      updates: [
        update("anthropics/claude-code-action", "version-update:semver-patch"),
      ],
      publisherAllowlist: NARROWED_ALLOWLIST,
    }),
    /anthropics\/claude-code-action is not an allowlisted publisher/u,
  );
});

test("a narrowed allowlist still arms a publisher it keeps", async () => {
  const { armCalls, notices } = await runGate({
    updates: [update("github/codeql-action", "version-update:semver-minor")],
    publisherAllowlist: NARROWED_ALLOWLIST,
  });
  assert.equal(notices.length, 0);
  assert.equal(armCalls.length, 1);
});

for (const malformed of [
  "not json",
  '{"actions/*":true}',
  '"actions/*"',
  '["actions/*",""]',
  '["actions/*",7]',
  "",
]) {
  test(`a malformed publisher-allowlist ${JSON.stringify(malformed)} arms nothing`, async () => {
    assertSkipped(
      await runGate({ publisherAllowlist: malformed }),
      /the publisher-allowlist input is not a JSON array of non-empty globs/u,
    );
  });
}

// The publisher and fast-track shape of standards
// components/dependabot-policy/policy.json schemaVersion 2 (standards#987),
// plus one review-tier publisher the real file does not list.
const policyText = ({ fastTrack, ecosystems, reviewOnly } = {}) =>
  JSON.stringify({
    schemaVersion: 2,
    fastTrack: fastTrack ?? {
      reviewed: "2026-11-11",
      basis: "owner decision",
      npm: ["@anthropic-ai/claude-code"],
      "github-actions": ["anthropics/*"],
      own: ["melodic-software/*"],
    },
    autoMerge: {
      publishers: {
        "actions/*": { tier: "auto" },
        "github/*": { tier: "auto" },
        "anthropics/*": { tier: "auto" },
        "example/*": { tier: "review" },
      },
      ecosystems: ecosystems ?? ["github-actions", "npm", "pip", "uv", "nuget"],
      reviewOnly: reviewOnly ?? [],
    },
  });

test("the gate's default allowlist is the reusable's publisher-allowlist default", () => {
  assert.deepEqual(DEFAULT_PUBLISHER_ALLOWLIST, JSON.parse(defaultAllowlist()));
});

test("the standards repository comes from the base commit's source-control.yaml, never the head", async () => {
  const { policyReads } = await runGate({ baseSyncedCopy: policyText() });
  assert.deepEqual(policyReads, [
    {
      owner: "melodic-software",
      repo: "medley",
      path: "docs/conventions/source-control.yaml",
      ref: BASE,
      mediaType: { format: "raw" },
    },
  ]);
});

test("the standards policy's fast track arms an own action", async () => {
  const { armCalls, notices, policyReads, standardsReads } = await runGate({
    updates: [
      update("melodic-software/ci-workflows", "version-update:semver-patch"),
    ],
  });
  assert.equal(policyReads.length, 1);
  assert.equal(standardsReads.length, 1);
  assert.deepEqual(notices, []);
  assert.equal(armCalls.length, 1);
});

test("a leftover synced copy at the base is ignored in favor of the standards policy", async () => {
  const { standardsReads, notices } = await runGate({
    updates: [
      update("melodic-software/ci-workflows", "version-update:semver-patch"),
    ],
    baseSyncedCopy: policyText(),
    policy: policyText({ fastTrack: { "github-actions": [], own: [] } }),
  });
  assert.equal(standardsReads.length, 1);
  assert.match(
    notices[0],
    /melodic-software\/ci-workflows is not an allowlisted publisher/u,
  );
});

test("with no readable standards policy, nothing arms and an earlier arm is disarmed, a synced copy notwithstanding", async () => {
  const result = await runGate({
    autoMerge: { enabled_by: {} },
    baseSyncedCopy: policyText(),
    standardsPolicy: { failure: "the standards policy could not be read" },
  });
  assert.equal(result.armCalls.length, 0);
  assert.match(result.notices[0], /the standards policy could not be read/u);
  assert.equal(result.disarmCalls.length, 1);
});

for (const [label, baseSourceControl] of [
  ["no source-control.yaml", null],
  ["no standards_repository", "convention: conventional\n"],
  ["another standards repository", "standards_repository: other/standards\n"],
]) {
  test(`a base with ${label} reads no policy, arms nothing and disarms an earlier arm`, async () => {
    const result = await runGate({
      autoMerge: { enabled_by: {} },
      baseSourceControl,
      baseSyncedCopy: policyText(),
    });
    assert.equal(result.armCalls.length, 0);
    assert.equal(result.standardsReads.length, 0);
    assert.match(
      result.notices[0],
      /docs\/conventions\/source-control\.yaml names .*, not melodic-software\/standards, so no dependabot policy is read/u,
    );
    assert.equal(result.disarmCalls.length, 1);
  });
}

test("with the standards policy, an own action's patch bump arms on the fast track", async () => {
  const { armCalls, notices } = await runGate({
    updates: [
      update("melodic-software/ci-workflows", "version-update:semver-patch"),
    ],
    policy: policyText(),
  });
  assert.deepEqual(notices, []);
  assert.equal(armCalls.length, 1);
});

test("with the standards policy, a fast-tracked major still goes to a person", async () => {
  assertSkipped(
    await runGate({
      updates: [
        update(
          "melodic-software/ci-workflows",
          "version-update:semver-major",
          "github_actions",
          {
            newVersion: "2.0.0",
          },
        ),
      ],
      policy: policyText(),
    }),
    /melodic-software\/ci-workflows is not a patch or minor update/u,
  );
});

// An own action below 1.0 whose every release is a minor bump.
const PSSA = "melodic-software/ci-workflows/.github/actions/psscriptanalyzer";
const ownMinor = (versions = {}) =>
  update(PSSA, "version-update:semver-minor", "github_actions", {
    prevVersion: "0.39.8",
    newVersion: "0.74.0",
    ...versions,
  });
const OWN_ALLOWLIST =
  '["actions/*","github/*","anthropics/*","melodic-software/*"]';
const vendorMinorBelowOne = update(
  "actions/checkout",
  "version-update:semver-minor",
  undefined,
  { prevVersion: "0.3.0", newVersion: "0.4.0" },
);
const belowOne = (name) =>
  new RegExp(
    `${name.replaceAll("/", "\\/").replaceAll(".", "\\.")} changes its minor version below 1\\.0`,
    "u",
  );

test("with the standards policy, an own action's minor below 1.0 arms", async () => {
  const { armCalls, notices } = await runGate({
    updates: [ownMinor()],
    policy: policyText(),
  });
  assert.deepEqual(notices, []);
  assert.equal(armCalls.length, 1);
});

test("a standards policy without fastTrack.own exempts no allowlisted name below 1.0", async () => {
  assertSkipped(
    await runGate({
      updates: [ownMinor()],
      publisherAllowlist: OWN_ALLOWLIST,
      policy: policyText({
        fastTrack: { "github-actions": ["anthropics/*"] },
      }),
    }),
    belowOne(PSSA),
  );
});

test("with the standards policy, a vendor action's minor below 1.0 is still skipped", async () => {
  assertSkipped(
    await runGate({
      updates: [vendorMinorBelowOne],
      policy: policyText(),
    }),
    belowOne("actions/checkout"),
  );
});

test("with the standards policy, an own action's move to 1.0 still goes to a person", async () => {
  assertSkipped(
    await runGate({
      updates: [
        ownMinor({
          updateType: "version-update:semver-major",
          prevVersion: "0.74.0",
          newVersion: "1.0.0",
        }),
      ],
      policy: policyText(),
    }),
    /psscriptanalyzer is not a patch or minor update/u,
  );
  assertSkipped(
    await runGate({
      updates: [ownMinor({ prevVersion: "0.74.0", newVersion: "1.0.0" })],
      policy: policyText(),
    }),
    belowOne(PSSA),
  );
});

test("a group with an own and a vendor minor below 1.0 is skipped for the vendor's", async () => {
  assertSkipped(
    await runGate({
      updates: [ownMinor(), vendorMinorBelowOne],
      policy: policyText(),
    }),
    belowOne("actions/checkout"),
  );
});

test("own globs come only from the standards policy, never the caller's inputs", async () => {
  const caller = {
    publisherAllowlist: OWN_ALLOWLIST,
    packageAutoMerge: "true",
    reviewOnly: "[]",
    ownGlobs: ["melodic-software/*"],
  };
  const repository = "melodic-software/medley";
  assert.match(
    resolvePolicyInputs(caller, undefined, repository).failure,
    /is not a readable dependabot policy/u,
    "no policy text resolves no inputs",
  );
  const unsynced = resolvePolicyInputs(
    caller,
    policyText({ fastTrack: {} }),
    repository,
  ).inputs;
  assert.deepEqual(unsynced.ownGlobs, []);
  assert.match(
    await gateFailure({
      pr: { user: { id: DEPENDABOT_ID } },
      updates: [ownMinor()],
      listCommits: () => assert.fail("the gate refuses before reading commits"),
      inputs: unsynced,
    }),
    belowOne(PSSA),
  );
});

test("with the standards policy, a review-tier publisher is not armed", async () => {
  assertSkipped(
    await runGate({
      updates: [update("example/action", "version-update:semver-patch")],
      policy: policyText(),
    }),
    /example\/action is not an allowlisted publisher/u,
  );
});

test("a standards policy with no fast track arms only its auto-tier publishers", async () => {
  assertSkipped(
    await runGate({
      updates: [
        update("melodic-software/ci-workflows", "version-update:semver-patch"),
      ],
      policy: policyText({ fastTrack: {} }),
    }),
    /melodic-software\/ci-workflows is not an allowlisted publisher/u,
  );
});

test("a caller's narrowed allowlist wins over the standards policy", async () => {
  for (const name of [
    "melodic-software/ci-workflows",
    "anthropics/claude-code-action",
  ]) {
    assertSkipped(
      await runGate({
        updates: [update(name, "version-update:semver-patch")],
        publisherAllowlist: NARROWED_ALLOWLIST,
        policy: policyText(),
      }),
      new RegExp(
        `${name.replace("/", "\\/")} is not an allowlisted publisher`,
        "u",
      ),
    );
  }
});

for (const [label, policy] of [
  ["not JSON", "{"],
  ["without autoMerge.publishers", JSON.stringify({ fastTrack: {} })],
  [
    "without autoMerge.ecosystems",
    JSON.stringify({ autoMerge: { publishers: {}, reviewOnly: [] } }),
  ],
  [
    "with a non-list fast track",
    policyText({ fastTrack: { own: "melodic-software/*" } }),
  ],
]) {
  test(`a standards policy ${label} arms nothing and disarms an earlier arm`, async () => {
    const result = await runGate({ policy, autoMerge: { enabled_by: {} } });
    assert.equal(result.armCalls.length, 0);
    assert.match(result.notices[0], /is not a readable dependabot policy/u);
    assert.equal(result.disarmCalls.length, 1);
  });
}

test("a base source-control.yaml the API cannot return arms nothing", async () => {
  const result = await runGate({
    baseSourceControlError: Object.assign(new Error("Server Error"), {
      status: 500,
    }),
  });
  assertSkipped(result, /could not be read at the base: Server Error/u);
  assert.equal(result.standardsReads.length, 0);
});

test("the standards policy's autoMerge.ecosystems leaves other ecosystems for a person", async () => {
  assertSkipped(
    await runGate({
      updates: [
        update("left-pad", "version-update:semver-patch", "npm_and_yarn"),
      ],
      policy: policyText({ ecosystems: ["github-actions"] }),
    }),
    /left-pad is a npm_and_yarn update, which the policy's autoMerge.ecosystems leaves out/u,
  );
  const { armCalls } = await runGate({
    updates: [
      update("left-pad", "version-update:semver-patch", "npm_and_yarn"),
    ],
    policy: policyText({ ecosystems: ["npm"] }),
  });
  assert.equal(armCalls.length, 1);
});

test("the standards policy's reviewOnly entries for this repository are never armed", async () => {
  const entry = (repository) => ({
    repository,
    ecosystem: "npm",
    directory: "/",
    dependency: "tedious",
  });
  assertSkipped(
    await runGate({
      updates: [
        update("tedious", "version-update:semver-patch", "npm_and_yarn"),
      ],
      policy: policyText({
        reviewOnly: [entry("melodic-software/medley")],
      }),
    }),
    /tedious is a review-only dependency/u,
  );
  const { armCalls } = await runGate({
    updates: [update("tedious", "version-update:semver-patch", "npm_and_yarn")],
    policy: policyText({ reviewOnly: [entry("melodic-software/other")] }),
  });
  assert.equal(
    armCalls.length,
    1,
    "another repository's entry does not apply here",
  );
});

test("the job runs only on pull_request events authored by Dependabot's account id", () => {
  const job = workflowLines.indexOf("  enable-auto-merge:");
  const ifLine = workflowLines
    .slice(job, job + 4)
    .find((line) => line.trim().startsWith("if:"));
  assert.match(ifLine, /github\.event_name == 'pull_request'/u);
  assert.match(ifLine, /github\.event\.pull_request\.user\.id == 49699333/u);
});

test("the sender and metadata outcome come from the event and the metadata step", () => {
  assert.notEqual(gateStepIndex, -1, "gate step must exist");
  assert.equal(stepInput("sender-id"), `\${{ github.event.sender.id }}`);
  assert.equal(stepInput("metadata-outcome"), `\${{ steps.metadata.outcome }}`);
  assert.equal(
    stepInput("updated-dependencies-json"),
    `\${{ steps.metadata.outputs.updated-dependencies-json }}`,
  );
  assert.equal(actionEnv("SENDER_ID"), `\${{ inputs.sender-id }}`);
  assert.equal(
    actionEnv("METADATA_OUTCOME"),
    `\${{ inputs.metadata-outcome }}`,
  );
  assert.equal(
    actionEnv("UPDATED_DEPENDENCIES_JSON"),
    `\${{ inputs.updated-dependencies-json }}`,
  );
});

test("the reusable runs the shared gate composite through $/", () => {
  assert.equal(
    workflowLines[gateStepIndex + 2].trim(),
    "uses: $/.github/actions/automerge-dependabot",
  );
});

test("PR-derived values reach the script through env, never an expression", () => {
  const script = actionLines.findIndex((line) =>
    /^ {8}script: \|$/u.test(line),
  );
  assert.notEqual(script, -1, "the composite's script block must exist");
  assert.doesNotMatch(actionLines.slice(script).join("\n"), /\$\{\{/u);
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
    workflowLines[gateStepIndex + 1].trim(),
    `if: \${{ !cancelled() }}`,
  );
});

test("a head that moved after the event is skipped", async () => {
  assertSkipped(
    await runGate({ commits: [dependabotCommit("c".repeat(40))] }),
    /the PR head moved after this event/u,
  );
});

// The publisher-allowlist input's default, its YAML quotes removed.
const defaultAllowlist = () =>
  inputDefault("publisher-allowlist").replace(/^'(.*)'$/u, "$1");

function inputDefault(name) {
  const input = workflowLines.indexOf(`      ${name}:`);
  assert.notEqual(input, -1, `${name} input must exist`);
  const line = workflowLines
    .slice(input + 1)
    .find((candidate) => candidate.trim().startsWith("default:"));
  return line.trim().slice("default:".length).trim();
}

test("package auto-merge is on by default with no review-only names", () => {
  assert.equal(inputDefault("package-auto-merge"), "true");
  assert.equal(inputDefault("review-only-dependencies"), '"[]"');
  assert.equal(
    stepInput("package-auto-merge"),
    `\${{ inputs.package-auto-merge }}`,
  );
  assert.equal(
    stepInput("review-only-dependencies"),
    `\${{ inputs.review-only-dependencies }}`,
  );
  assert.equal(
    actionEnv("PACKAGE_AUTO_MERGE"),
    `\${{ inputs.package-auto-merge }}`,
  );
  assert.equal(
    actionEnv("REVIEW_ONLY_DEPENDENCIES"),
    `\${{ inputs.review-only-dependencies }}`,
  );
});

for (const [ecosystem, name, updateType] of [
  ["npm_and_yarn", "lefthook", "version-update:semver-minor"],
  ["pip", "requests", "version-update:semver-patch"],
  ["uv", "ruff", "version-update:semver-patch"],
  ["nuget", "Microsoft.Extensions.Logging", "version-update:semver-minor"],
]) {
  test(`a ${ecosystem} ${updateType.split("-").at(-1)} from any publisher is armed`, async () => {
    const { armCalls, notices } = await runGate({
      updates: [update(name, updateType, ecosystem)],
    });
    assert.equal(notices.length, 0);
    assert.equal(armCalls.length, 1);
  });
}

test("a grouped npm update with one major bump is skipped", async () => {
  assertSkipped(
    await runGate({
      updates: [
        update("lefthook", "version-update:semver-minor", "npm_and_yarn"),
        update("typescript", "version-update:semver-major", "npm_and_yarn"),
      ],
    }),
    /typescript is not a patch or minor update/u,
  );
});

test("a package minor below 1.0 is skipped as breaking", async () => {
  assertSkipped(
    await runGate({
      updates: [
        update("smol-toml", "version-update:semver-minor", "npm_and_yarn", {
          prevVersion: "0.8.0",
          newVersion: "0.9.0",
        }),
      ],
    }),
    /smol-toml changes its minor version below 1\.0/u,
  );
});

test("a package patch below 1.0 is armed", async () => {
  const { armCalls } = await runGate({
    updates: [
      update("smol-toml", "version-update:semver-patch", "npm_and_yarn", {
        prevVersion: "0.8.0",
        newVersion: "0.8.1",
      }),
    ],
  });
  assert.equal(armCalls.length, 1);
});

test("a package minor at or above 1.0 is armed", async () => {
  const { armCalls } = await runGate({
    updates: [
      update("smol-toml", "version-update:semver-minor", "npm_and_yarn", {
        prevVersion: "1.8.0",
        newVersion: "1.9.0",
      }),
    ],
  });
  assert.equal(armCalls.length, 1);
});

test("a package update is skipped when the caller turns package auto-merge off", async () => {
  assertSkipped(
    await runGate({
      updates: [
        update("lefthook", "version-update:semver-patch", "npm_and_yarn"),
      ],
      packageAutoMerge: "false",
    }),
    /lefthook is a package update and this repository turned package auto-merge off/u,
  );
});

test("a vendor action is still armed with package auto-merge off", async () => {
  const { armCalls } = await runGate({ packageAutoMerge: "false" });
  assert.equal(armCalls.length, 1);
});

test("a review-only package dependency is skipped", async () => {
  assertSkipped(
    await runGate({
      updates: [update("yaml", "version-update:semver-patch", "npm_and_yarn")],
      reviewOnly: '["yaml"]',
    }),
    /yaml is a review-only dependency/u,
  );
});

test("an invalid review-only-dependencies input is skipped", async () => {
  assertSkipped(
    await runGate({ reviewOnly: '{"yaml":true}' }),
    /the review-only-dependencies input is not a JSON array of names/u,
  );
});

for (const ecosystem of ["docker", "dotnet_sdk"]) {
  test(`a ${ecosystem} update is skipped`, async () => {
    assertSkipped(
      await runGate({
        updates: [update("thing", "version-update:semver-patch", ecosystem)],
        // A policy that would arm the ecosystem leaves the gate's own check.
        standardsPolicy: {
          text: policyText({
            ecosystems: [
              "github-actions",
              "npm",
              "pip",
              "uv",
              "nuget",
              ecosystem,
            ],
          }),
        },
      }),
      /thing is not a GitHub Actions, npm, pip, uv or NuGet update/u,
    );
  });
}

test("a package named like an allowlisted publisher is judged as a package", async () => {
  assertSkipped(
    await runGate({
      updates: [
        update(
          "actions/checkout",
          "version-update:semver-major",
          "npm_and_yarn",
        ),
      ],
    }),
    /actions\/checkout is not a patch or minor update/u,
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

// Its GITHUB_TOKEN arm never enters main's merge queue; the scheduled
// pr-automerge-dependabot-queue.yml arms this repository's bumps instead.
test("no workflow here calls the reusable", () => {
  const workflowsDir = path.dirname(workflowPath);
  const callers = fs
    .readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/u.test(file))
    .filter((file) =>
      /^\s*-?\s*uses:\s*\S*pr-automerge-dependabot\.yml/mu.test(
        fs.readFileSync(path.join(workflowsDir, file), "utf8"),
      ),
    );
  assert.deepEqual(callers, []);
});

// Title from ci-workflows #989; body lines from #997.
const setupDotnet = update(
  "actions/setup-dotnet",
  "version-update:semver-minor",
  "github_actions",
  {
    prevVersion: "6.0.0",
    newVersion: "6.1.0",
  },
);

test("a single update whose title names its versions arms", async () => {
  const { armCalls, notices } = await runGate({
    updates: [setupDotnet],
    title:
      "build: bump actions/setup-dotnet from 6.0.0 to 6.1.0 in /.github/actions/dotnet-format",
    body: "Bumps [actions/setup-dotnet](https://github.com/actions/setup-dotnet) from 6.0.0 to 6.1.0.",
  });
  assert.deepEqual(notices, []);
  assert.equal(armCalls.length, 1);
});

test("a grouped update whose Updates lines name its versions arms", async () => {
  const { armCalls, notices } = await runGate({
    updates: [setupDotnet, setupDotnet],
    title:
      "build: bump the vendor-actions group across 2 directories with 1 update",
    body: "Updates `actions/setup-dotnet` from 6.0.0 to 6.1.0\nUpdates `actions/setup-dotnet` from 6.0.0 to 6.1.0",
  });
  assert.deepEqual(notices, []);
  assert.equal(armCalls.length, 1);
});

test("a grouped update whose body was cut off after its table arms", async () => {
  const checkout = { ...setupDotnet, dependencyName: "actions/checkout" };
  const { armCalls, notices } = await runGate({
    updates: [setupDotnet, checkout],
    title:
      "build: bump the vendor-actions group across 1 directory with 2 updates",
    body: [
      "| Package | From | To |",
      "| --- | --- | --- |",
      "| [actions/setup-dotnet](https://github.com/actions/setup-dotnet) | `6.0.0` | `6.1.0` |",
      "| [actions/checkout](https://github.com/actions/checkout) | `6.0.0` | `6.1.0` |",
      "",
      "Updates `actions/setup-dotnet` from 6.0.0 to 6.1.0",
    ].join("\n"),
  });
  assert.deepEqual(notices, []);
  assert.equal(armCalls.length, 1);
});

test("a table row the metadata lacks skips", async () => {
  assertSkipped(
    await runGate({
      updates: [setupDotnet],
      title:
        "build: bump the vendor-actions group across 1 directory with 2 updates",
      body: [
        "| [actions/setup-dotnet](https://github.com/actions/setup-dotnet) | `6.0.0` | `6.1.0` |",
        "| [actions/checkout](https://github.com/actions/checkout) | `5.0.0` | `6.0.0` |",
      ].join("\n"),
    }),
    /metadata does not include actions\/checkout from 5\.0\.0 to 6\.0\.0/u,
  );
});

test("a title naming other versions than the metadata skips and disarms", async () => {
  const result = await runGate({
    updates: [setupDotnet],
    title: "build: bump actions/setup-dotnet from 6.0.0 to 6.0.1",
    body: "",
    autoMerge: { enabled_by: { login: "github-actions[bot]" } },
  });
  assert.equal(result.armCalls.length, 0);
  assert.match(
    result.notices[0],
    /do not name actions\/setup-dotnet from 6\.0\.0 to 6\.1\.0/u,
  );
  assert.equal(result.disarmCalls.length, 1);
});

test("an Updates line the metadata lacks skips", async () => {
  assertSkipped(
    await runGate({
      updates: [setupDotnet],
      title:
        "build: bump the vendor-actions group across 1 directory with 2 updates",
      body: "Updates `actions/setup-dotnet` from 6.0.0 to 6.1.0\nUpdates `actions/checkout` from 5.0.0 to 6.0.0",
    }),
    /metadata does not include actions\/checkout from 5\.0\.0 to 6\.0\.0/u,
  );
});

test("metadata without versions skips", async () => {
  assertSkipped(
    await runGate({
      updates: [
        {
          dependencyName: "actions/setup-dotnet",
          updateType: "version-update:semver-minor",
          packageEcosystem: "github_actions",
        },
      ],
      title: "build: bump actions/setup-dotnet from 6.0.0 to 6.1.0",
      body: "",
    }),
    /has no from or to version/u,
  );
});

// GitHub refuses to arm a PR that is already mergeable; the wording below is
// the error standards-sync-automerge-arm.test.cjs exercises for its arm.
for (const status of ["clean", "unstable"]) {
  test(`an arm refused because the PR is in ${status} status only warns`, async () => {
    const { armCalls, warnings } = await runGate({
      armError: new Error(`Pull request is in ${status} status`),
    });
    assert.equal(armCalls.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Could not arm auto-merge on #7/u);
    assert.match(warnings[0], new RegExp(`${status} status`, "u"));
  });
}

test("any other arm failure still fails the job", async () => {
  await assert.rejects(
    runGate({ armError: new Error("Head sha did not match") }),
    /Head sha did not match/u,
  );
});

test("the standards read checks out the resolved commit and fails closed without it", () => {
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  const { STANDARDS_POLICY_PATH, readStandardsPolicy } = require(
    path.join(actionDir, "gate.cjs"),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-standards-"));
  try {
    const standards = path.join(root, "standards");
    const git = (...args) => execFileSync("git", ["-C", standards, ...args]);
    fs.mkdirSync(path.join(standards, path.dirname(STANDARDS_POLICY_PATH)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(standards, STANDARDS_POLICY_PATH), policyText());
    git("-c", "init.defaultBranch=main", "init", "-q");
    git("config", "uploadpack.allowAnySHA1InWant", "true");
    git("add", ".");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-qm",
      "s",
    );
    fs.mkdirSync(path.join(root, "temp"));
    const env = {
      PATH: process.env.PATH,
      RUNNER_TEMP: path.join(root, "temp"),
      STANDARDS_REF: "main",
      STANDARDS_URL: `file://${standards}`,
    };
    assert.deepEqual(readStandardsPolicy(env), { text: policyText() });
    const missing = readStandardsPolicy({ ...env, STANDARDS_REF: "absent" });
    assert.equal(missing.text, undefined);
    assert.match(missing.failure, /could not be read/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable standards repository fails the event path closed, a synced copy at the base notwithstanding", async () => {
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-unreadable-"));
  try {
    fs.mkdirSync(path.join(root, "temp"));
    for (const standardsEnv of [
      // No repository at the URL.
      { STANDARDS_URL: `file://${path.join(root, "absent")}` },
      // A ref that is not a branch name.
      { STANDARDS_REF: "bad..ref" },
    ]) {
      const result = await runGate({
        autoMerge: { enabled_by: {} },
        baseSyncedCopy: policyText(),
        standardsEnv: {
          PATH: process.env.PATH,
          RUNNER_TEMP: path.join(root, "temp"),
          STANDARDS_REF: "main",
          STANDARDS_URL: `file://${path.join(root, "absent")}`,
          ...standardsEnv,
        },
      });
      assert.equal(result.armCalls.length, 0);
      assert.match(
        result.notices[0],
        /the standards components\/dependabot-policy\/policy\.json could not be read/u,
      );
      assert.equal(result.disarmCalls.length, 1);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("standardsNamed accepts only the standards repository download-standards reads", () => {
  const { standardsNamed } = require(path.join(actionDir, "gate.cjs"));
  for (const named of [
    NAMES_STANDARDS,
    'standards_repository: "Melodic-Software/standards" # org layer\n',
  ]) {
    assert.deepEqual(standardsNamed(named), {}, named);
  }
  for (const [text, shown] of [
    ["", "no standards_repository"],
    ["convention: conventional\n", "no standards_repository"],
    ["standards_repository: other/standards\n", "other/standards"],
    [
      "  standards_repository: melodic-software/standards\n",
      "no standards_repository",
    ],
  ]) {
    assert.equal(
      standardsNamed(text).failure,
      `docs/conventions/source-control.yaml names ${shown}, not melodic-software/standards, so no dependabot policy is read`,
    );
  }
});
