#!/usr/bin/env bash
set -euo pipefail

GITHUB_OUTPUT="${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

write_multiline_output() {
  local name="$1" file="$2" delimiter
  delimiter="ci_runner_$(sha256sum "$file" | cut -d ' ' -f 1)"
  {
    printf '%s<<%s\n' "$name" "$delimiter"
    cat "$file"
    printf '%s\n' "$delimiter"
  } >>"$GITHUB_OUTPUT"
}

require_command jq
require_command sha256sum

: "${ACTION_PATH:?ACTION_PATH is required}"
: "${POLICY_CONTRACT:?POLICY_CONTRACT is required}"
: "${STACK_NAME:?STACK_NAME is required}"
: "${OPERATIONAL_RESOURCE_URNS_JSON:?OPERATIONAL_RESOURCE_URNS_JSON is required}"

[[ "$POLICY_CONTRACT" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
  fail "policy-contract must be a safe versioned contract name"
[[ "$STACK_NAME" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "stack-name must be a fully qualified organization/project/stack name"
IFS='/' read -r stack_organization stack_project stack_id <<<"$STACK_NAME"
stack_urn_prefix="urn:pulumi:${stack_id}::${stack_project}::"

contract="$ACTION_PATH/contracts/$POLICY_CONTRACT.json"
[[ -f "$contract" && ! -L "$contract" ]] || fail "unknown policy contract: $POLICY_CONTRACT"

temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

requested_urns="$temporary_directory/requested-urns.json"
printf '%s' "$OPERATIONAL_RESOURCE_URNS_JSON" >"$requested_urns"
jq -e '
  type == "array" and
  length >= 1 and length <= 32 and
  all(.[];
    type == "string" and
    test("^urn:pulumi:[A-Za-z0-9_.$:/@-]+$")
  ) and
  (unique | length) == length
' "$requested_urns" >/dev/null || fail "operational-resource-urns-json is invalid"
jq -e --arg prefix "$stack_urn_prefix" 'all(.[]; startswith($prefix))' "$requested_urns" >/dev/null ||
  fail "every operational resource URN must belong to the requested stack and project"

jq -e '
  def exact_keys($expected): keys == ($expected | sort);
  .organization as $org |
  type == "object" and
  exact_keys(["issuerUrl", "organization", "personalAllowPolicies", "schemaVersion"]) and
  .schemaVersion == 2 and
  (.organization | type == "string" and test("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")) and
  .issuerUrl == "https://token.actions.githubusercontent.com" and
  (.personalAllowPolicies | type == "array" and length >= 1) and
  all(.personalAllowPolicies[];
    . as $policy |
    ($policy.rules.repository | split("/")) as $repository_parts |
    exact_keys(["authorizedPermissions", "decision", "rules", "tokenType", "userLogin"]) and
    .decision == "allow" and
    .tokenType == "personal" and
    .userLogin == $org and
    .authorizedPermissions == [] and
    (.rules | type == "object") and
    (.rules | exact_keys([
      "actor_id", "aud", "environment", "event_name", "ref", "ref_type", "repository",
      "repository_id", "repository_owner_id", "repository_visibility", "run_attempt",
      "runner_environment", "sub", "workflow"
    ])) and
    (.rules | all(.[];
      type == "string" and length > 0 and (test("[*?.]") | not)
    )) and
    ($repository_parts | length == 2) and
    (.rules.repository_id | test("^[0-9]+$")) and
    (.rules.repository_owner_id | test("^[0-9]+$")) and
    (.rules.actor_id | test("^[0-9]+$")) and
    .rules.aud == ("urn:pulumi:org:" + $org) and
    .rules.sub == (
      "repo:" + $repository_parts[0] + "@" + .rules.repository_owner_id +
      "/" + $repository_parts[1] + "@" + .rules.repository_id +
      ":environment:" + .rules.environment
    ) and
    .rules.ref == "refs/heads/main" and
    .rules.ref_type == "branch" and
    .rules.environment == "github-iac-production" and
    .rules.event_name == "workflow_dispatch" and
    .rules.workflow == "github-iac-production-deploy-v1" and
    .rules.runner_environment == "github-hosted" and
    .rules.repository_visibility == "private" and
    .rules.run_attempt == "1"
  ) and
  ([.personalAllowPolicies[].rules.repository] | unique | length) ==
    (.personalAllowPolicies | length)
' "$contract" >/dev/null || fail "bundled Pulumi OIDC policy contract is invalid"

organization="$(jq -er '.organization' "$contract")"
issuer_url="$(jq -er '.issuerUrl' "$contract")"
[[ "$organization" == "$stack_organization" ]] ||
  fail "policy contract organization does not match stack organization"
pulumi_bin="${PULUMI_BIN:-pulumi}"
[[ -x "$pulumi_bin" ]] || command -v "$pulumi_bin" >/dev/null 2>&1 ||
  fail "Pulumi CLI is unavailable: $pulumi_bin"

issuers="$temporary_directory/issuers.json"
"$pulumi_bin" api "/api/orgs/$organization/oidc/issuers" >"$issuers"
issuer_id="$(jq -er --arg url "$issuer_url" '
  if type != "object" or (.oidcIssuers | type) != "array" then
    error("invalid issuer response")
  else
    [.oidcIssuers[] | select(.url == $url)] |
    if length == 1 then .[0].id else error("expected exactly one issuer") end
  end
' "$issuers")"
[[ "$issuer_id" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] ||
  fail "Pulumi returned an invalid GitHub OIDC issuer ID"

policy="$temporary_directory/policy.json"
"$pulumi_bin" api "/api/orgs/$organization/auth/policies/oidcissuers/$issuer_id" >"$policy"
jq -e '
  type == "object" and
  (.version | type == "number" and floor == .) and
  (.policies | type == "array")
' "$policy" >/dev/null || fail "Pulumi returned an invalid OIDC policy response"

expected_policies="$temporary_directory/expected-policies.json"
actual_policies="$temporary_directory/actual-policies.json"
jq -S '.personalAllowPolicies | sort_by(.rules.repository)' "$contract" >"$expected_policies"
jq -S '[.policies[] | select(.decision == "allow" and .tokenType == "personal")]
  | sort_by(.rules.repository)' "$policy" >"$actual_policies"
if ! cmp -s "$expected_policies" "$actual_policies"; then
  printf '%s\n' '::error::Pulumi personal-token allow policies do not exactly match the reviewed contract.' >&2
  diff -u "$expected_policies" "$actual_policies" >&2 || true
  exit 1
fi

state="$temporary_directory/stack-state.json"
"$pulumi_bin" stack export --non-interactive --stack "$STACK_NAME" --file "$state"
jq -e '
  type == "object" and
  (.deployment | type == "object") and
  (.deployment.resources | type == "array")
' "$state" >/dev/null || fail "Pulumi returned an invalid stack export"

counts="$temporary_directory/resource-counts.json"
jq -cn --slurpfile requested "$requested_urns" --slurpfile state "$state" '
  $requested[0] |
  map(. as $urn | {
    urn: $urn,
    count: ([$state[0].deployment.resources[] | select(.urn == $urn)] | length)
  })
' >"$counts"
jq -e 'all(.[]; .count == 0 or .count == 1)' "$counts" >/dev/null ||
  fail "an operational resource URN appears more than once in stack state"

existing_json="$temporary_directory/existing.json"
missing_json="$temporary_directory/missing.json"
existing_targets="$temporary_directory/existing-targets.txt"
jq -c '[.[] | select(.count == 1) | .urn]' "$counts" >"$existing_json"
jq -c '[.[] | select(.count == 0) | .urn]' "$counts" >"$missing_json"
jq -r '.[]' "$existing_json" >"$existing_targets"

existing_count="$(jq -r 'length' "$existing_json")"
missing_count="$(jq -r 'length' "$missing_json")"
{
  printf 'existing-count=%s\n' "$existing_count"
  printf 'missing-count=%s\n' "$missing_count"
  printf 'existing-urns-json=%s\n' "$(cat "$existing_json")"
  printf 'missing-urns-json=%s\n' "$(cat "$missing_json")"
} >>"$GITHUB_OUTPUT"
write_multiline_output "existing-targets" "$existing_targets"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    printf '## Pulumi deployment guard passed\n\n'
    printf -- '- OIDC policy contract: %s\n' "$POLICY_CONTRACT"
    printf -- '- Existing operational resources: %s\n' "$existing_count"
    printf -- '- First-apply resources: %s\n' "$missing_count"
  } >>"$GITHUB_STEP_SUMMARY"
fi
