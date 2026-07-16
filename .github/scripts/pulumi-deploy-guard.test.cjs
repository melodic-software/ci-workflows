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
const driftScript = fs.readFileSync(
  path.join(root, ".github", "scripts", "pulumi-version-drift.sh"),
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
    assert.equal(policy.rules.runner_environment, "github-hosted");
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
  assert.ok(guardOffset >= 0 && checkoutOffset > guardOffset);
  assert.match(drift, /push\|schedule\|workflow_dispatch/u);
  assert.match(drift, /refs\/heads\/main/u);
  assert.doesNotMatch(
    drift,
    /run: bash \.github\/scripts\/pulumi-version-drift\.sh/u,
  );
  assert.match(driftScript, /current="\$\(<"\$version_file"\)"/u);
  assert.doesNotMatch(driftScript, /tr -d/u);
  assert.match(driftScript, /ci-workflows:pulumi-cli-version-drift:v1:active/u);
  assert.match(
    driftScript,
    /ci-workflows:pulumi-cli-version-drift:v1:resolved/u,
  );
  assert.match(driftScript, /gh_read api --paginate --slurp/u);
  assert.match(driftScript, /issues\?state=all&per_page=100/u);
  assert.match(driftScript, /select\(\.pull_request\? == null\)/u);
  assert.match(driftScript, /incident_count > 1/u);
  assert.match(driftScript, /gh_mutate issue reopen/u);
  assert.match(driftScript, /gh_mutate issue close/u);
  assert.match(driftScript, /gh_mutate issue edit "\$issue_number" --title/u);
  assert.match(driftScript, /\.\[0\]\.created_at/u);
  assert.doesNotMatch(driftScript, /gh issue view/u);
  assert.doesNotMatch(driftScript, /head -n 1/u);
  assert.match(driftScript, /14 \* 24 \* 60 \* 60/u);
});

test("reusable drift workflow embeds the exact tested implementation", () => {
  const indentation = "          ";
  const begin = `${indentation}# BEGIN GENERATED: pulumi-version-drift.sh\n`;
  const end = `${indentation}# END GENERATED: pulumi-version-drift.sh`;
  const start = drift.indexOf(begin);
  const finish = drift.indexOf(end);
  assert.ok(start >= 0 && finish > start);
  assert.equal(drift.indexOf(begin, start + begin.length), -1);
  assert.equal(drift.indexOf(end, finish + end.length), -1);

  const embedded = drift
    .slice(start + begin.length, finish)
    .split("\n")
    .map((line) => {
      if (line.length === 0) {
        return "";
      }
      assert.ok(line.startsWith(indentation));
      return line.slice(indentation.length);
    })
    .join("\n");
  assert.equal(embedded, driftScript.replaceAll("\r\n", "\n"));
});
