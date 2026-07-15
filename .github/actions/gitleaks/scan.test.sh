#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
mkdir -- "$temporary_directory/bin"
printf '[extend]\nuseDefault = true\n' >"$temporary_directory/config.toml"

cat >"$temporary_directory/bin/gitleaks" <<'FAKE'
#!/usr/bin/env bash
printf '%s\0' "$@" >"$CAPTURED_ARGS"
case "$FAKE_MODE" in
clean) exit 0 ;;
finding) exit 1 ;;
error) exit 7 ;;
missing-report) exit 0 ;;
invalid-json) printf '{not json}\n' >"$REPORT_PATH"; exit 0 ;;
valid-json) printf '[]\n' >"$REPORT_PATH"; exit 0 ;;
finding-json) printf '[{"RuleID":"test-rule"}]\n' >"$REPORT_PATH"; exit 1 ;;
invalid-sarif) printf '{"version":"2.1.0","runs":"invalid"}\n' >"$REPORT_PATH"; exit 0 ;;
valid-sarif) printf '{"version":"2.1.0","runs":[{"results":[]}]}\n' >"$REPORT_PATH"; exit 0 ;;
string-sarif-results) printf '{"version":"2.1.0","runs":[{"results":"invalid"}]}\n' >"$REPORT_PATH"; exit 0 ;;
object-sarif-results) printf '{"version":"2.1.0","runs":[{"results":{}}]}\n' >"$REPORT_PATH"; exit 0 ;;
missing-sarif-results) printf '{"version":"2.1.0","runs":[{}]}\n' >"$REPORT_PATH"; exit 0 ;;
empty-sarif-runs) printf '{"version":"2.1.0","runs":[]}\n' >"$REPORT_PATH"; exit 0 ;;
finding-sarif)
  cat >"$REPORT_PATH" <<'SARIF'
{"version":"2.1.0","runs":[{"results":[{"ruleId":"test,rule","message":{"text":"raw-test-secret"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/test:file.js"},"region":{"startLine":7}}}]}]}]}
SARIF
  exit 1
  ;;
*) exit 99 ;;
esac
FAKE
chmod +x "$temporary_directory/bin/gitleaks"

full_repository="$temporary_directory/full repository&(history)!"
shallow_repository="$temporary_directory/shallow-repository"
mkdir -- "$full_repository"
git -C "$full_repository" init -q
printf 'first\n' >"$full_repository/history.txt"
git -C "$full_repository" add history.txt
git -C "$full_repository" -c user.name='CI Test' -c user.email='ci-test@example.invalid' commit -qm 'first commit'
printf 'second\n' >>"$full_repository/history.txt"
git -C "$full_repository" add history.txt
git -C "$full_repository" -c user.name='CI Test' -c user.email='ci-test@example.invalid' commit -qm 'second commit'
git -c protocol.file.allow=always clone -q --depth 1 "file://$full_repository" "$shallow_repository"
if [[ "$(git -C "$shallow_repository" rev-parse --is-shallow-repository)" != true ]]; then
  echo 'test setup did not produce a shallow repository' >&2
  exit 1
fi

run_case() {
  local name="$1" expected="$2" mode="$3" format="${4:-}" path="${5:-}" redact="${6:-false}"
  local scan_mode="${7:-dir}" scan_path="${8:-$temporary_directory}"
  local output status
  rm -f -- "$temporary_directory/report" "$temporary_directory/args"
  set +e
  output="$(
    CAPTURED_ARGS="$temporary_directory/args" \
      CONFIG="$temporary_directory/config.toml" \
      FAKE_MODE="$mode" \
      GITHUB_WORKSPACE="$temporary_directory" \
      PATH="$temporary_directory/bin:$PATH" \
      PATH_TO_SCAN="$scan_path" \
      REDACT="$redact" \
      REPORT_FORMAT="$format" \
      REPORT_PATH="$path" \
      SCAN_MODE="$scan_mode" \
      bash "$action_dir/scan.sh" 2>&1
  )"
  status=$?
  set -e
  if [[ "$status" != "$expected" ]]; then
    echo "$name: expected $expected, got $status" >&2
    echo "$output" >&2
    return 1
  fi
  if [[ -f "$temporary_directory/args" ]]; then
    local argument forced_redaction=false
    while IFS= read -r -d '' argument; do
      if [[ "$argument" == --redact ]]; then
        forced_redaction=true
      fi
    done <"$temporary_directory/args"
    if [[ "$forced_redaction" != true ]]; then
      echo "$name: scanner was not forced to redact" >&2
      return 1
    fi
  fi
  if grep -F 'raw-test-secret' <<<"$output" >/dev/null; then
    echo "$name: raw secret reached action output" >&2
    return 1
  fi
  echo "ok: $name"
}

assert_captured_args() {
  local name="$1"
  shift
  local -a actual expected=("$@")
  local index
  mapfile -d '' -t actual <"$temporary_directory/args"
  if ((${#actual[@]} != ${#expected[@]})); then
    echo "$name: expected ${#expected[@]} scanner arguments, got ${#actual[@]}" >&2
    return 1
  fi
  for index in "${!expected[@]}"; do
    if [[ "${actual[$index]}" != "${expected[$index]}" ]]; then
      printf '%s: argument %d mismatch: expected %q, got %q\n' \
        "$name" "$index" "${expected[$index]}" "${actual[$index]}" >&2
      return 1
    fi
  done
}

run_git_preflight_rejection() {
  local name="$1" scan_path="$2" path_value="${3:-$temporary_directory/bin:$PATH}"
  local fake_git_mode="${4:-}" output status
  rm -f -- "$temporary_directory/args"
  set +e
  output="$(
    CAPTURED_ARGS="$temporary_directory/args" \
      CONFIG="$temporary_directory/config.toml" \
      FAKE_GIT_MODE="$fake_git_mode" \
      FAKE_MODE=clean \
      GITHUB_WORKSPACE="$temporary_directory" \
      PATH="$path_value" \
      PATH_TO_SCAN="$scan_path" \
      REDACT=true \
      REPORT_FORMAT='' \
      REPORT_PATH='' \
      SCAN_MODE=git \
      bash "$action_dir/scan.sh" 2>&1
  )"
  status=$?
  set -e
  if [[ "$status" != 2 ]]; then
    echo "$name: expected 2, got $status" >&2
    echo "$output" >&2
    return 1
  fi
  if [[ -e "$temporary_directory/args" ]]; then
    echo "$name: scanner ran before Git preflight rejected the target" >&2
    return 1
  fi
  echo "ok: $name"
}

run_case 'clean scan' 0 clean
assert_captured_args 'directory mode argument contract' \
  dir "$temporary_directory" --config "$temporary_directory/config.toml" --no-banner --redact
run_case 'complete Git history scan' 0 clean '' '' true git "$full_repository"
assert_captured_args 'Git mode argument contract' \
  git "$full_repository" --log-opts=--all --config "$temporary_directory/config.toml" --no-banner --redact
run_case 'Git finding remains blocking' 1 finding '' '' true git "$full_repository"
run_case 'Git operational error fails closed' 7 error '' '' true git "$full_repository"
run_git_preflight_rejection 'shallow Git repository fails closed' "$shallow_repository"
run_git_preflight_rejection 'non-repository fails closed' "$temporary_directory"

mkdir -- "$temporary_directory/git-bin"
cat >"$temporary_directory/git-bin/git" <<'FAKE_GIT'
#!/usr/bin/env bash
case " $* " in
*' rev-parse --is-shallow-repository '*)
  case "$FAKE_GIT_MODE" in
  malformed) printf 'unknown\n' ;;
  error) exit 9 ;;
  *) exit 10 ;;
  esac
  ;;
*) exit 11 ;;
esac
FAKE_GIT
chmod +x "$temporary_directory/git-bin/git"
git_test_path="$temporary_directory/git-bin:$temporary_directory/bin:$PATH"
run_git_preflight_rejection 'malformed shallow-repository result fails closed' "$full_repository" "$git_test_path" malformed
run_git_preflight_rejection 'Git shallow check failure fails closed' "$full_repository" "$git_test_path" error

run_case 'finding remains blocking' 1 finding
run_case 'operational error fails closed' 7 error
run_case 'missing requested report fails closed' 2 missing-report json "$temporary_directory/report"
run_case 'invalid requested report fails closed' 2 invalid-json json "$temporary_directory/report"
run_case 'valid requested report preserves clean status' 0 valid-json json "$temporary_directory/report"
run_case 'finding with valid JSON remains blocking' 1 finding-json json "$temporary_directory/report"
run_case 'invalid SARIF fails closed' 2 invalid-sarif sarif "$temporary_directory/report"
run_case 'valid empty SARIF remains clean' 0 valid-sarif sarif "$temporary_directory/report"
run_case 'string SARIF results fail closed' 2 string-sarif-results sarif "$temporary_directory/report"
run_case 'object SARIF results fail closed' 2 object-sarif-results sarif "$temporary_directory/report"
run_case 'missing SARIF results fail closed' 2 missing-sarif-results sarif "$temporary_directory/report"
run_case 'empty SARIF runs fail closed' 2 empty-sarif-runs sarif "$temporary_directory/report"
run_case 'explicit redaction remains clean' 0 clean '' '' true

annotation_output="$(
  CAPTURED_ARGS="$temporary_directory/args" \
    CONFIG="$temporary_directory/config.toml" \
    FAKE_MODE=finding-sarif \
    GITHUB_WORKSPACE="$temporary_directory" \
    PATH="$temporary_directory/bin:$PATH" \
    PATH_TO_SCAN="$temporary_directory" \
    REDACT=true \
    REPORT_FORMAT=sarif \
    REPORT_PATH="$temporary_directory/report.sarif" \
    SCAN_MODE=dir \
    bash "$action_dir/scan.sh" 2>&1 || true
)"
grep -F '::error file=src/test%3Afile.js,line=7::Secret detected by Gitleaks (rule: test,rule).' <<<"$annotation_output" >/dev/null
if grep -F 'raw-test-secret' <<<"$annotation_output" >/dev/null; then
  echo 'SARIF annotation exposed a raw secret' >&2
  exit 1
fi

if CONFIG="$temporary_directory/missing.toml" GITHUB_WORKSPACE="$temporary_directory" PATH_TO_SCAN="$temporary_directory" SCAN_MODE=dir REPORT_FORMAT='' REPORT_PATH='' REDACT=true bash "$action_dir/scan.sh" >/dev/null 2>&1; then
  echo 'missing config unexpectedly passed' >&2
  exit 1
fi

if [[ "$(uname -s)" == Linux* || "$(uname -s)" == MINGW* ]]; then
  ln -s "$temporary_directory/config.toml" "$temporary_directory/config-link.toml"
  mkdir -- "$temporary_directory/scan-target"
  ln -s "$temporary_directory/scan-target" "$temporary_directory/scan-link"
  mkdir -- "$temporary_directory/report-target"
  ln -s "$temporary_directory/report-target" "$temporary_directory/report-link"
  if [[ -L "$temporary_directory/config-link.toml" && -L "$temporary_directory/scan-link" && -L "$temporary_directory/report-link" ]]; then
    for contract in config scan report; do
      config="$temporary_directory/config.toml"
      scan="$temporary_directory"
      format=''
      report=''
      case "$contract" in
      config) config="$temporary_directory/config-link.toml" ;;
      scan) scan="$temporary_directory/scan-link" ;;
      report)
        format=json
        report="$temporary_directory/report-link/result.json"
        ;;
      *) return 2 ;;
      esac
      if CAPTURED_ARGS="$temporary_directory/args" CONFIG="$config" FAKE_MODE=clean GITHUB_WORKSPACE="$temporary_directory" PATH="$temporary_directory/bin:$PATH" PATH_TO_SCAN="$scan" SCAN_MODE=dir REPORT_FORMAT="$format" REPORT_PATH="$report" REDACT=true bash "$action_dir/scan.sh" >/dev/null 2>&1; then
        echo "$contract symlink unexpectedly passed" >&2
        exit 1
      fi
    done
  else
    echo 'skip: filesystem does not support test symlinks'
  fi
fi

if CONFIG="$temporary_directory/config.toml" GITHUB_WORKSPACE="$temporary_directory" PATH_TO_SCAN="$action_dir" SCAN_MODE=dir REPORT_FORMAT='' REPORT_PATH='' REDACT=true bash "$action_dir/scan.sh" >/dev/null 2>&1; then
  echo 'out-of-workspace scan unexpectedly passed' >&2
  exit 1
fi

grep -F "default: 'true'" "$action_dir/action.yml" >/dev/null
grep -F 'always redacted' "$action_dir/action.yml" >/dev/null
