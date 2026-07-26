# shellcheck shell=bash

# Project the last claude-code-action SDK result message into safe, structured
# metadata and classify a genuine infrastructure failure into exactly one coarse
# class: auth | rate-limit | overloaded | other. Reads EXECUTION_FILE (the
# action's execution_file output, which may be unset, missing, or unparsable)
# and sets review_detail plus failure_class as shell variables and step outputs.
#
# This runs on a PUBLIC repo. The result message's `result` field is
# model-authored free text and its `errors[]` entries are raw error stacks; both
# are read INSIDE this block only, and nothing but the class token and the
# structured projection below ever leaves it. Never widen the projection to
# either field, and never echo the result message wholesale.
#
# Classification order:
#   1. `api_error_status` — the Anthropic-API HTTP status the SDK records when
#      the last assistant turn was an API error: 401/403 auth, 429 rate-limit,
#      5xx overloaded, every other status other.
#   2. an allowlisted substring over `errors[]`, matching the serialized
#      Anthropic error body (`{"type":"error","error":{"type":"<type>",...}}`)
#      that the API SDK folds into an APIError's message, and so into its stack.
#   3. other.
#
# The two sources are disjoint members of the SDK's result union:
# `api_error_status` exists only on the success variant (the shape a dead
# credential produces — subtype success, is_error true) and `errors[]` only on
# the error subtypes. So the substring pass is the error-variant path, not a
# second look at the same payload, and a present-but-unmapped status stays a
# status decision rather than falling through to it.
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

review_detail="(no execution file was produced)"
failure_class="other"

if [[ -n "${EXECUTION_FILE:-}" && -f "$EXECUTION_FILE" ]]; then
  review_detail=$(jq -c '
    (.[-1] // empty) as $last
    | if $last == null then empty
      else
        $last.api_error_status as $status
        | (($last.errors // []) | map(tostring) | join("\n")) as $text
        | (
            if ($status | type) == "number" then
              if $status == 401 or $status == 403 then "auth"
              elif $status == 429 then "rate-limit"
              elif $status >= 500 and $status < 600 then "overloaded"
              else "other"
              end
            elif ($text | (contains("\"type\":\"authentication_error\"")
              or contains("\"type\":\"permission_error\""))) then "auth"
            elif ($text | contains("\"type\":\"rate_limit_error\"")) then "rate-limit"
            elif ($text | (contains("\"type\":\"overloaded_error\"")
              or contains("\"type\":\"api_error\""))) then "overloaded"
            else "other"
            end
          ) as $class
        | {
            subtype: $last.subtype,
            is_error: $last.is_error,
            num_turns: $last.num_turns,
            duration_ms: $last.duration_ms,
            total_cost_usd: $last.total_cost_usd,
            api_error_status: $status,
            class: $class
          }
      end
  ' "$EXECUTION_FILE" 2>/dev/null || true)
  if [[ -n "$review_detail" ]]; then
    failure_class=$(jq -r '.class // "other"' <<<"$review_detail" 2>/dev/null || true)
    [[ -n "$failure_class" ]] || failure_class="other"
  else
    review_detail="(execution file present but unparsable)"
  fi
fi

{
  echo "failure_class=$failure_class"
  echo "review_detail=$review_detail"
} >>"$GITHUB_OUTPUT"
