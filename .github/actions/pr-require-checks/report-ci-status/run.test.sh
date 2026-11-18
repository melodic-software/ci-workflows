#!/usr/bin/env bash
# shellcheck shell=bash
# Fixture harness for the report-ci-status composite's draft policy (draft.sh). The
# step order, the aggregation's `!cancelled()` and the hold drop are checked
# against action.yml by .github/scripts/ci-fanout-consolidation.test.cjs.
#
# Every case names, in a comment, the check it would pass without. A case that
# still passes with its check removed proves nothing and does not belong here.
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

failures=0
shim_directory="$temporary_directory/bin"
gh_log="$temporary_directory/gh-calls.log"
mkdir -p "$shim_directory"

# A `gh` shim first on PATH: it records each call and prints LIVE_DRAFT, the
# pull request's live `draft` field, or fails when GH_FAIL is set.
cat >"$shim_directory/gh" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
if [[ -n "${GH_FAIL:-}" ]]; then
  echo "gh: HTTP 502" >&2
  exit 1
fi
printf '%s\n' "$LIVE_DRAFT"
SHIM
chmod +x "$shim_directory/gh"

# run_case NAME EXPECTED_EXIT EXPECTED_OUTPUT EXPECTED_GH_CALLS VAR=VALUE...
run_case() {
  local name="$1" expected_exit="$2" expected_output="$3" expected_calls="$4"
  shift 4
  : >"$gh_log"
  local output exit_code=0
  output="$(env -i PATH="$shim_directory:$PATH" GH_LOG="$gh_log" \
    PR_URL=https://api.github.com/repos/o/r/pulls/7 GH_TOKEN=token "$@" \
    bash "$script_directory/draft.sh" 2>&1)" || exit_code=$?
  local calls
  calls="$(wc -l <"$gh_log" | tr -d ' ')"
  if [[ "$exit_code" != "$expected_exit" ]]; then
    echo "FAIL $name: exit $exit_code, expected $expected_exit; output: $output"
    failures=$((failures + 1))
  elif [[ "$output" != *"$expected_output"* ]]; then
    echo "FAIL $name: output lacks '$expected_output': $output"
    failures=$((failures + 1))
  elif [[ "$calls" != "$expected_calls" ]]; then
    echo "FAIL $name: $calls gh calls, expected $expected_calls"
    failures=$((failures + 1))
  else
    echo "ok $name"
  fi
}

# Without the policy check, a typo such as `refues` would silently allow.
run_case "an unknown policy fails" 1 "draft must be refuse or allow" 0 \
  DRAFT_POLICY=refues EVENT_DRAFT=true CONTRACT_ONLY=false
run_case "an empty policy fails" 1 "draft must be refuse or allow" 0 \
  DRAFT_POLICY= EVENT_DRAFT=false CONTRACT_ONLY=false

# Without the allow branch, `allow` would refuse a draft.
run_case "allow passes a draft" 0 "" 0 \
  DRAFT_POLICY=allow EVENT_DRAFT=true CONTRACT_ONLY=false

# Without the event-draft check, refuse would fail every pull request.
run_case "refuse passes a ready pull request" 0 "" 0 \
  DRAFT_POLICY=refuse EVENT_DRAFT=false CONTRACT_ONLY=false
run_case "refuse passes a push (no pull request)" 0 "" 0 \
  DRAFT_POLICY=refuse EVENT_DRAFT= CONTRACT_ONLY=false

# Without the refusal, a draft full run would pass.
run_case "refuse fails a draft full run without a live read" 1 \
  "draft pull request; mark it ready for review to pass" 0 \
  DRAFT_POLICY=refuse EVENT_DRAFT=true CONTRACT_ONLY=false LIVE_DRAFT=false

# Without the live read, a contract-only run re-run after ready_for_review
# would stay red on its draft-era payload.
run_case "refuse passes a contract-only re-run that is ready now" 0 \
  "Ready for review now" 1 \
  DRAFT_POLICY=refuse EVENT_DRAFT=true CONTRACT_ONLY=true LIVE_DRAFT=false

# Without reading the live value, a still-draft contract-only run would pass.
run_case "refuse fails a contract-only run that is still a draft" 1 \
  "draft pull request" 1 \
  DRAFT_POLICY=refuse EVENT_DRAFT=true CONTRACT_ONLY=true LIVE_DRAFT=true

# Without both `set -e` on the read and the exact `false` match, a failed read
# would pass as ready.
run_case "refuse fails closed when the live read fails" 1 "HTTP 502" 1 \
  DRAFT_POLICY=refuse EVENT_DRAFT=true CONTRACT_ONLY=true GH_FAIL=1

# Without the exact `false` match (a `!= true` test instead), a read that
# succeeds but prints nothing or `null` would pass as ready.
run_case "refuse fails closed on an empty live draft field" 1 \
  "draft pull request" 1 \
  DRAFT_POLICY=refuse EVENT_DRAFT=true CONTRACT_ONLY=true LIVE_DRAFT=
run_case "refuse fails closed on a null live draft field" 1 \
  "draft pull request" 1 \
  DRAFT_POLICY=refuse EVENT_DRAFT=true CONTRACT_ONLY=true LIVE_DRAFT=null

if [[ "$failures" -gt 0 ]]; then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all draft policy cases passed"
