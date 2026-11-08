# shellcheck shell=bash
# shellcheck disable=SC2154 # gh_stdout, gh_stderr and gh_headers are set by the sourcing script.
# `gh_api` for the pr-require-checks runners, sourced by aggregate-results and
# check-contract. The caller sets `gh_stdout`, `gh_stderr` and `gh_headers`
# (scratch files) and defines `escape_annotation` before the first call.
#
# gh_api <method> <path> [extra args...]
# Writes the response body to `gh_stdout`, gh's stderr to `gh_stderr`, and the
# response headers to `gh_headers`. On failure sets `GH_HTTP_STATUS` from gh's
# "(HTTP nnn)" tail and `GH_MESSAGE` from gh's message, and, on a 403 or 429,
# `GH_FAILURE` to `rate-limit`, `permission` or `other`. Returns gh's status.
#
# A 403 or 429 prints one warning with the status, the message and the
# `x-ratelimit-remaining`, `x-ratelimit-reset`, `retry-after` and
# `x-accepted-github-permissions` headers. GitHub returns 403 or 429 for both
# rate limits and refusals, so the status alone never names the cause
# (https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api).
# It is a rate limit when `retry-after` is present, `x-ratelimit-remaining` is
# `0`, or the message names a rate limit; it is a permission failure when the
# message is "Resource not accessible by integration" or the
# `x-accepted-github-permissions` header is present.
#
# A call is sent at most `GH_API_ATTEMPTS` (3) times.
#
# A rate limit waits, then retries once: `retry-after` seconds when present,
# else until `x-ratelimit-reset` when remaining is `0`, else 60 seconds, the
# order GitHub documents
# (https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
# `RATE_LIMIT_WAIT_SECONDS` caps the waits of the whole step, summed. A wait
# that does not fit in what is left of the cap is not taken: the call fails at
# once and the warning names the reset time. A second rate limit after the wait
# fails too. GitHub refused a rate-limited request, so any method is retried.
#
# A 5xx, or a failure with no HTTP status (a network error), is sent again
# after a full-jitter wait of 0 to `GH_API_RETRY_BASE_SECONDS` seconds, then 0
# to twice that, but only when a resend cannot do the write twice: GET, PUT,
# PATCH, DELETE, a GraphQL query (never a `mutation`), or a POST whose caller
# sets `GH_API_RESEND=true` because it sends the same state each time. Any other POST may have taken effect before the error, so it is
# never resent. A caller whose own poll already reads again sets
# `GH_API_RETRY_ERRORS=false`, so a poll never multiplies the sends. Any other
# 4xx fails at once. A resendable call can take up to 32 s more than one send:
# two more sends GitHub may cut off at 10 s each, and up to 12 s of waits. The
# caller's handling of a failed call decides the verdict, and no path turns a
# failure into a pass.
#
# A GET sent with `-i` and answered with an `etag` is remembered with its body,
# keyed by the whole call. Sent again, it carries `If-None-Match`, and a `304`
# reuses the remembered body: GitHub bills no primary rate limit for an
# authorized `304`
# (https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate).
# A paginated call sends no `etag`, since it is not read with `-i`.
#
# Headers come from `gh api -i`, which mixes them into stdout, so they are split
# off here. `-i` is not passed with `--paginate`: gh prints a header block per
# page, and with `--slurp` wraps the raw output in a JSON array. A paginated
# call is classified from its message alone.
#
# `gh_api POST graphql -f query=... [-f/-F variables...]` is a GraphQL call,
# billed to the GraphQL rate limit rather than the REST one. GraphQL answers a
# primary rate limit with HTTP 200, an error message and
# `x-ratelimit-remaining: 0`, and a secondary one with 200 or 403
# (https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api),
# so the status alone misses it. Any `errors` entry fails the call, whatever
# gh's exit status, and its data is never read: `GH_HTTP_STATUS` comes from the
# response's status line, `GH_MESSAGE` from the first error, and
# `GH_GRAPHQL_ERROR_TYPES` lists the error types. It is a rate limit when an
# error's type is `RATE_LIMITED` or by the REST tests above, a permission
# failure when a type is `FORBIDDEN` or by those tests, and is reported, waited
# out and retried exactly as a REST rate limit is. A 200 with no `errors` is a
# success, so the caller must check every field it reads: GraphQL returns
# `null` for a resource it cannot resolve.

RATE_LIMIT_WAIT_SECONDS="${RATE_LIMIT_WAIT_SECONDS:-60}"
RATE_LIMIT_WAITED=0
GH_API_ATTEMPTS=3
# Overridable only so a harness can run without the waits; anything but 0 to
# 8 reads as 4, so the job env can never stretch the waits.
GH_API_RETRY_BASE_SECONDS="${GH_API_RETRY_BASE_SECONDS:-4}"
[[ "$GH_API_RETRY_BASE_SECONDS" =~ ^[0-8]$ ]] || GH_API_RETRY_BASE_SECONDS=4
GH_API_RESEND=false
GH_API_RETRY_ERRORS=true
GH_HTTP_STATUS=""
GH_MESSAGE=""
GH_FAILURE=""
GH_GRAPHQL_ERRORS=false
GH_GRAPHQL_ERROR_TYPES=""

# Call counting. Every request appends one reading line to a file under
# `gh_api_calls_dir`, which this step owns, in report-api-budget's format, so
# that action's api_budget_emit_calls prints the notice. The composites share
# one job and one RUNNER_TEMP, so the step's own directory keeps each count to
# its own step. report-api-budget is resolved beside this file, so a caller
# pinning these actions by SHA reads the function from the same ref.
#
# gh_api_calls_report prints the `api-calls` notice and a step-summary line;
# each runner calls it once from its EXIT trap, so the notice is the step's
# last annotation and appears on failure too. GitHub keeps 10 notice
# annotations per step and drops later ones
# (https://raw.githubusercontent.com/actions/toolkit/HEAD/docs/problem-matchers.md),
# so the summary line still carries the count when the notice is dropped.
# Neither counting nor reporting ever changes an exit status.
gh_api_calls_dir="$(mktemp -d 2>/dev/null || true)"
if [[ -n "$gh_api_calls_dir" ]] && ! mkdir -p "$gh_api_calls_dir/api-budget" 2>/dev/null; then
  gh_api_calls_dir=""
fi
# shellcheck source=../report-api-budget/api-budget.bash
source "${BASH_SOURCE[0]%/*}/../report-api-budget/api-budget.bash" 2>/dev/null || true

# gh_api_count <method> <path> <status> <requests>: <requests> readings, each
# `<status> na na na na <resource> <route>`. A 304 is recorded as such, and
# api_budget_emit_calls counts it as not-modified rather than as a request.
gh_api_count() {
  local status="${3:-na}" requests="${4:-1}" resource=na route=other i
  [[ -n "$gh_api_calls_dir" ]] || return 0
  [[ "$status" =~ ^[0-9]{3}$ ]] || status=na
  [[ "$requests" =~ ^[1-9][0-9]{0,4}$ ]] || requests=1
  if [[ "$2" == graphql ]]; then
    resource=graphql
    route=graphql
  fi
  for ((i = 0; i < requests; i++)); do
    printf '%s na na na na %s %s\n' "$status" "$resource" "$route"
  done 2>/dev/null >>"$gh_api_calls_dir/api-budget/github-token" || true
  return 0
}

gh_api_calls_report() {
  local line
  if [[ -z "$gh_api_calls_dir" ]] || ! declare -F api_budget_emit_calls >/dev/null; then
    return 0
  fi
  # shellcheck disable=SC2310,SC2311 # counting never stops the step.
  line="$(RUNNER_TEMP="$gh_api_calls_dir" api_budget_emit_calls github-token 2>/dev/null || true)"
  rm -rf -- "${gh_api_calls_dir:?}" 2>/dev/null || true
  [[ -n "$line" ]] || return 0
  printf '%s\n' "$line"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '\nAPI calls: %s\n' "${line#*title=api-calls::}" 2>/dev/null >>"$GITHUB_STEP_SUMMARY" || true
  fi
  return 0
}

# The value of one response header, matched case-insensitively; gh prints the
# names in Go's canonical case (`X-Ratelimit-Remaining`).
gh_header() {
  awk -v name="$1" '
    { sub(/\r$/, "") }
    index($0, ":") > 0 && tolower(substr($0, 1, index($0, ":") - 1)) == name {
      value = substr($0, index($0, ":") + 1)
      sub(/^[ \t]+/, "", value)
      print value
      exit
    }' "$gh_headers"
}

gh_api_once() {
  local method="$1" path="$2"
  shift 2
  local status=0 include=true argument cached="" etag code
  local -a conditional=()
  for argument in "$@"; do
    if [[ "$argument" == --paginate ]]; then
      include=false
    fi
  done
  : >"$gh_stdout"
  : >"$gh_stderr"
  : >"$gh_headers"
  GH_HTTP_STATUS=""
  GH_MESSAGE=""
  GH_FAILURE=""
  GH_GRAPHQL_ERRORS=false
  GH_GRAPHQL_ERROR_TYPES=""
  if [[ "$include" == true && "$method" == GET ]]; then
    mkdir -p -- "$gh_stdout.etag"
    cached="$gh_stdout.etag/$(printf '%s\0' "$method" "$path" "$@" | sha256sum | cut -c1-64)"
    if [[ -s "$cached.etag" && -f "$cached.body" ]]; then
      conditional=(-H "If-None-Match: $(cat -- "$cached.etag")")
    fi
  fi
  # `set +e` around the call: a failed API call is classified by the caller,
  # not aborted by errexit.
  set +e
  if [[ "$include" == true ]]; then
    gh api -X "$method" "$path" "$@" "${conditional[@]}" -i >"$gh_stdout.raw" 2>"$gh_stderr"
    status=$?
    # Headers run from the `HTTP/` status line to the first empty line. Output
    # that does not open with a status line is all body.
    awk -v headers="$gh_headers" '
      NR == 1 && !/^HTTP\// { body = 1 }
      body { print; next }
      { sub(/\r$/, "") }
      $0 == "" { body = 1; next }
      { print >headers }' "$gh_stdout.raw" >"$gh_stdout"
  else
    gh api -X "$method" "$path" "$@" >"$gh_stdout" 2>"$gh_stderr"
    status=$?
  fi
  set -e
  code="$(awk 'NR == 1 && /^HTTP\// { print $2 }' "$gh_headers")"
  if [[ -n "$cached" ]]; then
    # gh exits 1 on a `304`, with `gh: HTTP 304` and no body.
    if [[ "$code" == 304 && ${#conditional[@]} -gt 0 ]]; then
      cp -- "$cached.body" "$gh_stdout"
      status=0
    elif [[ "$status" -eq 0 ]]; then
      # shellcheck disable=SC2311 # gh_header is one awk read; errexit has nothing to stop in it.
      etag="$(gh_header etag)"
      if [[ -n "$etag" ]]; then
        printf '%s' "$etag" >"$cached.etag"
        cp -- "$gh_stdout" "$cached.body"
      else
        rm -f -- "$cached.etag" "$cached.body"
      fi
    fi
  fi
  if [[ "$path" == graphql ]] && jq -e 'type == "object" and ((.errors // []) | length > 0)' <"$gh_stdout" >/dev/null 2>&1; then
    GH_GRAPHQL_ERRORS=true
    GH_GRAPHQL_ERROR_TYPES="$(jq -r '[.errors[]? | .type? | strings] | join(",")' <"$gh_stdout" 2>/dev/null || true)"
    if [[ "$status" -eq 0 ]]; then
      status=1
    fi
  fi
  if [[ "$status" -ne 0 ]]; then
    GH_HTTP_STATUS="$(sed -n 's/.*(HTTP \([0-9][0-9]*\)).*/\1/p' "$gh_stderr" | head -n1)"
    # A response with no error message, such as a `304`, reads `gh: HTTP 304`;
    # the status line still names the status.
    if [[ -z "$GH_HTTP_STATUS" && "$code" =~ ^[0-9]{3}$ ]]; then
      GH_HTTP_STATUS="$code"
    fi
    GH_MESSAGE="$(sed -n 's/^gh: \(.*\) (HTTP [0-9][0-9]*)$/\1/p' "$gh_stderr" | head -n1)"
    if [[ "$GH_GRAPHQL_ERRORS" == true ]]; then
      if [[ -z "$GH_HTTP_STATUS" ]]; then
        GH_HTTP_STATUS="$(awk 'NR == 1 && /^HTTP\// { print $2 }' "$gh_headers")"
        [[ "$GH_HTTP_STATUS" =~ ^[0-9]{3}$ ]] || GH_HTTP_STATUS=""
      fi
      GH_MESSAGE="$(jq -r 'first(.errors[]? | .message? | strings) // ""' <"$gh_stdout" 2>/dev/null | head -n1 || true)"
    fi
    if [[ -z "$GH_MESSAGE" ]]; then
      GH_MESSAGE="$(head -n1 "$gh_stderr")"
    fi
  fi
  # A paginated call carries no status line; `--slurp` wraps one array element
  # per page, so a successful one counts a request per page.
  local count_status="" count_requests=1
  if [[ "$include" == true ]]; then
    count_status="$(awk 'NR == 1 && /^HTTP\// { print $2 }' "$gh_headers" 2>/dev/null || true)"
  elif [[ "$status" -eq 0 ]]; then
    count_status=200
    count_requests="$(jq 'if type == "array" then length else 1 end' <"$gh_stdout" 2>/dev/null || true)"
  fi
  if [[ -z "$count_status" ]]; then
    count_status="$GH_HTTP_STATUS"
  fi
  gh_api_count "$method" "$path" "$count_status" "$count_requests"
  return "$status"
}

# On a 403 or 429, or a GraphQL `errors` entry, sets `GH_FAILURE` and the four
# header values and prints the report line. Returns 1 for any other failure.
# shellcheck disable=SC2311 # gh_header is one awk read; errexit has nothing to stop in it.
gh_classify() {
  local method="$1" path="$2"
  if [[ "$GH_HTTP_STATUS" != 403 && "$GH_HTTP_STATUS" != 429 && "$GH_GRAPHQL_ERRORS" != true ]]; then
    return 1
  fi
  gh_remaining="$(gh_header x-ratelimit-remaining)"
  gh_reset="$(gh_header x-ratelimit-reset)"
  gh_retry_after="$(gh_header retry-after)"
  gh_accepted="$(gh_header x-accepted-github-permissions)"
  if [[ ",${GH_GRAPHQL_ERROR_TYPES}," == *,RATE_LIMITED,* || -n "$gh_retry_after" || "$gh_remaining" == 0 || "${GH_MESSAGE,,}" == *'rate limit'* ]]; then
    GH_FAILURE=rate-limit
  elif [[ ",${GH_GRAPHQL_ERROR_TYPES}," == *,FORBIDDEN,* || "$GH_MESSAGE" == *'Resource not accessible by integration'* || -n "$gh_accepted" ]]; then
    GH_FAILURE=permission
  else
    GH_FAILURE=other
  fi
  echo "::warning::${method} ${path} returned HTTP ${GH_HTTP_STATUS:-unknown}${GH_GRAPHQL_ERROR_TYPES:+ with GraphQL error $(escape_annotation "$GH_GRAPHQL_ERROR_TYPES")} (${GH_FAILURE}): $(escape_annotation "$GH_MESSAGE"); x-ratelimit-remaining=$(escape_annotation "${gh_remaining:-absent}") x-ratelimit-reset=$(escape_annotation "${gh_reset:-absent}") retry-after=$(escape_annotation "${gh_retry_after:-absent}") x-accepted-github-permissions=$(escape_annotation "${gh_accepted:-absent}")"
}

# Whether a 5xx or a network error may be sent again; see the header.
gh_api_resendable() {
  local method="$1" path="$2" argument
  shift 2
  case "$method" in
    GET | HEAD | PUT | PATCH | DELETE) return 0 ;;
    POST)
      if [[ "$path" == graphql ]]; then
        for argument in "$@"; do
          if [[ "$argument" == query=* && "$argument" == *mutation* ]]; then
            return 1
          fi
        done
        return 0
      fi
      [[ "$GH_API_RESEND" == true ]]
      ;;
    *) return 1 ;;
  esac
}

gh_api() {
  local method="$1" path="$2"
  local status reset_at wait left attempt=1 rate_waited=false ceiling
  while :; do
    # shellcheck disable=SC2310 # gh_api_once handles its own errexit; the status is classified below.
    gh_api_once "$@" && return 0
    status=$?
    # shellcheck disable=SC2310 # gh_classify reports a status it does not classify through its return.
    if gh_classify "$method" "$path"; then
      if [[ "$GH_FAILURE" != rate-limit ]]; then
        return "$status"
      fi
      if [[ "$rate_waited" == true ]]; then
        echo "::warning::${method} ${path} is still rate limited after the wait; not retrying."
        return "$status"
      fi
      if [[ "$attempt" -ge "$GH_API_ATTEMPTS" ]]; then
        return "$status"
      fi
      # At most ten digits, read as decimal: a longer or non-numeric value is
      # treated as absent, so the arithmetic never overflows or reads octal.
      if [[ "$gh_retry_after" =~ ^[0-9]{1,10}$ ]]; then
        wait=$((10#$gh_retry_after))
      elif [[ "$gh_remaining" == 0 && "$gh_reset" =~ ^[0-9]{1,10}$ ]]; then
        wait=$((10#$gh_reset - $(date +%s)))
        if [[ "$wait" -lt 1 ]]; then
          wait=1
        fi
      else
        wait=60
      fi
      left=$((RATE_LIMIT_WAIT_SECONDS - RATE_LIMIT_WAITED))
      if [[ "$wait" -gt "$left" ]]; then
        reset_at="an unknown time"
        if [[ "$gh_reset" =~ ^[0-9]{1,10}$ ]]; then
          reset_at="${gh_reset} ($(jq -rn --arg epoch "$gh_reset" '$epoch | tonumber | todate'))"
        fi
        echo "::warning::${method} ${path} is rate limited and needs a ${wait}s wait, more than the ${left}s left of rate-limit-wait-seconds (${RATE_LIMIT_WAIT_SECONDS}); not waiting. The limit resets at ${reset_at}."
        return "$status"
      fi
      echo "::warning::${method} ${path} is rate limited; waiting ${wait}s, then retrying once."
      sleep "$wait"
      RATE_LIMIT_WAITED=$((RATE_LIMIT_WAITED + wait))
      rate_waited=true
    else
      # shellcheck disable=SC2310 # gh_api_resendable answers through its status.
      if [[ "$attempt" -ge "$GH_API_ATTEMPTS" || "$GH_API_RETRY_ERRORS" != true ]] ||
        [[ -n "$GH_HTTP_STATUS" && ! "$GH_HTTP_STATUS" =~ ^5[0-9][0-9]$ ]] ||
        ! gh_api_resendable "$@"; then
        return "$status"
      fi
      # Full jitter: a random wait from 0 to a ceiling that doubles per attempt.
      ceiling=$((10#$GH_API_RETRY_BASE_SECONDS * (1 << (attempt - 1))))
      wait=$((RANDOM % (ceiling + 1)))
      echo "::warning::${method} ${path} failed (HTTP ${GH_HTTP_STATUS:-unknown}); sending it again in ${wait}s (attempt $((attempt + 1)) of ${GH_API_ATTEMPTS})."
      if [[ "$wait" -gt 0 ]]; then
        sleep "$wait"
      fi
    fi
    attempt=$((attempt + 1))
  done
}
