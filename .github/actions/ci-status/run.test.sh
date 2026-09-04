#!/usr/bin/env bash
# shellcheck shell=bash
# Fixture harness for the ci-status runner: lane aggregation, the ci-lanes
# commit-status write, and the carry-forward branch that reads it back.
#
# Every case names, in a comment, the check it would pass without. A case that
# still passes with its check removed proves nothing and does not belong here.
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

failures=0
log_file="$temporary_directory/log"
gh_log="$temporary_directory/gh-calls.log"
fixtures="$temporary_directory/fixtures"
calls="$temporary_directory/calls"
shim_directory="$temporary_directory/bin"
mkdir -p "$fixtures" "$calls" "$shim_directory"

sha=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
repository=melodic-software/ci-workflows

# A `gh` shim first on PATH: it serves fixture JSON keyed by method plus API
# path, records every call so the harness can assert on writes that did and did
# not happen, and can fail a keyed call a fixed number of times before
# succeeding (the retry case).
cat >"$shim_directory/gh" <<'SHIM'
#!/usr/bin/env bash
set -uo pipefail

printf '%s\n' "$*" >>"$GH_LOG"

method=GET
path=""
input=""
seen_api=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    api)
      seen_api=true
      shift
      ;;
    -X)
      method="$2"
      shift 2
      ;;
    --input)
      input="$2"
      shift 2
      ;;
    --paginate | --silent)
      shift
      ;;
    -*)
      shift
      ;;
    *)
      if [[ "$seen_api" == true && -z "$path" ]]; then
        path="$1"
      fi
      shift
      ;;
  esac
done

key="${method}_${path//\//_}"
if [[ -n "$input" && -f "$input" ]]; then
  cp -- "$input" "$GH_CALLS/${key}.input.json"
elif [[ "$input" == "-" ]]; then
  cat >"$GH_CALLS/${key}.input.json"
fi

fail_times="$GH_FIXTURES/${key}.fail-times"
if [[ -f "$fail_times" ]]; then
  remaining="$(cat "$fail_times")"
  if [[ "$remaining" -gt 0 ]]; then
    printf '%s\n' "$((remaining - 1))" >"$fail_times"
    echo "gh: Internal Server Error (HTTP 500)" >&2
    exit 1
  fi
fi

if [[ -f "$GH_FIXTURES/${key}.err" ]]; then
  cat "$GH_FIXTURES/${key}.err" >&2
  exit 1
fi

if [[ -f "$GH_FIXTURES/${key}.json" ]]; then
  cat "$GH_FIXTURES/${key}.json"
  exit 0
fi

echo '{}'
SHIM
chmod +x "$shim_directory/gh"

# run_case <expected-status> <results> <treat-skipped-as> <contract-only> [same-repo]
run_case() {
  local expected_status="$1" results="$2" treat_skipped_as="$3" contract_only="$4"
  local same_repo="${5-true}"
  local actual_status
  : >"$gh_log"
  rm -rf -- "$calls"
  mkdir -p "$calls"
  set +e
  env \
    PATH="$shim_directory:$PATH" \
    GH_LOG="$gh_log" \
    GH_FIXTURES="$fixtures" \
    GH_CALLS="$calls" \
    GH_TOKEN=fixture-token \
    RESULTS="$results" \
    TREAT_SKIPPED_AS="$treat_skipped_as" \
    CONTRACT_ONLY="$contract_only" \
    SAME_REPO="$same_repo" \
    STATUS_CONTEXT=ci-lanes \
    REPOSITORY="$repository" \
    SHA="$sha" \
    STATUS_RETRY_BASE_DELAY=0 \
    GITHUB_SERVER_URL=https://github.com \
    GITHUB_RUN_ID=4242 \
    bash "$script_directory/run.sh" >"$log_file" 2>&1
  actual_status=$?
  set -e
  if [[ "$actual_status" -ne "$expected_status" ]]; then
    echo "FAIL: expected exit $expected_status, got $actual_status"
    cat "$log_file"
    # Record and continue: the suite accumulates failures and reports them all.
    failures=$((failures + 1))
  fi
}

expect_log() {
  local expected="$1"
  if ! grep -qF -- "$expected" "$log_file"; then
    echo "FAIL: expected log to contain '$expected', got:"
    cat "$log_file"
    failures=$((failures + 1))
  fi
}

expect_no_log() {
  local unexpected="$1"
  if grep -qF -- "$unexpected" "$log_file"; then
    echo "FAIL: expected log NOT to contain '$unexpected', got:"
    cat "$log_file"
    failures=$((failures + 1))
  fi
}

expect_gh_call() {
  local expected="$1"
  if ! grep -qF -- "$expected" "$gh_log"; then
    echo "FAIL: expected a gh call matching '$expected', got:"
    cat "$gh_log"
    failures=$((failures + 1))
  fi
}

expect_no_gh_call() {
  local unexpected="$1"
  if grep -qF -- "$unexpected" "$gh_log"; then
    echo "FAIL: expected NO gh call matching '$unexpected', got:"
    cat "$gh_log"
    failures=$((failures + 1))
  fi
}

expect_status_payload() {
  local expected="$1"
  local payload="$calls/POST_repos_melodic-software_ci-workflows_statuses_${sha}.input.json"
  if [[ ! -f "$payload" ]]; then
    echo "FAIL: expected a recorded status payload, none written"
    cat "$gh_log"
    failures=$((failures + 1))
    return
  fi
  if ! grep -qF -- "$expected" "$payload"; then
    echo "FAIL: expected status payload to contain '$expected', got:"
    cat "$payload"
    failures=$((failures + 1))
  fi
}

combined_status() {
  # combined_status <json>
  printf '%s' "$1" >"$fixtures/GET_repos_melodic-software_ci-workflows_commits_${sha}_status.json"
}

# --- full mode -------------------------------------------------------------

# Without the lane-aggregation loop this passes anyway; without the status
# write it fails on the missing payload assertion.
echo 'case: full mode aggregates green lanes and records ci-lanes success'
run_case 0 'success success success' pass ''
expect_log 'All lanes passed or were skipped.'
expect_gh_call "POST repos/${repository}/statuses/${sha}"
expect_status_payload '"state": "success"'

# Without the failing-lane branch the run exits 0 and records success.
echo 'case: full mode records ci-lanes failure naming the failing lane position'
run_case 1 'success success failure success' pass ''
expect_log 'A lane did not pass (result: failure).'
expect_status_payload '"state": "failure"'
expect_status_payload 'lane 3 of 4 did not pass (result: failure)'

# Without the load-bearing status write (best-effort instead) this exits 0.
echo 'case: full mode fails the run when the status write is refused after retries'
printf '%s\n' 99 >"$fixtures/POST_repos_melodic-software_ci-workflows_statuses_${sha}.fail-times"
run_case 1 'success success' pass ''
expect_log 'All lanes passed or were skipped.'
expect_log "::error::could not record ci-lanes on ${sha} (500); the ci-status job needs statuses: write"
rm -f -- "$fixtures/POST_repos_melodic-software_ci-workflows_statuses_${sha}.fail-times"

# Without the retry loop the first 500 fails the run.
echo 'case: full mode passes when the status write succeeds on the second attempt'
printf '%s\n' 1 >"$fixtures/POST_repos_melodic-software_ci-workflows_statuses_${sha}.fail-times"
run_case 0 'success success' pass ''
expect_log 'retrying in 0s'
expect_log "Recorded ci-lanes=success on ${sha}."
rm -f -- "$fixtures/POST_repos_melodic-software_ci-workflows_statuses_${sha}.fail-times"

# Without the treat-skipped-as branch a skipped lane fails here.
echo 'case: treat-skipped-as pass lets a skipped lane through'
run_case 0 'success skipped success' pass ''
expect_log 'All lanes passed or were skipped.'
expect_status_payload '"state": "success"'

# Without the treat-skipped-as branch a skipped lane passes here.
echo 'case: treat-skipped-as fail rejects a skipped lane'
run_case 1 'success skipped success' fail ''
expect_log 'A lane did not pass (result: skipped).'
expect_status_payload '"state": "failure"'

# Without the policy validation an unrecognised value silently takes the laxer
# branch and this exits 0.
echo 'case: an unrecognised treat-skipped-as value is rejected'
run_case 1 'success' Fail ''
expect_log "::error::treat-skipped-as must be 'pass' or 'fail', got: Fail"
expect_no_gh_call 'statuses/'

# Without the post-split emptiness check an empty results string aggregates
# nothing and reports success.
echo 'case: empty results fails closed'
run_case 1 '   ' pass ''
expect_log '::error::results is required.'

# Without the contract-only branch test this would read a status instead of
# aggregating, and no fixture status exists for it. This is also the
# `edited`-with-`changes.base` shape: the caller's predicate is false, so a base
# change runs the full workflow and records a fresh verdict.
echo 'case: contract-only false aggregates and records normally'
run_case 1 'success failure' pass false
expect_log 'A lane did not pass (result: failure).'
expect_status_payload '"state": "failure"'
expect_no_gh_call "commits/${sha}/status"

# Without the empty-input fallback a push run, where the caller's expression
# renders empty, would take neither branch cleanly.
echo 'case: an empty contract-only input (push) aggregates normally'
run_case 0 'success success' pass ''
expect_log 'All lanes passed or were skipped.'
expect_no_gh_call "commits/${sha}/status"

# Without the boolean validation a typo resolves to a branch the caller did not
# ask for — the same failure mode treat-skipped-as validation exists to prevent.
echo 'case: an unrecognised contract-only value is rejected'
run_case 1 'success' pass True
expect_log "::error::contract-only must be 'true' or 'false', got: True"
expect_no_gh_call 'statuses/'

echo 'case: an unrecognised same-repo value is rejected'
run_case 1 'success' pass false yes
expect_log "::error::same-repo must be 'true' or 'false', got: yes"
expect_no_gh_call 'statuses/'

# --- fork pull requests ----------------------------------------------------

# Without the same-repo branch the write is attempted, the fork's read-only
# token refuses it, and the load-bearing failure turns every fork PR red.
echo 'case: same-repo false skips the status write and passes on the lanes verdict'
run_case 0 'success success' pass false false
expect_log 'All lanes passed or were skipped.'
expect_log '::notice::fork pull request: lane state is not recorded; every event runs the full workflow'
expect_no_gh_call 'statuses/'

# Without the lanes verdict surviving the fork branch, a fork PR would pass
# whatever its lanes did.
echo 'case: same-repo false still fails on a failing lane'
run_case 1 'success failure' pass false false
expect_log 'A lane did not pass (result: failure).'
expect_no_gh_call 'statuses/'

# Unreachable from the shipped defaults (the predicate is false for every fork
# event), but a caller that overrides contract-only owns the claim that the
# lanes did not run; branching on contract-only FIRST honours it instead of
# aggregating over results that are all `skipped`.
echo 'case: contract-only true with same-repo false is still carry-forward'
combined_status '{"state":"success","statuses":[{"context":"ci-lanes","state":"success"}]}'
run_case 0 'skipped skipped' fail true false
expect_log "Carried forward: ci-lanes is success on ${sha}."
expect_no_gh_call 'statuses/'

# --- carry-forward mode ----------------------------------------------------

# Without the carry-forward branch, `skipped skipped` under treat-skipped-as
# fail would go red.
echo 'case: carry-forward passes on a recorded ci-lanes success without aggregating'
combined_status '{"state":"success","statuses":[{"context":"ci-lanes","state":"success"}]}'
run_case 0 'skipped skipped' fail true
expect_log "Carried forward: ci-lanes is success on ${sha}."
expect_no_gh_call "statuses/${sha}"
expect_no_log 'All lanes passed'

# Without reading the per-context state, any 200 response would pass.
echo 'case: carry-forward fails on a recorded ci-lanes failure'
combined_status '{"state":"failure","statuses":[{"context":"ci-lanes","state":"failure"}]}'
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without the explicit `== success` test, a pending status would ride through.
echo 'case: carry-forward fails on a pending ci-lanes status'
combined_status '{"state":"pending","statuses":[{"context":"ci-lanes","state":"pending"}]}'
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without the context filter, another context's success would satisfy the gate.
echo 'case: carry-forward fails when no entry carries the ci-lanes context'
combined_status '{"state":"success","statuses":[{"context":"other-lane","state":"success"}]}'
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without the context filter, the FIRST entry (a failure under another context)
# would decide.
echo 'case: carry-forward selects the ci-lanes entry regardless of its position'
combined_status '{"state":"failure","statuses":[{"context":"other-lane","state":"failure"},{"context":"ci-lanes","state":"success"}]}'
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}."

# Without the API-failure branch a 404 would be read as an empty state and the
# error message would be the same, but the run must still fail rather than
# aborting under errexit inside the command substitution.
echo 'case: carry-forward fails closed when the combined status cannot be read'
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_commits_${sha}_status.json"
printf '%s\n' 'gh: Not Found (HTTP 404)' >"$fixtures/GET_repos_melodic-software_ci-workflows_commits_${sha}_status.err"
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_commits_${sha}_status.err"

# --- metadata contract -----------------------------------------------------

echo 'case: action.yml still wires every input this harness exercises'
action_metadata="$script_directory/action.yml"
for input_name in results treat-skipped-as contract-only same-repo status-context token repository sha; do
  if ! grep -qE "^  ${input_name}:" "$action_metadata"; then
    echo "FAIL: action.yml declares no '${input_name}' input"
    failures=$((failures + 1))
  fi
done
for environment_name in RESULTS TREAT_SKIPPED_AS CONTRACT_ONLY SAME_REPO STATUS_CONTEXT GH_TOKEN REPOSITORY SHA; do
  if ! grep -qF "        ${environment_name}: " "$action_metadata"; then
    echo "FAIL: action.yml does not pass '${environment_name}' to run.sh"
    failures=$((failures + 1))
  fi
done

if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed."
  exit 1
fi
echo 'All ci-status tests passed.'
