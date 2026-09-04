#!/usr/bin/env bash
# Aggregate lane results into the single required gate check, and carry that
# verdict forward to contract-only pull-request events.
#
# Full mode (the event action is NOT in `carry-forward-actions`): aggregate
# `results` exactly as before, then record the verdict as a commit status on the
# head SHA under `status-context`. That status is the only signal a
# contract-only run can trust, because a check run cannot say which event
# produced it — a chain of contract-only runs could otherwise self-certify.
#
# Carry-forward mode (the event action IS in the list): the lanes were gated off
# by construction, so aggregation is skipped and the combined commit status for
# `status-context` on the same SHA decides. The combined-status endpoint returns
# the latest state per context, so a later full-run failure on the same SHA
# overrides an earlier success.
set -euo pipefail

: "${TREAT_SKIPPED_AS:?TREAT_SKIPPED_AS is required}"

RESULTS="${RESULTS:-}"
EVENT_ACTION="${EVENT_ACTION:-}"
CARRY_FORWARD_ACTIONS="${CARRY_FORWARD_ACTIONS:-edited,labeled,unlabeled}"
STATUS_CONTEXT="${STATUS_CONTEXT:-ci-lanes}"
REPOSITORY="${REPOSITORY:-}"
SHA="${SHA:-}"
# Retries are 1s, 2s, 4s in CI; the harness sets 0 so a nine-second sleep does
# not ride on every refused-write case.
STATUS_RETRY_BASE_DELAY="${STATUS_RETRY_BASE_DELAY:-1}"

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

is_carry_forward_action() {
  local candidate
  [[ -n "$EVENT_ACTION" ]] || return 1
  while IFS= read -r candidate; do
    candidate="${candidate#"${candidate%%[![:space:]]*}"}"
    candidate="${candidate%"${candidate##*[![:space:]]}"}"
    [[ -n "$candidate" ]] || continue
    if [[ "$candidate" == "$EVENT_ACTION" ]]; then
      return 0
    fi
    # `printf '%s\n'` (not '%s'): without the trailing newline `read` drops the
    # last list entry, which silently un-enrols `unlabeled` from carry-forward.
  done < <(printf '%s\n' "$CARRY_FORWARD_ACTIONS" | tr ',' '\n')
  return 1
}

# ---------------------------------------------------------------------------
# Carry-forward mode.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2310 # a pure predicate over the input list; it runs no fallible command.
if is_carry_forward_action; then
  : "${REPOSITORY:?REPOSITORY is required in carry-forward mode}"
  : "${SHA:?SHA is required in carry-forward mode}"
  echo "Contract-only event '${EVENT_ACTION}': reading the ${STATUS_CONTEXT} status on ${SHA} instead of aggregating skipped lanes."
  # shellcheck disable=SC2310 # gh_api handles its own errexit; the caller classifies the status.
  if ! gh_api GET "repos/${REPOSITORY}/commits/${SHA}/status"; then
    cat "$gh_stderr" >&2
    echo "::error::no successful ${STATUS_CONTEXT} status on ${SHA}; re-run the full workflow"
    exit 1
  fi
  state="$(jq -r --arg context "$STATUS_CONTEXT" \
    '[ (.statuses // [])[] | select(.context == $context) ] | (.[0].state // "")' \
    <"$gh_stdout")"
  if [[ "$state" == success ]]; then
    echo "Carried forward: ${STATUS_CONTEXT} is success on ${SHA}."
    exit 0
  fi
  echo "::error::no successful ${STATUS_CONTEXT} status on ${SHA}; re-run the full workflow"
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
# Record the verdict as a commit status. Load-bearing, not best-effort: the
# carry-forward branch reads nothing else, so a silently missing status turns
# every later contract-only run red with no way to tell a refused write from a
# genuinely failing lane.
# ---------------------------------------------------------------------------
: "${REPOSITORY:?REPOSITORY is required to record the ${STATUS_CONTEXT} status}"
: "${SHA:?SHA is required to record the ${STATUS_CONTEXT} status}"

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
