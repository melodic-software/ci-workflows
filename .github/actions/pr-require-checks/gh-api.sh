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
# A rate limit waits, then retries once: `retry-after` seconds when present,
# else until `x-ratelimit-reset` when remaining is `0`, else 60 seconds, the
# order GitHub documents
# (https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
# `RATE_LIMIT_WAIT_SECONDS` caps the waits of the whole step, summed. A wait
# that does not fit in what is left of the cap is not taken: the call fails at
# once and the warning names the reset time. A second rate limit after the wait
# fails too. The caller's handling of a failed call decides the verdict, and no
# path turns a failure into a pass.
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
GH_HTTP_STATUS=""
GH_MESSAGE=""
GH_FAILURE=""
GH_GRAPHQL_ERRORS=false
GH_GRAPHQL_ERROR_TYPES=""

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
  local status=0 include=true argument
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
  # `set +e` around the call: a failed API call is classified by the caller,
  # not aborted by errexit.
  set +e
  if [[ "$include" == true ]]; then
    gh api -X "$method" "$path" "$@" -i >"$gh_stdout.raw" 2>"$gh_stderr"
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
  if [[ "$path" == graphql ]] && jq -e 'type == "object" and ((.errors // []) | length > 0)' <"$gh_stdout" >/dev/null 2>&1; then
    GH_GRAPHQL_ERRORS=true
    GH_GRAPHQL_ERROR_TYPES="$(jq -r '[.errors[]? | .type? | strings] | join(",")' <"$gh_stdout" 2>/dev/null || true)"
    if [[ "$status" -eq 0 ]]; then
      status=1
    fi
  fi
  if [[ "$status" -ne 0 ]]; then
    GH_HTTP_STATUS="$(sed -n 's/.*(HTTP \([0-9][0-9]*\)).*/\1/p' "$gh_stderr" | head -n1)"
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

gh_api() {
  local method="$1" path="$2"
  local status reset_at wait left
  # shellcheck disable=SC2310 # gh_api_once handles its own errexit; the status is classified below.
  gh_api_once "$@" && return 0
  status=$?
  # shellcheck disable=SC2310 # gh_classify reports a status it does not classify through its return.
  if ! gh_classify "$method" "$path" || [[ "$GH_FAILURE" != rate-limit ]]; then
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
  # shellcheck disable=SC2310 # gh_api_once handles its own errexit; the status is classified below.
  gh_api_once "$@" && return 0
  status=$?
  # shellcheck disable=SC2310 # gh_classify reports a status it does not classify through its return.
  if gh_classify "$method" "$path" && [[ "$GH_FAILURE" == rate-limit ]]; then
    echo "::warning::${method} ${path} is still rate limited after the wait; not retrying."
  fi
  return "$status"
}
