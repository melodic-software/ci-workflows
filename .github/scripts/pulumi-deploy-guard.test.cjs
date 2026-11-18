"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");
const action = fs.readFileSync(
  path.join(
    root,
    ".github",
    "actions",
    "verify-pulumi-deploy-policy",
    "action.yml",
  ),
  "utf8",
);
const guard = fs.readFileSync(
  path.join(
    root,
    ".github",
    "actions",
    "verify-pulumi-deploy-policy",
    "guard.sh",
  ),
  "utf8",
);
const contract = JSON.parse(
  fs.readFileSync(
    path.join(
      root,
      ".github",
      "actions",
      "verify-pulumi-deploy-policy",
      "contracts",
      "pulumi-oidc-policies.json",
    ),
    "utf8",
  ),
);

const byRepository = Object.fromEntries(
  contract.personalAllowPolicies.map((policy) => [
    policy.rules.repository,
    policy,
  ]),
);

test("contract holds the github-iac policy and an azure-iac policy that differs only in repository identity and sub", () => {
  assert.deepEqual(Object.keys(byRepository).sort(), [
    "melodic-software/azure-iac",
    "melodic-software/github-iac",
  ]);
  const azure = byRepository["melodic-software/azure-iac"];
  assert.deepEqual(azure.rules, {
    ...byRepository["melodic-software/github-iac"].rules,
    sub: "repo:melodic-software@58273638/azure-iac@1404939524:environment:azure-iac-production:job_workflow_ref:melodic-software/azure-iac/.github/workflows/release-deploy.yml@refs/heads/main",
    repository: "melodic-software/azure-iac",
    repository_id: "1404939524",
    repository_owner_id: "58273638",
    environment: "azure-iac-production",
    workflow: "Release Deploy",
    actor_id: "153232337",
  });
});

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

test("bundled OIDC contract is exact, wildcard-free, and covers the organization IaC repositories", () => {
  assert.equal(contract.schemaVersion, 2);
  assert.equal(contract.organization, "kyle-sexton");
  assert.equal(
    contract.issuerUrl,
    "https://token.actions.githubusercontent.com",
  );
  assert.equal(contract.personalAllowPolicies.length, 2);
  const identities = {
    "melodic-software/github-iac": {
      ownerId: "58273638",
      repositoryId: "1277417810",
      jobWorkflowRef: "",
    },
    "melodic-software/azure-iac": {
      ownerId: "58273638",
      repositoryId: "1404939524",
      jobWorkflowRef:
        ":job_workflow_ref:melodic-software/azure-iac/.github/workflows/release-deploy.yml@refs/heads/main",
    },
  };
  assert.deepEqual(
    contract.personalAllowPolicies
      .map((policy) => policy.rules.repository)
      .sort(),
    Object.keys(identities).sort(),
  );
  for (const policy of contract.personalAllowPolicies) {
    const identity = identities[policy.rules.repository];
    const [owner, repository] = policy.rules.repository.split("/");
    assert.equal(policy.decision, "allow");
    assert.equal(policy.tokenType, "personal");
    assert.deepEqual(policy.authorizedPermissions, []);
    assert.equal(policy.rules.ref, "refs/heads/main");
    assert.equal(policy.rules.ref_type, "branch");
    assert.equal(policy.rules.environment, `${repository}-production`);
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
      `repo:${owner}@${identity.ownerId}/${repository}@${identity.repositoryId}:environment:${repository}-production${identity.jobWorkflowRef}`,
    );
    assert.equal(policy.rules.workflow, "Release Deploy");
    for (const [name, ruleValue] of Object.entries(policy.rules)) {
      if (name !== "sub" || identity.jobWorkflowRef === "") {
        assert.doesNotMatch(ruleValue, /[*?.]/u);
      }
    }
  }
});
