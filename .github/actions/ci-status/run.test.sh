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

# A no-op `sleep` first on PATH. The carry-forward wait accounts for elapsed
# time arithmetically against its own 15-second interval, so shimming the sleep
# keeps the ceiling arithmetic real while the suite runs instantly — and, unlike
# a test-only poll-interval knob, it adds nothing to the shipped runner.
cat >"$shim_directory/sleep" <<'SLEEP_SHIM'
#!/usr/bin/env bash
exit 0
SLEEP_SHIM
chmod +x "$shim_directory/sleep"

# A `gh` shim first on PATH: it serves fixture JSON keyed by method plus API
# path, records every call so the harness can assert on writes that did and did
# not happen, can fail a keyed call a fixed number of times before succeeding
# (the retry case), and can serve a DIFFERENT body on the Nth call to the same
# key (`<key>.<n>.json`), which is how a status appearing mid-wait is fixtured.
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

# Fixture keys ignore the query string, so `?per_page=100` does not need a
# fixture of its own.
path="${path%%\?*}"
key="${method}_${path//\//_}"
if [[ -n "$input" && -f "$input" ]]; then
  cp -- "$input" "$GH_CALLS/${key}.input.json"
elif [[ "$input" == "-" ]]; then
  cat >"$GH_CALLS/${key}.input.json"
fi

count_file="$GH_CALLS/${key}.count"
call_number=1
if [[ -f "$count_file" ]]; then
  call_number="$(($(cat "$count_file") + 1))"
fi
printf '%s\n' "$call_number" >"$count_file"

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

if [[ -f "$GH_FIXTURES/${key}.${call_number}.json" ]]; then
  cat "$GH_FIXTURES/${key}.${call_number}.json"
  exit 0
fi

if [[ -f "$GH_FIXTURES/${key}.json" ]]; then
  cat "$GH_FIXTURES/${key}.json"
  exit 0
fi

echo '{}'
SHIM
chmod +x "$shim_directory/gh"

# run_case <expected-status> <results> <treat-skipped-as> <contract-only> [same-repo] [NAME=VALUE ...]
# Trailing NAME=VALUE pairs are appended to the `env` invocation, so they
# override the defaults set below (later assignments win).
run_case() {
  local expected_status="$1" results="$2" treat_skipped_as="$3" contract_only="$4"
  local same_repo="${5-true}"
  shift $(($# > 5 ? 5 : $#))
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
    CARRY_FORWARD_WAIT_SECONDS=0 \
    REPOSITORY="$repository" \
    SHA="$sha" \
    STATUS_RETRY_BASE_DELAY=0 \
    GITHUB_SERVER_URL=https://github.com \
    GITHUB_RUN_ID=4242 \
    "$@" \
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

# expect_gh_call_before <earlier-substring> <later-substring>
# The gh log is append-ordered, so line numbers are call order. This is what
# proves the wait runs BEFORE the status read rather than after it.
expect_gh_call_before() {
  local first="$1" second="$2" first_line second_line
  first_line="$(grep -nF -- "$first" "$gh_log" | head -n1 | cut -d: -f1)"
  second_line="$(grep -nF -- "$second" "$gh_log" | head -n1 | cut -d: -f1)"
  if [[ -z "$first_line" || -z "$second_line" || "$first_line" -ge "$second_line" ]]; then
    echo "FAIL: expected a gh call matching '$first' before one matching '$second', got:"
    cat "$gh_log"
    failures=$((failures + 1))
  fi
}

# The shim logs `$*`, which never contains the literal `gh api` — it starts at
# `api -X GET …` — so asserting on that string could never fire. Assert the log
# is empty instead.
expect_no_gh_calls_at_all() {
  if [[ -s "$gh_log" ]]; then
    echo 'FAIL: expected NO gh calls at all, got:'
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

# status_list <json-array>
# The LIST endpoint, newest entry first, as GitHub returns it.
status_list() {
  printf '%s' "$1" >"$fixtures/GET_repos_melodic-software_ci-workflows_commits_${sha}_statuses.json"
}

# bot_status / user_status <id> <state>
# The id is what `max_by(.id)` orders on; a higher id is a newer status.
bot_status() {
  printf '{"id":%s,"context":"ci-lanes","state":"%s","creator":{"login":"github-actions[bot]","type":"Bot"}}' "$1" "$2"
}

user_status() {
  printf '{"id":%s,"context":"ci-lanes","state":"%s","creator":{"login":"a-collaborator","type":"User"}}' "$1" "$2"
}

# --- carry-forward wait fixtures -------------------------------------------

statuses_key="GET_repos_melodic-software_ci-workflows_commits_${sha}_statuses"
current_run_key='GET_repos_melodic-software_ci-workflows_actions_runs_4242'
workflow_runs_key='GET_repos_melodic-software_ci-workflows_actions_workflows_777_runs'
# The run under test: workflow 777, created at 12:00:30Z. Every "earlier" run
# below is created before that instant and every "newer" one after it.
current_run_created_at='2026-09-05T12:00:30Z'

# status_list_on_call <n> <json-array>
# The status list served on the Nth read, so a status can appear mid-wait.
status_list_on_call() {
  printf '%s' "$2" >"$fixtures/${statuses_key}.${1}.json"
}

clear_status_fixtures() {
  rm -f -- "$fixtures/${statuses_key}".*.json "$fixtures/${statuses_key}.json"
}

clear_run_fixtures() {
  rm -f -- "$fixtures/${current_run_key}".* "$fixtures/${workflow_runs_key}".*
  rm -f -- "$fixtures/${current_run_key}.json" "$fixtures/${workflow_runs_key}.json"
}

current_run() {
  printf '{"id":4242,"workflow_id":777,"created_at":"%s"}' "$current_run_created_at" \
    >"$fixtures/${current_run_key}.json"
}

# workflow_runs <json-array-of-run-objects>
workflow_runs() {
  printf '{"workflow_runs":%s}' "$1" >"$fixtures/${workflow_runs_key}.json"
}

# workflow_runs_on_call <n> <json-array-of-run-objects>
# The run list served on the Nth poll, so an earlier run can finish mid-wait.
workflow_runs_on_call() {
  printf '{"workflow_runs":%s}' "$2" >"$fixtures/${workflow_runs_key}.${1}.json"
}

# run_entry <id> <status> <created_at>
run_entry() {
  printf '{"id":%s,"status":"%s","created_at":"%s"}' "$1" "$2" "$3"
}

earlier_full_run="$(run_entry 4000 in_progress 2026-09-05T12:00:00Z)"

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
status_list "[$(bot_status 100 success)]"
run_case 0 'skipped skipped' fail true false
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_no_gh_call 'statuses/'

# --- carry-forward mode ----------------------------------------------------

# Without the carry-forward branch, `skipped skipped` under treat-skipped-as
# fail would go red.
echo 'case: carry-forward passes on a recorded ci-lanes success without aggregating'
status_list "[$(bot_status 100 success)]"
run_case 0 'skipped skipped' fail true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_gh_call "commits/${sha}/statuses?per_page=100"
expect_no_gh_call "POST repos/${repository}/statuses/${sha}"
expect_no_log 'All lanes passed'

# Without reading the per-context state, any 200 response would pass.
echo 'case: carry-forward fails on a recorded ci-lanes failure'
status_list "[$(bot_status 100 failure)]"
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without the explicit `== success` test, a pending status would ride through.
echo 'case: carry-forward fails on a pending ci-lanes status'
status_list "[$(bot_status 100 pending)]"
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without the context filter, another context's success would satisfy the gate.
echo 'case: carry-forward fails when no entry carries the ci-lanes context'
status_list '[{"context":"other-lane","state":"success","creator":{"login":"github-actions[bot]","type":"Bot"}}]'
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without the context filter, the FIRST entry (a failure under another context)
# would decide.
echo 'case: carry-forward selects the ci-lanes entry regardless of its position'
status_list "[{\"context\":\"other-lane\",\"state\":\"failure\",\"creator\":{\"login\":\"github-actions[bot]\",\"type\":\"Bot\"}},$(bot_status 100 success)]"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# Without the API-failure branch a 404 would be read as an empty state and the
# error message would be the same, but the run must still fail rather than
# aborting under errexit inside the command substitution.
echo 'case: carry-forward fails closed when the status list cannot be read'
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_commits_${sha}_statuses.json"
printf '%s\n' 'gh: Not Found (HTTP 404)' >"$fixtures/GET_repos_melodic-software_ci-workflows_commits_${sha}_statuses.err"
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_commits_${sha}_statuses.err"

# --- carry-forward: forged statuses ----------------------------------------
#
# Any collaborator with write can POST a commit status. Without the creator
# filter, one forged `ci-lanes=success` plus a label flip turns the sole
# required check green over failing lanes.

# Without the creator filter the newest entry is the user's success and passes.
echo 'case: a forged success by a user account does not satisfy the carry-forward'
status_list "[$(user_status 200 success),$(bot_status 100 failure)]"
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without newest-first selection an older user failure would shadow the bot's
# real success.
echo 'case: a bot success newer than a user failure passes'
status_list "[$(bot_status 200 success),$(user_status 300 failure)]"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# Without first-match-wins a later bot failure would be ignored in favour of the
# earlier success — a re-run that went red could then be carried forward green.
echo 'case: a bot failure newer than a bot success fails'
status_list "[$(bot_status 200 failure),$(bot_status 100 success)]"
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without the empty-list guard an absent status would read as an empty state.
echo 'case: an empty status list fails the carry-forward'
status_list '[]'
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without the creator filter, a context that ONLY a user ever wrote satisfies
# the gate — the plant-then-label attack in its simplest form.
echo 'case: the ci-lanes context present only from a user account fails'
status_list "[$(user_status 100 success)]"
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without the Bot type check, an account merely NAMED like the bot passes.
echo 'case: a user account impersonating the bot login fails'
status_list '[{"context":"ci-lanes","state":"success","creator":{"login":"github-actions[bot]","type":"User"}}]'
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without `max_by(.id)` the selection depends on the array order the API
# happens to return; an oldest-first list would then hand back the stale
# success and carry a superseded verdict forward.
echo 'case: an oldest-first status list still selects the newest bot entry'
status_list '[{"id":10,"context":"ci-lanes","state":"success","creator":{"login":"github-actions[bot]","type":"Bot"}},{"id":20,"context":"ci-lanes","state":"failure","creator":{"login":"github-actions[bot]","type":"Bot"}}]'
run_case 1 'skipped skipped' pass true
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

echo 'case: an oldest-first status list still carries a newer bot success forward'
status_list '[{"id":10,"context":"ci-lanes","state":"failure","creator":{"login":"github-actions[bot]","type":"Bot"}},{"id":20,"context":"ci-lanes","state":"success","creator":{"login":"github-actions[bot]","type":"Bot"}}]'
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# --- carry-forward: the bounded wait ---------------------------------------
#
# The branched concurrency group (ci-perf Phase 6b) stops a contract-only run
# queueing behind the full run whose `ci-lanes` status it reads, so the two race.
# Every case here sets the ceiling explicitly; the harness default is 0, which
# keeps every case above on the pre-6b fail-immediately path.

# Without the wait this run reads the status list while the earlier run is still
# in flight, and on an absent status goes red.
echo 'case: the wait holds until the earlier full run finishes, then reads the status'
clear_status_fixtures
clear_run_fixtures
status_list "[$(bot_status 100 success)]"
current_run
workflow_runs_on_call 1 "[${earlier_full_run}]"
workflow_runs_on_call 2 '[]'
run_case 0 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "Waiting 15s for earlier run(s) 4000 on ${sha} to finish (waited 0s of 60s)."
expect_log "Earlier run(s) on ${sha} finished after 15s; reading the ci-lanes status."
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_gh_call 'actions/runs/4242'
# The load-bearing ordering: without wait-before-read, a SHA already carrying an
# older green status lets a contract-only run bypass the full run in flight that
# is about to overwrite it.
expect_gh_call_before 'actions/workflows/777/runs' "commits/${sha}/statuses"

# Without the ceiling the loop never ends; without "never pass on timeout" this
# case exits 0 on the green status sitting on the SHA while an earlier run is
# still in flight — the exact bypass the ordering exists to prevent.
echo 'case: the wait exits 1 at the ceiling without reading the unsettled status'
clear_status_fixtures
clear_run_fixtures
status_list "[$(bot_status 100 success)]"
current_run
workflow_runs "[${earlier_full_run}]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=30
expect_log '::warning::reached the 30s carry-forward-wait-seconds ceiling with earlier run(s) 4000'
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow (waited 30s of 30s on earlier run(s): 4000)"
expect_no_gh_call "commits/${sha}/statuses"

# The single status read happens AFTER the wait, so what decides the gate is the
# verdict the earlier run left behind, not whatever was on the SHA when this run
# started. Serving a failure on that one read proves the decision comes from the
# post-wait state.
echo 'case: the status read after the wait takes the fresh verdict, not the pre-wait one'
clear_status_fixtures
clear_run_fixtures
status_list_on_call 1 "[$(bot_status 200 failure)]"
current_run
workflow_runs_on_call 1 "[${earlier_full_run}]"
workflow_runs_on_call 2 '[]'
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log 'Waiting 15s for earlier run(s) 4000'
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow (waited 15s of 60s on earlier run(s): 4000)"

# Same correction from the other side: a recorded FAILURE no longer
# short-circuits while an earlier run is incomplete, because that run may be the
# re-run about to replace it.
echo 'case: an existing failure status still waits while an earlier run is incomplete'
clear_status_fixtures
clear_run_fixtures
status_list "[$(bot_status 100 failure)]"
current_run
workflow_runs_on_call 1 "[${earlier_full_run}]"
workflow_runs_on_call 2 '[]'
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log 'Waiting 15s for earlier run(s) 4000'
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without the `created_at` ordering term this run waits on itself forever, and
# two contract-only runs wait on each other; without the status filter it waits
# on a run that already finished.
echo 'case: the wait ignores this run, newer runs, and completed runs'
clear_status_fixtures
clear_run_fixtures
status_list '[]'
current_run
workflow_runs "[$(run_entry 4242 in_progress "$current_run_created_at"),$(run_entry 5000 queued 2026-09-05T12:01:00Z),$(run_entry 3000 completed 2026-09-05T11:59:00Z)]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_gh_call 'actions/workflows/777/runs'
expect_no_log 'Waiting '
expect_no_log 'on earlier run(s)'
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"

# Without the 403 branch the missing scope reads as "no earlier run", which is
# the same outcome but unattributable. The run degrades to the pre-6b contract —
# read the recorded status and decide — and must not pass on an absent one.
echo 'case: a 403 on the workflow-runs endpoint warns naming actions: read and still fails'
clear_status_fixtures
clear_run_fixtures
status_list '[]'
current_run
printf '%s\n' 'gh: Resource not accessible by integration (HTTP 403)' >"$fixtures/${workflow_runs_key}.err"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "::warning::repos/${repository}/actions/workflows/777/runs returned HTTP 403; the ci-status job needs 'actions: read'"
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"
expect_no_log 'Waiting '

echo 'case: a 403 on the current-run fetch warns and never reaches the workflow-runs endpoint'
clear_status_fixtures
clear_run_fixtures
status_list '[]'
printf '%s\n' 'gh: Resource not accessible by integration (HTTP 403)' >"$fixtures/${current_run_key}.err"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "::warning::repos/${repository}/actions/runs/4242 returned HTTP 403; the ci-status job needs 'actions: read'"
expect_no_gh_call 'actions/workflows/'

# Without the `> 0` guard, a consumer that disabled the wait still pays two
# Actions API calls and still needs the `actions: read` scope.
echo 'case: carry-forward-wait-seconds 0 disables the wait and makes no Actions API call'
clear_status_fixtures
clear_run_fixtures
status_list '[]'
current_run
workflow_runs "[${earlier_full_run}]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=0
expect_log "::error::no successful ci-lanes status on ${sha}; re-run the full workflow"
expect_no_gh_call 'actions/'

# Without the runner-side default, an action.yml regression that stopped passing
# the input would silently disable the wait rather than fall back to 240.
echo 'case: an empty carry-forward-wait-seconds falls back to the 240-second default'
clear_status_fixtures
clear_run_fixtures
status_list '[]'
current_run
workflow_runs "[${earlier_full_run}]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=
expect_log '::warning::reached the 240s carry-forward-wait-seconds ceiling with earlier run(s) 4000'
expect_log 'waited 240s of 240s on earlier run(s): 4000'

# Without the validation a negative value makes the ceiling unreachable and the
# wait unbounded; a non-numeric one makes the arithmetic an error mid-wait.
echo 'case: a negative carry-forward-wait-seconds is rejected before any API call'
clear_run_fixtures
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=-5
expect_log '::error::carry-forward-wait-seconds must be a non-negative integer number of seconds, got: -5'
expect_no_gh_calls_at_all

echo 'case: a non-numeric carry-forward-wait-seconds is rejected before any API call'
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=soon
expect_log '::error::carry-forward-wait-seconds must be a non-negative integer number of seconds, got: soon'
expect_no_gh_calls_at_all

clear_status_fixtures

# --- input validation ------------------------------------------------------
#
# Every one of these values is interpolated into a `gh api` path.

echo 'case: a malformed repository is rejected before any API call'
run_case 1 'success' pass false true REPOSITORY='melodic-software/ci-workflows/../other'
expect_log '::error::repository must be OWNER/REPO'
expect_no_gh_calls_at_all

echo 'case: a malformed sha is rejected before any API call'
run_case 1 'success' pass false true SHA='HEAD'
expect_log '::error::sha must be a full 40-character lowercase commit SHA'
expect_no_gh_calls_at_all

# `status-context` is deliberately NOT validated: a context carrying a space is
# legal and never reaches a path. Without that decision this run goes red.
echo 'case: a status-context carrying a space is accepted and used verbatim'
run_case 0 'success success' pass false true STATUS_CONTEXT='CI Lanes'
expect_log 'Recorded CI Lanes=success'
expect_status_payload '"context": "CI Lanes"'

# --- metadata contract -----------------------------------------------------

echo 'case: action.yml still wires every input this harness exercises'
action_metadata="$script_directory/action.yml"
for input_name in results treat-skipped-as contract-only same-repo status-context carry-forward-wait-seconds token repository sha; do
  if ! grep -qE "^  ${input_name}:" "$action_metadata"; then
    echo "FAIL: action.yml declares no '${input_name}' input"
    failures=$((failures + 1))
  fi
done
for environment_name in RESULTS TREAT_SKIPPED_AS CONTRACT_ONLY SAME_REPO STATUS_CONTEXT CARRY_FORWARD_WAIT_SECONDS GH_TOKEN REPOSITORY SHA; do
  if ! grep -qF "        ${environment_name}: " "$action_metadata"; then
    echo "FAIL: action.yml does not pass '${environment_name}' to run.sh"
    failures=$((failures + 1))
  fi
done

# The published default is the contract consumers inherit when they pass
# nothing, and the design fixes it at 240 seconds (below cursor-plugins'
# five-minute ci-status job budget). A drift here is invisible to every case
# above, which sets the value explicitly.
if ! grep -qF "    default: '240'" "$action_metadata"; then
  echo "FAIL: action.yml does not default carry-forward-wait-seconds to 240"
  failures=$((failures + 1))
fi

if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed."
  exit 1
fi
echo 'All ci-status tests passed.'
