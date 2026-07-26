# shellcheck shell=bash
set -euo pipefail

core="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/classify-infra-failure.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
github_output="$temporary_directory/output"
execution_file="$temporary_directory/execution.json"

# A distinctive string standing in for the model-authored `result` text and the
# raw error stacks: it must never reach an output, because those two fields are
# the ones this repo keeps off every public surface.
CANARY='canary-never-publish-this'

result_message() { # api_error_status_json extra_json
  extra="${2:-}"
  [[ -n "$extra" ]] || extra='{}'
  jq -cn --argjson status "$1" --argjson extra "$extra" --arg canary "$CANARY" '
    [{
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      duration_ms: 1856,
      total_cost_usd: 0,
      result: ("model-authored free text " + $canary),
      api_error_status: $status
    } + $extra]
  '
}

error_message() { # errors_json_array
  jq -cn --argjson errors "$1" '
    [{
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 2,
      duration_ms: 42,
      total_cost_usd: 0,
      errors: $errors
    }]
  '
}

# The first element of a real error-variant `errors[]` is always a synthetic
# diagnostic line; no allowlist token may collide with its vocabulary.
diagnostic='"[ede_diagnostic] result_type=api_error last_content_type=text stop_reason=null"' # spellchecker:disable-line

api_error_body() { # error_type -> a serialized APIError stack line
  jq -cn --arg type "$1" --arg canary "$CANARY" '
    "APIError: {\"type\":\"error\",\"error\":{\"type\":\"" + $type +
    "\",\"message\":\"" + $canary + "\"}}\n    at request (/x/y.js:1:1)"
  '
}

run() { # execution_file_contents -> sets status, out, class, detail
  if [[ "$#" -gt 0 ]]; then
    jq -c . <<<"$1" >"$execution_file"
  fi
  set +e
  out="$(EXECUTION_FILE="$execution_file" GITHUB_OUTPUT="$github_output" bash "$core" 2>&1)"
  status=$?
  set -e
  class="$(sed -n 's/^failure_class=//p' "$github_output" 2>/dev/null || true)"
  detail="$(sed -n 's/^review_detail=//p' "$github_output" 2>/dev/null || true)"
  rm -f -- "$github_output"
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_class() { # label expected_class contents
  run "$3"
  [[ "$status" == 0 ]] || fail "$1: expected exit 0, got $status ($out)"
  [[ "$class" == "$2" ]] || fail "$1: expected class '$2', got '$class' (detail: $detail)"
  grep -F "$CANARY" <<<"$out$detail$class" >/dev/null &&
    fail "$1: free-text field reached an output surface"
  return 0
}

# 1-5. The structured Anthropic-API status decides the class on the shape a
#      dead credential produces (subtype success, is_error true).
assert_class '401' auth "$(result_message 401)"
assert_class '403' auth "$(result_message 403)"
assert_class '429' rate-limit "$(result_message 429)"
assert_class '500' overloaded "$(result_message 500)"
assert_class '529' overloaded "$(result_message 529)"

# 6. A status outside the mapped set is still a status decision: it resolves to
#    `other` rather than falling through to the substring pass.
assert_class 'unmapped status' other \
  "$(result_message 402 "{\"errors\":[$(api_error_body rate_limit_error)]}")"

# 7. A status present but null is treated as absent, so the substring pass runs.
assert_class 'null status with auth text' auth \
  "$(result_message null "{\"errors\":[$diagnostic,$(api_error_body authentication_error)]}")"

# 8-11. The error-variant substring pass, one case per allowlisted token.
assert_class 'authentication_error' auth \
  "$(error_message "[$diagnostic,$(api_error_body authentication_error)]")"
assert_class 'permission_error' auth \
  "$(error_message "[$diagnostic,$(api_error_body permission_error)]")"
assert_class 'rate_limit_error' rate-limit \
  "$(error_message "[$diagnostic,$(api_error_body rate_limit_error)]")"
assert_class 'overloaded_error' overloaded \
  "$(error_message "[$diagnostic,$(api_error_body overloaded_error)]")"
assert_class 'api_error' overloaded \
  "$(error_message "[$diagnostic,$(api_error_body api_error)]")"

# 12. The synthetic diagnostic line alone must not match any token, even though
#     it can carry the literal text `api_error` in its result_type field.
assert_class 'diagnostic only' other "$(error_message "[$diagnostic]")"

# 13. The observed incident payload, whose projection carried no class field at
#     all: no status, no errors, nothing to classify.
assert_class 'unclassifiable' other \
  '[{"type":"result","subtype":"success","is_error":true,"num_turns":1,"duration_ms":1856,"total_cost_usd":0}]'

# 14. The class token joins the safe projection alongside the numeric status.
run "$(result_message 401)"
[[ "$(jq -r '.class' <<<"$detail")" == auth ]] || fail "projection: missing class ($detail)"
[[ "$(jq -r '.api_error_status' <<<"$detail")" == 401 ]] || fail "projection: missing status ($detail)"
[[ "$(jq -r 'has("result") or has("errors")' <<<"$detail")" == false ]] ||
  fail "projection: leaked a free-text field ($detail)"

# 15. An unparsable execution file degrades to `other` and says so, rather than
#     emitting an empty detail that reads as a successful projection.
run
jq -c . <<<'[]' >"$execution_file"
run
[[ "$class" == other ]] || fail "empty array: expected other, got '$class'"
[[ "$detail" == '(execution file present but unparsable)' ]] ||
  fail "empty array: unexpected detail '$detail'"

cp /dev/null "$execution_file"
run
[[ "$class" == other ]] || fail "unparsable: expected other, got '$class'"
[[ "$detail" == '(execution file present but unparsable)' ]] ||
  fail "unparsable: unexpected detail '$detail'"

# 16. No execution file at all (the action failed before producing one).
rm -f -- "$execution_file"
run
[[ "$class" == other ]] || fail "missing file: expected other, got '$class'"
[[ "$detail" == '(no execution file was produced)' ]] ||
  fail "missing file: unexpected detail '$detail'"

out="$(EXECUTION_FILE="" GITHUB_OUTPUT="$github_output" bash "$core" 2>&1)"
class="$(sed -n 's/^failure_class=//p' "$github_output")"
detail="$(sed -n 's/^review_detail=//p' "$github_output")"
rm -f -- "$github_output"
[[ "$class" == other ]] || fail "empty EXECUTION_FILE: expected other, got '$class'"
[[ "$detail" == '(no execution file was produced)' ]] ||
  fail "empty EXECUTION_FILE: unexpected detail '$detail'"

# 17. An unset GITHUB_OUTPUT fails closed instead of silently discarding the
#     class the annotation and the PR comment are both keyed on.
set +e
out="$(EXECUTION_FILE="" bash "$core" 2>&1)"
status=$?
set -e
[[ "$status" != 0 ]] || fail "unset GITHUB_OUTPUT: expected non-zero exit, got 0 ($out)"

echo "classify-infra-failure.sh: all cases passed"
