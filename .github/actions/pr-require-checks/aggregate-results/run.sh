#!/usr/bin/env bash
# Aggregate lane results into the single required gate check, and carry that
# verdict forward to contract-only pull-request events.
#
# Full mode (`contract-only` false): aggregate `results`, then
# record the verdict as a commit status on the head SHA under `status-context`.
# That status is the only signal a contract-only run can trust, because a check
# run cannot say which event produced it — a chain of contract-only runs could
# otherwise self-certify.
#
# With `rerun-contract-only-siblings`, a full run that records `success` then
# re-runs every failed contract-only run of this workflow on the SHA, so its red
# check run is replaced by one that reads the success. See
# `rerun_failed_contract_only_siblings` for how a contract-only run is
# recognized and why the re-run cannot loop.
#
# Pending mode (`record-pending` true): the first job of a full run marks
# `status-context` `pending` and stops. A contract-only run that reads the
# status while that full run is in flight then fails instead of carrying an
# older run's `success` forward, and the full run's gate overwrites the marker
# with its verdict.
#
# Carry-forward mode (`contract-only` true): the lanes were gated off by
# construction, so aggregation is skipped and the recorded commit status for
# `status-context` on the same SHA decides. It is read from the status LIST
# endpoint, which carries `.creator`, and the newest entry by id from
# `github-actions[bot]` wins, so a later full-run failure on the same SHA
# overrides an earlier success. The combined-status endpoint would be shorter
# but exposes no author; see `read_carried_state` for why that matters. A
# `success` passes only when its writer run belongs to this same workflow; see
# `verify_carried_writer`.
#
# The branched concurrency group stops a contract-only run
# queueing behind the full run whose status it reads, so the two now race.
# `carry-forward-wait-seconds` bounds a poll loop that closes that race. Each
# poll does three things, in this order:
#
#   1. List the runs of this same workflow on this same head SHA that are still
#      incomplete, excluding this run. Any run id; see below.
#   2. Read the newest `github-actions[bot]` status for `status-context`. A
#      `success` is a settled verdict, so stop polling and apply it. A
#      `failure` or `error` is settled too, unless the full run that wrote it
#      (the run its `target_url` names) is in flight again with a current
#      attempt that started after the status was created: that is a re-run
#      about to replace the verdict, so the wait narrows to that one run.
#   3. Otherwise, if step 1 found nothing in flight, stop: no run that could
#      still write a verdict exists, and an absent status fails the run as it
#      always has. If something IS in flight, sleep and poll again.
#
# ANY in-flight sibling, not only one with a lower run id: a pull request opened
# with labels already applied creates the `opened` full run and the `labeled`
# contract-only run together, and either may draw the lower id. Step 2 is what
# breaks a mutual wait: once the full run writes its verdict, both contract-only
# runs read it and stop.
#
# Only the writer's re-run holds a settled failure open. Only a full run writes
# the status, so a contract-only sibling is never that run, and two contract-only
# runs on a failed SHA still stop at once instead of waiting on each other. A
# `run_attempt > 1` test would also catch a re-run contract-only run and bring
# that mutual wait back. The start-time test keeps the writer's own first
# attempt, which writes the status a moment before it completes, out of the
# wait. The known limit: a re-run of a DIFFERENT full run on the same SHA does
# not hold a failure open, and the run fails at once as it did before.
#
# Step 1 before step 2 WITHIN a poll. A sibling writes the status and flips to
# `completed` a moment later. Listing after reading would let that completion
# land in the gap between the two calls and report both "no status" and "nothing
# in flight", failing a SHA that does carry a verdict. Listing first closes the
# gap, because a status written before the listing is still read after it.
#
# The loop never turns a verdict green. Reaching the ceiling exits 1 rather than
# passing on an unsettled status; there is no pass-on-timeout path. Two cases
# run to the ceiling: two or more contract-only runs on a SHA with no status and
# no full run in flight to write one (they wait on each other and then both fail
# closed), and a writer re-run that outlasts the ceiling. The ceiling is elapsed
# wall-clock time since the wait began, API calls included, not the sum of the
# sleeps, so a large ceiling stays under the job budget it was sized against.
#
# Reading a settled `success` before the wait set empties is a deliberate trade:
# it releases the mutual wait above, and it can carry an older `success` forward
# while a re-run of the same SHA is in flight to overwrite it. The defenses
# against a forged status (context, creator login, Bot type, newest id, writer
# workflow) hold.
#
# Every red names the remedy that fits the state it read; see
# `fail_carry_forward`.
#
# `same-repo` false is a fork pull request. Its token is read-only on
# `pull_request` whatever `permissions:` requests, so it cannot record lane
# state; it aggregates, reports the lanes verdict, and writes nothing. The
# caller's contract-only predicate is false for a fork on every event, so a fork
# always runs the full workflow and never needs a carried verdict.
set -euo pipefail

: "${TREAT_SKIPPED_AS:?TREAT_SKIPPED_AS is required}"

RESULTS="${RESULTS:-}"
CONTRACT_ONLY="${CONTRACT_ONLY:-}"
SAME_REPO="${SAME_REPO:-}"
RERUN_CONTRACT_ONLY_SIBLINGS="${RERUN_CONTRACT_ONLY_SIBLINGS:-}"
RECORD_PENDING="${RECORD_PENDING:-}"
YIELD_TO_FULL_RUN="${YIELD_TO_FULL_RUN:-}"
STATUS_CONTEXT="${STATUS_CONTEXT:-ci-lanes}"
REPOSITORY="${REPOSITORY:-}"
SHA="${SHA:-}"
# Retries are 1s, 2s, 4s in CI; the harness sets 0 so a nine-second sleep does
# not ride on every refused-write case.
STATUS_RETRY_BASE_DELAY="${STATUS_RETRY_BASE_DELAY:-1}"
# The login a `GITHUB_TOKEN`-authored commit status carries. Overridable only so
# the harness can exercise the check; a caller minting statuses with a GitHub
# App token would need its own value and takes on proving that identity itself.
STATUS_CREATOR="${STATUS_CREATOR:-github-actions[bot]}"
# Ceiling on the carry-forward wait, in seconds; `0` disables the wait.
# Validated below, once `escape_annotation` exists.
CARRY_FORWARD_WAIT_SECONDS="${CARRY_FORWARD_WAIT_SECONDS:-240}"
# Poll interval, deliberately not a caller input: it is an implementation detail
# of the wait, and the only knob a consumer should reason about is the ceiling.
CARRY_FORWARD_POLL_SECONDS=15
# GitHub run statuses that mean "this run has not finished yet". `completed` is
# the only other value, and a completed run either wrote the status or never
# will.
INCOMPLETE_RUN_STATUSES='["queued","in_progress","waiting","pending","requested"]'

# Reject an unrecognized policy rather than silently defaulting: a typo such as
# `Fail` would otherwise resolve to the laxer branch and quietly weaken the gate
# it was written to tighten.
case "$TREAT_SKIPPED_AS" in
pass | fail) ;;
*)
  echo "::error::treat-skipped-as must be 'pass' or 'fail', got: ${TREAT_SKIPPED_AS}"
  exit 1
  ;;
esac

scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
gh_stdout="$scratch/gh-stdout"
gh_stderr="$scratch/gh-stderr"

GH_HTTP_STATUS=""
gh_api() {
  local method="$1" path="$2"
  shift 2
  local status=0
  : >"$gh_stdout"
  : >"$gh_stderr"
  GH_HTTP_STATUS=""
  set +e
  gh api -X "$method" "$path" "$@" >"$gh_stdout" 2>"$gh_stderr"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    GH_HTTP_STATUS="$(sed -n 's/.*(HTTP \([0-9][0-9]*\)).*/\1/p' "$gh_stderr" | head -n1)"
  fi
  return "$status"
}

# A GitHub expression renders as the literal `true`/`false`. Empty means the
# caller left the input unset, which takes the safer reading of each flag:
# aggregate rather than carry forward, and record rather than silently skip.
# Anything else is a miswired caller and fails rather than resolving to a
# branch it did not ask for.
read_boolean() {
  local name="$1" value="$2" fallback="$3"
  case "$value" in
  true) echo true ;;
  false) echo false ;;
  '') echo "$fallback" ;;
  *)
    echo "::error::${name} must be 'true' or 'false', got: ${value}" >&2
    return 1
    ;;
  esac
}

# shellcheck disable=SC2310 # read_boolean reports a bad value through its status; the caller exits on it.
if ! contract_only="$(read_boolean contract-only "$CONTRACT_ONLY" false)"; then
  exit 1
fi
# shellcheck disable=SC2310 # read_boolean reports a bad value through its status; the caller exits on it.
if ! same_repo="$(read_boolean same-repo "$SAME_REPO" true)"; then
  exit 1
fi
# shellcheck disable=SC2310 # read_boolean reports a bad value through its status; the caller exits on it.
if ! rerun_contract_only_siblings="$(read_boolean rerun-contract-only-siblings "$RERUN_CONTRACT_ONLY_SIBLINGS" false)"; then
  exit 1
fi
# shellcheck disable=SC2310 # read_boolean reports a bad value through its status; the caller exits on it.
if ! record_pending="$(read_boolean record-pending "$RECORD_PENDING" false)"; then
  exit 1
fi
# shellcheck disable=SC2310 # read_boolean reports a bad value through its status; the caller exits on it.
if ! yield_to_full_run="$(read_boolean yield-to-full-run "$YIELD_TO_FULL_RUN" false)"; then
  exit 1
fi

# GitHub's documented escaping for workflow-command data, so a value echoed back
# in an annotation cannot close it and inject a second command. `%` first, or the
# escapes introduced by the others get double-escaped.
escape_annotation() {
  local text="$1"
  text="${text//'%'/%25}"
  text="${text//$'\r'/%0D}"
  text="${text//$'\n'/%0A}"
  printf '%s' "$text"
}

# The two values interpolated into a `gh api` path. Validate before the first
# call rather than trusting the caller's expression: a `repository` or `sha`
# carrying `../` or a query separator would address a different resource than
# the one named. `status-context` is deliberately NOT validated — a context like
# `CI Lanes` is legal, and it only ever travels through `jq --arg` into a
# comparison or a JSON body, never into a path.
require_pattern() {
  local name="$1" value="$2" pattern="$3" shape="$4"
  if [[ ! "$value" =~ $pattern ]]; then
    echo "::error::${name} must be ${shape}, got: $(escape_annotation "$value")"
    exit 1
  fi
}

require_pattern repository "$REPOSITORY" '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' 'OWNER/REPO'
require_pattern sha "$SHA" '^[0-9a-f]{40}$' 'a full 40-character lowercase commit SHA'
# Not a path component, but it drives arithmetic and a `sleep`: a non-numeric
# value would otherwise make the comparison an error under `set -e` or the sleep
# a no-op, either of which silently changes the branch the caller asked for.
require_pattern carry-forward-wait-seconds "$CARRY_FORWARD_WAIT_SECONDS" '^[0-9]+$' 'a non-negative integer number of seconds'

# POST one `status-context` entry on `sha` naming this run, retrying after 1s,
# 2s and 4s. Every write is load-bearing, not best-effort: the carry-forward
# branch reads nothing else, so a silently missing status turns every later
# contract-only run red, or lets one carry an older verdict, with no way to tell
# a refused write from a real result. Returns 1 after printing the error.
write_status() {
  local state="$1" description="$2" attempt delay
  jq -n \
    --arg state "$state" \
    --arg context "$STATUS_CONTEXT" \
    --arg description "$description" \
    --arg target_url "${GITHUB_SERVER_URL:-https://github.com}/${REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-0}" \
    '{state: $state, context: $context, description: $description, target_url: $target_url}' \
    >"$scratch/status-payload.json"
  for attempt in 1 2 3 4; do
    # shellcheck disable=SC2310 # gh_api handles its own errexit; the retry loop classifies the status.
    if gh_api POST "repos/${REPOSITORY}/statuses/${SHA}" --input "$scratch/status-payload.json"; then
      return 0
    fi
    if [[ "$attempt" -lt 4 ]]; then
      delay=$((STATUS_RETRY_BASE_DELAY * (1 << (attempt - 1))))
      echo "::warning::could not record ${STATUS_CONTEXT} on ${SHA} (HTTP ${GH_HTTP_STATUS:-unknown}); retrying in ${delay}s"
      sleep "$delay"
    fi
  done
  cat "$gh_stderr" >&2
  echo "::error::could not record ${STATUS_CONTEXT} on ${SHA} (${GH_HTTP_STATUS:-unknown}); the calling job needs statuses: write"
  return 1
}

# ---------------------------------------------------------------------------
# Pending mode. Only the full run a contract-only run would wait for marks its
# verdict pending: a contract-only run marking it would fail itself and every
# sibling with nothing coming to replace the marker, a fork's token cannot
# write, and a push has no contract-only sibling to protect. Each of those
# passes with a notice, so the step is safe in a job that runs on every event.
# ---------------------------------------------------------------------------
if [[ "$record_pending" == true ]]; then
  if [[ "$contract_only" == true ]]; then
    echo "::notice::contract-only event: ${STATUS_CONTEXT} is not marked pending; only a full run marks its own verdict pending."
    exit 0
  fi
  if [[ "$same_repo" != true ]]; then
    echo "::notice::fork pull request: ${STATUS_CONTEXT} is not marked pending; a fork never carries a verdict forward."
    exit 0
  fi
  case "${GITHUB_EVENT_NAME:-}" in
  pull_request | pull_request_target) ;;
  *)
    echo "::notice::${GITHUB_EVENT_NAME:-unknown} event: ${STATUS_CONTEXT} is not marked pending; only a pull request has contract-only runs."
    exit 0
    ;;
  esac
  # shellcheck disable=SC2310 # write_status prints its own error; the caller exits on it.
  if ! write_status pending 'Full run in flight; lanes not yet aggregated.'; then
    exit 1
  fi
  echo "Recorded ${STATUS_CONTEXT}=pending on ${SHA}; a contract-only run fails until this run's gate records its verdict."
  exit 0
fi

# ---------------------------------------------------------------------------
# Carry-forward mode. Branched on first, before `same-repo`: the caller's
# predicate makes `contract-only` false for every fork event, so the
# true/false combination is unreachable from the defaults — but a caller that
# overrides `contract-only` owns the claim that the lanes did not run, and the
# runner honors it rather than second-guessing it into an aggregation over
# results that are all `skipped`.
# ---------------------------------------------------------------------------

# Newest `status-context` state written by the Actions bot on this SHA, or the
# empty string when the context is absent. Sets `carried_state` rather than
# echoing it so the caller can distinguish "read failed" from "read empty"
# through the return status.
carried_state=""
# When that entry was created, and the run id its `target_url` names (the full
# run that wrote it). Empty when absent; either one empty means the wait never
# treats a run as the writer's re-run.
carried_created_at=""
carried_writer_run_id=""
# Whether `carried_state` holds a completed read. The poll loop reads the status
# itself, so the caller below must not read a second time and overwrite what the
# loop decided on.
carried_state_read=false
read_carried_state() {
  local entry
  carried_state=""
  carried_created_at=""
  carried_writer_run_id=""
  carried_state_read=false
  # The LIST endpoint, not the combined one: `commits/<sha>/status` collapses to
  # one entry per context and exposes no author, so any collaborator with write
  # could POST a forged `ci-lanes=success` and then flip a label to turn the
  # sole required check green over failing lanes. The list carries `.creator`,
  # newest first, so the gate can insist the newest entry for this context was
  # written by the Actions bot and ignore anything a human pushed. `--slurp`
  # wraps every page in one outer array so `max_by` below sees the whole list;
  # without it jq runs once per page and picks a winner per page.
  # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
  if ! gh_api GET "repos/${REPOSITORY}/commits/${SHA}/statuses?per_page=100" --paginate --slurp; then
    return 1
  fi
  # Highest id wins, not first element: status ids are monotonic, so `max_by`
  # states the intent directly instead of depending on the documented
  # newest-first ordering. A later bot failure on the same SHA therefore
  # overrides an earlier bot success, and a later forged success by a user
  # account is skipped rather than shadowing the bot's real verdict.
  # `|| return 1` rather than a bare assignment: an assignment from a command
  # substitution carries the substitution's status, and every caller invokes
  # this function under `if !`, which suppresses errexit inside it. Without the
  # explicit check a malformed or truncated body would make jq exit nonzero,
  # that status would be discarded, and the function would report a completed
  # read of an empty state. A body this function cannot parse is a failed read.
  # One pass, `|`-joined: tab is IFS whitespace, so `read` would collapse an
  # empty middle field and shift the ones after it. The writer run id comes only
  # from a `target_url` of the exact shape `write_status` records, on this
  # server and repository; any other URL yields no writer.
  entry="$(jq -r --arg context "$STATUS_CONTEXT" --arg creator "$STATUS_CREATOR" \
    --arg runs_prefix "${GITHUB_SERVER_URL:-https://github.com}/${REPOSITORY}/actions/runs/" \
    '[ .[][] | select(.context == $context and (.creator.login // "") == $creator and (.creator.type // "") == "Bot") ] | (max_by(.id) // {})
     | [(.state // ""), (.created_at // ""), ((.target_url // "") | if startswith($runs_prefix) and (ltrimstr($runs_prefix) | test("\\A[0-9]+\\z")) then ltrimstr($runs_prefix) else "" end)] | join("|")' \
    <"$gh_stdout")" || return 1
  IFS='|' read -r carried_state carried_created_at carried_writer_run_id <<<"$entry"
  if [[ "$carried_state" == success ]]; then
    # shellcheck disable=SC2310 # verify_carried_writer reports a failed lookup through its status.
    if ! verify_carried_writer; then
      return 1
    fi
  fi
  carried_state_read=true
}

# Every workflow in the repository posts as the Actions bot, so the creator
# check alone lets ANY workflow write the `success` that turns the required
# check green. Only `success` is verified, as the only state that passes: the
# run its `target_url` names must be a run of this same workflow on this same
# SHA. A `success` naming no run, or any other run, is discarded and the read goes
# on as if no status were recorded. A failed lookup returns 1, a failed read,
# which every caller turns red: an unverifiable writer never passes.
verify_carried_writer() {
  local writer writer_workflow_id writer_head_sha
  local unverified='Cannot verify which workflow wrote the carried status, so this run fails closed.'
  if [[ -z "$carried_writer_run_id" ]]; then
    echo "::warning::the newest ${STATUS_CONTEXT} success on ${SHA} names no run of ${REPOSITORY} in its target_url; ignoring it."
    carried_state=""
    return 0
  fi
  if [[ ! "$workflow_id" =~ ^[0-9]+$ ]]; then
    # shellcheck disable=SC2310 # resolve_workflow_id warns itself; the caller fails closed.
    if ! resolve_workflow_id 'actions: read' "$unverified"; then
      return 1
    fi
  fi
  # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
  if ! gh_api GET "repos/${REPOSITORY}/actions/runs/${carried_writer_run_id}"; then
    warn_actions_failed "repos/${REPOSITORY}/actions/runs/${carried_writer_run_id}" 'actions: read' "$unverified"
    return 1
  fi
  writer="$(jq -r '"\(.workflow_id // "")|\(.head_sha // "")"' <"$gh_stdout")" || return 1
  IFS='|' read -r writer_workflow_id writer_head_sha <<<"$writer"
  if [[ "$writer_workflow_id" != "$workflow_id" ]]; then
    echo "::warning::the newest ${STATUS_CONTEXT} success on ${SHA} was written by run ${carried_writer_run_id} of workflow ${writer_workflow_id:-unknown}, not this workflow (${workflow_id}); ignoring it."
    carried_state=""
  elif [[ "$writer_head_sha" != "$SHA" ]]; then
    # A real run of this workflow on another commit is no verdict for this one.
    echo "::warning::the newest ${STATUS_CONTEXT} success on ${SHA} names run ${carried_writer_run_id}, which ran on ${writer_head_sha:-an unknown commit}; ignoring it."
    carried_state=""
  fi
}

# The Actions calls need a scope an explicit `permissions:` block does not grant
# by default: `actions: read` to wait, `actions: write` to re-run siblings. Name
# the scope rather than printing a bare 403, and say what the run does instead.
# Neither caller treats a refusal as permission to pass.
warn_actions_failed() {
  local endpoint="$1" scope="$2" consequence="$3"
  if [[ "$GH_HTTP_STATUS" == 403 ]]; then
    echo "::warning::${endpoint} returned HTTP 403; the ci-status job needs '${scope}'. ${consequence}"
  else
    echo "::warning::could not read ${endpoint} (HTTP ${GH_HTTP_STATUS:-unknown}). ${consequence}"
  fi
  cat "$gh_stderr" >&2
}

# Sets `workflow_id` to this run's workflow, the key both the wait and the
# sibling re-run list runs under, and validates `GITHUB_RUN_ID`, which both
# exclude from that list. Returns 1 after a warning ending in `consequence`.
workflow_id=""
resolve_workflow_id() {
  local scope="$1" consequence="$2" run_id="${GITHUB_RUN_ID:-}"
  if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
    echo "::warning::GITHUB_RUN_ID is not a run id; cannot exclude this run from the runs on ${SHA}. ${consequence}"
    return 1
  fi
  # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
  if ! gh_api GET "repos/${REPOSITORY}/actions/runs/${run_id}"; then
    warn_actions_failed "repos/${REPOSITORY}/actions/runs/${run_id}" "$scope" "$consequence"
    return 1
  fi
  workflow_id="$(jq -r '.workflow_id // ""' <"$gh_stdout")"
  if [[ ! "$workflow_id" =~ ^[0-9]+$ ]]; then
    echo "::warning::run ${run_id} reported no workflow_id. ${consequence}"
    return 1
  fi
}

# Wall-clock seconds since the wait began, and the sibling run ids waited on,
# for the ceiling message. Set by wait_for_sibling_runs.
carry_forward_waited=0
carry_forward_wait_note=""

# The ceiling message's tail. Deduplicated numerically, because the ids are
# re-collected on every poll and a reader expects them in run order.
set_wait_note() {
  if [[ "$carry_forward_waited" -gt 0 ]]; then
    carry_forward_wait_note=" (waited ${carry_forward_waited}s of ${CARRY_FORWARD_WAIT_SECONDS}s on in-flight run(s): $(printf '%s' "$1" | tr ' ' '\n' | sort -un | tr '\n' ' ' | sed 's/ *$//'))"
  fi
}

# Poll until this SHA's verdict settles, nothing that could still write one is
# in flight, or the ceiling is reached. See the header for the ordering and the
# wait set.
#
# Returns 1 at the ceiling, which the caller turns into the fail-closed error.
# Every other outcome returns 0. On a 0 the caller applies `carried_state` when
# `carried_state_read` is true, and otherwise reads the status itself: that is
# the degraded path, taken when an Actions read fails and when a status read
# fails part way through the loop. A failed read
# never leaves `carried_state_read` true, so the degraded path is a fresh read
# that fails closed on its own failure; there is no outcome that passes without
# one completed read.
wait_for_sibling_runs() {
  local ids all_ids="" sleep_for remaining wait_started now
  local no_wait='Reading the recorded status without waiting.'
  # `date`, not bash's `SECONDS`: an external clock is one the harness can
  # advance from its `sleep` and `gh` shims, so the ceiling arithmetic stays
  # real in tests without a test-only knob in this script.
  wait_started="$(date +%s)"
  # shellcheck disable=SC2310 # resolve_workflow_id warns itself; the caller degrades to one read.
  if ! resolve_workflow_id 'actions: read' "$no_wait"; then
    return 0
  fi
  while :; do
    # Not `--paginate`: this endpoint returns an object, and concatenated
    # objects are not valid input to the filter below. 100 runs on one head SHA
    # is already far past the burst this wait exists for.
    # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
    if ! gh_api GET "repos/${REPOSITORY}/actions/workflows/${workflow_id}/runs?head_sha=${SHA}&per_page=100"; then
      warn_actions_failed "repos/${REPOSITORY}/actions/workflows/${workflow_id}/runs" 'actions: read' "$no_wait"
      # Discard any earlier poll's read so the caller takes the single fresh
      # read the warning above promises. Without this, a listing that fails on
      # the second or later poll would decide on the state read before the
      # sleep, which is exactly the stale verdict the degraded path exists to
      # avoid. A 403 fires on the first poll, before any read; this covers a
      # transient failure mid-wait.
      carried_state_read=false
      break
    fi
    # Every incomplete sibling, at any run id, minus this run. `!=` rather than
    # `<`: neither run of an `opened`/`labeled` pair is reliably the lower id,
    # so an ordering term drops the sibling this wait exists to see. `// $self`
    # covers a run object with no `id`, keeping a malformed entry out rather
    # than waiting on it forever. Sorted so the ids read in run order and the
    # log line is stable from one poll to the next.
    ids="$(jq -r --argjson incomplete "$INCOMPLETE_RUN_STATUSES" --argjson self "$GITHUB_RUN_ID" \
      '[ .workflow_runs[]? | select(.status as $s | $incomplete | index($s)) | select((.id // $self) != $self) | .id ] | sort | join(" ")' \
      <"$gh_stdout")"
    # Kept for the settled-failure check below, which runs after the status
    # read has overwritten gh_stdout.
    cp -- "$gh_stdout" "$scratch/runs.json"
    now="$(date +%s)"
    carry_forward_waited=$((now - wait_started))
    # The status read comes AFTER the listing above, never before it: a sibling
    # writes the status and flips to `completed` moments later, and the other
    # order lets that completion land between the two calls.
    # shellcheck disable=SC2310 # read_carried_state handles its own errexit; the caller classifies the status.
    if ! read_carried_state; then
      # The same degraded path the listing failure above takes, for the same
      # reason. This endpoint is read once per poll, up to sixteen times
      # under the 240s ceiling, so failing the run on the first transient 5xx
      # would let one bad read of sixteen turn the sole required check red. Break
      # instead, and let the caller take its single fresh re-read, which fails
      # closed when it fails too. Still no pass without a completed read.
      #
      # This poll's ids are appended here rather than below, because the append
      # below runs only after the settled and empty-set exits: a sibling first
      # seen on the poll whose read failed would otherwise be missing from the
      # note that names what this run waited on.
      all_ids="${all_ids}${all_ids:+ }${ids}"
      carried_state_read=false
      echo "::warning::could not read repos/${REPOSITORY}/commits/${SHA}/statuses (HTTP ${GH_HTTP_STATUS:-unknown}); taking one fresh read of the recorded status."
      cat "$gh_stderr" >&2
      break
    fi
    # A failure is stale while the full run that wrote it is re-running, so the
    # wait narrows to that one run; see the header for why only the writer.
    # `error` goes with `failure`: both are terminal states the API accepts, and
    # neither passes below.
    if [[ "$carried_state" == failure || "$carried_state" == error ]]; then
      ids="$(jq -r --argjson incomplete "$INCOMPLETE_RUN_STATUSES" --arg writer "$carried_writer_run_id" --arg since "$carried_created_at" \
        '[ .workflow_runs[]? | select(.status as $s | $incomplete | index($s)) | select($since != "" and (.id | tostring) == $writer and (.run_started_at // "") > $since) | .id ] | join(" ")' \
        <"$scratch/runs.json")"
    fi
    # A settled verdict with no writer re-run in flight ends the wait whatever
    # else is in flight. This is what releases two contract-only runs that
    # would otherwise wait on each other.
    if [[ "$carried_state" == success || ("$carried_state" =~ ^(failure|error)$ && -z "$ids") ]]; then
      if [[ "$carry_forward_waited" -gt 0 ]]; then
        echo "The ${STATUS_CONTEXT} status on ${SHA} settled after ${carry_forward_waited}s."
      fi
      break
    fi
    if [[ -z "$ids" ]]; then
      # Nothing that could still write a verdict is in flight, so waiting longer
      # cannot change the answer. The caller fails on the unsettled state, which
      # is the fast fail this action has always had when no full run is coming.
      if [[ "$carry_forward_waited" -gt 0 ]]; then
        echo "No run on ${SHA} is still in flight after ${carry_forward_waited}s; using the ${STATUS_CONTEXT} status."
      fi
      break
    fi
    all_ids="${all_ids}${all_ids:+ }${ids}"
    remaining=$((CARRY_FORWARD_WAIT_SECONDS - carry_forward_waited))
    if [[ "$remaining" -le 0 ]]; then
      echo "::warning::reached the ${CARRY_FORWARD_WAIT_SECONDS}s carry-forward-wait-seconds ceiling with in-flight run(s) ${ids} still incomplete on ${SHA}."
      set_wait_note "$all_ids"
      return 1
    fi
    sleep_for="$CARRY_FORWARD_POLL_SECONDS"
    if [[ "$sleep_for" -gt "$remaining" ]]; then
      sleep_for="$remaining"
    fi
    echo "Waiting ${sleep_for}s for in-flight run(s) ${ids} on ${SHA} to finish (waited ${carry_forward_waited}s of ${CARRY_FORWARD_WAIT_SECONDS}s)."
    sleep "$sleep_for"
  done
  set_wait_note "$all_ids"
}

# Every carry-forward red. The remedy follows the state read. `pending` names
# the full run in flight, whose own gate check run supersedes this one, so
# nothing needs re-running unless that run was cancelled. A `failure` or `error`
# names the run that recorded it. An absent status, or a read that failed,
# cannot tell whether a full run is coming, so it gives both cases. The closing
# sentence says who replaces this red once the lanes pass: the full run itself
# when this workflow re-runs contract-only siblings (the same step runs in both
# modes, so this run's input is the full run's), otherwise whoever re-runs this
# run, which is cheaper than a new commit that re-runs every lane.
fail_carry_forward() {
  local writer="" remedy closing
  if [[ -n "$carried_writer_run_id" ]]; then
    writer="${GITHUB_SERVER_URL:-https://github.com}/${REPOSITORY}/actions/runs/${carried_writer_run_id}"
  fi
  case "$carried_state" in
  pending)
    remedy="full run ${writer:-on this SHA} is still in flight, and its own ci-status check supersedes this one when it finishes. Re-run that run only if it was cancelled"
    ;;
  failure | error)
    remedy="the lanes verdict is ${carried_state}${writer:+ (${writer})}; fix the failing lane, or re-run that run's failed jobs if the failure was transient"
    ;;
  *)
    remedy="if a full run on this SHA is in flight, its ci-status check supersedes this one; otherwise re-run the full workflow"
    ;;
  esac
  if [[ "$rerun_contract_only_siblings" == true ]]; then
    closing="A full run that records ${STATUS_CONTEXT}=success on ${SHA} re-runs this run; re-run it yourself only if it stays red after that."
  else
    closing="Once ${STATUS_CONTEXT} on ${SHA} is success, re-run this run instead."
  fi
  echo "::error::no successful ${STATUS_CONTEXT} status on ${SHA}; ${remedy}${carry_forward_wait_note}. ${closing}"
  exit 1
}

# Yield mode (`yield-to-full-run` true): a contract-only run never waits. It
# lists this workflow's in-flight runs on the SHA once, then reads the status
# once, in that order for the reason the wait gives. A full run in flight
# supersedes this run: it fails at once naming that run, whose own ci-status
# check run is newer than this one's and is the one the merge gate reads. With
# `rerun-contract-only-siblings`, that run re-runs this one once it records
# `success`. A red is never a false green, so failing here is always safe; the
# cost is a red check run that the full run's newer one supersedes.
#
# This closes the gap `record-pending` alone leaves: a full run that is queued,
# or whose first job has not yet written its `pending` marker, would otherwise
# let this run carry an older `success` forward across it.
#
# An in-flight sibling is contract-only, and not waited for, when its latest
# attempt has more than one job and every job but one is skipped, and that one
# job carries this run's gate name: the shape
# `rerun_failed_contract_only_siblings` recognizes, read before the gate
# finishes. The name check stops a full run whose first job has finished and
# whose lanes were skipped, before its gate job exists, from passing for one.
# The gate name is this run's own one non-skipped job; when that cannot be
# read, every sibling is a full run, as is one with more jobs than the one page
# of 100 lists. Every other sibling is a full run,
# including one whose jobs are not listed yet or cannot be read, so a misread
# fails closed. The one full run
# excluded is the writer of a `success` already on the SHA, when the attempt in
# flight is the one that wrote it: its verdict is written, and it is in flight
# only to finish, or to re-run this very run. A later attempt of that run (a
# re-run) has not written its verdict yet, so it still supersedes this run.
#
# Sets `yield_full_runs` to the full runs that supersede this run. Returns 1
# when the runs cannot be listed, which the caller fails closed on: without the
# listing an older `success` could be carried across a full run in flight.
yield_full_runs=""
list_in_flight_full_runs() {
  local closed='Cannot tell whether a full run is in flight on this SHA, so this run fails closed; re-run it.'
  local attempt ids id shape gate=""
  yield_full_runs=""
  # shellcheck disable=SC2310 # resolve_workflow_id warns itself; the caller fails closed.
  if ! resolve_workflow_id 'actions: read' "$closed"; then
    return 1
  fi
  for attempt in 1 2 3; do
    # shellcheck disable=SC2310 # gh_api handles its own errexit; the retry loop classifies the status.
    if gh_api GET "repos/${REPOSITORY}/actions/workflows/${workflow_id}/runs?head_sha=${SHA}&per_page=100"; then
      break
    fi
    if [[ "$attempt" -eq 3 ]]; then
      warn_actions_failed "repos/${REPOSITORY}/actions/workflows/${workflow_id}/runs" 'actions: read' "$closed"
      return 1
    fi
    sleep "$((STATUS_RETRY_BASE_DELAY * attempt))"
  done
  ids="$(jq -r --argjson incomplete "$INCOMPLETE_RUN_STATUSES" --argjson self "$GITHUB_RUN_ID" \
    '[ .workflow_runs[]? | select(.status as $s | $incomplete | index($s)) | select((.id // $self) != $self) | .id ] | sort | join(" ")' \
    <"$gh_stdout")" || return 1
  cp -- "$gh_stdout" "$scratch/runs.json"
  if [[ -z "$ids" ]]; then
    return 0
  fi
  # shellcheck disable=SC2310 # gh_api handles its own errexit; no gate name counts every sibling as a full run.
  if gh_api GET "repos/${REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs?filter=latest&per_page=100"; then
    gate="$(jq -r '[ .jobs[]? | select(.conclusion != "skipped") | .name ] | if length == 1 then .[0] else "" end' <"$gh_stdout")" || gate=""
  else
    warn_actions_failed "repos/${REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs" 'actions: read' 'Counting every run in flight as a full run.'
  fi
  for id in $ids; do
    shape=false
    # shellcheck disable=SC2310 # gh_api handles its own errexit; an unreadable sibling counts as a full run.
    if gh_api GET "repos/${REPOSITORY}/actions/runs/${id}/jobs?filter=latest&per_page=100"; then
      shape="$(jq -r --arg gate "$gate" '(.total_count // 0) as $total | [ .jobs[]? ] | length > 1 and length >= $total and (map(select(.conclusion != "skipped") | .name) == [$gate])' <"$gh_stdout")" || shape=false
    else
      warn_actions_failed "repos/${REPOSITORY}/actions/runs/${id}/jobs" 'actions: read' "Counting run ${id} as a full run in flight."
    fi
    if [[ "$shape" != true ]]; then
      yield_full_runs="${yield_full_runs}${yield_full_runs:+ }${id}"
    fi
  done
}

# The yield red: a full run in flight decides the merge gate, so this run says
# which one and who replaces this red.
fail_superseded() {
  local runs="" id closing
  for id in $1; do
    runs="${runs}${runs:+, }${GITHUB_SERVER_URL:-https://github.com}/${REPOSITORY}/actions/runs/${id}"
  done
  if [[ "$rerun_contract_only_siblings" == true ]]; then
    closing="It re-runs this run once it records ${STATUS_CONTEXT}=success; re-run this run yourself only if it stays red after that."
  else
    closing="Once ${STATUS_CONTEXT} on ${SHA} is success, re-run this run."
  fi
  echo "::error::superseded by full run ${runs} in flight on ${SHA}: its own ci-status check run is newer than this one and decides the merge gate. ${closing}"
  exit 1
}

if [[ "$contract_only" == true && "$yield_to_full_run" == true ]]; then
  echo "Contract-only event: yielding to any full run in flight on ${SHA}, else reading the ${STATUS_CONTEXT} status once."
  # shellcheck disable=SC2310 # list_in_flight_full_runs warns itself; the caller fails closed.
  if ! list_in_flight_full_runs; then
    echo "::error::could not list this workflow's runs on ${SHA}, so a full run in flight cannot be ruled out; re-run this run."
    exit 1
  fi
  # shellcheck disable=SC2310 # read_carried_state handles its own errexit; the caller classifies the status.
  if ! read_carried_state; then
    cat "$gh_stderr" >&2
    fail_carry_forward
  fi
  superseding=""
  for id in $yield_full_runs; do
    if [[ "$carried_state" == success && "$id" == "$carried_writer_run_id" && -n "$carried_created_at" ]] &&
      [[ "$(jq -r --arg id "$id" --arg since "$carried_created_at" \
        '[ .workflow_runs[]? | select((.id | tostring) == $id and (.run_started_at // "") != "" and .run_started_at <= $since) ] | length > 0' \
        <"$scratch/runs.json")" == true ]]; then
      continue
    fi
    superseding="${superseding}${superseding:+ }${id}"
  done
  if [[ -n "$superseding" ]]; then
    fail_superseded "$superseding"
  fi
  if [[ "$carried_state" == success ]]; then
    echo "Carried forward: ${STATUS_CONTEXT} is success on ${SHA} (recorded by ${STATUS_CREATOR})."
    exit 0
  fi
  fail_carry_forward
fi

if [[ "$contract_only" == true ]]; then
  echo "Contract-only event: reading the ${STATUS_CONTEXT} status on ${SHA} instead of aggregating skipped lanes."
  if [[ "$CARRY_FORWARD_WAIT_SECONDS" -gt 0 ]]; then
    carry_forward_wait_status=0
    # shellcheck disable=SC2310 # wait_for_sibling_runs reports the ceiling through its status; the caller exits on it.
    wait_for_sibling_runs || carry_forward_wait_status=$?
    if [[ "$carry_forward_wait_status" -ne 0 ]]; then
      # Never pass on timeout: a run that could still write this SHA's verdict
      # is in flight, so whatever is on the SHA right now is not settled.
      fail_carry_forward
    fi
  fi
  # Only when the loop did not read it: a failed Actions read or a mid-loop
  # status-read failure degrades to this single read, whose failure fails the run.
  if [[ "$carried_state_read" != true ]]; then
    # shellcheck disable=SC2310 # read_carried_state handles its own errexit; the caller classifies the status.
    if ! read_carried_state; then
      cat "$gh_stderr" >&2
      fail_carry_forward
    fi
  fi
  if [[ "$carried_state" == success ]]; then
    echo "Carried forward: ${STATUS_CONTEXT} is success on ${SHA} (recorded by ${STATUS_CREATOR})."
    exit 0
  fi
  fail_carry_forward
fi

# ---------------------------------------------------------------------------
# Full mode — aggregate the lane results.
# ---------------------------------------------------------------------------
# Unquoted expansion word-splits on all of IFS (space, tab, newline), so a YAML
# block scalar spanning lines is parsed in full. `read` would stop at the first
# newline and silently skip every later lane.
# shellcheck disable=SC2206
results=($RESULTS)
# Checked after splitting: whitespace-only input yields no elements, and an
# empty loop would otherwise report success with nothing aggregated.
if [[ ${#results[@]} -eq 0 ]]; then
  echo '::error::results is required.'
  exit 1
fi

lanes_state=success
lanes_description=""
lane_number=0
for r in "${results[@]}"; do
  lane_number=$((lane_number + 1))
  case "$r" in
  success) ;;
  skipped)
    if [[ "$TREAT_SKIPPED_AS" == fail ]]; then
      lanes_state=failure
    fi
    ;;
  *) lanes_state=failure ;;
  esac
  if [[ "$lanes_state" == failure ]]; then
    echo "A lane did not pass (result: $r)."
    # `results` carries no lane names — the caller builds it from
    # `needs.<lane>.result` — so the description names the failing lane by its
    # position in that list, which is the most the input allows.
    lanes_description="lane ${lane_number} of ${#results[@]} did not pass (result: ${r})"
    break
  fi
done

if [[ "$lanes_state" == success ]]; then
  if [[ "$TREAT_SKIPPED_AS" == fail ]]; then
    lanes_description='All lanes passed.'
  else
    lanes_description='All lanes passed or were skipped.'
  fi
  echo "$lanes_description"
fi

# ---------------------------------------------------------------------------
# Record the verdict as a commit status (see `write_status`).
#
# A fork pull request is the one exception: its token cannot write a status at
# all, and nothing will ever read one for it, so the run reports the lanes
# verdict and stops.
# ---------------------------------------------------------------------------
if [[ "$same_repo" != true ]]; then
  echo "::notice::fork pull request: lane state is not recorded; every event runs the full workflow"
  if [[ "$lanes_state" == failure ]]; then
    exit 1
  fi
  exit 0
fi

# shellcheck disable=SC2310 # write_status prints its own error; the caller exits on it.
if ! write_status "$lanes_state" "$lanes_description"; then
  exit 1
fi

echo "Recorded ${STATUS_CONTEXT}=${lanes_state} on ${SHA}."

if [[ "$lanes_state" == failure ]]; then
  exit 1
fi

# Re-run every failed contract-only run of this workflow on this SHA, so its red
# check run is replaced by one that reads the success just recorded. Runs only
# after that write, so a re-run cannot read anything older.
#
# A contract-only run is recognized by its jobs, not its event, which the run
# object does not carry: in its latest attempt every job but one was skipped,
# and that one failed. A full run always runs more than its gate, and this run
# is excluded by id, so neither is ever re-run. A re-run attempt keeps its
# original event, so it is contract-only again and never reaches this code: no
# loop. A contract-only run that is red for a contract reason (title,
# `do-not-merge`) just goes red again, at the cost of one short job.
#
# The known gap: a contract-only run still in flight when this lists the runs
# read the status before this run wrote it, finishes red after, and is not
# re-run. Its message therefore ends by telling the reader to re-run it if it
# stays red after the full run's success.
#
# Nothing here changes this run's verdict: the success is already recorded, so
# a refusal warns and moves on.
rerun_failed_contract_only_siblings() {
  local skip='Not re-running failed contract-only runs.' candidates id contract_shaped rerun_count=0
  # shellcheck disable=SC2310 # resolve_workflow_id warns itself; a refusal only skips the re-run.
  if ! resolve_workflow_id 'actions: write' "$skip"; then
    return 0
  fi
  # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
  if ! gh_api GET "repos/${REPOSITORY}/actions/workflows/${workflow_id}/runs?head_sha=${SHA}&per_page=100"; then
    warn_actions_failed "repos/${REPOSITORY}/actions/workflows/${workflow_id}/runs" 'actions: write' "$skip"
    return 0
  fi
  candidates="$(jq -r --argjson self "$GITHUB_RUN_ID" \
    '[ .workflow_runs[]? | select(.status == "completed" and .conclusion == "failure" and (.id // $self) != $self) | .id ] | sort | join(" ")' \
    <"$gh_stdout")"
  for id in $candidates; do
    # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
    if ! gh_api GET "repos/${REPOSITORY}/actions/runs/${id}/jobs?filter=latest&per_page=100"; then
      warn_actions_failed "repos/${REPOSITORY}/actions/runs/${id}/jobs" 'actions: write' "Not re-running run ${id}."
      continue
    fi
    contract_shaped="$(jq -r '[ .jobs[]? | .conclusion ] | ((map(select(. != "skipped")) == ["failure"]) and (length > 1))' <"$gh_stdout")"
    if [[ "$contract_shaped" != true ]]; then
      continue
    fi
    # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
    if ! gh_api POST "repos/${REPOSITORY}/actions/runs/${id}/rerun-failed-jobs"; then
      if [[ "$GH_HTTP_STATUS" == 403 ]]; then
        echo "::warning::re-running run ${id} returned HTTP 403; rerun-contract-only-siblings needs 'actions: write' on the ci-status job."
      else
        echo "::warning::could not re-run run ${id} (HTTP ${GH_HTTP_STATUS:-unknown})."
      fi
      cat "$gh_stderr" >&2
      continue
    fi
    echo "Re-running failed contract-only run ${id} on ${SHA}."
    rerun_count=$((rerun_count + 1))
  done
  echo "Re-ran ${rerun_count} failed contract-only run(s) on ${SHA}."
}

if [[ "$rerun_contract_only_siblings" == true ]]; then
  # shellcheck disable=SC2310 # errexit is off inside on purpose: the success is recorded, and a body jq cannot parse must not turn it red.
  rerun_failed_contract_only_siblings || true
fi
