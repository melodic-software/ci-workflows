#!/usr/bin/env bash
# Aggregate lane results into the single required gate check, and carry that
# verdict forward to contract-only pull-request events.
#
# Full mode (`contract-only` false): aggregate `results` exactly as before, then
# record the verdict as a commit status on the head SHA under `status-context`.
# That status is the only signal a contract-only run can trust, because a check
# run cannot say which event produced it — a chain of contract-only runs could
# otherwise self-certify.
#
# Carry-forward mode (`contract-only` true): the lanes were gated off by
# construction, so aggregation is skipped and the combined commit status for
# `status-context` on the same SHA decides. The combined-status endpoint returns
# the latest state per context, so a later full-run failure on the same SHA
# overrides an earlier success.
#
# When no status of any state is on the SHA yet, the run may simply have started
# before the full run it depends on finished: the branched concurrency group
# (ci-perf Phase 6b) stops a contract-only run queueing behind that full run, so
# the two now race. `carry-forward-wait-seconds` bounds a wait on EARLIER
# incomplete runs of this same workflow on this same head SHA. Only earlier ones:
# that excludes this run from its own wait set and makes mutual waiting between
# two contract-only runs impossible, because the older of the pair waits on
# nothing and fails fast. The wait never turns a verdict green — a recorded
# `failure` still short-circuits, and reaching the ceiling still exits 1.
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
# Ceiling on the carry-forward wait, in seconds. `0` disables it and restores the
# fail-immediately behaviour. Validated below, once `escape_annotation` exists.
CARRY_FORWARD_WAIT_SECONDS="${CARRY_FORWARD_WAIT_SECONDS:-240}"
# Poll interval, deliberately not a caller input: it is an implementation detail
# of the wait, and the only knob a consumer should reason about is the ceiling.
CARRY_FORWARD_POLL_SECONDS=15
# GitHub run statuses that mean "this run has not finished yet". `completed` is
# the only other value, and a completed run either wrote the status or never
# will.
INCOMPLETE_RUN_STATUSES='["queued","in_progress","waiting","pending","requested"]'

# Reject an unrecognised policy rather than silently defaulting: a typo such as
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

# ---------------------------------------------------------------------------
# Carry-forward mode. Branched on first, before `same-repo`: the caller's
# predicate makes `contract-only` false for every fork event, so the
# true/false combination is unreachable from the defaults — but a caller that
# overrides `contract-only` owns the claim that the lanes did not run, and the
# runner honours it rather than second-guessing it into an aggregation over
# results that are all `skipped`.
# ---------------------------------------------------------------------------

# Newest `status-context` state written by the Actions bot on this SHA, or the
# empty string when the context is absent. Sets `carried_state` rather than
# echoing it so the caller can distinguish "read failed" from "read empty"
# through the return status.
carried_state=""
read_carried_state() {
  carried_state=""
  # The LIST endpoint, not the combined one: `commits/<sha>/status` collapses to
  # one entry per context and exposes no author, so any collaborator with write
  # could POST a forged `ci-lanes=success` and then flip a label to turn the
  # sole required check green over failing lanes. The list carries `.creator`,
  # newest first, so the gate can insist the newest entry for this context was
  # written by the Actions bot and ignore anything a human pushed.
  # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
  if ! gh_api GET "repos/${REPOSITORY}/commits/${SHA}/statuses?per_page=100" --paginate; then
    return 1
  fi
  # Highest id wins, not first element: status ids are monotonic, so `max_by`
  # states the intent directly instead of depending on the documented
  # newest-first ordering. A later bot failure on the same SHA therefore
  # overrides an earlier bot success, and a later forged success by a user
  # account is skipped rather than shadowing the bot's real verdict.
  carried_state="$(jq -r --arg context "$STATUS_CONTEXT" --arg creator "$STATUS_CREATOR" \
    '[ .[] | select(.context == $context and (.creator.login // "") == $creator and (.creator.type // "") == "Bot") ] | (max_by(.id).state // "")' \
    <"$gh_stdout")"
}

# Both Actions reads need `actions: read`, which an explicit `permissions:` block
# does not grant by default. Name the scope rather than printing a bare 403, and
# never treat the refusal as permission to pass: the caller falls through to the
# immediate failure it would have taken without the wait.
warn_actions_read_failed() {
  local endpoint="$1"
  if [[ "$GH_HTTP_STATUS" == 403 ]]; then
    echo "::warning::${endpoint} returned HTTP 403; the ci-status job needs 'actions: read' to wait for an earlier full run. Failing without waiting."
  else
    echo "::warning::could not read ${endpoint} (HTTP ${GH_HTTP_STATUS:-unknown}); failing without waiting."
  fi
  cat "$gh_stderr" >&2
}

# Seconds actually slept, and the earlier run ids waited on, for the ceiling
# message. Set by wait_for_earlier_runs.
carry_forward_waited=0
carry_forward_wait_note=""

# Wait for any run of this workflow on this head SHA that is still incomplete AND
# was created strictly before this one, re-reading the status list after each
# sleep. Returns 0 always: every failure mode inside falls through to the
# caller's existing verdict, which is red.
wait_for_earlier_runs() {
  local run_id="${GITHUB_RUN_ID:-}" workflow_id created_at ids all_ids="" sleep_for remaining
  if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
    echo "::warning::GITHUB_RUN_ID is not a run id; cannot exclude this run from its own wait set. Failing without waiting."
    return 0
  fi
  # One fetch of the current run gives both the workflow to enumerate and the
  # `created_at` the ordering term compares against. Reading them from the run
  # itself, not from the event payload, keeps the two consistent.
  # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
  if ! gh_api GET "repos/${REPOSITORY}/actions/runs/${run_id}"; then
    warn_actions_read_failed "repos/${REPOSITORY}/actions/runs/${run_id}"
    return 0
  fi
  workflow_id="$(jq -r '.workflow_id // ""' <"$gh_stdout")"
  created_at="$(jq -r '.created_at // ""' <"$gh_stdout")"
  if [[ ! "$workflow_id" =~ ^[0-9]+$ || -z "$created_at" ]]; then
    echo "::warning::run ${run_id} reported no workflow_id or created_at; failing without waiting."
    return 0
  fi
  while :; do
    # Not `--paginate`: this endpoint returns an object, and concatenated
    # objects are not valid input to the filter below. 100 runs on one head SHA
    # is already far past the burst this wait exists for.
    # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
    if ! gh_api GET "repos/${REPOSITORY}/actions/workflows/${workflow_id}/runs?head_sha=${SHA}&per_page=100"; then
      warn_actions_read_failed "repos/${REPOSITORY}/actions/workflows/${workflow_id}/runs"
      break
    fi
    # `created_at` is an ISO-8601 UTC timestamp of fixed width, so a string
    # comparison is a chronological one. The id test is belt and braces: this
    # run cannot be strictly earlier than itself, but a same-second sibling
    # would be excluded by the timestamp alone and this makes the intent plain.
    ids="$(jq -r --argjson incomplete "$INCOMPLETE_RUN_STATUSES" --arg created "$created_at" --arg self "$run_id" \
      '[ .workflow_runs[]? | select(.status as $s | $incomplete | index($s)) | select((.created_at // "") < $created) | select((.id | tostring) != $self) | .id ] | join(" ")' \
      <"$gh_stdout")"
    if [[ -z "$ids" ]]; then
      # An earlier run can write its status and reach `completed` between the
      # status read that sent us here and this query, which drops it from the
      # wait set. Breaking straight out would then report "no successful status"
      # over a verdict that exists. One more read closes that window; on the
      # common no-earlier-run path it costs a single GET.
      # shellcheck disable=SC2310 # read_carried_state handles its own errexit; the caller classifies the status.
      if ! read_carried_state; then
        cat "$gh_stderr" >&2
      fi
      break
    fi
    all_ids="${all_ids}${all_ids:+ }${ids}"
    remaining=$((CARRY_FORWARD_WAIT_SECONDS - carry_forward_waited))
    if [[ "$remaining" -le 0 ]]; then
      echo "::warning::reached the ${CARRY_FORWARD_WAIT_SECONDS}s carry-forward-wait-seconds ceiling with earlier run(s) ${ids} still incomplete on ${SHA}."
      break
    fi
    sleep_for="$CARRY_FORWARD_POLL_SECONDS"
    if [[ "$sleep_for" -gt "$remaining" ]]; then
      sleep_for="$remaining"
    fi
    echo "Waiting ${sleep_for}s for earlier run(s) ${ids} on ${SHA} to record ${STATUS_CONTEXT} (waited ${carry_forward_waited}s of ${CARRY_FORWARD_WAIT_SECONDS}s)."
    sleep "$sleep_for"
    carry_forward_waited=$((carry_forward_waited + sleep_for))
    # shellcheck disable=SC2310 # read_carried_state handles its own errexit; the caller classifies the status.
    if ! read_carried_state; then
      cat "$gh_stderr" >&2
      break
    fi
    # Any recorded state ends the wait: `success` carries forward, and anything
    # else is a verdict this run must not sit on hoping it improves.
    if [[ -n "$carried_state" ]]; then
      break
    fi
  done
  if [[ "$carry_forward_waited" -gt 0 ]]; then
    carry_forward_wait_note=" (waited ${carry_forward_waited}s of ${CARRY_FORWARD_WAIT_SECONDS}s on earlier run(s): $(printf '%s' "$all_ids" | tr ' ' '\n' | sort -un | tr '\n' ' ' | sed 's/ *$//'))"
  fi
}

if [[ "$contract_only" == true ]]; then
  echo "Contract-only event: reading the ${STATUS_CONTEXT} status on ${SHA} instead of aggregating skipped lanes."
  # shellcheck disable=SC2310 # read_carried_state handles its own errexit; the caller classifies the status.
  if ! read_carried_state; then
    cat "$gh_stderr" >&2
    echo "::error::no successful ${STATUS_CONTEXT} status on ${SHA}; re-run the full workflow"
    exit 1
  fi
  # Only an ABSENT status waits. A recorded `failure`, `error` or `pending` is a
  # verdict already reached on this SHA and short-circuits exactly as before.
  if [[ -z "$carried_state" && "$CARRY_FORWARD_WAIT_SECONDS" -gt 0 ]]; then
    wait_for_earlier_runs
  fi
  if [[ "$carried_state" == success ]]; then
    echo "Carried forward: ${STATUS_CONTEXT} is success on ${SHA} (recorded by ${STATUS_CREATOR})."
    exit 0
  fi
  echo "::error::no successful ${STATUS_CONTEXT} status on ${SHA}; re-run the full workflow${carry_forward_wait_note}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Full mode — aggregate exactly as before.
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
# Record the verdict as a commit status. Load-bearing on a same-repository run,
# not best-effort: the carry-forward branch reads nothing else, so a silently
# missing status turns every later contract-only run red with no way to tell a
# refused write from a genuinely failing lane.
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

target_url="${GITHUB_SERVER_URL:-https://github.com}/${REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-0}"
jq -n \
  --arg state "$lanes_state" \
  --arg context "$STATUS_CONTEXT" \
  --arg description "$lanes_description" \
  --arg target_url "$target_url" \
  '{state: $state, context: $context, description: $description, target_url: $target_url}' \
  >"$scratch/status-payload.json"

status_written=false
for attempt in 1 2 3 4; do
  # shellcheck disable=SC2310 # gh_api handles its own errexit; the retry loop classifies the status.
  if gh_api POST "repos/${REPOSITORY}/statuses/${SHA}" --input "$scratch/status-payload.json"; then
    status_written=true
    break
  fi
  if [[ "$attempt" -lt 4 ]]; then
    delay=$((STATUS_RETRY_BASE_DELAY * (1 << (attempt - 1))))
    echo "::warning::could not record ${STATUS_CONTEXT} on ${SHA} (HTTP ${GH_HTTP_STATUS:-unknown}); retrying in ${delay}s"
    sleep "$delay"
  fi
done

if [[ "$status_written" != true ]]; then
  cat "$gh_stderr" >&2
  echo "::error::could not record ${STATUS_CONTEXT} on ${SHA} (${GH_HTTP_STATUS:-unknown}); the ci-status job needs statuses: write"
  exit 1
fi

echo "Recorded ${STATUS_CONTEXT}=${lanes_state} on ${SHA}."

if [[ "$lanes_state" == failure ]]; then
  exit 1
fi
