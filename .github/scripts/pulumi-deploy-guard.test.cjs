"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");
const action = fs.readFileSync(
  path.join(root, ".github", "actions", "pulumi-deploy-guard", "action.yml"),
  "utf8",
);
const guard = fs.readFileSync(
  path.join(root, ".github", "actions", "pulumi-deploy-guard", "guard.sh"),
  "utf8",
);
const contract = JSON.parse(
  fs.readFileSync(
    path.join(
      root,
      ".github",
      "actions",
      "pulumi-deploy-guard",
      "contracts",
      "kyle-sexton-github-iac.json",
    ),
    "utf8",
  ),
);
const drift = fs.readFileSync(
  path.join(root, ".github", "workflows", "pulumi-version-drift-check.yml"),
  "utf8",
);

test("deployment guard exposes only reviewed state-adoption outputs", () => {
  for (const input of [
    "policy-contract",
    "stack-name",
    "operational-resource-urns-json",
  ]) {
    assert.match(action, new RegExp(`^ {2}${input}:`, "mu"));
  }
  for (const output of [
    "existing-count",
    "missing-count",
    "existing-targets",
    "existing-urns-json",
    "missing-urns-json",
  ]) {
    assert.match(action, new RegExp(`^ {2}${output}:`, "mu"));
  }
  assert.match(action, /bash "\$ACTION_PATH\/guard\.sh"/u);
  assert.match(
    action,
    /Empty array selects policy-only validation while still validating exported stack state\./u,
  );
  assert.match(action, /Empty in policy-only mode\./u);
  assert.doesNotMatch(action, /secrets\./u);
});

test("guard audits the complete personal allow set before exporting state", () => {
  const policyOffset = guard.indexOf("actual_policies=");
  const exportOffset = guard.indexOf("stack export");
  assert.ok(policyOffset >= 0 && exportOffset > policyOffset);
  assert.match(
    guard,
    /select\(\.decision == "allow" and \.tokenType == "personal"\)/u,
  );
  assert.match(guard, /cmp -s "\$expected_policies" "\$actual_policies"/u);
  assert.match(guard, /\.count == 0 or \.count == 1/u);
  assert.match(guard, /type == "array" and\n\s+length <= 32/u);
  assert.match(guard, /length == 1 and/u);
  assert.doesNotMatch(guard, /length >= 1 and length <= 32/u);
  assert.doesNotMatch(guard, /--show-secrets/u);
  assert.doesNotMatch(guard, /set -x/u);
});

test("bundled OIDC contract is exact, wildcard-free, and covers the organization IaC repository", () => {
  assert.equal(contract.schemaVersion, 2);
  assert.equal(contract.organization, "kyle-sexton");
  assert.equal(
    contract.issuerUrl,
    "https://token.actions.githubusercontent.com",
  );
  assert.equal(contract.personalAllowPolicies.length, 1);
  assert.deepEqual(
    contract.personalAllowPolicies
      .map((policy) => policy.rules.repository)
      .sort(),
    ["melodic-software/github-iac"],
  );
  const identities = {
    "melodic-software/github-iac": {
      ownerId: "58273638",
      repositoryId: "1277417810",
    },
  };
  for (const policy of contract.personalAllowPolicies) {
    const identity = identities[policy.rules.repository];
    const [owner, repository] = policy.rules.repository.split("/");
    assert.equal(policy.decision, "allow");
    assert.equal(policy.tokenType, "personal");
    assert.deepEqual(policy.authorizedPermissions, []);
    assert.equal(policy.rules.ref, "refs/heads/main");
    assert.equal(policy.rules.ref_type, "branch");
    assert.equal(policy.rules.environment, "github-iac-production");
    assert.equal(policy.rules.event_name, "workflow_dispatch");
    assert.equal(policy.rules.runner_environment, "self-hosted");
    assert.equal(policy.rules.repository_visibility, "private");
    assert.equal(policy.rules.repository_owner_id, identity.ownerId);
    assert.equal(policy.rules.repository_id, identity.repositoryId);
    assert.equal(policy.rules.actor_id, "153232337");
    assert.equal(policy.rules.run_attempt, "1");
    assert.equal(policy.rules.aud, "urn:pulumi:org:kyle-sexton");
    assert.equal(
      policy.rules.sub,
      `repo:${owner}@${identity.ownerId}/${repository}@${identity.repositoryId}:environment:github-iac-production`,
    );
    assert.equal(policy.rules.workflow, "github-iac-production-deploy-v1");
    for (const ruleValue of Object.values(policy.rules)) {
      assert.doesNotMatch(ruleValue, /[*?.]/u);
    }
  }
  assert.deepEqual(
    Object.fromEntries(
      contract.personalAllowPolicies.map((policy) => [
        policy.rules.repository,
        policy.rules.repository_id,
      ]),
    ),
    {
      "melodic-software/github-iac": "1277417810",
    },
  );
});

test("Pulumi drift workflow is reusable-only and rejects untrusted refs before checkout", () => {
  assert.match(drift, /^on:\n {2}workflow_call:/mu);
  assert.doesNotMatch(
    drift,
    /^ {2}(push|pull_request|schedule|workflow_dispatch):/mu,
  );
  assert.match(drift, /^permissions: \{\}$/mu);
  assert.match(
    drift,
    /^concurrency:\n {2}group: pulumi-cli-version-drift-\$\{\{ github\.repository \}\}\n {2}cancel-in-progress: false$/mu,
  );
  assert.match(
    drift,
    /^ {4}inputs:\n {6}runner:\n {8}description: [^\n]+\n {8}type: string\n {8}default: ubuntu-24\.04$/mu,
  );
  assert.match(drift, /^ {4}runs-on: \$\{\{ inputs\.runner \}\}$/mu);
  assert.match(drift, /^ {6}issues: write/mu);
  const guardOffset = drift.indexOf(
    "Require a trusted default-branch maintenance event",
  );
  const checkoutOffset = drift.indexOf("Check out reviewed caller state");
  const driftDetectOffset = drift.indexOf(
    "Detect and record stable-version drift",
  );
  assert.ok(
    guardOffset >= 0 &&
      checkoutOffset > guardOffset &&
      driftDetectOffset > checkoutOffset,
  );
  assert.match(drift, /push\|schedule\|workflow_dispatch/u);
  assert.match(drift, /refs\/heads\/main/u);

  const driftStep = drift.slice(driftDetectOffset);
  assert.match(driftStep, /uses: actions\/github-script@/u);
  // This reusable runs on a caller-selected runner, and a self-hosted image
  // is not guaranteed to ship the gh CLI or jq. The step's executable script
  // (not the surrounding explanatory comments, which may name either tool in
  // prose) must not shell out to either.
  const driftScriptBody = driftStep.slice(driftStep.indexOf("script: |"));
  assert.doesNotMatch(driftScriptBody, /\bgh (api|issue)\b/u);
  assert.doesNotMatch(driftScriptBody, /\bjq\b/u);

  assert.match(
    driftStep,
    /current = fs\.readFileSync\(versionFile, "utf8"\)\.replace\(\/\\n\+\$\/, ""\)/u,
  );
  // A plain .trim() would strip leading/trailing spaces and tabs too, which
  // the shell's `$(<file)` command substitution never did — that would
  // silently accept a whitespace-padded pin the strict SemVer regex below is
  // meant to reject.
  assert.doesNotMatch(
    driftStep,
    /readFileSync\(versionFile, "utf8"\)\.trim\(\)/u,
  );
  assert.match(driftStep, /ci-workflows:pulumi-cli-version-drift:v1:active/u);
  assert.match(driftStep, /ci-workflows:pulumi-cli-version-drift:v1:resolved/u);
  assert.match(
    driftStep,
    /github\.paginate\(github\.rest\.issues\.listForRepo, \{/u,
  );
  assert.match(driftStep, /state: "all"/u);
  assert.match(driftStep, /!issue\.pull_request/u);
  assert.match(driftStep, /activeIncidents\.length > 1/u);
  assert.match(driftStep, /state: "open"/u);
  assert.match(driftStep, /state_reason: "completed"/u);
  assert.match(driftStep, /github\.rest\.issues\.create\(/u);
  assert.match(driftStep, /github\.rest\.issues\.update\(/u);
  assert.match(driftStep, /incident\.created_at/u);
  assert.match(driftStep, /14 \* 24 \* 60 \* 60/u);
});

test("the version-file read strips only trailing newlines, matching bash $(<file) semantics", () => {
  // Same operation the workflow step runs, extracted here to prove the
  // actual behavior — not just that the source text is present. Bash
  // command substitution strips trailing newline(s) only; every other kind
  // of surrounding whitespace must still fail the strict SemVer regex.
  const readVersion = (raw) => raw.replace(/\n+$/, "");
  const semver = /^\d+\.\d+\.\d+$/;

  for (const clean of ["1.2.3\n", "1.2.3\n\n", "1.2.3"]) {
    assert.match(readVersion(clean), semver, `'${clean}' should be accepted`);
  }
  for (const padded of [" 1.2.3\n", "1.2.3 \n", "\t1.2.3\n", "1.2.3\r\n"]) {
    assert.doesNotMatch(
      readVersion(padded),
      semver,
      `whitespace-padded '${JSON.stringify(padded)}' must still be rejected`,
    );
  }
});

test("drift detection reproduces the retired bash helper's bounded-read, single-retry semantics", () => {
  const driftStep = drift.slice(
    drift.indexOf("Detect and record stable-version drift"),
  );
  assert.match(
    driftStep,
    /READ_TIMEOUT_MILLISECONDS = 60_000/u,
    "the read timeout must match the retired gh_read/gh_mutate 60s bound",
  );
  assert.match(
    driftStep,
    /async function boundedRead\(operation\) \{[\s\S]*?catch \(error\) \{[\s\S]*?retrying once/u,
    "a read must retry exactly once on failure, mirroring gh_read",
  );
  // Mutations (create/update/comment) are never wrapped in boundedRead: a
  // timed-out mutation may already have applied server-side, matching how
  // gh_mutate never retried.
  assert.doesNotMatch(
    driftStep,
    /boundedRead\(\(\) =>\s*\n?\s*github\.rest\.issues\.(create|update|createComment)/u,
  );
});
