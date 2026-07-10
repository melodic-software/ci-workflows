#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$script_directory/pulumi-version-drift.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

mock_bin="$temporary_directory/bin"
state="$temporary_directory/issues.json"
version_file="$temporary_directory/.pulumi.version"
runner_temp="$temporary_directory/runner-temp"
stdout="$temporary_directory/stdout"
stderr="$temporary_directory/stderr"
close_failure="$temporary_directory/fail-close-once"
mkdir -p "$mock_bin" "$runner_temp"

cat >"$mock_bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

state="${MOCK_GH_STATE:?MOCK_GH_STATE is required}"

replace_state() {
  local replacement="$1"
  mv "$replacement" "$state"
}

case "${1:-}" in
  api)
    shift
    if [[ "${1:-}" == 'repos/pulumi/pulumi/releases/latest' ]]; then
      printf 'v%s\n' "${MOCK_LATEST:?MOCK_LATEST is required}"
      exit 0
    fi
    if [[ "${1:-}" == '--paginate' && "${2:-}" == '--slurp' ]]; then
      jq -c '[.]' "$state"
      exit 0
    fi
    exit 90
    ;;
  issue)
    operation="${2:-}"
    shift 2
    case "$operation" in
      create)
        title=''
        body_file=''
        while (($#)); do
          case "$1" in
            --title) title="$2"; shift 2 ;;
            --body-file) body_file="$2"; shift 2 ;;
            *) exit 91 ;;
          esac
        done
        number="$(jq -r '([.[].number] | max // 0) + 1' "$state")"
        replacement="$(mktemp)"
        jq --argjson number "$number" \
          --arg title "$title" \
          --rawfile body "$body_file" \
          --arg created_at "${MOCK_CREATED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" \
          '. + [{number: $number, title: $title, body: $body, state: "open", created_at: $created_at}]' \
          "$state" >"$replacement"
        replace_state "$replacement"
        printf 'https://github.com/example/repository/issues/%s\n' "$number"
        ;;
      edit)
        number="$1"
        shift
        title=''
        body_file=''
        while (($#)); do
          case "$1" in
            --title) title="$2"; shift 2 ;;
            --body-file) body_file="$2"; shift 2 ;;
            *) exit 92 ;;
          esac
        done
        replacement="$(mktemp)"
        jq --argjson number "$number" \
          --arg title "$title" \
          --rawfile body "$body_file" \
          'map(if .number == $number then .title = $title | .body = $body else . end)' \
          "$state" >"$replacement"
        replace_state "$replacement"
        ;;
      reopen)
        number="$1"
        replacement="$(mktemp)"
        jq --argjson number "$number" \
          'map(if .number == $number then .state = "open" else . end)' \
          "$state" >"$replacement"
        replace_state "$replacement"
        ;;
      close)
        number="$1"
        if [[ -n "${MOCK_FAIL_CLOSE_ONCE_FILE:-}" && -f "$MOCK_FAIL_CLOSE_ONCE_FILE" ]]; then
          rm -f -- "$MOCK_FAIL_CLOSE_ONCE_FILE"
          exit 93
        fi
        replacement="$(mktemp)"
        jq --argjson number "$number" \
          'map(if .number == $number then .state = "closed" else . end)' \
          "$state" >"$replacement"
        replace_state "$replacement"
        ;;
      *) exit 94 ;;
    esac
    ;;
  *) exit 95 ;;
esac
MOCK
chmod +x "$mock_bin/gh"

reset_fixtures() {
  printf '[]\n' >"$state"
  printf '1.0.0\n' >"$version_file"
  : >"$stdout"
  : >"$stderr"
  rm -f -- "$close_failure"
}

run_drift() {
  GITHUB_REPOSITORY='example/repository' \
    ISSUE_TITLE='[Maintenance] Pulumi CLI version drift' \
    MOCK_FAIL_CLOSE_ONCE_FILE="$close_failure" \
    MOCK_GH_STATE="$state" \
    MOCK_LATEST="${TEST_LATEST:-2.0.0}" \
    PATH="$mock_bin:$PATH" \
    PULUMI_VERSION_FILE="$version_file" \
    RUNNER_TEMP="$runner_temp" \
    bash "$script" >"$stdout" 2>"$stderr"
}

expect_failure() {
  local description="$1"
  local status
  set +e
  run_drift
  status=$?
  set -e
  if ((status == 0)); then
    printf 'FAIL: %s unexpectedly passed\n' "$description" >&2
    exit 1
  fi
  printf 'PASS: %s\n' "$description"
}

active_marker='ci-workflows:pulumi-cli-version-drift:v1:active'
resolved_marker='ci-workflows:pulumi-cli-version-drift:v1:resolved'

reset_fixtures
printf '1.0\n.0\n' >"$version_file"
expect_failure 'split SemVer fails without whitespace normalization'

reset_fixtures
MOCK_CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" run_drift
jq -e --arg marker "$active_marker" '
  length == 1 and
  .[0].number == 1 and
  .[0].state == "open" and
  (.[0].body | contains($marker))
' "$state" >/dev/null
original_created_at="$(jq -r '.[0].created_at' "$state")"
printf 'PASS: unresolved drift creates one durable active incident\n'

replacement="$temporary_directory/renamed.json"
jq '.[0].title = "manually renamed"' "$state" >"$replacement"
mv "$replacement" "$state"
run_drift
jq -e --arg created_at "$original_created_at" '
  length == 1 and
  .[0].number == 1 and
  .[0].title == "[Maintenance] Pulumi CLI version drift" and
  .[0].created_at == $created_at
' "$state" >/dev/null
printf 'PASS: renamed incident is repaired without resetting age\n'

replacement="$temporary_directory/closed.json"
jq '.[0].state = "closed"' "$state" >"$replacement"
mv "$replacement" "$state"
run_drift
jq -e --arg created_at "$original_created_at" '
  length == 1 and .[0].number == 1 and .[0].state == "open" and
  .[0].created_at == $created_at
' "$state" >/dev/null
printf 'PASS: manually closed unresolved incident is reopened in place\n'

printf '2.0.0\n' >"$version_file"
: >"$close_failure"
expect_failure 'transient close failure preserves active marker'
jq -e --arg marker "$active_marker" '
  length == 1 and .[0].state == "open" and (.[0].body | contains($marker))
' "$state" >/dev/null
run_drift
jq -e --arg active "$active_marker" --arg resolved "$resolved_marker" '
  length == 1 and .[0].state == "closed" and
  ((.[0].body | contains($active)) | not) and
  (.[0].body | contains($resolved))
' "$state" >/dev/null
printf 'PASS: resolution is retry-safe and retires the active marker\n'

TEST_LATEST='3.0.0' run_drift
jq -e --arg active "$active_marker" --arg resolved "$resolved_marker" '
  length == 2 and
  ([.[] | select(.state == "closed" and (.body | contains($resolved)))] | length) == 1 and
  ([.[] | select(.state == "open" and (.body | contains($active)))] | length) == 1
' "$state" >/dev/null
printf 'PASS: later drift creates a separately aged incident\n'

reset_fixtures
now_epoch="$(date -u +%s)"
old_created_at="$(date -u -d "@$((now_epoch - 14 * 24 * 60 * 60 - 60))" +%Y-%m-%dT%H:%M:%SZ)"
jq -cn --arg marker "$active_marker" --arg created_at "$old_created_at" '[{
  number: 1,
  title: "renamed",
  body: ("<!-- " + $marker + " -->"),
  state: "open",
  created_at: $created_at
}]' >"$state"
expect_failure 'active drift beyond the 14-day boundary hard-fails'
grep -F 'at least 14 days' "$stderr" >/dev/null

reset_fixtures
recent_created_at="$(date -u -d "@$((now_epoch - 14 * 24 * 60 * 60 + 60 * 60))" +%Y-%m-%dT%H:%M:%SZ)"
jq -cn --arg marker "$active_marker" --arg created_at "$recent_created_at" '[{
  number: 1,
  title: "renamed",
  body: ("<!-- " + $marker + " -->"),
  state: "open",
  created_at: $created_at
}]' >"$state"
run_drift
printf 'PASS: active drift below the 14-day boundary remains a warning\n'

replacement="$temporary_directory/duplicate.json"
jq '.[1] = (.[0] | .number = 2)' "$state" >"$replacement"
mv "$replacement" "$state"
expect_failure 'duplicate active incidents fail closed'
grep -F 'active Pulumi drift incidents' "$stderr" >/dev/null

reset_fixtures
jq -cn --arg marker "$active_marker" '[{
  number: 99,
  title: "pull request",
  body: ("<!-- " + $marker + " -->"),
  state: "open",
  created_at: "2026-07-10T12:00:00Z",
  pull_request: {url: "https://api.github.com/pulls/99"}
}]' >"$state"
MOCK_CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" run_drift
jq -e --arg marker "$active_marker" '
  length == 2 and
  ([.[] | select(.pull_request? == null and (.body | contains($marker)))] | length) == 1
' "$state" >/dev/null
printf 'PASS: pull requests cannot impersonate a drift incident\n'

printf 'Pulumi version-drift behavioral tests passed.\n'
