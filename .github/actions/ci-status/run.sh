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
# construction, so aggregation is skipped and the recorded commit status for
# `status-context` on the same SHA decides. It is read from the status LIST
# endpoint, which carries `.creator`, and the newest entry by id from
# `github-actions[bot]` wins, so a later full-run failure on the same SHA
# overrides an earlier success. The combined-status endpoint would be shorter
# but exposes no author; see `read_carried_state` for why that matters.
#
# The branched concurrency group (ci-perf Phase 6b) stops a contract-only run
# queueing behind the full run whose status it reads, so the two now race.
# `carry-forward-wait-seconds` bounds a poll loop that closes that race. Each
# poll does three things, in this order:
#
#   1. List the runs of this same workflow on this same head SHA that are still
#      incomplete, excluding this run. Any run id; see below.
#   2. Read the newest `github-actions[bot]` status for `status-context`. A
#      `success` or `failure` is a settled verdict, so stop polling and apply
#      it under the usual rules.
#   3. Otherwise, if step 1 found nothing in flight, stop: no run that could
#      still write a verdict exists, and an absent status fails the run as it
#      always has. If something IS in flight, sleep and poll again.
#
# ANY in-flight sibling, not only one with a lower run id. v0.22.1 waited only
# on lower ids, reasoning that ordering the pair makes a mutual wait impossible.
# The ordering is real; the premise that a full run always holds the lower id is
# not. A pull request opened with labels already applied creates the `opened`
# full run and the `labeled` contract-only run together, and nothing decides
# which of the two draws the lower id. When the contract-only run drew it, its
# wait set was empty, it read a status its sibling had not written yet, and it
# failed instantly. Widening the set to every in-flight sibling fixes that and
# gives up the ordering, so step 2 is what now breaks a mutual wait: once the
# full run writes its verdict, both contract-only runs read it and stop.
#
# Step 1 before step 2 WITHIN a poll. A sibling writes the status and flips to
# `completed` a moment later. Listing after reading would let that completion
# land in the gap between the two calls and report both "no status" and "nothing
# in flight", failing a SHA that does carry a verdict. Listing first closes the
# gap, because a status written before the listing is still read after it.
#
# The loop never turns a verdict green. Reaching the ceiling exits 1 rather than
# passing on an unsettled status; there is no pass-on-timeout path. The one case
# that runs to the ceiling is two or more contract-only runs on a SHA with no
# full run in flight to write a verdict for them: they wait on each other and
# then both fail closed.
#
# Reading a settled status before the wait set empties is a deliberate trade. It
# is what releases the mutual wait above, and it gives up the guard v0.22.1 had
# against carrying an older `success` forward while a re-run of the same SHA is
# in flight to overwrite it. That guard bound only when a full run had already
# written a verdict for this exact SHA and another full run was in flight on it
# again, and it cost a false red on every same-second sibling. The defences
# against a forged status (context, creator login, Bot type, newest id) are
# untouched.
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
# Whether `carried_state` holds a completed read. The poll loop reads the status
# itself, so the caller below must not read a second time and overwrite what the
# loop decided on.
carried_state_read=false
read_carried_state() {
  carried_state=""
  carried_state_read=false
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
  # `|| return 1` rather than a bare assignment: an assignment from a command
  # substitution carries the substitution's status, and every caller invokes
  # this function under `if !`, which suppresses errexit inside it. Without the
  # explicit check a malformed or truncated body would make jq exit nonzero,
  # that status would be discarded, and the function would report a completed
  # read of an empty state. A body this function cannot parse is a failed read.
  carried_state="$(jq -r --arg context "$STATUS_CONTEXT" --arg creator "$STATUS_CREATOR" \
    '[ .[] | select(.context == $context and (.creator.login // "") == $creator and (.creator.type // "") == "Bot") ] | (max_by(.id).state // "")' \
    <"$gh_stdout")" || return 1
  carried_state_read=true
}

# Both Actions reads need `actions: read`, which an explicit `permissions:` block
# does not grant by default. Name the scope rather than printing a bare 403, and
# never treat the refusal as permission to pass: the caller falls through to the
# status read it would have done without the wait, which is the pre-6b contract.
warn_actions_read_failed() {
  local endpoint="$1"
  if [[ "$GH_HTTP_STATUS" == 403 ]]; then
    echo "::warning::${endpoint} returned HTTP 403; the ci-status job needs 'actions: read' to wait for a sibling run. Reading the recorded status without waiting."
  else
    echo "::warning::could not read ${endpoint} (HTTP ${GH_HTTP_STATUS:-unknown}); reading the recorded status without waiting."
  fi
  cat "$gh_stderr" >&2
}

# Seconds actually slept, and the sibling run ids waited on, for the ceiling
# message. Set by wait_for_sibling_runs.
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
# in flight, or the ceiling is reached. See the header for the ordering and for
# why the wait set is every sibling rather than the lower-id ones.
#
# Returns 1 at the ceiling, which the caller turns into the fail-closed error.
# Every other outcome returns 0. On a 0 the caller applies `carried_state` when
# `carried_state_read` is true, and otherwise reads the status itself: that is
# the degraded path, taken when an Actions read fails and when a status read
# fails part way through the loop, and it is the pre-6b behaviour. A failed read
# never leaves `carried_state_read` true, so the degraded path is a fresh read
# that fails closed on its own failure; there is no outcome that passes without
# one completed read.
wait_for_sibling_runs() {
  local run_id="${GITHUB_RUN_ID:-}" workflow_id ids all_ids="" sleep_for remaining
  if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
    echo "::warning::GITHUB_RUN_ID is not a run id; cannot exclude this run from its own wait set. Reading the recorded status without waiting."
    return 0
  fi
  # One fetch of the current run gives the workflow to enumerate. The ordering
  # term needs nothing from it: `GITHUB_RUN_ID` is this run's own id, which is
  # what the wait set is compared against.
  # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
  if ! gh_api GET "repos/${REPOSITORY}/actions/runs/${run_id}"; then
    warn_actions_read_failed "repos/${REPOSITORY}/actions/runs/${run_id}"
    return 0
  fi
  workflow_id="$(jq -r '.workflow_id // ""' <"$gh_stdout")"
  if [[ ! "$workflow_id" =~ ^[0-9]+$ ]]; then
    echo "::warning::run ${run_id} reported no workflow_id; reading the recorded status without waiting."
    return 0
  fi
  while :; do
    # Not `--paginate`: this endpoint returns an object, and concatenated
    # objects are not valid input to the filter below. 100 runs on one head SHA
    # is already far past the burst this wait exists for.
    # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
    if ! gh_api GET "repos/${REPOSITORY}/actions/workflows/${workflow_id}/runs?head_sha=${SHA}&per_page=100"; then
      warn_actions_read_failed "repos/${REPOSITORY}/actions/workflows/${workflow_id}/runs"
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
    ids="$(jq -r --argjson incomplete "$INCOMPLETE_RUN_STATUSES" --argjson self "$run_id" \
      '[ .workflow_runs[]? | select(.status as $s | $incomplete | index($s)) | select((.id // $self) != $self) | .id ] | sort | join(" ")' \
      <"$gh_stdout")"
    # The status read comes AFTER the listing above, never before it: a sibling
    # writes the status and flips to `completed` moments later, and the other
    # order lets that completion land between the two calls.
    # shellcheck disable=SC2310 # read_carried_state handles its own errexit; the caller classifies the status.
    if ! read_carried_state; then
      # The same degraded path the listing failure above takes, for the same
      # reason. This endpoint is now read once per poll, up to sixteen times
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
    # A settled verdict ends the wait whatever is still in flight. This is what
    # releases two contract-only runs that would otherwise wait on each other.
    # `error` is settled alongside `failure`: both are terminal states the API
    # accepts, and neither passes below, so waiting on one only delays a red.
    if [[ "$carried_state" == success || "$carried_state" == failure || "$carried_state" == error ]]; then
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
    carry_forward_waited=$((carry_forward_waited + sleep_for))
  done
  set_wait_note "$all_ids"
}

if [[ "$contract_only" == true ]]; then
  echo "Contract-only event: reading the ${STATUS_CONTEXT} status on ${SHA} instead of aggregating skipped lanes."
  # The poll loop reads the status itself, once per poll and after listing the
  # in-flight siblings. It stops on a settled verdict, on an empty wait set, on
  # a read it could not complete, or at the ceiling.
  if [[ "$CARRY_FORWARD_WAIT_SECONDS" -gt 0 ]]; then
    carry_forward_wait_status=0
    # shellcheck disable=SC2310 # wait_for_sibling_runs reports the ceiling through its status; the caller exits on it.
    wait_for_sibling_runs || carry_forward_wait_status=$?
    if [[ "$carry_forward_wait_status" -ne 0 ]]; then
      # Never pass on timeout: a run that could still write this SHA's verdict
      # is in flight, so whatever is on the SHA right now is not settled.
      echo "::error::no successful ${STATUS_CONTEXT} status on ${SHA}; re-run the full workflow${carry_forward_wait_note}"
      exit 1
    fi
  fi
  # Only when the loop did not read it. Both a failed Actions read and a status
  # read that failed part way through the loop degrade to the pre-6b path, where
  # this is the single status read, and a second failure here fails the run.
  if [[ "$carried_state_read" != true ]]; then
    # shellcheck disable=SC2310 # read_carried_state handles its own errexit; the caller classifies the status.
    if ! read_carried_state; then
      cat "$gh_stderr" >&2
      echo "::error::no successful ${STATUS_CONTEXT} status on ${SHA}; re-run the full workflow${carry_forward_wait_note}"
      exit 1
    fi
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
