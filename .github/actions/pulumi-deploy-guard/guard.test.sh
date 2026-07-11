#!/usr/bin/env bash
set -euo pipefail

action_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
contract="$action_path/contracts/kyle-sexton-github-iac-v2.json"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

urn_one='urn:pulumi:production::project::github:index/actionsVariable:ActionsVariable::one-ci-policy'
urn_two='urn:pulumi:production::project::github:index/actionsVariable:ActionsVariable::two-ci-policy'
child_urn="urn:pulumi:production::project::component:index:Parent\$github:index/actionsVariable:ActionsVariable::child-ci-policy"
requested_urns="$(jq -cn --arg one "$urn_one" --arg two "$urn_two" '[$one, $two]')"

mock_pulumi="$temporary_directory/pulumi"
cat >"$mock_pulumi" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  api)
    if [[ "$2" == */oidc/issuers ]]; then
      cat "$MOCK_ISSUERS"
    elif [[ "$2" == */auth/policies/oidcissuers/* ]]; then
      cat "$MOCK_POLICY"
    else
      exit 90
    fi
    ;;
  stack)
    [[ "$2" == export ]] || exit 91
    shift 2
    output=''
    while (($#)); do
      case "$1" in
        --non-interactive) shift ;;
        --stack) shift 2 ;;
        --file) output="$2"; shift 2 ;;
        *) exit 92 ;;
      esac
    done
    [[ -n "$output" ]] || exit 93
    cp "$MOCK_STATE" "$output"
    ;;
  *) exit 94 ;;
esac
MOCK
chmod +x "$mock_pulumi"

issuers="$temporary_directory/issuers.json"
policy="$temporary_directory/policy.json"
state="$temporary_directory/state.json"
output="$temporary_directory/github-output"
stdout="$temporary_directory/stdout"
stderr="$temporary_directory/stderr"

reset_valid_fixtures() {
  requested_urns="$(jq -cn --arg one "$urn_one" --arg two "$urn_two" '[$one, $two]')"
  cat >"$issuers" <<'JSON'
{"oidcIssuers":[{"id":"b4302a8d-1111-4222-8333-123456789abc","url":"https://token.actions.githubusercontent.com"}]}
JSON
  jq -c '{version: 4, policies: .personalAllowPolicies}' "$contract" >"$policy"
  jq -cn --arg urn "$urn_one" '{deployment:{resources:[{urn:"urn:pulumi:production::project::pulumi:pulumi:Stack::project-production"},{urn:$urn}]}}' >"$state"
  : >"$output"
  : >"$stdout"
  : >"$stderr"
}

run_guard() {
  ACTION_PATH="${TEST_ACTION_PATH:-$action_path}" \
    GITHUB_OUTPUT="$output" \
    MOCK_ISSUERS="$issuers" \
    MOCK_POLICY="$policy" \
    MOCK_STATE="$state" \
    OPERATIONAL_RESOURCE_URNS_JSON="$requested_urns" \
    POLICY_CONTRACT='kyle-sexton-github-iac-v2' \
    PULUMI_BIN="$mock_pulumi" \
    STACK_NAME="${TEST_STACK_NAME:-kyle-sexton/project/production}" \
    bash "$action_path/guard.sh" >"$stdout" 2>"$stderr"
}

expect_failure() {
  local description="$1"
  local status
  set +e
  run_guard
  status=$?
  set -e
  if ((status == 0)); then
    printf 'FAIL: %s unexpectedly passed\n' "$description" >&2
    exit 1
  fi
  printf 'PASS: %s\n' "$description"
}

reset_valid_fixtures
run_guard
grep -Fx 'existing-count=1' "$output" >/dev/null
grep -Fx 'missing-count=1' "$output" >/dev/null
grep -Fx "existing-urns-json=[\"$urn_one\"]" "$output" >/dev/null
grep -Fx "missing-urns-json=[\"$urn_two\"]" "$output" >/dev/null
grep -Fx "$urn_one" "$output" >/dev/null
printf 'PASS: exact policy and mixed established/first-apply state\n'

reset_valid_fixtures
requested_urns='[]'
run_guard
cat >"$temporary_directory/expected-policy-only-output" <<'OUTPUT'
existing-count=0
missing-count=0
existing-urns-json=[]
missing-urns-json=[]
existing-targets<<ci_runner_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
ci_runner_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
OUTPUT
cmp "$temporary_directory/expected-policy-only-output" "$output"
printf 'PASS: empty array performs policy-only validation with deterministic empty outputs\n'

reset_valid_fixtures
requested_urns='[]'
jq '.policies[0].rules.workflow = "github-iac-production-deploy-v2"' "$policy" >"$policy.tmp"
mv "$policy.tmp" "$policy"
expect_failure 'policy-only mode still requires the exact OIDC policy'
grep -F 'do not exactly match' "$stderr" >/dev/null

reset_valid_fixtures
requested_urns='[]'
jq -cn '{deployment:{resources:{}}}' >"$state"
expect_failure 'policy-only mode still requires a valid stack export shape'
grep -F 'invalid stack export' "$stderr" >/dev/null

reset_valid_fixtures
requested_urns='[]'
TEST_STACK_NAME='other/project/production' expect_failure 'policy-only mode still validates stack identity'
grep -F 'policy contract organization does not match stack organization' "$stderr" >/dev/null

invalid_action_path="$temporary_directory/invalid-action"
mkdir -p "$invalid_action_path/contracts"
for operator in '*' '?' '.'; do
  jq --arg operator "$operator" \
    '.personalAllowPolicies[0].rules.workflow += $operator' \
    "$contract" >"$invalid_action_path/contracts/kyle-sexton-github-iac-v2.json"
  reset_valid_fixtures
  TEST_ACTION_PATH="$invalid_action_path" \
    expect_failure "bundled contract rejects Pulumi '$operator' matcher semantics"
  grep -F 'bundled Pulumi OIDC policy contract is invalid' "$stderr" >/dev/null
done

reset_valid_fixtures
jq -cn '{deployment:{resources:[{urn:"urn:pulumi:production::project::pulumi:pulumi:Stack::project-production"}]}}' >"$state"
run_guard
grep -Fx 'existing-count=0' "$output" >/dev/null
grep -Fx 'missing-count=2' "$output" >/dev/null
printf 'PASS: first apply safely reports every operational resource absent\n'

reset_valid_fixtures
jq '.policies[0].rules.sub += "*"' "$policy" >"$policy.tmp"
mv "$policy.tmp" "$policy"
expect_failure 'Pulumi pattern metacharacter policy fails closed'
grep -F 'do not exactly match' "$stderr" >/dev/null

reset_valid_fixtures
jq '.policies[0].rules.workflow = "github-iac-production-deploy-v2"' "$policy" >"$policy.tmp"
mv "$policy.tmp" "$policy"
expect_failure 'near-match workflow claim fails closed'
grep -F 'do not exactly match' "$stderr" >/dev/null

reset_valid_fixtures
jq '.policies += [.policies[0]]' "$policy" >"$policy.tmp"
mv "$policy.tmp" "$policy"
expect_failure 'extra personal-token allow policy fails closed'

reset_valid_fixtures
jq --arg urn "$urn_one" '.deployment.resources += [{urn:$urn}]' "$state" >"$state.tmp"
mv "$state.tmp" "$state"
expect_failure 'duplicate operational URN in state fails closed'
grep -F 'appears more than once' "$stderr" >/dev/null

reset_valid_fixtures
jq '.oidcIssuers += [.oidcIssuers[0]]' "$issuers" >"$issuers.tmp"
mv "$issuers.tmp" "$issuers"
expect_failure 'duplicate matching GitHub issuer fails closed'

reset_valid_fixtures
POLICY_CONTRACT='missing-contract' \
  ACTION_PATH="$action_path" \
  GITHUB_OUTPUT="$output" \
  OPERATIONAL_RESOURCE_URNS_JSON="$requested_urns" \
  STACK_NAME='kyle-sexton/project/production' \
  bash "$action_path/guard.sh" >"$stdout" 2>"$stderr" && {
  printf 'FAIL: unknown policy contract unexpectedly passed\n' >&2
  exit 1
}
grep -F 'unknown policy contract' "$stderr" >/dev/null
printf 'PASS: unknown policy contract fails before authentication\n'

reset_valid_fixtures
requested_urns='["urn:pulumi:ok","urn:pulumi:ok"]'
expect_failure 'duplicate requested URNs fail before authentication'
grep -F 'operational-resource-urns-json is invalid' "$stderr" >/dev/null

reset_valid_fixtures
requested_urns='not-json'
expect_failure 'malformed operational resource JSON fails before authentication'
grep -F 'operational-resource-urns-json is invalid' "$stderr" >/dev/null

reset_valid_fixtures
requested_urns='{"urn":"urn:pulumi:production::project::github:index/actionsVariable:ActionsVariable::not-an-array"}'
expect_failure 'non-array operational resource JSON fails before authentication'
grep -F 'operational-resource-urns-json is invalid' "$stderr" >/dev/null

reset_valid_fixtures
requested_urns=$'[]\n[]'
expect_failure 'multiple JSON documents fail before authentication'
grep -F 'operational-resource-urns-json is invalid' "$stderr" >/dev/null

reset_valid_fixtures
requested_urns='["urn:pulumi:other::project::github:index/actionsVariable:ActionsVariable::wrong-stack"]'
expect_failure 'cross-stack operational URN fails before authentication'
grep -F 'must belong to the requested stack and project' "$stderr" >/dev/null

reset_valid_fixtures
requested_urns="$(jq -cn --arg urn "$child_urn" '[$urn]')"
run_guard
grep -Fx 'existing-count=0' "$output" >/dev/null
grep -Fx 'missing-count=1' "$output" >/dev/null
printf 'PASS: documented child-resource URN is accepted\n'

reset_valid_fixtures
requested_urns="$(jq -cn --arg one "$urn_one" --arg two "$urn_two" '[$one, $two]')"
TEST_STACK_NAME='other/project/production' expect_failure 'contract and stack organizations must match'
grep -F 'policy contract organization does not match stack organization' "$stderr" >/dev/null

printf 'Pulumi deployment guard contract tests passed.\n'
