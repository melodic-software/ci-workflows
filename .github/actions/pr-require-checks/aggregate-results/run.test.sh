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

# The carry-forward red, one remedy per state read; see `fail_carry_forward`.
fail_prefix="::error::no successful ci-lanes status on ${sha}; "
absent_remedy='if a full run on this SHA is in flight, its ci-status check supersedes this one; otherwise re-run the full workflow'
failure_remedy="the lanes verdict is failure; fix the failing lane, or re-run that run's failed jobs if the failure was transient"
writer_failure_remedy="the lanes verdict is failure (https://github.com/${repository}/actions/runs/4000); fix the failing lane, or re-run that run's failed jobs if the failure was transient"
pending_remedy='full run on this SHA is still in flight, and its own ci-status check supersedes this one when it finishes. Re-run that run only if it was cancelled'
manual_closing="Once ci-lanes on ${sha} is success, re-run this run instead."
automatic_closing="A full run that records ci-lanes=success on ${sha} re-runs this run; re-run it yourself only if it stays red after that."

# A `sleep` and a `date` first on PATH that share a fake clock: sleeping
# advances it, and `date +%s` reads it. The wait's ceiling is elapsed wall-clock
# time, so this keeps the ceiling arithmetic real while the suite runs
# instantly, and adds nothing test-only to the shipped runner. Every sleep is
# logged so a case can assert that none happened.
clock_file="$temporary_directory/clock"
sleep_log="$temporary_directory/sleep.log"
cat >"$shim_directory/sleep" <<'SLEEP_SHIM'
#!/usr/bin/env bash
printf '%s\n' "$1" >>"$SLEEP_LOG"
printf '%s\n' "$(($(cat "$FAKE_CLOCK") + $1))" >"$FAKE_CLOCK"
SLEEP_SHIM
chmod +x "$shim_directory/sleep"
cat >"$shim_directory/date" <<'DATE_SHIM'
#!/usr/bin/env bash
if [[ "$*" != '+%s' ]]; then
  echo "date shim: only +%s is supported, got: $*" >&2
  exit 1
fi
cat "$FAKE_CLOCK"
DATE_SHIM
chmod +x "$shim_directory/date"

# A `gh` shim first on PATH: it serves fixture JSON keyed by method plus API
# path, records every call so the harness can assert on writes that did and did
# not happen, can fail a keyed call a fixed number of times before succeeding
# (the retry case), can serve a DIFFERENT body on the Nth call to the same key
# (`<key>.<n>.json`), which is how a status appearing mid-wait is fixtured, and
# can make every call to a key take time on the fake clock (`<key>.advance`).
# Under `-i` it prints `<key>.<n>.headers` or `<key>.headers` (a status line
# and header lines) before the output, as `gh api -i` does, and
# `<key>.<n>.err` fails only the Nth call with that stderr.
cat >"$shim_directory/gh" <<'SHIM'
#!/usr/bin/env bash
set -uo pipefail

printf '%s\n' "$*" >>"$GH_LOG"

method=GET
path=""
input=""
slurp=false
include=false
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
    --slurp)
      slurp=true
      shift
      ;;
    -i | --include)
      include=true
      shift
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

if [[ "$include" == true ]]; then
  for headers in "$GH_FIXTURES/${key}.${call_number}.headers" "$GH_FIXTURES/${key}.headers"; do
    if [[ -f "$headers" ]]; then
      cat "$headers"
      printf '\r\n'
      break
    fi
  done
fi

if [[ -f "$GH_FIXTURES/${key}.advance" ]]; then
  printf '%s\n' "$(($(cat "$FAKE_CLOCK") + $(cat "$GH_FIXTURES/${key}.advance")))" >"$FAKE_CLOCK"
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

# Fail one specific call to a key while every other call to it succeeds, which
# `.fail-times` (always the FIRST n) cannot express. A read that fails part way
# through the poll loop is a different path from one that fails on entry.
fail_on_call="$GH_FIXTURES/${key}.fail-on-call"
if [[ -f "$fail_on_call" && "$call_number" == "$(cat "$fail_on_call")" ]]; then
  echo "gh: Internal Server Error (HTTP 500)" >&2
  exit 1
fi

if [[ -f "$GH_FIXTURES/${key}.${call_number}.err" ]]; then
  cat "$GH_FIXTURES/${key}.${call_number}.err" >&2
  exit 1
fi

if [[ -f "$GH_FIXTURES/${key}.err" ]]; then
  cat "$GH_FIXTURES/${key}.err" >&2
  exit 1
fi

# Pagination as `gh` does it: `<key>.pages.json` holds an array of pages, which
# `--slurp` prints as one array and a bare `--paginate` prints one page after
# another. A one-page fixture is wrapped the same way under `--slurp`.
if [[ -f "$GH_FIXTURES/${key}.pages.json" ]]; then
  if [[ "$slurp" == true ]]; then
    cat "$GH_FIXTURES/${key}.pages.json"
  else
    jq -c '.[]' "$GH_FIXTURES/${key}.pages.json"
  fi
  exit 0
fi

body='{}'
if [[ -f "$GH_FIXTURES/${key}.${call_number}.json" ]]; then
  body="$(cat "$GH_FIXTURES/${key}.${call_number}.json")"
elif [[ -f "$GH_FIXTURES/${key}.json" ]]; then
  body="$(cat "$GH_FIXTURES/${key}.json")"
fi
if [[ "$slurp" == true ]]; then
  printf '[%s]\n' "$body"
else
  printf '%s\n' "$body"
fi
# A GraphQL body with an `errors` array, as gh 2.102.0 prints one: the body on
# stdout, `gh: <first message>` with no "(HTTP nnn)" on stderr, and exit 1.
if jq -e 'type == "object" and ((.errors // []) | length > 0)' <<<"$body" >/dev/null 2>&1; then
  printf 'gh: %s\n' "$(jq -r '.errors[0].message // ""' <<<"$body")" >&2
  exit 1
fi
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
  : >"$sleep_log"
  printf '0\n' >"$clock_file"
  rm -rf -- "$calls"
  mkdir -p "$calls"
  set +e
  env \
    PATH="$shim_directory:$PATH" \
    GH_LOG="$gh_log" \
    GH_FIXTURES="$fixtures" \
    GH_CALLS="$calls" \
    FAKE_CLOCK="$clock_file" \
    SLEEP_LOG="$sleep_log" \
    GH_TOKEN=fixture-token \
    RESULTS="$results" \
    TREAT_SKIPPED_AS="$treat_skipped_as" \
    CONTRACT_ONLY="$contract_only" \
    SAME_REPO="$same_repo" \
    STATUS_CONTEXT=ci-lanes \
    CARRY_FORWARD_WAIT_SECONDS=0 \
    RERUN_CONTRACT_ONLY_SIBLINGS=false \
    RECORD_PENDING=false \
    YIELD_TO_FULL_RUN=false \
    REPOSITORY="$repository" \
    SHA="$sha" \
    STATUS_RETRY_BASE_DELAY=0 \
    GITHUB_SERVER_URL=https://github.com \
    GITHUB_RUN_ID=4242 \
    GITHUB_EVENT_NAME=pull_request \
    RUNNER_NAME="$own_runner" \
    STEP_NAME= \
    JOB_CHECK_RUN_ID= \
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
# proves each poll LISTS the in-flight runs before it READS the status, the
# order that stops a sibling's flip to `completed` landing between the two.
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

# expect_status_reads <n>
# The shim counts calls per key, so this pins how many times the status list
# was read, independent of which fixture answered.
expect_status_reads() {
  local expected="$1" actual=0
  local count_file="$calls/GET_repos_melodic-software_ci-workflows_commits_${sha}_statuses.count"
  if [[ -f "$count_file" ]]; then
    actual="$(cat "$count_file")"
  fi
  if [[ "$actual" -ne "$expected" ]]; then
    echo "FAIL: expected $expected status read(s), got $actual"
    cat "$gh_log"
    failures=$((failures + 1))
  fi
}

# expect_calls <key> <n>
# How many times the shim served one key.
expect_calls() {
  local actual=0
  if [[ -f "$calls/${1}.count" ]]; then
    actual="$(cat "$calls/${1}.count")"
  fi
  if [[ "$actual" -ne "$2" ]]; then
    echo "FAIL: expected $2 call(s) to ${1}, got $actual"
    cat "$gh_log"
    failures=$((failures + 1))
  fi
}

expect_no_sleep() {
  if [[ -s "$sleep_log" ]]; then
    echo 'FAIL: expected no sleep, got:'
    cat "$sleep_log"
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

# writer_status <id> <state> <created_at> <writer-run-id>
# A bot status as a full run records it: `target_url` names the run that wrote
# it, which is how the wait recognizes that run's re-run.
writer_status() {
  printf '{"id":%s,"context":"ci-lanes","state":"%s","created_at":"%s","target_url":"https://github.com/%s/actions/runs/%s","creator":{"login":"github-actions[bot]","type":"Bot"}}' \
    "$1" "$2" "$3" "$repository" "$4"
}

# full_run_success <id>
# A success as this workflow's full run 4100 records it. Run 4100 is never in a
# run listing, so it is only ever the verified writer, never a sibling.
full_run_success() {
  writer_status "$1" success 2026-09-05T12:00:05Z 4100
}

# run_of_workflow <run-id> <workflow-id> [head-sha]
# The run object a carried success's writer is verified against; it ran on the
# SHA under test unless a head SHA is given.
run_of_workflow() {
  printf '{"id":%s,"workflow_id":%s,"head_sha":"%s"}' "$1" "$2" "${3:-$sha}" \
    >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_${1}.json"
}
run_of_workflow 4100 777
run_of_workflow 4000 777

# The gate job as the jobs API lists it: this run's, with this action's step
# running after the contract step; and a full run's, whose aggregate step ended
# with the given conclusion (`running` for a step still in progress).
own_runner='GitHub Actions 7'
own_gate_job='{"id":9100,"name":"ci-status","status":"in_progress","conclusion":null,"runner_name":"GitHub Actions 7","steps":[{"name":"Check the pull-request contract","status":"completed","conclusion":"success"},{"name":"Aggregate lane results","status":"in_progress","conclusion":null}]}'
# writer_gate_job <aggregate-step-conclusion|running> [job-conclusion]
writer_gate_job() {
  if [[ "$1" == running ]]; then
    printf '{"name":"ci-status","status":"in_progress","conclusion":null,"steps":[{"name":"Aggregate lane results","status":"in_progress","conclusion":null}]}'
  else
    printf '{"name":"ci-status","status":"completed","conclusion":"%s","steps":[{"name":"Check the pull-request contract","status":"completed","conclusion":"%s"},{"name":"Aggregate lane results","status":"completed","conclusion":"%s"}]}' \
      "${2:-$1}" "${2:-success}" "$1"
  fi
}
# writer_jobs <run-id> <aggregate-step-conclusion|running> [job-conclusion]
writer_jobs() {
  printf '{"jobs":[{"name":"lint","status":"completed","conclusion":"success","steps":[]},%s]}' "$(writer_gate_job "$2" "${3:-}")" \
    >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_${1}_jobs.json"
}
install_step_fixtures() {
  printf '{"jobs":[{"name":"lint","conclusion":"skipped"},%s]}' "$own_gate_job" \
    >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4242_jobs.json"
  writer_jobs 4100 success
  writer_jobs 4000 success
}
install_step_fixtures

# --- carry-forward wait fixtures -------------------------------------------

statuses_key="GET_repos_melodic-software_ci-workflows_commits_${sha}_statuses"
current_run_key='GET_repos_melodic-software_ci-workflows_actions_runs_4242'
# The run's workflow is read over GraphQL, the only GraphQL call this step makes.
graphql_key='POST_graphql'
workflow_runs_key='GET_repos_melodic-software_ci-workflows_actions_workflows_777_runs'
# The run under test: workflow 777, run id 4242, created at 12:00:30Z. Every
# incomplete sibling counts whatever its id, and only 4242 itself is excluded;
# ids on both sides of 4242 pin that, and the same-second `created_at` cases
# prove the runner ignores creation time.
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
  rm -f -- "$fixtures/${current_run_key}".* "$fixtures/${workflow_runs_key}".* "$fixtures/${graphql_key}".*
  rm -f -- "$fixtures/${current_run_key}.json" "$fixtures/${workflow_runs_key}.json" "$fixtures/${graphql_key}.json"
}

# run_resource <run-id> <workflow-id> [typename]
# `resource(url:)` for a run's URL, in the shape GitHub returned for a real run
# of this repository: `workflow.databaseId` is the REST `workflow_id`.
run_resource() {
  printf '{"data":{"run":{"__typename":"%s","databaseId":%s,"workflow":{"databaseId":%s}}}}' "${3:-WorkflowRun}" "$1" "$2" \
    >"$fixtures/${graphql_key}.json"
}

current_run() {
  printf '{"id":4242,"workflow_id":777,"created_at":"%s"}' "$current_run_created_at" \
    >"$fixtures/${current_run_key}.json"
  run_resource 4242 777
}
current_run

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

# attempt_entry <id> <status> <created_at> <run_attempt> <run_started_at>
# `run_started_at` is when the CURRENT attempt started; a re-run moves it and
# leaves `created_at` alone.
attempt_entry() {
  printf '{"id":%s,"status":"%s","created_at":"%s","run_attempt":%s,"run_started_at":"%s"}' "$1" "$2" "$3" "$4" "$5"
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
expect_log "::error::could not record ci-lanes on ${sha} (500); the calling job needs statuses: write"
rm -f -- "$fixtures/POST_repos_melodic-software_ci-workflows_statuses_${sha}.fail-times"

# Without the retry loop the first 500 fails the run.
echo 'case: full mode passes when the status write succeeds on the second attempt'
printf '%s\n' 1 >"$fixtures/POST_repos_melodic-software_ci-workflows_statuses_${sha}.fail-times"
run_case 0 'success success' pass ''
expect_log 'retrying in 0s'
expect_log "Recorded ci-lanes=success on ${sha}."
rm -f -- "$fixtures/POST_repos_melodic-software_ci-workflows_statuses_${sha}.fail-times"

# --- rate limits -----------------------------------------------------------
#
# A 403 or 429 is classified from its message and headers, not its status, and
# a rate limit waits once inside rate-limit-wait-seconds, then fails closed.
status_post_key="POST_repos_melodic-software_ci-workflows_statuses_${sha}"
primary_limit_message='gh: API rate limit exceeded for installation ID 1 (HTTP 403)'
clear_rate_limit_fixtures() {
  rm -f -- "$fixtures/${status_post_key}".*.err "$fixtures/${status_post_key}".*.headers
}

# Without the header capture the warning carries no x-ratelimit values, and
# without the classification it names a missing scope.
echo 'case: a primary-limit 403 reports status, message and headers, waits until the reset, and retries once'
printf '%s\n' "$primary_limit_message" >"$fixtures/${status_post_key}.1.err"
printf 'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 30\r\n' >"$fixtures/${status_post_key}.1.headers"
run_case 0 'success success' pass ''
expect_log "::warning::POST repos/${repository}/statuses/${sha} returned HTTP 403 (rate-limit): API rate limit exceeded for installation ID 1; x-ratelimit-remaining=0 x-ratelimit-reset=30 retry-after=absent"
expect_log 'rate limited; waiting 30s, then retrying once.'
expect_log "Recorded ci-lanes=success on ${sha}."
expect_no_log 'needs statuses: write'
if [[ "$(cat "$sleep_log")" != 30 ]]; then
  echo "FAIL: expected one 30s sleep, got: $(cat "$sleep_log")"
  failures=$((failures + 1))
fi
clear_rate_limit_fixtures

# Without the single-retry rule the second limit falls into the 1/2/4s retry
# loop, which GitHub says not to do on a secondary limit.
echo 'case: a call still rate limited after the wait fails closed without further retries'
printf '%s\n' "$primary_limit_message" >"$fixtures/${status_post_key}.1.err"
printf '%s\n' "$primary_limit_message" >"$fixtures/${status_post_key}.2.err"
printf 'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 30\r\n' >"$fixtures/${status_post_key}.1.headers"
printf 'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 3600\r\n' >"$fixtures/${status_post_key}.2.headers"
run_case 1 'success success' pass ''
expect_log 'x-ratelimit-remaining=0 x-ratelimit-reset=3600 retry-after=absent'
expect_log 'is still rate limited after the wait; not retrying.'
expect_log "::error::could not record ci-lanes on ${sha} (HTTP 403): rate limited past rate-limit-wait-seconds"
expect_no_log 'retrying in'
if [[ "$(cat "$calls/${status_post_key}.count")" != 2 ]]; then
  echo "FAIL: expected 2 status writes, got $(cat "$calls/${status_post_key}.count")"
  failures=$((failures + 1))
fi
clear_rate_limit_fixtures

# Without retry-after taking precedence the wait would run to the reset (50s).
echo 'case: a secondary-limit 429 with retry-after waits retry-after, not until the reset'
printf '%s\n' 'gh: You have exceeded a secondary rate limit. (HTTP 429)' >"$fixtures/${status_post_key}.1.err"
printf 'HTTP/2.0 429 Too Many Requests\r\nRetry-After: 7\r\nX-Ratelimit-Remaining: 12\r\nX-Ratelimit-Reset: 50\r\n' >"$fixtures/${status_post_key}.1.headers"
run_case 0 'success success' pass ''
expect_log 'returned HTTP 429 (rate-limit): You have exceeded a secondary rate limit.; x-ratelimit-remaining=12 x-ratelimit-reset=50 retry-after=7'
expect_log 'waiting 7s, then retrying once.'
if [[ "$(cat "$sleep_log")" != 7 ]]; then
  echo "FAIL: expected one 7s sleep, got: $(cat "$sleep_log")"
  failures=$((failures + 1))
fi
clear_rate_limit_fixtures

# Without `10#` a leading zero reads as octal: 010 would wait 8s, and 09 is an
# arithmetic error that ends the step.
echo 'case: a reset with leading zeros is read as decimal'
printf '%s\n' "$primary_limit_message" >"$fixtures/${status_post_key}.1.err"
printf 'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 010\r\n' >"$fixtures/${status_post_key}.1.headers"
run_case 0 'success success' pass ''
expect_log 'waiting 10s, then retrying once.'
if [[ "$(cat "$sleep_log")" != 10 ]]; then
  echo "FAIL: expected one 10s sleep, got: $(cat "$sleep_log")"
  failures=$((failures + 1))
fi
clear_rate_limit_fixtures

# Without the ten-digit bound the arithmetic overflows bash's integers and
# the wait comes out negative or wrong; an oversized value counts as absent.
echo 'case: an oversized retry-after or reset falls back to the 60s wait'
printf '%s\n' "$primary_limit_message" >"$fixtures/${status_post_key}.1.err"
printf 'HTTP/2.0 403 Forbidden\r\nRetry-After: 99999999999999999999\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 99999999999999999999\r\n' >"$fixtures/${status_post_key}.1.headers"
run_case 0 'success success' pass ''
expect_log 'waiting 60s, then retrying once.'
if [[ "$(cat "$sleep_log")" != 60 ]]; then
  echo "FAIL: expected one 60s sleep, got: $(cat "$sleep_log")"
  failures=$((failures + 1))
fi
clear_rate_limit_fixtures

# Without the cap check the run would sleep ten minutes past its job timeout.
echo 'case: a reset beyond rate-limit-wait-seconds fails closed at once and prints the reset time'
printf '%s\n' "$primary_limit_message" >"$fixtures/${status_post_key}.1.err"
printf 'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 600\r\n' >"$fixtures/${status_post_key}.1.headers"
run_case 1 'success success' pass '' true 'RATE_LIMIT_WAIT_SECONDS=60'
expect_log 'needs a 600s wait, more than the 60s left of rate-limit-wait-seconds (60); not waiting. The limit resets at 600 (1970-01-01T00:10:00Z).'
expect_log "::error::could not record ci-lanes on ${sha} (HTTP 403): rate limited past rate-limit-wait-seconds"
expect_no_sleep
clear_rate_limit_fixtures

# Without the permission branch this would wait as if rate limited, or name no
# scope at all.
echo 'case: a permission 403 names the scope and does not wait'
printf '%s\n' 'gh: Resource not accessible by integration (HTTP 403)' >"$fixtures/${status_post_key}.1.err"
printf 'HTTP/2.0 403 Forbidden\r\nX-Accepted-Github-Permissions: statuses=write\r\nX-Ratelimit-Remaining: 4999\r\n' >"$fixtures/${status_post_key}.1.headers"
run_case 0 'success success' pass ''
expect_log 'returned HTTP 403 (permission): Resource not accessible by integration; x-ratelimit-remaining=4999 x-ratelimit-reset=absent retry-after=absent x-accepted-github-permissions=statuses=write'
expect_no_log 'rate limited'
clear_rate_limit_fixtures

echo 'case: an out-of-range rate-limit-wait-seconds is rejected'
run_case 1 'success success' pass '' true 'RATE_LIMIT_WAIT_SECONDS=3601'
expect_log '::error::rate-limit-wait-seconds must be an integer number of seconds from 0 to 3600, got: 3601'

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

# Without the policy validation an unrecognized value silently takes the laxer
# branch and this exits 0.
echo 'case: an unrecognized treat-skipped-as value is rejected'
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
echo 'case: an unrecognized contract-only value is rejected'
run_case 1 'success' pass True
expect_log "::error::contract-only must be 'true' or 'false', got: True"
expect_no_gh_call 'statuses/'

echo 'case: an unrecognized same-repo value is rejected'
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
# lanes did not run; branching on contract-only FIRST honors it instead of
# aggregating over results that are all `skipped`.
echo 'case: contract-only true with same-repo false is still carry-forward'
status_list "[$(full_run_success 100)]"
run_case 0 'skipped skipped' fail true false
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_no_gh_call 'statuses/'

# --- carry-forward mode ----------------------------------------------------

# Without the carry-forward branch, `skipped skipped` under treat-skipped-as
# fail would go red.
echo 'case: carry-forward passes on a recorded ci-lanes success without aggregating'
status_list "[$(full_run_success 100)]"
run_case 0 'skipped skipped' fail true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_gh_call "commits/${sha}/statuses?per_page=100"
expect_no_gh_call "POST repos/${repository}/statuses/${sha}"
expect_no_log 'All lanes passed'

# Without reading the per-context state, any 200 response would pass.
echo 'case: carry-forward fails on a recorded ci-lanes failure'
status_list "[$(bot_status 100 failure)]"
run_case 1 'skipped skipped' pass true
expect_log "${fail_prefix}${failure_remedy}. ${manual_closing}"

# Without the explicit `== success` test, a pending status would ride through.
# Without the pending branch of the message, the reader is told to re-run a
# full run that is still in flight.
echo 'case: carry-forward fails on a pending ci-lanes status'
status_list "[$(bot_status 100 pending)]"
run_case 1 'skipped skipped' pass true
expect_log "${fail_prefix}${pending_remedy}. ${manual_closing}"
expect_no_log 're-run the full workflow'

# Without the context filter, another context's success would satisfy the gate.
echo 'case: carry-forward fails when no entry carries the ci-lanes context'
status_list '[{"context":"other-lane","state":"success","creator":{"login":"github-actions[bot]","type":"Bot"}}]'
run_case 1 'skipped skipped' pass true
expect_log "${fail_prefix}${absent_remedy}"

# Without the context filter, the FIRST entry (a failure under another context)
# would decide.
echo 'case: carry-forward selects the ci-lanes entry regardless of its position'
status_list "[{\"context\":\"other-lane\",\"state\":\"failure\",\"creator\":{\"login\":\"github-actions[bot]\",\"type\":\"Bot\"}},$(full_run_success 100)]"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# Without the API-failure branch a 404 would be read as an empty state and the
# error message would be the same, but the run must still fail rather than
# aborting under errexit inside the command substitution.
echo 'case: carry-forward fails closed when the status list cannot be read'
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_commits_${sha}_statuses.json"
printf '%s\n' 'gh: Not Found (HTTP 404)' >"$fixtures/GET_repos_melodic-software_ci-workflows_commits_${sha}_statuses.err"
run_case 1 'skipped skipped' pass true
expect_log "${fail_prefix}${absent_remedy}"
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
expect_log "${fail_prefix}${failure_remedy}"

# Without newest-first selection an older user failure would shadow the bot's
# real success.
echo 'case: a bot success newer than a user failure passes'
status_list "[$(full_run_success 200),$(user_status 300 failure)]"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# Without first-match-wins a later bot failure would be ignored in favor of the
# earlier success — a re-run that went red could then be carried forward green.
echo 'case: a bot failure newer than a bot success fails'
status_list "[$(bot_status 200 failure),$(full_run_success 100)]"
run_case 1 'skipped skipped' pass true
expect_log "${fail_prefix}${failure_remedy}"

# The marker a full run's first job writes under `record-pending`. Without
# newest-id selection the older success is carried forward while that full run
# is still in flight, which is the stale green the marker exists to stop.
echo 'case: a bot pending newer than a bot success fails'
status_list "[$(writer_status 200 pending 2026-09-05T12:00:20Z 4000),$(full_run_success 100)]"
run_case 1 'skipped skipped' pass true
expect_log "${fail_prefix}full run https://github.com/${repository}/actions/runs/4000 is still in flight"
expect_no_log 'Carried forward'

# Without the empty-list guard an absent status would read as an empty state.
echo 'case: an empty status list fails the carry-forward'
status_list '[]'
run_case 1 'skipped skipped' pass true
expect_log "${fail_prefix}${absent_remedy}"

# Without the creator filter, a context that ONLY a user ever wrote satisfies
# the gate — the plant-then-label attack in its simplest form.
echo 'case: the ci-lanes context present only from a user account fails'
status_list "[$(user_status 100 success)]"
run_case 1 'skipped skipped' pass true
expect_log "${fail_prefix}${absent_remedy}"

# Without the Bot type check, an account merely NAMED like the bot passes.
echo 'case: a user account impersonating the bot login fails'
status_list '[{"context":"ci-lanes","state":"success","creator":{"login":"github-actions[bot]","type":"User"}}]'
run_case 1 'skipped skipped' pass true
expect_log "${fail_prefix}${absent_remedy}"

# Without `max_by(.id)` the selection depends on the array order the API
# happens to return; an oldest-first list would then hand back the stale
# success and carry a superseded verdict forward.
echo 'case: an oldest-first status list still selects the newest bot entry'
status_list '[{"id":10,"context":"ci-lanes","state":"success","creator":{"login":"github-actions[bot]","type":"Bot"}},{"id":20,"context":"ci-lanes","state":"failure","creator":{"login":"github-actions[bot]","type":"Bot"}}]'
run_case 1 'skipped skipped' pass true
expect_log "${fail_prefix}${failure_remedy}"

echo 'case: an oldest-first status list still carries a newer bot success forward'
status_list "[$(bot_status 10 failure),$(full_run_success 20)]"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# --- carry-forward: the writer must be this workflow -------------------------

# Without the writer check this passes before any Actions call: the creator
# check alone accepts the success.
echo 'case: a success written by this workflow is carried after verifying its writer run'
status_list "[$(full_run_success 100)]"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_gh_call "-f url=https://github.com/${repository}/actions/runs/4242 -i"
expect_gh_call "GET repos/${repository}/actions/runs/4100"

# Without the workflow comparison a bot success from any workflow passes.
echo 'case: a bot success written by another workflow is rejected'
run_of_workflow 5000 888
status_list "[$(writer_status 100 success 2026-09-05T12:00:05Z 5000)]"
run_case 1 'skipped skipped' pass true
expect_log "::warning::the newest ci-lanes success on ${sha} was written by run 5000 of workflow 888, not this workflow (777); ignoring it."
expect_log "${fail_prefix}${absent_remedy}"

echo 'case: yield mode rejects a bot success written by another workflow'
clear_run_fixtures
current_run
workflow_runs '[]'
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log 'not this workflow (777); ignoring it.'
expect_log "${fail_prefix}${absent_remedy}"

# Without the exact-shape target_url parse, a URL on another repository that
# ends in a run id of this workflow would be looked up here and pass.
echo 'case: a bot success whose target_url names another repository is rejected'
status_list '[{"id":100,"context":"ci-lanes","state":"success","target_url":"https://github.com/someone/else/actions/runs/4100","creator":{"login":"github-actions[bot]","type":"Bot"}}]'
run_case 1 'skipped skipped' pass true
expect_log "::warning::the newest ci-lanes success on ${sha} names no run of ${repository} in its target_url; ignoring it."
expect_no_gh_call 'actions/runs/4100'

# Without the head_sha check, a real run of this workflow on another commit
# vouches for this one.
echo 'case: a success naming a run of this workflow on another SHA is rejected'
run_of_workflow 5100 777 cafebabecafebabecafebabecafebabecafebabe
status_list "[$(writer_status 100 success 2026-09-05T12:00:05Z 5100)]"
run_case 1 'skipped skipped' pass true
expect_log "::warning::the newest ci-lanes success on ${sha} names run 5100, which ran on cafebabecafebabecafebabecafebabecafebabe; ignoring it."
expect_log "${fail_prefix}${absent_remedy}"

# Without the `\z` anchor a run id followed by a newline still parses as the
# writer and is looked up.
echo 'case: a target_url with text after the run id on a new line is rejected'
status_list "[{\"id\":100,\"context\":\"ci-lanes\",\"state\":\"success\",\"target_url\":\"https://github.com/${repository}/actions/runs/4100\\n\",\"creator\":{\"login\":\"github-actions[bot]\",\"type\":\"Bot\"}}]"
run_case 1 'skipped skipped' pass true
expect_log 'names no run of'
expect_no_gh_call 'actions/runs/4100'

# Without the writer-step check, any real run of this workflow on this SHA
# vouches for a forged success, whatever its aggregate step concluded.
echo 'case: a success whose writer aggregate step failed is rejected'
status_list "[$(full_run_success 100)]"
writer_jobs 4100 failure
run_case 1 'skipped skipped' pass true
expect_log "::warning::the newest ci-lanes success on ${sha} names run 4100, whose step 'Aggregate lane results' of job 'ci-status' did not succeed (failure); ignoring it."
expect_log "${fail_prefix}${absent_remedy}"

# Without checking the step rather than the job, a full run whose job failed
# only on the contract check would never carry its lanes success to the
# contract-only run that fixes the title.
echo 'case: a success whose writer step passed while its job failed the contract check is carried'
writer_jobs 4100 success failure
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# Without the running state, a success whose writer step is still running would
# be carried before that step finished, or never waited for.
echo 'case: a success whose writer step is still running is waited for, then fails closed'
clear_run_fixtures
current_run
workflow_runs "[$(run_entry 4100 in_progress 2026-09-05T12:00:00Z)]"
writer_jobs 4100 running
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=30
expect_log "Run 4100 has not finished step 'Aggregate lane results' of job 'ci-status'"
expect_log "(waited 30s of 30s on in-flight run(s): 4100)"
expect_no_log 'Carried forward'

echo 'case: a success whose writer step finishes during the wait is carried'
writer_jobs 4100 running
cp -- "$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4100_jobs.json" \
  "$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4100_jobs.1.json"
writer_jobs 4100 success
run_case 0 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=30
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_log 'Waiting 15s for in-flight run(s) 4100'
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4100_jobs.1.json"
clear_run_fixtures
current_run

echo 'case: a bot success with no target_url is rejected'
status_list "[$(bot_status 100 success)]"
run_case 1 'skipped skipped' pass true
expect_log 'names no run of'
expect_log "${fail_prefix}${absent_remedy}"

# Without fail-closed handling an unreadable writer run would leave the success
# standing and pass.
echo 'case: a writer run that cannot be read fails closed'
status_list "[$(full_run_success 100)]"
printf '%s\n' 'gh: Resource not accessible by integration (HTTP 403)' \
  >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4100.err"
run_case 1 'skipped skipped' pass true
expect_log "::warning::repos/${repository}/actions/runs/4100 returned HTTP 403; the ci-status job needs 'actions: read'"
expect_no_log 'Carried forward'
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4100.err"

# Without the classification an unexplained 403 would name a scope the job
# may already hold.
echo 'case: an unclassified 403 reports its message and names no scope'
status_list "[$(full_run_success 100)]"
printf '%s\n' 'gh: Forbidden (HTTP 403)' \
  >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4100.err"
run_case 1 'skipped skipped' pass true
expect_log "::warning::repos/${repository}/actions/runs/4100 returned HTTP 403: Forbidden."
expect_no_log 'needs'
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4100.err"

echo 'case: a current run whose workflow cannot be read fails closed'
printf '%s\n' 'gh: Internal Server Error (HTTP 500)' >"$fixtures/${graphql_key}.err"
run_case 1 'skipped skipped' pass true
expect_no_log 'Carried forward'
expect_no_gh_call 'actions/runs/4100'
rm -f -- "$fixtures/${graphql_key}.err"

# --- GraphQL reads -------------------------------------------------------------

# Without the GraphQL read this run's workflow costs a REST call. The same
# case made 6 REST calls and no GraphQL call at 8b41a59
# (origin/main before this read moved to GraphQL).
echo 'case: a contract-only run carrying a success makes one REST call fewer than before'
status_list "[$(full_run_success 100)]"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_calls "$graphql_key" 1
expect_calls "$current_run_key" 0
rest_calls="$(grep -cv '^api -X POST graphql ' "$gh_log" || true)"
if [[ "$rest_calls" -ne 5 ]]; then
  echo "FAIL: expected 5 REST calls (6 at 8b41a59, less 1), got ${rest_calls}"
  cat "$gh_log"
  failures=$((failures + 1))
fi

# Without reading the GraphQL `errors` array a primary rate limit, which
# GraphQL answers with HTTP 200, is neither reported nor waited out, and the
# carry fails closed on the first throttled read. The type alone marks it: no
# header and no message here says rate limit.
echo 'case: a GraphQL RATE_LIMITED error on HTTP 200 is reported as a rate limit, waited out, and retried'
printf '{"data":null,"errors":[{"type":"RATE_LIMITED","message":"Throttled."}]}' >"$fixtures/${graphql_key}.1.json"
printf 'HTTP/2.0 200 OK\r\nX-Ratelimit-Resource: graphql\r\n' >"$fixtures/${graphql_key}.1.headers"
run_case 0 'skipped skipped' pass true
expect_log '::warning::POST graphql returned HTTP 200 with GraphQL error RATE_LIMITED (rate-limit): Throttled.; x-ratelimit-remaining=absent'
expect_log 'POST graphql is rate limited; waiting 60s, then retrying once.'
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_no_log "needs 'actions: read'"
expect_calls "$graphql_key" 2

# Without the rate-limit classification a second throttled read would be named
# a refusal; with it the carry still fails closed, never passes.
echo 'case: a GraphQL RATE_LIMITED error that outlasts the wait fails the carry closed'
printf '{"data":null,"errors":[{"type":"RATE_LIMITED","message":"Throttled."}]}' >"$fixtures/${graphql_key}.2.json"
printf 'HTTP/2.0 200 OK\r\nX-Ratelimit-Resource: graphql\r\n' >"$fixtures/${graphql_key}.2.headers"
run_case 1 'skipped skipped' pass true
expect_log 'POST graphql is still rate limited after the wait; not retrying.'
expect_log '::warning::graphql WorkflowRun 4242 is rate limited (HTTP 200).'
expect_no_log 'Carried forward'
rm -f -- "$fixtures/${graphql_key}".1.* "$fixtures/${graphql_key}".2.*

# Without checking which run the URL resolved to, a resource that is not this
# run would supply the workflow the carried writer is compared against.
echo 'case: a GraphQL run read that resolves to another run fails closed'
run_resource 5555 777
run_case 1 'skipped skipped' pass true
expect_log '::warning::run 4242 reported no workflow_id.'
expect_no_log 'Carried forward'

# Without the type check, an object of another type that carries this run's
# databaseId would supply the workflow the carried writer is compared against.
echo 'case: a GraphQL run read that resolves to a non-WorkflowRun fails closed'
run_resource 4242 777 CheckRun
run_case 1 'skipped skipped' pass true
expect_log '::warning::run 4242 reported no workflow_id.'
expect_no_log 'Carried forward'

# A URL GraphQL cannot resolve reads `null` with no error, which must never
# pass as a workflow.
echo 'case: a GraphQL run read with no run in its data fails closed'
printf '{"data":{"run":null}}' >"$fixtures/${graphql_key}.json"
run_case 1 'skipped skipped' pass true
expect_log '::warning::run 4242 reported no workflow_id.'
expect_no_log 'Carried forward'
current_run

# --- carry-forward: pagination -----------------------------------------------

# Without `--slurp` jq runs once per page, so the filter never sees both pages
# together and the newest entry on a later page is not selected.
echo 'case: the newest bot entry is selected across pages (failure on a later page)'
clear_status_fixtures
printf '[[%s],[%s]]' "$(full_run_success 10)" "$(bot_status 20 failure)" >"$fixtures/${statuses_key}.pages.json"
run_case 1 'skipped skipped' pass true
expect_log "${fail_prefix}${failure_remedy}"

echo 'case: the newest bot entry is selected across pages (success on a later page)'
printf '[[%s],[%s]]' "$(bot_status 10 failure)" "$(full_run_success 20)" >"$fixtures/${statuses_key}.pages.json"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
rm -f -- "$fixtures/${statuses_key}.pages.json"

# --- carry-forward: the bounded wait ---------------------------------------
#
# Every case here sets the ceiling explicitly; the harness default is 0, which
# keeps every case above on the fail-immediately path.

# Without the wait this run reads the absent status while the sibling is still
# in flight and goes red on the first poll.
echo 'case: the wait holds until the sibling full run finishes, then reads the status'
clear_status_fixtures
clear_run_fixtures
status_list_on_call 1 '[]'
status_list_on_call 2 "[$(full_run_success 100)]"
current_run
workflow_runs_on_call 1 "[${earlier_full_run}]"
workflow_runs_on_call 2 '[]'
run_case 0 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "Waiting 15s for in-flight run(s) 4000 on ${sha} to finish (waited 0s of 60s)."
expect_log "The ci-lanes status on ${sha} settled after 15s."
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_gh_call "-f url=https://github.com/${repository}/actions/runs/4242 -i"
# The load-bearing intra-poll ordering: listing after reading would let a
# sibling's flip to `completed` land between the two calls, reporting both "no
# status" and "nothing in flight" on a SHA that does carry a verdict.
expect_gh_call_before 'actions/workflows/777/runs' "commits/${sha}/statuses"

# Without the ceiling the loop never ends; without "never pass on timeout" a
# `pending` status would eventually have to resolve to something. Only `success`
# and `failure` are settled, so a status stuck at `pending` behind an in-flight
# sibling must run to the ceiling and fail rather than ride through.
echo 'case: a pending status behind an in-flight sibling runs to the ceiling and fails'
clear_status_fixtures
clear_run_fixtures
status_list "[$(bot_status 100 pending)]"
current_run
workflow_runs "[${earlier_full_run}]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=30
expect_log '::warning::reached the 30s carry-forward-wait-seconds ceiling with in-flight run(s) 4000'
expect_log "${fail_prefix}${pending_remedy} (waited 30s of 30s on in-flight run(s): 4000)"

# The ceiling is elapsed wall-clock time, API calls included. Each listing here
# takes 10 seconds, so after one 15-second sleep 35 seconds have passed and the
# 30-second ceiling is reached on the second poll. Counting only the sleeps
# (15, then 30) would poll a third time and report 30 of 30, which is how a
# large ceiling used to outlast the job budget sized for it.
echo 'case: the ceiling counts elapsed wall-clock time, not summed sleeps'
clear_status_fixtures
clear_run_fixtures
status_list "[$(bot_status 100 pending)]"
current_run
workflow_runs "[${earlier_full_run}]"
printf '%s\n' 10 >"$fixtures/${workflow_runs_key}.advance"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=30
expect_log "Waiting 15s for in-flight run(s) 4000 on ${sha} to finish (waited 10s of 30s)."
expect_log "${fail_prefix}${pending_remedy} (waited 35s of 30s on in-flight run(s): 4000)"
expect_no_log 'waited 30s of 30s'
rm -f -- "$fixtures/${workflow_runs_key}.advance"

# What decides the gate is the verdict the sibling left behind, not whatever was
# on the SHA when this run started. Serving nothing on the first read and a
# failure on the second proves the decision comes from the post-wait state.
echo 'case: the status read after the wait takes the fresh verdict, not the pre-wait one'
clear_status_fixtures
clear_run_fixtures
status_list_on_call 1 '[]'
status_list_on_call 2 "[$(bot_status 200 failure)]"
current_run
workflow_runs_on_call 1 "[${earlier_full_run}]"
workflow_runs_on_call 2 '[]'
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log 'Waiting 15s for in-flight run(s) 4000'
expect_log "${fail_prefix}${failure_remedy} (waited 15s of 60s on in-flight run(s): 4000)"

# A settled failure ends the wait even with a sibling incomplete, when that
# sibling is not the writer re-running (this status names no writer at all).
# An absent or `pending` status still waits, as the case above shows.
echo 'case: a settled status ends the wait even with a sibling still incomplete'
clear_status_fixtures
clear_run_fixtures
status_list "[$(bot_status 100 failure)]"
current_run
workflow_runs "[${earlier_full_run}]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_no_log 'Waiting '
expect_log "${fail_prefix}${failure_remedy}"

# Without the self-exclusion term this run waits on itself forever; without the
# status filter it waits on a run that already finished.
echo 'case: the wait ignores this run and completed runs'
clear_status_fixtures
clear_run_fixtures
status_list '[]'
current_run
workflow_runs "[$(run_entry 4242 in_progress "$current_run_created_at"),$(run_entry 3000 completed 2026-09-05T11:59:00Z)]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_gh_call 'actions/workflows/777/runs'
expect_no_log 'Waiting '
expect_no_log 'in-flight run(s):'
expect_log "${fail_prefix}${absent_remedy}"

# Without the 403 branch the missing scope reads as "no earlier run", which is
# the same outcome but unattributable. The run degrades to
# reading the recorded status and deciding, and must not pass on an absent one.
echo 'case: a 403 on the workflow-runs endpoint warns naming actions: read and still fails'
clear_status_fixtures
clear_run_fixtures
status_list '[]'
current_run
printf '%s\n' 'gh: Resource not accessible by integration (HTTP 403)' >"$fixtures/${workflow_runs_key}.err"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "::warning::repos/${repository}/actions/workflows/777/runs returned HTTP 403; the ci-status job needs 'actions: read'"
expect_log "${fail_prefix}${absent_remedy}"
expect_no_log 'Waiting '

# Without discarding the earlier poll's read, a listing that fails PART WAY
# through the wait decides on the state read before the sleep rather than the
# fresh one its own warning promises. Here the sibling records success during
# that sleep, so the stale read would fail a SHA that is green.
echo 'case: a listing failure mid-wait re-reads the status rather than using the pre-sleep one'
clear_status_fixtures
clear_run_fixtures
current_run
status_list_on_call 1 '[]'
status_list_on_call 2 "[$(full_run_success 100)]"
workflow_runs "[${earlier_full_run}]"
printf '%s\n' 2 >"$fixtures/${workflow_runs_key}.fail-on-call"
run_case 0 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "Waiting 15s for in-flight run(s) 4000 on ${sha} to finish (waited 0s of 60s)."
expect_log '::warning::could not read'
expect_log "Carried forward: ci-lanes is success on ${sha}"
rm -f -- "$fixtures/${workflow_runs_key}.fail-on-call"

echo 'case: a 403 on the current-run fetch warns and never reaches the workflow-runs endpoint'
clear_status_fixtures
clear_run_fixtures
status_list '[]'
printf '%s\n' 'gh: Resource not accessible by integration (HTTP 403)' >"$fixtures/${graphql_key}.err"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "::warning::graphql WorkflowRun 4242 returned HTTP 403; the ci-status job needs 'actions: read'"
expect_no_gh_call 'actions/workflows/'

# Without the `> 0` guard, a consumer that disabled the wait still pays two
# Actions API calls, still needs the `actions: read` scope, and holds its runner
# while a sibling is in flight. Wait 0 is one status read and nothing else.
echo 'case: carry-forward-wait-seconds 0 reads the status once, never waits, and makes no Actions API call'
clear_status_fixtures
clear_run_fixtures
status_list '[]'
current_run
workflow_runs "[${earlier_full_run}]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=0
expect_log "${fail_prefix}${absent_remedy}"
expect_no_gh_call 'actions/'
expect_status_reads 1
expect_no_sleep

echo 'case: carry-forward-wait-seconds 0 carries a recorded success after one read'
clear_status_fixtures
status_list "[$(full_run_success 100)]"
run_case 0 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=0
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_status_reads 1
expect_no_sleep

# Without the runner-side default, an action.yml regression that stopped passing
# the input would silently disable the wait rather than fall back to 240.
echo 'case: an empty carry-forward-wait-seconds falls back to the 240-second default'
clear_status_fixtures
clear_run_fixtures
status_list '[]'
current_run
workflow_runs "[${earlier_full_run}]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=
expect_log '::warning::reached the 240s carry-forward-wait-seconds ceiling with in-flight run(s) 4000'
expect_log 'waited 240s of 240s on in-flight run(s): 4000'

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

# --- carry-forward: waiting on ANY in-flight sibling ------------------------

# Without waiting on a HIGHER-id sibling this reads the absent status on the
# first poll and exits 1. The sibling is same-second AND higher-id, so
# neither a `created_at` term nor a run-id term puts it in the wait set.
echo 'case: a same-second sibling with a HIGHER run id is waited on until its status appears'
clear_status_fixtures
clear_run_fixtures
current_run
status_list_on_call 1 '[]'
status_list_on_call 2 '[]'
status_list_on_call 3 "[$(full_run_success 100)]"
workflow_runs "[$(run_entry 5000 in_progress "$current_run_created_at")]"
run_case 0 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "Waiting 15s for in-flight run(s) 5000 on ${sha} to finish (waited 0s of 60s)."
expect_log "Waiting 15s for in-flight run(s) 5000 on ${sha} to finish (waited 15s of 60s)."
expect_log "The ci-lanes status on ${sha} settled after 30s."
expect_log "Carried forward: ci-lanes is success on ${sha}"
# The enumerate still precedes the read WITHIN a poll. A sibling writes the
# status and flips to `completed` moments later; reading first would let that
# completion land in the gap and report both "no status" and "nothing in
# flight".
expect_gh_call_before 'actions/workflows/777/runs' "commits/${sha}/statuses"

# Without the empty-wait-set fast fail this sleeps to the ceiling on every SHA
# whose full run was cancelled or superseded, turning a prompt red into a
# four-minute one.
echo 'case: no sibling in flight and no status fails immediately without waiting'
clear_status_fixtures
clear_run_fixtures
current_run
status_list '[]'
workflow_runs "[$(run_entry 3000 completed 2026-09-05T11:59:00Z)]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "${fail_prefix}${absent_remedy}"
expect_no_log 'Waiting '
expect_no_log 'waited '

# The one case that waits to the ceiling: two or more contract-only runs on a
# SHA with no full run in flight and no status to release them. Each waits on
# the other until the ceiling and then FAILS. Without the fail-closed ceiling
# this would pass on an absent verdict, which is the whole gate. The pair is
# same-second and straddles this run's id (4100 below, 4300 above).
echo 'case: two contract-only siblings with no full run wait to the ceiling and fail closed'
clear_status_fixtures
clear_run_fixtures
current_run
status_list '[]'
workflow_runs "[$(run_entry 4100 in_progress "$current_run_created_at"),$(run_entry 4300 in_progress "$current_run_created_at")]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=30
expect_log "Waiting 15s for in-flight run(s) 4100 4300 on ${sha} to finish (waited 0s of 30s)."
expect_log '::warning::reached the 30s carry-forward-wait-seconds ceiling with in-flight run(s) 4100 4300'
expect_log "${fail_prefix}${absent_remedy} (waited 30s of 30s on in-flight run(s): 4100 4300)"

# Without `error` in the settled set this waits the full 60s on a verdict that
# can never change, then fails anyway. `error` is a terminal commit-status state
# like `failure`, and neither passes below, so waiting on one only delays a red.
echo 'case: an error status is settled and fails at once rather than waiting to the ceiling'
clear_status_fixtures
clear_run_fixtures
current_run
status_list "[$(bot_status 100 error)]"
workflow_runs "[${earlier_full_run}]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_no_log 'Waiting '
expect_log "${fail_prefix}the lanes verdict is error; fix the failing lane"

# --- carry-forward: a stale failure while its writer re-runs ----------------
#
# Full run 4000 fails and records ci-lanes=failure at 12:00:10Z. Someone re-runs
# it: attempt 2 starts at 12:00:20Z. A contract-only run arrives meanwhile.

stale_failure="$(writer_status 100 failure 2026-09-05T12:00:10Z 4000)"
writer_rerun="$(attempt_entry 4000 in_progress 2026-09-05T11:59:00Z 2 2026-09-05T12:00:20Z)"

# Without holding a settled failure open for the writer's re-run, this reads
# the stale failure on the first poll and goes red while the re-run that
# replaces it is still in flight.
echo 'case: a stale failure waits for the in-flight re-run of its writer and carries its success'
clear_status_fixtures
clear_run_fixtures
current_run
status_list_on_call 1 "[${stale_failure}]"
status_list_on_call 2 "[$(writer_status 200 success 2026-09-05T12:04:00Z 4000),${stale_failure}]"
workflow_runs_on_call 1 "[${writer_rerun}]"
workflow_runs_on_call 2 '[]'
run_case 0 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "Waiting 15s for in-flight run(s) 4000 on ${sha} to finish (waited 0s of 60s)."
expect_log "The ci-lanes status on ${sha} settled after 15s."
expect_log "Carried forward: ci-lanes is success on ${sha}"

# Without the ceiling a re-run slower than it holds the run forever, and
# without "never pass on timeout" it would have to resolve to something.
echo 'case: a writer re-run that outlasts the ceiling fails closed naming it'
clear_status_fixtures
clear_run_fixtures
current_run
status_list "[${stale_failure}]"
workflow_runs "[${writer_rerun}]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=30
expect_log '::warning::reached the 30s carry-forward-wait-seconds ceiling with in-flight run(s) 4000'
expect_log "${fail_prefix}${writer_failure_remedy} (waited 30s of 30s on in-flight run(s): 4000). ${manual_closing}"

# Without the start-time term this waits on the writer's own first attempt,
# which records the status a moment before it completes, and turns a prompt
# red into a wait.
echo 'case: the writer attempt that recorded the failure is not waited on'
clear_status_fixtures
clear_run_fixtures
current_run
status_list "[${stale_failure}]"
workflow_runs "[$(attempt_entry 4000 in_progress 2026-09-05T11:59:00Z 1 2026-09-05T11:59:00Z)]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_no_log 'Waiting '
expect_log "${fail_prefix}${writer_failure_remedy}"

# Without narrowing the wait to the writer, a failed SHA brings back the mutual
# wait: each contract-only run holds the failure open for the other until the
# ceiling. 4300 is itself a re-run started after the failure, so a
# `run_attempt > 1` test in place of the writer test waits on it too.
echo 'case: two contract-only siblings on a failed SHA do not wait on each other'
clear_status_fixtures
clear_run_fixtures
current_run
status_list "[${stale_failure}]"
workflow_runs "[$(attempt_entry 4100 in_progress "$current_run_created_at" 1 "$current_run_created_at"),$(attempt_entry 4300 in_progress 2026-09-05T12:00:00Z 2 2026-09-05T12:01:00Z)]"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_no_log 'Waiting '
expect_log "${fail_prefix}${writer_failure_remedy}. ${manual_closing}"

# Without the unsettled-state fail a re-run of the full run that ends without
# recording anything would leave an absent status to pass. No status names no
# writer, so this is the ordinary wait on any sibling, and it still fails.
echo 'case: a missing status still fails after the re-run ends without recording one'
clear_status_fixtures
clear_run_fixtures
current_run
status_list '[]'
workflow_runs_on_call 1 "[${writer_rerun}]"
workflow_runs_on_call 2 '[]'
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "Waiting 15s for in-flight run(s) 4000 on ${sha} to finish (waited 0s of 60s)."
expect_log "${fail_prefix}${absent_remedy} (waited 15s of 60s on in-flight run(s): 4000)."
expect_no_log 'Carried forward'

# Without the closing remedy a red that outlived its failure gets a new commit
# (every lane again) where re-running this run is enough. Without naming the
# writer the reader has to hunt for the run whose failed jobs to re-run.
echo 'case: the failure message names the writer and the re-run-this-run remedy for a later success'
clear_status_fixtures
clear_run_fixtures
current_run
status_list "[${stale_failure}]"
workflow_runs '[]'
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "${fail_prefix}${writer_failure_remedy}. ${manual_closing}"

# The same step runs in both modes, so this run's rerun-contract-only-siblings
# is the full run's. Without branching the closing on it, the reader is told to
# re-run by hand a run the full run is about to re-run itself.
echo 'case: with rerun-contract-only-siblings the closing says the full run re-runs this run'
clear_status_fixtures
clear_run_fixtures
status_list "[$(writer_status 200 pending 2026-09-05T12:00:20Z 4000)]"
run_case 1 'skipped skipped' pass true true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "${fail_prefix}full run https://github.com/${repository}/actions/runs/4000 is still in flight, and its own ci-status check supersedes this one when it finishes. Re-run that run only if it was cancelled. ${automatic_closing}"
expect_no_log "$manual_closing"
expect_no_log 're-run the full workflow'
# A contract-only run never re-runs anything, even with the input on: the
# re-run is a full-mode step, which is what keeps it from looping.
expect_no_gh_call 'rerun-failed-jobs'
expect_no_gh_call 'actions/'

# The documented trade, pinned deliberately from the passing side. A recorded
# success ends the wait even with a sibling in flight, so a re-run of this SHA
# that is about to overwrite it does not hold the run. Without that the loop
# waits, and two contract-only runs on an already-green SHA would wait on each
# other to the ceiling and both go red.
echo 'case: a settled success ends the wait even with a sibling in flight'
clear_status_fixtures
clear_run_fixtures
current_run
status_list "[$(full_run_success 100)]"
workflow_runs "[${earlier_full_run}]"
run_case 0 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_no_log 'Waiting '
expect_log "Carried forward: ci-lanes is success on ${sha}"

# A status read that fails inside the wait takes one fresh re-read, and here
# every read fails, so the re-read fails too and the run goes red. Without
# discarding the failed read the caller would skip its re-read and decide on an
# unread state; without the fail-closed re-read this would pass on one. The
# stderr passes through so the cause is visible, not just the verdict.
echo 'case: a status read failure inside the wait fails closed and surfaces the cause'
clear_status_fixtures
clear_run_fixtures
current_run
workflow_runs "[${earlier_full_run}]"
printf '%s\n' 'gh: Not Found (HTTP 404)' >"$fixtures/${statuses_key}.err"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "::warning::could not read repos/${repository}/commits/${sha}/statuses (HTTP 404)"
expect_log "${fail_prefix}${absent_remedy}"
expect_log 'gh: Not Found (HTTP 404)'
rm -f -- "$fixtures/${statuses_key}.err"

# One transient 5xx on any one poll must not fail the sole required check: the
# loop reads this endpoint on every poll, up to sixteen times under the shipped
# ceiling. Without the retry through the degraded path the run goes red here
# even though the sibling recorded success and the very next read sees it.
echo 'case: a status read failing on one poll re-reads and carries the fresh success forward'
clear_status_fixtures
clear_run_fixtures
current_run
status_list_on_call 1 '[]'
status_list_on_call 3 "[$(full_run_success 100)]"
workflow_runs "[${earlier_full_run}]"
printf '%s\n' 2 >"$fixtures/${statuses_key}.fail-on-call"
run_case 0 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "Waiting 15s for in-flight run(s) 4000 on ${sha} to finish (waited 0s of 60s)."
expect_log "::warning::could not read repos/${repository}/commits/${sha}/statuses"
expect_log "Carried forward: ci-lanes is success on ${sha}"
rm -f -- "$fixtures/${statuses_key}.fail-on-call"

# The wait note names what this run waited on, so a sibling first seen on the
# poll whose read failed has to be in it. Without appending this poll's ids
# before the break, 4700 is missing from the message and the note understates
# the wait. The re-read here succeeds and returns an empty list, so the run
# still fails on the absent status.
echo 'case: a status read failing on a later poll names every sibling in the wait note'
clear_status_fixtures
clear_run_fixtures
current_run
status_list '[]'
workflow_runs_on_call 1 "[${earlier_full_run}]"
workflow_runs_on_call 2 "[${earlier_full_run},$(run_entry 4700 in_progress "$current_run_created_at")]"
printf '%s\n' 2 >"$fixtures/${statuses_key}.fail-on-call"
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "${fail_prefix}${absent_remedy} (waited 15s of 60s on in-flight run(s): 4000 4700)"
rm -f -- "$fixtures/${statuses_key}.fail-on-call"

# A sibling can finish without ever recording a verdict: cancelled, or failed
# before the ci-status job ran. The wait set empties, nothing more can write,
# and the run fails on the absent status rather than sleeping to the ceiling.
echo 'case: a sibling that finishes without writing a status fails on the emptied wait set'
clear_status_fixtures
clear_run_fixtures
current_run
status_list '[]'
workflow_runs_on_call 1 "[${earlier_full_run}]"
workflow_runs_on_call 2 '[]'
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "Waiting 15s for in-flight run(s) 4000 on ${sha} to finish (waited 0s of 60s)."
expect_log "No run on ${sha} is still in flight after 15s; using the ci-lanes status."
expect_log "${fail_prefix}${absent_remedy} (waited 15s of 60s on in-flight run(s): 4000)"

# A truncated body is what a cut-off response looks like: valid JSON up to the
# point the connection dropped. `status_list` writes its argument verbatim, so
# the missing `]` below is deliberate. jq exits nonzero on it. Without checking
# that status the read reports a completed read of an empty state, the run exits
# 1 for the wrong reason, and neither the warning nor the fresh re-read below
# happens. The warning is the assertion that separates the two.
echo 'case: a malformed statuses body fails the read rather than reading as an empty state'
clear_status_fixtures
clear_run_fixtures
current_run
status_list "[$(full_run_success 100)"
workflow_runs '[]'
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "::warning::could not read repos/${repository}/commits/${sha}/statuses"
expect_log "${fail_prefix}${absent_remedy}"
expect_no_log 'Waiting '

clear_status_fixtures

# --- pending mode ----------------------------------------------------------

status_write_key="POST_repos_melodic-software_ci-workflows_statuses_${sha}"

# Without pending mode, a contract-only run that reads the status while a full
# run is in flight carries an older run's success forward over lanes nobody has
# run yet. The marker names this run, which is how a contract-only red names
# the run to wait for. No aggregation: `results` is empty here and must not fail.
echo 'case: record-pending marks ci-lanes pending on a same-repository pull request and stops'
run_case 0 '' pass false true RECORD_PENDING=true
expect_status_payload '"state": "pending"'
expect_status_payload '"context": "ci-lanes"'
expect_status_payload "\"target_url\": \"https://github.com/${repository}/actions/runs/4242\""
expect_log "Recorded ci-lanes=pending on ${sha}"
expect_no_log 'results is required'
expect_no_gh_call 'actions/'
expect_no_gh_call "commits/${sha}/statuses"

echo 'case: record-pending writes on a pull_request_target event too'
run_case 0 '' pass false true RECORD_PENDING=true GITHUB_EVENT_NAME=pull_request_target
expect_status_payload '"state": "pending"'

# Without the contract-only guard this run would mark the verdict pending, and
# it and every contract-only sibling would go red with no full run coming to
# overwrite the marker.
echo 'case: record-pending on a contract-only event writes nothing and passes'
run_case 0 '' pass true true RECORD_PENDING=true
expect_log '::notice::contract-only event: ci-lanes is not marked pending'
expect_no_gh_calls_at_all

# Without the fork guard the read-only token's refused write fails the job.
echo 'case: record-pending on a fork pull request writes nothing and passes'
run_case 0 '' pass false false RECORD_PENDING=true
expect_log '::notice::fork pull request: ci-lanes is not marked pending'
expect_no_gh_calls_at_all

# Without the event guard a push leaves a pending marker on a main commit that
# no full pull-request run will ever overwrite.
echo 'case: record-pending on a push writes nothing and passes'
run_case 0 '' pass '' true RECORD_PENDING=true GITHUB_EVENT_NAME=push
expect_log '::notice::push event: ci-lanes is not marked pending'
expect_no_gh_calls_at_all

# Without the load-bearing write a refused marker passes silently, and the stale
# green it exists to stop comes back with nothing to say why.
echo 'case: record-pending fails the run when the write is refused after retries'
printf '%s\n' 99 >"$fixtures/${status_write_key}.fail-times"
run_case 1 '' pass false true RECORD_PENDING=true
expect_log "::error::could not record ci-lanes on ${sha} (500); the calling job needs statuses: write"
rm -f -- "$fixtures/${status_write_key}.fail-times"

echo 'case: an unrecognized record-pending value is rejected'
run_case 1 '' pass false true RECORD_PENDING=yes
expect_log "::error::record-pending must be 'true' or 'false', got: yes"
expect_no_gh_calls_at_all

# --- full mode: re-running failed contract-only siblings -------------------

# completed_run <id> <conclusion>
completed_run() {
  printf '{"id":%s,"status":"completed","conclusion":"%s"}' "$1" "$2"
}

# jobs_for <id> <conclusion>...
# The latest attempt's jobs of run <id>, one per conclusion.
jobs_for() {
  local id="$1" jobs="" conclusion
  shift
  for conclusion in "$@"; do
    jobs="${jobs}${jobs:+,}{\"name\":\"job\",\"conclusion\":\"${conclusion}\"}"
  done
  printf '{"jobs":[%s]}' "$jobs" >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_${id}_jobs.json"
}

clear_rerun_fixtures() {
  rm -f -- "$fixtures"/GET_repos_melodic-software_ci-workflows_actions_runs_*_jobs.* \
    "$fixtures"/POST_repos_melodic-software_ci-workflows_actions_runs_*
}

# 5000 and 4242 (this run, completed only in this fixture) are contract-only
# shaped: one failed gate, every other job skipped. 5100 is a failed full run,
# 5500 a failed single-job run, and 5200, 5300 and 5400 did not fail.
clear_run_fixtures
clear_rerun_fixtures
current_run
workflow_runs "[$(completed_run 5000 failure),$(completed_run 5100 failure),$(completed_run 5200 success),$(run_entry 5300 in_progress 2026-09-05T12:00:40Z),$(completed_run 5400 cancelled),$(completed_run 5500 failure),$(completed_run 4242 failure)]"
jobs_for 5000 failure skipped skipped
jobs_for 5100 success failure failure
jobs_for 5500 failure
jobs_for 4242 failure skipped skipped

# Without the re-run the contract-only red stays beside this run's green until
# someone re-runs it by hand. Without the shape test the failed full run 5100 is
# re-run too, every lane again for a verdict already recorded; without the
# single-job guard so is 5500; without the conclusion filter the green,
# in-flight and cancelled runs are fetched; without excluding this run's id it
# re-runs itself. A carry-forward wait above 0 without yield, so the in-flight
# run 5300 is not waited for (the in-flight wait has cases of its own below).
echo 'case: a full-mode success re-runs only the failed contract-only siblings'
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "Recorded ci-lanes=success on ${sha}."
expect_gh_call "POST repos/${repository}/actions/runs/5000/rerun-failed-jobs"
expect_log "Re-running failed contract-only run 5000 on ${sha}."
expect_log "Re-ran 1 failed contract-only run(s) on ${sha}."
for not_rerun in 5100 5500 4242; do
  expect_no_gh_call "actions/runs/${not_rerun}/rerun-failed-jobs"
done
for not_fetched in 5200 5300 5400 4242; do
  expect_no_gh_call "actions/runs/${not_fetched}/jobs"
done
# The re-run reads the status, so it must come after the write.
expect_gh_call_before "POST repos/${repository}/statuses/${sha}" 'rerun-failed-jobs'

# Without the success gate a failing run re-runs siblings that can only read
# its failure and go red again.
echo 'case: a full-mode failure re-runs nothing'
run_case 1 'success failure' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_status_payload '"state": "failure"'
expect_no_gh_call 'actions/'

# Without the opt-in every consumer would need `actions: write` on upgrade.
echo 'case: rerun-contract-only-siblings off by default makes no Actions call'
run_case 0 'success success' pass false true
expect_no_gh_call 'actions/'

echo 'case: a fork run re-runs nothing'
run_case 0 'success success' pass false false RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_no_gh_call 'actions/'

# The verdict is already recorded, so a refused re-run must not turn it red,
# and must not stop the next candidate.
echo 'case: a refused re-run warns naming actions: write and moves to the next sibling'
jobs_for 5600 failure skipped
workflow_runs "[$(completed_run 5000 failure),$(completed_run 5600 failure)]"
printf '%s\n' 'gh: Resource not accessible by integration (HTTP 403)' >"$fixtures/POST_repos_melodic-software_ci-workflows_actions_runs_5000_rerun-failed-jobs.err"
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "::warning::re-running run 5000 returned HTTP 403; rerun-contract-only-siblings needs 'actions: write' on the ci-status job."
expect_gh_call "POST repos/${repository}/actions/runs/5600/rerun-failed-jobs"
expect_log "Re-ran 1 failed contract-only run(s) on ${sha}."
rm -f -- "$fixtures/POST_repos_melodic-software_ci-workflows_actions_runs_5000_rerun-failed-jobs.err"

echo 'case: a jobs read failure skips that sibling and still passes'
printf '%s\n' 'gh: Internal Server Error (HTTP 500)' >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_5000_jobs.err"
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "::warning::could not read repos/${repository}/actions/runs/5000/jobs (HTTP 500). Not re-running run 5000."
expect_no_gh_call 'actions/runs/5000/rerun-failed-jobs'
expect_gh_call "POST repos/${repository}/actions/runs/5600/rerun-failed-jobs"
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_5000_jobs.err"

echo 'case: a 403 listing the runs warns naming actions: write and still passes'
printf '%s\n' 'gh: Resource not accessible by integration (HTTP 403)' >"$fixtures/${workflow_runs_key}.err"
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "::warning::repos/${repository}/actions/workflows/777/runs returned HTTP 403; the ci-status job needs 'actions: write'. Not re-running failed contract-only runs."
expect_no_gh_call 'rerun-failed-jobs'

# Without errexit off inside the re-run, jq failing on a cut-off body exits the
# script nonzero after the success is recorded, turning a green gate red.
echo 'case: a malformed run list re-runs nothing and still passes'
rm -f -- "$fixtures/${workflow_runs_key}.err"
printf '%s' '{"workflow_runs":[' >"$fixtures/${workflow_runs_key}.json"
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "Recorded ci-lanes=success on ${sha}."
expect_no_gh_call 'rerun-failed-jobs'

echo 'case: an unrecognized rerun-contract-only-siblings value is rejected'
run_case 1 'success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=on
expect_log "::error::rerun-contract-only-siblings must be 'true' or 'false', got: on"
expect_no_gh_calls_at_all

clear_run_fixtures
clear_rerun_fixtures

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

# --- carry-forward: yield to a full run in flight ----------------------------

# jobs_raw <id> <json-array-of-job-objects>
# The latest attempt's jobs of an in-flight run, where a running job's
# conclusion is null.
jobs_raw() {
  printf '{"jobs":%s}' "$2" >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_${1}_jobs.json"
}

# A full run's first job running; a contract-only run's lanes skipped and its
# gate running.
full_run_jobs='[{"name":"changes","conclusion":null}]'
contract_only_jobs='[{"name":"lint","conclusion":"skipped"},{"name":"test","conclusion":"skipped"},{"name":"ci-status","conclusion":null}]'
superseded_prefix="::error::superseded by full run https://github.com/${repository}/actions/runs/4000 in flight on ${sha}: its own ci-status check run is newer than this one and decides the merge gate. "
superseded_manual="Once ci-lanes on ${sha} is success, re-run this run."
superseded_automatic='It re-runs this run once it records ci-lanes=success; re-run this run yourself only if it stays red after that.'

reset_yield_fixtures() {
  clear_status_fixtures
  clear_run_fixtures
  clear_rerun_fixtures
  current_run
  install_step_fixtures
}

# Without the listing, an older `success` is carried across a full run that is
# queued or has not yet written its `pending` marker: the false green this mode
# exists to close.
echo 'case: yield fails at once, superseded, when a full run is in flight over an older success'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
workflow_runs "[${earlier_full_run}]"
jobs_raw 4000 "$full_run_jobs"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "${superseded_prefix}${superseded_manual}"
expect_no_log 'Carried forward'
expect_gh_call_before 'actions/workflows/777/runs' "commits/${sha}/statuses"
expect_status_reads 1
expect_no_sleep

# Without `queued` in the in-flight set, a full run waiting for a runner would
# read as nothing in flight and the older success would carry across it.
echo 'case: yield is superseded by a queued full run over an older success'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
workflow_runs "[$(run_entry 4000 queued 2026-09-05T12:00:00Z)]"
jobs_raw 4000 "$full_run_jobs"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "${superseded_prefix}${superseded_manual}"

# Without counting an unlisted run as full, a full run created a moment ago,
# whose jobs the API does not list yet, would read as nothing in flight.
echo 'case: yield counts an in-flight run with no jobs listed yet as a full run'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
workflow_runs "[${earlier_full_run}]"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "${superseded_prefix}${superseded_manual}"

# Without failing closed on an unreadable jobs list, a read error would drop
# the sibling and let the older success through.
echo 'case: yield counts an in-flight run whose jobs cannot be read as a full run'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
workflow_runs "[${earlier_full_run}]"
printf '%s\n' 'gh: Internal Server Error (HTTP 500)' >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4000_jobs.err"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "${superseded_prefix}${superseded_manual}"
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4000_jobs.err"

# Without the contract-only shape check, two contract-only runs on a green SHA
# would each fail on the other.
echo 'case: yield ignores an in-flight contract-only sibling and carries a recorded success'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
# This run (4242) is listed too: without excluding itself it would count as a
# full run in flight and always fail.
workflow_runs "[$(run_entry 4300 in_progress 2026-09-05T12:00:31Z),$(run_entry 4242 in_progress 2026-09-05T12:00:30Z)]"
jobs_raw 4300 "$contract_only_jobs"
run_case 0 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_no_sleep

# Without the gate-name check, a full run whose first job has finished and whose
# lanes were skipped, before its gate job exists, has the contract-only shape
# and the older success would carry across it.
echo 'case: yield is superseded by a full run whose lanes skipped before its gate exists'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
workflow_runs "[${earlier_full_run}]"
jobs_raw 4000 '[{"name":"changes","conclusion":"success"},{"name":"lint","conclusion":"skipped"},{"name":"test","conclusion":"skipped"}]'
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "${superseded_prefix}${superseded_manual}"

# Without failing closed on this run's own unreadable jobs, there is no gate
# name to match and a sibling's shape could not be told apart.
# Without the total_count check, a first page of 100 jobs in contract-only shape
# would hide a full-run job on a later page.
echo 'case: yield counts a sibling with more jobs than one page lists as a full run'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
workflow_runs "[$(run_entry 4300 in_progress 2026-09-05T12:00:31Z)]"
printf '{"total_count":150,"jobs":%s}' "$contract_only_jobs" >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4300_jobs.json"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log '::error::superseded by full run https://github.com/melodic-software/ci-workflows/actions/runs/4300'

echo 'case: yield counts every sibling as a full run when its own jobs cannot be read'
reset_yield_fixtures
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4242_jobs.json"
printf '%s\n' 'gh: Internal Server Error (HTTP 500)' >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4242_jobs.err"
status_list '[]'
workflow_runs "[$(run_entry 4300 in_progress 2026-09-05T12:00:31Z)]"
jobs_raw 4300 "$contract_only_jobs"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log '::error::superseded by full run https://github.com/melodic-software/ci-workflows/actions/runs/4300'
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4242_jobs.err"

echo 'case: yield with only a contract-only sibling in flight fails on an absent status without waiting'
reset_yield_fixtures
status_list '[]'
workflow_runs "[$(run_entry 4300 in_progress 2026-09-05T12:00:31Z)]"
jobs_raw 4300 "$contract_only_jobs"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "${fail_prefix}${absent_remedy}"
expect_no_log 'superseded'
expect_no_sleep

# Without the writer exclusion, the re-run a full run starts from its own gate
# job (which is still in flight) would read that run as superseding it and go
# red again.
echo 'case: yield ignores the in-flight full run whose attempt wrote the success'
reset_yield_fixtures
status_list "[$(writer_status 100 success 2026-09-05T12:05:00Z 4000)]"
workflow_runs "[$(attempt_entry 4000 in_progress 2026-09-05T12:00:00Z 1 2026-09-05T12:00:00Z)]"
writer_jobs 4000 success
run_case 0 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# Without the start-time test, a re-run of the writer would be ignored and this
# run would carry the success the re-run is about to replace.
echo 'case: yield is superseded by a re-run of the writer that started after its success'
reset_yield_fixtures
status_list "[$(writer_status 100 success 2026-09-05T12:05:00Z 4000)]"
workflow_runs "[$(attempt_entry 4000 in_progress 2026-09-05T12:00:00Z 2 2026-09-05T12:10:00Z)]"
jobs_raw 4000 "$full_run_jobs"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "${superseded_prefix}${superseded_manual}"

# Without restricting the exclusion to `success`, the writer of a `pending`
# marker would be ignored and the red would name no superseding run.
echo 'case: yield is superseded by the in-flight writer of a pending marker'
reset_yield_fixtures
status_list "[$(writer_status 100 pending 2026-09-05T12:00:10Z 4000)]"
workflow_runs "[$(attempt_entry 4000 in_progress 2026-09-05T12:00:00Z 1 2026-09-05T12:00:00Z)]"
jobs_raw 4000 "$full_run_jobs"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "${superseded_prefix}${superseded_automatic}"

# The late sibling: run 4000 recorded success and is still in its aggregate
# step, past its last listing of siblings, so nothing would re-run a red here.
# Without the wait this fails superseded by 4000; without re-reading after it,
# the step's completion is never seen.
writer_jobs_key='GET_repos_melodic-software_ci-workflows_actions_runs_4000_jobs'
writer_running_then_success() {
  writer_jobs 4000 running
  mv -- "$fixtures/${writer_jobs_key}.json" "$fixtures/${writer_jobs_key}.1.json"
  cp -- "$fixtures/${writer_jobs_key}.1.json" "$fixtures/${writer_jobs_key}.2.json"
  writer_jobs 4000 success
}
late_writer_runs="[$(attempt_entry 4000 in_progress 2026-09-05T12:00:00Z 1 2026-09-05T12:00:00Z)]"
echo 'case: yield carries a success whose writer step is still finishing once that step succeeds'
reset_yield_fixtures
status_list "[$(writer_status 100 success 2026-09-05T12:05:00Z 4000)]"
workflow_runs "$late_writer_runs"
writer_running_then_success
run_case 0 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "Run 4000 recorded ci-lanes=success on ${sha} and its step is still finishing; waiting 5s (waited 0s of 30s)."
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_no_log 'superseded'
expect_status_reads 2

# Without the ceiling a writer step that never finishes (a cancelled run) would
# hold this run to the job timeout; without failing at it, the unproven
# success would pass.
echo 'case: yield fails superseded when the writer step is still running at the ceiling'
reset_yield_fixtures
status_list "[$(writer_status 100 success 2026-09-05T12:05:00Z 4000)]"
workflow_runs "$late_writer_runs"
writer_jobs 4000 running
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "::warning::the step of run 4000 that recorded ci-lanes=success on ${sha} was still running after 30s."
expect_log "${superseded_prefix}${superseded_automatic}"
expect_no_log 'Carried forward'
if [[ "$(awk '{ total += $1 } END { print total + 0 }' "$sleep_log")" -ne 30 ]]; then
  echo "FAIL: expected the writer wait to sleep 30s in total, got: $(paste -sd' ' "$sleep_log")"
  failures=$((failures + 1))
fi

# Without keying the wait on the writer's running step, a `pending` marker newer
# than the success would be waited on as well; it means the lanes are running,
# and the full run re-runs this run once they pass.
echo 'case: yield fails at once on a pending marker newer than the success'
reset_yield_fixtures
status_list "[$(writer_status 101 pending 2026-09-05T12:06:00Z 4000),$(writer_status 100 success 2026-09-05T12:05:00Z 4000)]"
workflow_runs "$late_writer_runs"
writer_jobs 4000 running
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "${superseded_prefix}${superseded_automatic}"
expect_no_sleep
expect_status_reads 1

# Without failing closed on the re-read, a status read that fails during the
# writer wait would leave the first read's state in place.
echo 'case: yield fails closed when the status re-read fails during the writer wait'
reset_yield_fixtures
status_list "[$(writer_status 100 success 2026-09-05T12:05:00Z 4000)]"
workflow_runs "$late_writer_runs"
writer_running_then_success
printf '2\n' >"$fixtures/${statuses_key}.fail-on-call"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "${fail_prefix}${absent_remedy}"
expect_no_log 'Carried forward'
rm -f -- "$fixtures/${statuses_key}.fail-on-call"

echo 'case: yield fails closed when the status re-read cannot be parsed during the writer wait'
reset_yield_fixtures
status_list "[$(writer_status 100 success 2026-09-05T12:05:00Z 4000)]"
status_list_on_call 2 'not json'
workflow_runs "$late_writer_runs"
writer_running_then_success
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "${fail_prefix}${absent_remedy}"
expect_no_log 'Carried forward'

# A contract-only run starts late: full run 4000 recorded success and, still in
# its aggregate step, re-ran the failed contract-only run 4300, whose attempt 2
# lists only its queued gate so far. Without classifying a re-run attempt by
# its first attempt, 4300 counts as a full run and this run fails superseded by
# a run that never re-runs anything.
attempt_one_jobs() {
  printf '{"total_count":%s,"jobs":%s}' "$(jq length <<<"$2")" "$2" \
    >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_${1}_attempts_1_jobs.json"
}
rerun_sibling_jobs='[{"name":"ci-status","conclusion":null}]'
echo 'case: yield ignores a re-run attempt of a contract-only sibling whose new jobs are not listed yet'
reset_yield_fixtures
status_list "[$(writer_status 100 success 2026-09-05T12:05:00Z 4000)]"
workflow_runs "[$(attempt_entry 4000 in_progress 2026-09-05T12:00:00Z 1 2026-09-05T12:00:00Z),$(attempt_entry 4300 queued 2026-09-05T12:00:31Z 2 2026-09-05T12:05:02Z)]"
writer_running_then_success
jobs_raw 4300 "$rerun_sibling_jobs"
attempt_one_jobs 4300 '[{"name":"ci-status","conclusion":"failure"},{"name":"lint","conclusion":"skipped"},{"name":"test","conclusion":"skipped"}]'
run_case 0 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_no_log 'superseded'

# Without reading the first attempt's shape, rather than the attempt number
# alone, a re-run of a full run would be ignored and an older success carried
# across it.
echo 'case: yield is superseded by a re-run attempt of a full run'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
workflow_runs "[$(attempt_entry 4300 queued 2026-09-05T12:00:31Z 2 2026-09-05T12:05:02Z)]"
jobs_raw 4300 "$rerun_sibling_jobs"
attempt_one_jobs 4300 '[{"name":"changes","conclusion":"success"},{"name":"lint","conclusion":"failure"},{"name":"ci-status","conclusion":"failure"}]'
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log '::error::superseded by full run https://github.com/melodic-software/ci-workflows/actions/runs/4300'

echo 'case: yield counts a re-run attempt whose first attempt cannot be read as a full run'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
workflow_runs "[$(attempt_entry 4300 queued 2026-09-05T12:00:31Z 2 2026-09-05T12:05:02Z)]"
jobs_raw 4300 "$rerun_sibling_jobs"
printf '%s\n' 'gh: Internal Server Error (HTTP 500)' >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4300_attempts_1_jobs.err"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log '::error::superseded by full run https://github.com/melodic-software/ci-workflows/actions/runs/4300'
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_4300_attempts_1_jobs.err"

# Without yield overriding the wait, a 60-second ceiling would still poll.
echo 'case: yield with nothing in flight reads the status once and never waits'
reset_yield_fixtures
status_list "[$(bot_status 100 failure)]"
workflow_runs '[]'
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true CARRY_FORWARD_WAIT_SECONDS=60
expect_log "${fail_prefix}${failure_remedy}. ${manual_closing}"
expect_status_reads 1
expect_no_sleep

# Without failing closed, a refused listing would degrade to the bare status
# read and carry the older success across any full run in flight.
echo 'case: yield fails closed when the runs cannot be listed'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
printf '%s\n' 'gh: Resource not accessible by integration (HTTP 403)' >"$fixtures/${workflow_runs_key}.err"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "needs 'actions: read'"
expect_log "::error::could not list this workflow's runs on ${sha}, so a full run in flight cannot be ruled out; re-run this run."
expect_status_reads 0
rm -f -- "$fixtures/${workflow_runs_key}.err"

# Without the retry, one transient 5xx on the listing turns the sole required
# check red.
echo 'case: yield retries a transient listing failure'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
workflow_runs '[]'
printf '2\n' >"$fixtures/${workflow_runs_key}.fail-times"
run_case 0 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "Carried forward: ci-lanes is success on ${sha}"
rm -f -- "$fixtures/${workflow_runs_key}.fail-times"

echo 'case: an invalid yield-to-full-run value is rejected'
reset_yield_fixtures
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=yes
expect_log "::error::yield-to-full-run must be 'true' or 'false', got: yes"
expect_no_gh_calls_at_all

# Without the contract-only guard, a full run would list its siblings instead
# of aggregating its own lanes.
echo 'case: yield-to-full-run does not change full mode'
reset_yield_fixtures
run_case 0 'success success' pass false true YIELD_TO_FULL_RUN=true
expect_log 'All lanes passed or were skipped.'
expect_no_gh_call 'actions/'

# Without a line per failed run, a scan that re-runs nothing cannot show which
# runs it saw and why it passed over each.
echo 'case: a full-mode success logs each failed run it considered and why'
reset_yield_fixtures
workflow_runs "[$(completed_run 5000 failure),$(completed_run 5100 failure)]"
jobs_for 5000 failure skipped
jobs_for 5100 failure success
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true RERUN_WAIT_SECONDS=0
expect_log "Failed run(s) of this workflow on ${sha} to consider for a re-run: 5000 5100."
expect_log "Re-running failed contract-only run 5000 on ${sha}."
expect_log "Not re-running failed run 5100 on ${sha}: its latest attempt is not contract-only"

# --- full mode: waiting for in-flight contract-only siblings -----------------

rerun_runs_count="$calls/${workflow_runs_key}.count"
inflight_contract_only_jobs='[{"name":"lint","status":"completed","conclusion":"skipped"},{"name":"ci-status","status":"in_progress","conclusion":null}]'
inflight_full_jobs='[{"name":"changes","status":"completed","conclusion":"success"},{"name":"lint","status":"in_progress","conclusion":null},{"name":"ci-status","status":"queued","conclusion":null}]'

# expect_rerun_after_last_listing <run-id>
# The re-run must be issued after the final listing, never between polls: an
# early re-run would read this step's success while it is still running.
expect_rerun_after_last_listing() {
  local last_listing rerun_line
  last_listing="$(grep -nF 'actions/workflows/777/runs' "$gh_log" | tail -n1 | cut -d: -f1)"
  rerun_line="$(grep -nF "actions/runs/${1}/rerun-failed-jobs" "$gh_log" | head -n1 | cut -d: -f1)"
  if [[ -z "$last_listing" || -z "$rerun_line" || "$rerun_line" -le "$last_listing" ]]; then
    echo "FAIL: expected the re-run of ${1} after the last run listing, got:"
    cat "$gh_log"
    failures=$((failures + 1))
  fi
}

# The race #684 names. Without the wait, run 5300, still in flight on the
# first listing, finishes red after it and is never re-run, leaving its red
# check run on a green SHA. Without re-listing, the second poll could not see
# it complete; without issuing re-runs after the wait, the completed sibling
# 5000 is re-run while this step is still running.
echo 'case: under yield a full-mode success waits for an in-flight contract-only sibling, then re-runs it'
reset_yield_fixtures
workflow_runs_on_call 1 "[$(completed_run 5000 failure),$(run_entry 5300 in_progress 2026-09-05T12:00:40Z)]"
workflow_runs "[$(completed_run 5000 failure),$(completed_run 5300 failure)]"
jobs_for 5000 failure skipped
printf '{"jobs":%s}' "$inflight_contract_only_jobs" >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_5300_jobs.1.json"
jobs_for 5300 failure skipped
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true YIELD_TO_FULL_RUN=true
expect_log "Waiting 10s for in-flight run(s) 5300 on ${sha} to finish before re-running failed contract-only runs."
expect_gh_call "POST repos/${repository}/actions/runs/5300/rerun-failed-jobs"
expect_rerun_after_last_listing 5000
expect_rerun_after_last_listing 5300
expect_log "Re-ran 2 failed contract-only run(s) on ${sha}."

# A carry-forward wait of 0 reads once and never polls, so it has the same race.
echo 'case: with a carry-forward wait of 0 a full-mode success also waits for an in-flight contract-only sibling'
reset_yield_fixtures
workflow_runs_on_call 1 "[$(run_entry 5300 in_progress 2026-09-05T12:00:40Z)]"
workflow_runs "[$(completed_run 5300 failure)]"
printf '{"jobs":%s}' "$inflight_contract_only_jobs" >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_5300_jobs.1.json"
jobs_for 5300 failure skipped
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true CARRY_FORWARD_WAIT_SECONDS=0
expect_gh_call "POST repos/${repository}/actions/runs/5300/rerun-failed-jobs"

# Without excluding a known full run, every full run on a SHA with a second
# full run in flight would hold its required check open to the ceiling.
echo 'case: a full-mode success does not wait for an in-flight full run'
reset_yield_fixtures
workflow_runs "[$(completed_run 5000 failure),$(run_entry 5300 in_progress 2026-09-05T12:00:40Z)]"
jobs_for 5000 failure skipped
jobs_raw 5300 "$inflight_full_jobs"
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true YIELD_TO_FULL_RUN=true
expect_no_sleep
expect_gh_call "POST repos/${repository}/actions/runs/5000/rerun-failed-jobs"
expect_no_gh_call 'actions/runs/5300/rerun-failed-jobs'

# Without the mode check, a polling contract-only run, which waits on this run
# to finish, and this run, waiting on it, would hold each other to the ceiling.
echo 'case: with a carry-forward wait above 0 and no yield a full-mode success does not wait'
reset_yield_fixtures
workflow_runs "[$(run_entry 5300 in_progress 2026-09-05T12:00:40Z)]"
jobs_raw 5300 "$inflight_contract_only_jobs"
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true CARRY_FORWARD_WAIT_SECONDS=60
expect_no_sleep
expect_no_gh_call 'actions/runs/5300/jobs'

# Without counting an unreadable sibling as one to wait for, a jobs read error
# would drop a contract-only run back into the gap.
echo 'case: a full-mode success waits for an in-flight sibling whose jobs cannot be read'
reset_yield_fixtures
workflow_runs_on_call 1 "[$(run_entry 5300 in_progress 2026-09-05T12:00:40Z)]"
workflow_runs "[$(completed_run 5300 failure)]"
printf '1\n' >"$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_5300_jobs.fail-on-call"
jobs_for 5300 failure skipped
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true YIELD_TO_FULL_RUN=true
expect_log 'Waiting 10s for in-flight run(s) 5300'
expect_gh_call "POST repos/${repository}/actions/runs/5300/rerun-failed-jobs"
rm -f -- "$fixtures/GET_repos_melodic-software_ci-workflows_actions_runs_5300_jobs.fail-on-call"

# Without the ceiling a sibling that never finishes would hold this run's
# required check open until the job timeout. The success stays recorded and
# the completed sibling is still re-run.
echo 'case: a full-mode success stops waiting at the ceiling and still re-runs what completed'
reset_yield_fixtures
workflow_runs "[$(completed_run 5000 failure),$(run_entry 5300 in_progress 2026-09-05T12:00:40Z)]"
jobs_for 5000 failure skipped
jobs_raw 5300 "$inflight_contract_only_jobs"
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true YIELD_TO_FULL_RUN=true
expect_log "::warning::contract-only run(s) 5300 still in flight on ${sha} after 90s; not waiting longer to re-run them."
expect_gh_call "POST repos/${repository}/actions/runs/5000/rerun-failed-jobs"
expect_no_gh_call 'actions/runs/5300/rerun-failed-jobs'
if [[ "$(awk '{ total += $1 } END { print total + 0 }' "$sleep_log")" -ne 90 ]]; then
  echo "FAIL: expected the wait to sleep 90s in total, got: $(paste -sd' ' "$sleep_log")"
  failures=$((failures + 1))
fi
if [[ "$(cat "$rerun_runs_count")" -ne 10 ]]; then
  echo "FAIL: expected 10 run listings (one per 10s poll plus the last), got: $(cat "$rerun_runs_count")"
  failures=$((failures + 1))
fi

# Without reading the input, a consumer whose gate jobs queue longer could not
# move the ceiling without forking the action.
echo 'case: rerun-wait-seconds sets the ceiling of the in-flight wait'
reset_yield_fixtures
workflow_runs "[$(run_entry 5300 in_progress 2026-09-05T12:00:40Z)]"
jobs_raw 5300 "$inflight_contract_only_jobs"
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true YIELD_TO_FULL_RUN=true RERUN_WAIT_SECONDS=30
expect_log "::warning::contract-only run(s) 5300 still in flight on ${sha} after 30s; not waiting longer to re-run them."
if [[ "$(awk '{ total += $1 } END { print total + 0 }' "$sleep_log")" -ne 30 ]]; then
  echo "FAIL: expected the wait to sleep 30s in total, got: $(paste -sd' ' "$sleep_log")"
  failures=$((failures + 1))
fi

# Without the zero check, `0` would still list and read every in-flight
# sibling's jobs and log a ceiling warning.
echo 'case: rerun-wait-seconds 0 never waits'
run_case 0 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true YIELD_TO_FULL_RUN=true RERUN_WAIT_SECONDS=0
expect_no_sleep
expect_no_gh_call 'actions/runs/5300/jobs'

# Without validation a non-numeric value makes the arithmetic an error, which
# the `|| true` around the re-run would swallow silently.
echo 'case: a non-numeric rerun-wait-seconds is rejected'
run_case 1 'success success' pass false true RERUN_CONTRACT_ONLY_SIBLINGS=true RERUN_WAIT_SECONDS=soon
expect_log '::error::rerun-wait-seconds must be a non-negative integer number of seconds, got: soon'
expect_no_gh_calls_at_all

reset_yield_fixtures

# --- carry-forward: the writer must be a full run, and no newer full run on
# the SHA may disagree ---------------------------------------------------------

runs_key_prefix='GET_repos_melodic-software_ci-workflows_actions_runs'
# writer_run <run-id> <run_started_at> [run_attempt]
# The writer run object with the start of its latest attempt.
writer_run() {
  printf '{"id":%s,"workflow_id":777,"head_sha":"%s","run_started_at":"%s","run_attempt":%s}' "$1" "$sha" "$2" "${3:-1}" \
    >"$fixtures/${runs_key_prefix}_${1}.json"
}
# listed_run <id> <conclusion> <run_attempt> <run_started_at>
# A completed run of this workflow on the SHA, as the run listing shows it.
listed_run() {
  printf '{"id":%s,"status":"completed","conclusion":"%s","run_attempt":%s,"run_started_at":"%s"}' "$1" "$2" "$3" "$4"
}
# gate_jobs_json <json-array-of-other-jobs> <aggregate-step-conclusion> [contract-step-conclusion]
gate_jobs_json() {
  jq -c --argjson gate "$(writer_gate_job "$2" "${3:-}")" '. + [$gate]' <<<"$1"
}
# completed_gate_jobs <run-id> <json-array-of-other-jobs> <aggregate-step-conclusion> [contract-step-conclusion]
completed_gate_jobs() {
  printf '{"jobs":%s}' "$(gate_jobs_json "$2" "$3" "${4:-}")" >"$fixtures/${runs_key_prefix}_${1}_jobs.json"
}
skipped_lanes='[{"name":"lint","status":"completed","conclusion":"skipped"},{"name":"test","status":"completed","conclusion":"skipped"}]'
docs_only_lanes='[{"name":"changes","status":"completed","conclusion":"success"},{"name":"lint","status":"completed","conclusion":"skipped"},{"name":"test","status":"completed","conclusion":"skipped"}]'
writer_started='2026-09-05T12:00:00Z'
newer_started='2026-09-05T12:10:00Z'
older_started='2026-09-05T11:50:00Z'
not_full_warning="::warning::the newest ci-lanes success on ${sha} names run 4100, which is not a full run of this workflow"
clear_writer_fixtures() {
  local id
  for id in 4100 3900 4500 4600; do
    rm -f -- "${fixtures:?}/${runs_key_prefix:?}_${id}".*
  done
}
reset_writer_fixtures() {
  reset_yield_fixtures
  clear_writer_fixtures
  writer_run 4100 "$writer_started"
  status_list "[$(full_run_success 100)]"
}

# Without the shape check, a `success` naming a green contract-only run of this
# workflow on this SHA passes: its aggregate step succeeds when it carries.
echo 'case: a success naming a contract-only run is rejected'
reset_writer_fixtures
completed_gate_jobs 4100 "$skipped_lanes" success
run_case 1 'skipped skipped' pass true
expect_log "${not_full_warning} (its jobs read contract); ignoring it."
expect_log "${fail_prefix}${absent_remedy}"

# Without reading a re-run writer's first attempt, a re-run of a contract-only
# run whose latest attempt lists as full would vouch for the success.
echo 'case: a success naming a re-run whose first attempt is contract-only is rejected'
reset_writer_fixtures
writer_run 4100 "$writer_started" 2
attempt_one_jobs 4100 "$(gate_jobs_json "$skipped_lanes" success)"
run_case 1 'skipped skipped' pass true
expect_log "${not_full_warning} (its jobs read contract); ignoring it."
expect_gh_call "GET repos/${repository}/actions/runs/4100/attempts/1/jobs"

echo 'case: a re-run writer whose first attempt cannot be read fails closed'
reset_writer_fixtures
writer_run 4100 "$writer_started" 2
printf '%s\n' 'gh: Internal Server Error (HTTP 500)' >"$fixtures/${runs_key_prefix}_4100_attempts_1_jobs.err"
run_case 1 'skipped skipped' pass true
expect_log "::warning::could not read repos/${repository}/actions/runs/4100/attempts/1/jobs (HTTP 500)."
expect_no_log 'Carried forward'

# Without counting the change-detection job as a run lane, a full run whose path
# filters skipped every lane reads as contract-only and its success is lost.
echo 'case: a docs-only full run, lanes skipped but change detection run, is accepted as the writer'
reset_writer_fixtures
completed_gate_jobs 4100 "$docs_only_lanes" success
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# Without positive proof of a full run, a page listing fewer jobs than the run
# has could hide that only the gate ran.
echo 'case: a writer whose jobs page is incomplete is rejected'
reset_writer_fixtures
printf '{"total_count":150,"jobs":%s}' "$(gate_jobs_json "$docs_only_lanes" success)" >"$fixtures/${runs_key_prefix}_4100_jobs.json"
run_case 1 'skipped skipped' pass true
expect_log "${not_full_warning} (its jobs read unknown); ignoring it."

echo 'case: a writer whose jobs cannot be read fails closed'
reset_writer_fixtures
rm -f -- "$fixtures/${runs_key_prefix}_4100_jobs.json"
printf '%s\n' 'gh: Internal Server Error (HTTP 500)' >"$fixtures/${runs_key_prefix}_4100_jobs.err"
run_case 1 'skipped skipped' pass true
expect_log "::warning::could not read repos/${repository}/actions/runs/4100/jobs (HTTP 500)."
expect_no_log 'Carried forward'

# Retention deletes workflow runs and statuses; a status that outlives its run
# names a writer that reads 404. Without failing closed it would pass unverified.
echo 'case: a writer run deleted by retention (404) fails closed'
reset_writer_fixtures
rm -f -- "$fixtures/${runs_key_prefix}_4100.json"
printf '%s\n' 'gh: Not Found (HTTP 404)' >"$fixtures/${runs_key_prefix}_4100.err"
run_case 1 'skipped skipped' pass true
expect_log "::warning::could not read repos/${repository}/actions/runs/4100 (HTTP 404)."
expect_no_log 'Carried forward'

# Without the newer-run check, a `success` naming older green run 4100 overrides
# the failure newer full run 4500 recorded on the same SHA.
echo 'case: a newer full run whose aggregate step failed discards the carried success'
reset_writer_fixtures
workflow_runs "[$(listed_run 4100 success 1 "$writer_started"),$(listed_run 4500 failure 1 "$newer_started")]"
writer_jobs 4500 failure
run_case 1 'skipped skipped' pass true
expect_log "::warning::the newest ci-lanes success on ${sha} names run 4100, but newer full run 4500 on this SHA ended step 'Aggregate lane results' of job 'ci-status' with failure; ignoring it."
expect_log "${fail_prefix}${absent_remedy}"
expect_calls "${runs_key_prefix}_4100_jobs" 1

# Without judging the step rather than the run's conclusion, a cancelled run
# would be skipped although its aggregate step recorded a failure.
echo 'case: a newer full run that concluded cancelled with a failed aggregate step discards the carry'
reset_writer_fixtures
workflow_runs "[$(listed_run 4500 cancelled 1 "$newer_started")]"
writer_jobs 4500 failure cancelled
run_case 1 'skipped skipped' pass true
expect_log 'but newer full run 4500 on this SHA ended step'
expect_no_log 'Carried forward'

# Without ignoring a run that reached no verdict, a newer run whose gate step
# was skipped, or never listed, would discard every later carry.
echo 'case: a newer full run whose aggregate step was skipped is ignored'
reset_writer_fixtures
workflow_runs "[$(listed_run 4500 cancelled 1 "$newer_started")]"
writer_jobs 4500 skipped cancelled
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_gh_call "GET repos/${repository}/actions/runs/4500/jobs"

echo 'case: a newer full run with no aggregate step listed is ignored'
reset_writer_fixtures
workflow_runs "[$(listed_run 4500 cancelled 1 "$newer_started")]"
jobs_raw 4500 '[{"name":"lint","status":"completed","conclusion":"cancelled"},{"name":"ci-status","status":"completed","conclusion":"cancelled","steps":[]}]'
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# Without judging the aggregate step rather than the job, a newer full run that
# failed only its contract check would discard the lanes success that the
# contract-only run fixing the title, or dropping the label, must carry.
for contract_fix in 'title fix' 'do-not-merge label removed'; do
  echo "case: a newer full run that failed only its contract check does not discard the carry (${contract_fix})"
  reset_writer_fixtures
  workflow_runs "[$(listed_run 4500 failure 1 "$newer_started")]"
  writer_jobs 4500 success failure
  run_case 0 'skipped skipped' pass true
  expect_log "Carried forward: ci-lanes is success on ${sha}"
done

# Without the shape filter, a contract-only run that failed closed would
# discard every later carry on the SHA.
echo 'case: a newer contract-only run that failed does not discard the carry'
reset_writer_fixtures
workflow_runs "[$(listed_run 4500 failure 1 "$newer_started")]"
completed_gate_jobs 4500 "$skipped_lanes" failure
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# Without ordering by the latest attempt's start, a re-run of lower run id 3900
# that started after the writer would be taken as older, and run 4600, a higher
# id whose only attempt started before the writer, as newer.
echo 'case: newer is the latest attempt start time, not the run id'
reset_writer_fixtures
workflow_runs "[$(listed_run 3900 failure 2 "$newer_started"),$(listed_run 4600 failure 1 "$older_started")]"
writer_jobs 3900 failure
attempt_one_jobs 3900 "$(gate_jobs_json "$docs_only_lanes" failure)"
writer_jobs 4600 failure
run_case 1 'skipped skipped' pass true
expect_log 'but newer full run 3900 on this SHA ended step'
expect_no_gh_call 'actions/runs/4600/jobs'

echo 'case: an older full run whose aggregate step failed does not discard the carry'
reset_writer_fixtures
workflow_runs "[$(listed_run 4600 failure 1 "$older_started")]"
writer_jobs 4600 failure
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_no_gh_call 'actions/runs/4600/jobs'

# Without failing closed, a refused listing would skip the comparison.
echo 'case: a run listing that fails while verifying the writer fails closed'
reset_writer_fixtures
printf '%s\n' 'gh: Internal Server Error (HTTP 500)' >"$fixtures/${workflow_runs_key}.err"
run_case 1 'skipped skipped' pass true
expect_log "::warning::could not read repos/${repository}/actions/workflows/777/runs (HTTP 500)."
expect_no_log 'Carried forward'

echo 'case: a newer full run whose jobs cannot be read discards the carry'
reset_writer_fixtures
workflow_runs "[$(listed_run 4500 failure 1 "$newer_started")]"
printf '%s\n' 'gh: Internal Server Error (HTTP 500)' >"$fixtures/${runs_key_prefix}_4500_jobs.err"
run_case 1 'skipped skipped' pass true
expect_log 'Cannot rule out a newer verdict from run 4500'
expect_no_log 'Carried forward'

# Without reusing the poll's listing, the wait would list the runs twice per
# read; and the writer's one jobs read serves both the step and the shape.
echo 'case: the wait reuses its own run listing and the writer jobs read'
reset_writer_fixtures
workflow_runs "[$(listed_run 4500 success 1 "$newer_started")]"
writer_jobs 4500 success
run_case 0 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=30
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_calls "$workflow_runs_key" 1
expect_calls "${runs_key_prefix}_4100_jobs" 1

# At most one call more than before the shape and newer-run checks: the run
# listing. Before them a plain carry made five (this run, the status list, the
# writer run, this run's jobs, the writer's jobs).
echo 'case: carrying one success makes at most one extra API call'
reset_writer_fixtures
workflow_runs '[]'
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_calls "${runs_key_prefix}_4100_jobs" 1
if [[ "$(wc -l <"$gh_log")" -gt 6 ]]; then
  echo "FAIL: expected at most 6 API calls, got $(wc -l <"$gh_log")"
  cat "$gh_log"
  failures=$((failures + 1))
fi

clear_writer_fixtures
run_of_workflow 4100 777
reset_yield_fixtures

# --- carry-forward: reads reused across the writer check and the polls --------

# row_of_run <id> <workflow-id> <head-sha> [status]
# A run as the run listing shows it, with the fields the writer check reads.
row_of_run() {
  printf '{"id":%s,"status":"%s","conclusion":"success","workflow_id":%s,"head_sha":"%s","run_attempt":1,"run_started_at":"%s"}' \
    "$1" "${4:-completed}" "$2" "$3" "$writer_started"
}

# Without comparing the row's own workflow, the listing's filter alone would
# vouch for the writer; before the row was read, the run object (workflow 777)
# decided and this passed.
echo "case: a carried writer row in the listing with another workflow_id is ignored"
reset_writer_fixtures
workflow_runs "[$(row_of_run 4100 888 "$sha")]"
run_case 1 'skipped skipped' pass true
expect_log "::warning::the newest ci-lanes success on ${sha} was written by run 4100 of workflow 888, not this workflow (777); ignoring it."
expect_calls "${runs_key_prefix}_4100" 0

echo "case: a carried writer row in the listing with another head_sha is ignored"
reset_writer_fixtures
workflow_runs "[$(row_of_run 4100 777 cafebabecafebabecafebabecafebabecafebabe)]"
run_case 1 'skipped skipped' pass true
expect_log "::warning::the newest ci-lanes success on ${sha} names run 4100, which ran on cafebabecafebabecafebabecafebabecafebabe; ignoring it."
expect_calls "${runs_key_prefix}_4100" 0

# Without the row, every carry reads the writer run again.
echo 'case: a carried writer row in the listing replaces the writer run read'
reset_writer_fixtures
workflow_runs "[$(row_of_run 4100 777 "$sha")]"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_calls "${runs_key_prefix}_4100" 0

# Without the fallback, a writer missing from the listing (or a row without its
# workflow or SHA) could not be verified at all.
echo 'case: a writer missing from the listing is read exactly once'
reset_writer_fixtures
workflow_runs '[]'
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_calls "${runs_key_prefix}_4100" 1

echo 'case: a writer row without its head_sha falls back to one writer run read'
reset_writer_fixtures
workflow_runs '[{"id":4100,"status":"completed","workflow_id":777}]'
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_calls "${runs_key_prefix}_4100" 1

# A yield run that waits two polls for writer 4000's step, beside an in-flight
# contract-only sibling. Without keeping the workflow id between polls, every
# poll reads this run again; without the writer's row, every poll reads the
# writer run; this run's own jobs are read once, shared with the gate resolver.
# The same fixture made 17 calls at 834f4e1 (origin/main before #743); the
# ceiling below is that minus 2.
echo 'case: a multi-poll yield carry reads this run, its jobs and the writer run at most once'
reset_writer_fixtures
status_list "[$(writer_status 100 success 2026-09-05T12:05:00Z 4000)]"
workflow_runs "[$(row_of_run 4000 777 "$sha" in_progress),$(run_entry 4300 in_progress 2026-09-05T12:00:31Z)]"
writer_running_then_success
jobs_raw 4300 "$contract_only_jobs"
run_case 0 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true RERUN_CONTRACT_ONLY_SIBLINGS=true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_status_reads 2
expect_calls "$graphql_key" 1
expect_calls "$current_run_key" 0
expect_calls "${runs_key_prefix}_4242_jobs" 1
expect_calls "${runs_key_prefix}_4000" 0
if [[ "$(wc -l <"$gh_log")" -gt 15 ]]; then
  echo "FAIL: expected at most 15 API calls (17 at 834f4e1, less 2), got $(wc -l <"$gh_log")"
  cat "$gh_log"
  failures=$((failures + 1))
fi

clear_writer_fixtures
run_of_workflow 4100 777
run_of_workflow 4000 777
reset_yield_fixtures

# --- this run's own gate job and step ------------------------------------------

own_jobs_key='GET_repos_melodic-software_ci-workflows_actions_runs_4242_jobs'
# own_jobs <json-array-of-job-objects> [call-number]
# This run's latest-attempt jobs, on every read or only on the Nth.
own_jobs() {
  printf '{"jobs":%s}' "$1" >"$fixtures/${own_jobs_key}${2:+.$2}.json"
}
clear_own_jobs() {
  rm -f -- "$fixtures/${own_jobs_key}".*.json
  install_step_fixtures
}
# expect_total_sleep_at_most <seconds>
expect_total_sleep_at_most() {
  local total=0 seconds
  while read -r seconds; do
    total=$((total + seconds))
  done <"$sleep_log"
  if [[ "$total" -le 0 || "$total" -gt "$1" ]]; then
    echo "FAIL: expected a total sleep in 1..$1 seconds, got $total"
    cat "$sleep_log"
    failures=$((failures + 1))
  fi
}
own_cause_prefix="::warning::could not identify this run's gate job and running step in repos/${repository}/actions/runs/4242/jobs: "
running_contract_step='{"name":"Check the pull-request contract","status":"in_progress","conclusion":null}'
running_aggregate_step='{"name":"Aggregate lane results","status":"in_progress","conclusion":null}'

# Without matching this run's own job by its runner among in-progress jobs, a
# sibling job the API still lists as queued is a second non-skipped job, and
# the gate goes unidentified.
echo 'case: a sibling job still listed as queued does not hide the gate job'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
own_jobs "[{\"name\":\"lint\",\"status\":\"queued\",\"conclusion\":null},${own_gate_job}]"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_no_sleep

# Without the runner match, a reusable-workflow call job that ran in a
# contract-only run is a second non-skipped job, and the gate goes unidentified
# on every such run.
echo 'case: an extra non-gate job that ran does not hide the gate job'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
own_jobs "[{\"name\":\"pr-refine / fix-docs\",\"status\":\"completed\",\"conclusion\":\"success\",\"runner_name\":\"GitHub Actions 3\"},${own_gate_job}]"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"

# Without the shared resolver in the yield listing, a lagging sibling in this
# run leaves no gate name, and a contract-only sibling counts as a full run.
echo 'case: the yield listing resolves the gate job past a lagging sibling of this run'
reset_yield_fixtures
status_list '[]'
own_jobs "[{\"name\":\"lint\",\"status\":\"queued\",\"conclusion\":null},${own_gate_job}]"
workflow_runs "[$(run_entry 4300 in_progress 2026-09-05T12:00:31Z)]"
jobs_raw 4300 "$contract_only_jobs"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "${fail_prefix}${absent_remedy}"
expect_no_log 'superseded'

# Without the retry, a step the API has not flipped to in_progress yet fails the
# run on the first read.
echo 'case: a step listed as in_progress only on the second read resolves after one retry'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
own_jobs "[{\"name\":\"lint\",\"conclusion\":\"skipped\"},{\"id\":9100,\"name\":\"ci-status\",\"status\":\"in_progress\",\"conclusion\":null,\"runner_name\":\"${own_runner}\",\"steps\":[{\"name\":\"Check the pull-request contract\",\"status\":\"completed\",\"conclusion\":\"success\"},{\"name\":\"Aggregate lane results\",\"status\":\"queued\",\"conclusion\":null}]}]" 1
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
if [[ "$(cat "$sleep_log")" != 1 ]]; then
  echo "FAIL: expected one 1-second sleep before the second read, got: $(tr '\n' ' ' <"$sleep_log")"
  failures=$((failures + 1))
fi
clear_own_jobs

# Without failing closed on an empty key, a job with no runner name would match
# whichever in-progress job also lacks one.
echo 'case: an empty job.check_run_id and runner name fail closed naming the cause'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
run_case 1 'skipped skipped' pass true true RUNNER_NAME=
expect_log "${own_cause_prefix}job.check_run_id and RUNNER_NAME are both empty, so this run's own job has no key."
expect_no_log 'Carried forward'
expect_no_gh_call "actions/runs/4100/jobs"

# Without the in-progress test on a named step, a step-name naming a step that
# already finished would be trusted as the step running this action.
echo 'case: a step-name naming a completed step fails closed'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
run_case 1 'skipped skipped' pass true true 'STEP_NAME=Check the pull-request contract'
expect_log "${own_cause_prefix}job 'ci-status' has no in-progress step named 'Check the pull-request contract' after 9 reads."
expect_no_log 'Carried forward'

# Without the control-character replacement and the digits-only count, a job
# name carrying the field separator and a newline would shift text into the
# count, which bash arithmetic evaluates when no step resolves.
echo 'case: a job name carrying a field separator and a newline is never evaluated'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
injected_marker="$temporary_directory/injected"
rm -f -- "$injected_marker"
jq -cn --arg runner "$own_runner" --arg marker "$injected_marker" \
  '{jobs: [{id: 9100, name: ("ci-status\u001fx\u001fx\u001fGITHUB_RUN_ID[$(touch " + $marker + ")]\nsteps"), status: "in_progress", conclusion: null, runner_name: $runner,
    steps: []}]}' \
  >"$fixtures/${own_jobs_key}.json"
run_case 1 'skipped skipped' pass true
expect_no_log 'Carried forward'
if [[ -e "$injected_marker" ]]; then
  echo 'FAIL: a job name was evaluated by bash'
  failures=$((failures + 1))
fi
clear_own_jobs

# check_job <job-id> <run-id>
# `GET actions/jobs/{id}`: this run's gate job as the id path reads it, in the
# run given.
check_job_key='GET_repos_melodic-software_ci-workflows_actions_jobs_9100'
check_job() {
  jq -c --argjson run "$2" '. + {run_id: $run}' <<<"$own_gate_job" >"$fixtures/${check_job_key}.json"
}
check_job_cause_prefix="::warning::could not identify this run's gate job and running step in repos/${repository}/actions/jobs/9100: "

# Without the id path, an empty runner name leaves the job unidentified; with
# it, the job is read by its id and the run's job listing is never read.
echo 'case: job.check_run_id reads the gate job of this run directly'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
check_job 9100 4242
run_case 0 'skipped skipped' pass true true JOB_CHECK_RUN_ID=9100 RUNNER_NAME=
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_log "This run's gate job is 'ci-status' (REST id 9100, job.check_run_id 9100), found by job.check_run_id 9100 in run 4242."
expect_gh_call "GET repos/${repository}/actions/jobs/9100"
expect_no_gh_call "actions/runs/4242/jobs"
expect_no_sleep

# Without the fallback, a runner that leaves job.check_run_id empty (GHES, or
# a runner before v2.324.0) could never identify its job.
echo 'case: an empty job.check_run_id falls back to the runner-name match'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
run_case 0 'skipped skipped' pass true true JOB_CHECK_RUN_ID=
expect_log "found by runner '${own_runner}'."
expect_gh_call "GET repos/${repository}/actions/runs/4242/jobs"
expect_no_gh_call "actions/jobs/"

# Without the run check, a job id of another run would lend that run's job and
# step names to this one.
echo 'case: a job.check_run_id of another run fails closed'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
check_job 9100 5555
run_case 1 'skipped skipped' pass true true JOB_CHECK_RUN_ID=9100
expect_log "${check_job_cause_prefix}no in-progress job matched job.check_run_id 9100 in run 4242 after 9 reads."
expect_no_log 'Carried forward'
expect_no_gh_call "actions/runs/4242/jobs"
rm -f -- "$fixtures/${check_job_key}.json"

# Without validating the id, a value carrying `/` or `?` would address another
# resource than this job.
echo 'case: a job.check_run_id that is not a number fails closed before any jobs read'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
run_case 1 'skipped skipped' pass true true 'JOB_CHECK_RUN_ID=9100/../9200'
expect_log "::warning::could not identify this run's gate job and running step in repos/${repository}/actions/jobs: job.check_run_id is not a job id: 9100/../9200."
expect_no_gh_call "actions/jobs/"
expect_no_gh_call "actions/runs/4242/jobs"

# Without the bound, a job that never appears would retry past the job's
# timeout instead of failing with the cause.
echo 'case: an own job that never resolves fails closed after a bounded retry'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
run_case 1 'skipped skipped' pass true true 'RUNNER_NAME=other runner'
expect_log "${own_cause_prefix}no in-progress job matched runner 'other runner' after 9 reads."
expect_total_sleep_at_most 120
# The lookup waits about 120 s for a lagging jobs API, not 15.
if [[ "$(awk '{ t += $1 } END { print t + 0 }' "$sleep_log")" != 120 ]]; then
  echo "FAIL: expected the own-job lookup to sleep 120s in all, got: $(tr '\n' ' ' <"$sleep_log")"
  failures=$((failures + 1))
fi
expect_no_log 'Carried forward'
# Without naming the lookup, the red reads as a missing lanes status, which
# hides the cause.
expect_log "::error::the own-job lookup failed, so the ci-lanes success on ${sha} could not be verified: no in-progress job matched runner 'other runner' after 9 reads."
expect_no_log 'no successful ci-lanes status'

# Without retrying a 5xx, a jobs API outage of a few reads fails the run.
echo 'case: the own-job lookup reads again past eight 5xx answers, to its last read'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
printf '8\n' >"$fixtures/${own_jobs_key}.fail-times"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
rm -f -- "$fixtures/${own_jobs_key}.fail-times"

# expect_total_sleep <seconds>
expect_total_sleep() {
  if [[ "$(awk '{ t += $1 } END { print t + 0 }' "$sleep_log")" != "$1" ]]; then
    echo "FAIL: expected $1s of sleep in all, got: $(tr '\n' ' ' <"$sleep_log")"
    failures=$((failures + 1))
  fi
}

# Without looking the gate up before the run listing, a lookup that retries
# leaves the listing up to 120 s stale, and a full run that starts meanwhile is
# missed by the newer-verdict check.
echo 'case: the yield run looks its own gate up before it lists the runs'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
run_case 0 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_gh_call_before "actions/runs/4242/jobs" "actions/workflows/777/runs"

echo 'case: a single status read looks its own gate up before it lists the runs'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
run_case 0 'skipped skipped' pass true
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_gh_call_before "actions/runs/4242/jobs" "actions/workflows/777/runs"

echo 'case: a waiting run looks its own gate up before it lists the runs'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
run_case 0 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=30
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_gh_call_before "actions/runs/4242/jobs" "actions/workflows/777/runs"

# Without one lookup per run, a job found on the last read is followed by a
# second full retry for the step, and the run sleeps 240 s.
echo 'case: a job found on the last read and a step never found share one 120s budget'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
workflow_runs "[$(run_entry 4300 in_progress 2026-09-05T12:00:31Z)]"
jobs_raw 4300 "$contract_only_jobs"
for call in 1 2 3 4 5 6 7 8; do
  own_jobs '[]' "$call"
done
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true 'STEP_NAME=Aggregate'
expect_total_sleep 120
expect_calls "$own_jobs_key" 9
expect_no_log 'Carried forward'
clear_own_jobs

# Without starting the carry-forward ceiling before the lookup, a lookup that
# spends its 120 s lands on top of the ceiling and outlives the job timeout.
echo 'case: the carry-forward ceiling counts the own-job lookup'
reset_yield_fixtures
status_list '[]'
workflow_runs "[${earlier_full_run}]"
for call in 1 2 3 4 5 6 7 8; do
  own_jobs '[]' "$call"
done
run_case 1 'skipped skipped' pass true true CARRY_FORWARD_WAIT_SECONDS=200
expect_total_sleep 200
expect_calls "$own_jobs_key" 9
expect_log 'reached the 200s carry-forward-wait-seconds ceiling'
clear_own_jobs

# Without answering every later call from the one failed lookup, the yield
# listing and the writer check each spend the 120 s retry.
echo 'case: a failed own-job lookup spends one 120s budget across the yield listing and the writer check'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
workflow_runs "[$(run_entry 4300 in_progress 2026-09-05T12:00:31Z)]"
jobs_raw 4300 "$contract_only_jobs"
run_case 1 'skipped skipped' pass true true YIELD_TO_FULL_RUN=true 'RUNNER_NAME=other runner'
expect_total_sleep 120
expect_calls "$own_jobs_key" 9

# Without recording a failed read as the cause, the red names no cause at all.
echo 'case: a jobs API that answers 5xx on every read names the HTTP status and read count'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
echo 'gh: Internal Server Error (HTTP 500)' >"$fixtures/${own_jobs_key}.err"
run_case 1 'skipped skipped' pass true
expect_log "::error::the own-job lookup failed, so the ci-lanes success on ${sha} could not be verified: repos/${repository}/actions/runs/4242/jobs could not be read (HTTP 500) after 9 reads."
expect_calls "$own_jobs_key" 9
rm -f -- "$fixtures/${own_jobs_key}.err"

# Without failing at once on a 403 or a 429, a refusal that retrying cannot fix
# spends the whole 120 s.
for refused in 403 429; do
  echo "case: an HTTP ${refused} on the own-job lookup fails at once"
  reset_yield_fixtures
  status_list "[$(full_run_success 100)]"
  echo "gh: refused (HTTP ${refused})" >"$fixtures/${own_jobs_key}.err"
  run_case 1 'skipped skipped' pass true
  expect_calls "$own_jobs_key" 1
  expect_no_sleep
  expect_log "could not be read (HTTP ${refused}) after 1 reads."
  rm -f -- "$fixtures/${own_jobs_key}.err"
done

# Without failing on more than one match, a self-hosted runner name shared by a
# repository and an organization runner could pick another job's steps.
echo 'case: two in-progress jobs on the same runner name fail closed'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
own_jobs "[{\"name\":\"other\",\"status\":\"in_progress\",\"conclusion\":null,\"runner_name\":\"${own_runner}\",\"steps\":[]},${own_gate_job}]"
run_case 1 'skipped skipped' pass true
expect_log "${own_cause_prefix}2 in-progress jobs matched runner '${own_runner}' after 9 reads; a runner name is not unique."
expect_no_log 'Carried forward'
clear_own_jobs

# Without the step-name input, parallel steps leave two in-progress steps and
# the running step goes unidentified.
echo 'case: step-name picks the step that runs this action among parallel steps'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
own_jobs "[{\"id\":9100,\"name\":\"ci-status\",\"status\":\"in_progress\",\"conclusion\":null,\"runner_name\":\"${own_runner}\",\"steps\":[${running_contract_step},${running_aggregate_step}]}]"
run_case 0 'skipped skipped' pass true true 'STEP_NAME=Aggregate lane results'
expect_log "Carried forward: ci-lanes is success on ${sha}"
expect_no_sleep

echo 'case: without step-name, two in-progress steps fail closed naming the input'
run_case 1 'skipped skipped' pass true
expect_log "${own_cause_prefix}job 'ci-status' has 2 in-progress steps after 9 reads; set step-name to the name of the step that runs this action."
clear_own_jobs

echo 'case: a step-name no step of the gate job carries fails closed naming it'
reset_yield_fixtures
status_list "[$(full_run_success 100)]"
run_case 1 'skipped skipped' pass true true 'STEP_NAME=Aggregate'
expect_log "${own_cause_prefix}job 'ci-status' has no in-progress step named 'Aggregate' after 9 reads."
expect_total_sleep_at_most 120

reset_yield_fixtures

echo 'case: action.yml still wires every input this harness exercises'
action_metadata="$script_directory/action.yml"
for input_name in results treat-skipped-as contract-only same-repo status-context carry-forward-wait-seconds rerun-contract-only-siblings rerun-wait-seconds rate-limit-wait-seconds record-pending yield-to-full-run token repository sha; do
  if ! grep -qE "^  ${input_name}:" "$action_metadata"; then
    echo "FAIL: action.yml declares no '${input_name}' input"
    failures=$((failures + 1))
  fi
done
for environment_name in RESULTS TREAT_SKIPPED_AS CONTRACT_ONLY SAME_REPO STATUS_CONTEXT CARRY_FORWARD_WAIT_SECONDS RERUN_CONTRACT_ONLY_SIBLINGS RERUN_WAIT_SECONDS RATE_LIMIT_WAIT_SECONDS RECORD_PENDING YIELD_TO_FULL_RUN GH_TOKEN REPOSITORY SHA; do
  if ! grep -qF "        ${environment_name}: " "$action_metadata"; then
    echo "FAIL: action.yml does not pass '${environment_name}' to run.sh"
    failures=$((failures + 1))
  fi
done

# Both A+ inputs are opt-in: a consumer that passes nothing keeps today's
# behavior and needs no new permission.
for input_name in rerun-contract-only-siblings record-pending yield-to-full-run; do
  input_default="$(awk -v key="  ${input_name}:" '$0 == key { found = 1; next } found && /^    default:/ { print; exit }' "$action_metadata")"
  if [[ "$input_default" != "    default: 'false'" ]]; then
    echo "FAIL: action.yml does not default ${input_name} to 'false' (got: ${input_default})"
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

# The rerun wait holds the full run's ci-status open, so its default must stay
# inside the 7-minute ci-status job the README recommends. Every case above
# runs on run.sh's own fallback, which this does not see.
rerun_wait_default="$(awk '$0 == "  rerun-wait-seconds:" { found = 1; next } found && /^    default:/ { print; exit }' "$action_metadata")"
if [[ "$rerun_wait_default" != "    default: '90'" ]]; then
  echo "FAIL: action.yml does not default rerun-wait-seconds to '90' (got: ${rerun_wait_default})"
  failures=$((failures + 1))
fi

# step-name is opt-in: empty keeps the one-in-progress-step rule.
if ! grep -qE '^  step-name:' "$action_metadata" || ! grep -qF '        STEP_NAME: ' "$action_metadata"; then
  echo "FAIL: action.yml does not declare and wire the step-name input"
  failures=$((failures + 1))
fi
step_name_default="$(awk '$0 == "  step-name:" { found = 1; next } found && /^    default:/ { print; exit }' "$action_metadata")"
if [[ "$step_name_default" != "    default: ''" ]]; then
  echo "FAIL: action.yml does not default step-name to '' (got: ${step_name_default})"
  failures=$((failures + 1))
fi

if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed."
  exit 1
fi
echo 'All ci-status tests passed.'
