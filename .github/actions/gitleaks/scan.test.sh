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
printf '%s\n' "$@" >"$CAPTURED_ARGS"
case "$FAKE_MODE" in
clean) exit 0 ;;
finding) exit 1 ;;
error) exit 7 ;;
missing-report) exit 0 ;;
invalid-json) printf '{not json}\n' >"$REPORT_PATH"; exit 0 ;;
valid-json) printf '[]\n' >"$REPORT_PATH"; exit 0 ;;
finding-sarif)
  cat >"$REPORT_PATH" <<'SARIF'
{"version":"2.1.0","runs":[{"results":[{"ruleId":"test,rule","locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/test:file.js"},"region":{"startLine":7}}}]}]}]}
SARIF
  exit 1
  ;;
*) exit 99 ;;
esac
FAKE
chmod +x "$temporary_directory/bin/gitleaks"

run_case() {
  local name="$1" expected="$2" mode="$3" format="${4:-}" path="${5:-}"
  local output status
  rm -f -- "$temporary_directory/report" "$temporary_directory/args"
  set +e
  output="$(
    CAPTURED_ARGS="$temporary_directory/args" \
      CONFIG="$temporary_directory/config.toml" \
      FAKE_MODE="$mode" \
      GITHUB_WORKSPACE="$temporary_directory" \
      PATH="$temporary_directory/bin:$PATH" \
      PATH_TO_SCAN="$temporary_directory" \
      REDACT=false \
      REPORT_FORMAT="$format" \
      REPORT_PATH="$path" \
      SCAN_MODE=dir \
      bash "$action_dir/scan.sh" 2>&1
  )"
  status=$?
  set -e
  if [[ "$status" != "$expected" ]]; then
    echo "$name: expected $expected, got $status" >&2
    echo "$output" >&2
    return 1
  fi
  if [[ -f "$temporary_directory/args" ]] && ! grep -Fx -- '--redact' "$temporary_directory/args" >/dev/null; then
    echo "$name: scanner was not forced to redact" >&2
    return 1
  fi
  if grep -F 'raw-test-secret' <<<"$output" >/dev/null; then
    echo "$name: raw secret reached action output" >&2
    return 1
  fi
  echo "ok: $name"
}

run_case 'clean scan' 0 clean
run_case 'finding remains blocking' 1 finding
run_case 'operational error fails closed' 7 error
run_case 'missing requested report fails closed' 2 missing-report json "$temporary_directory/report"
run_case 'invalid requested report fails closed' 2 invalid-json json "$temporary_directory/report"
run_case 'valid requested report preserves clean status' 0 valid-json json "$temporary_directory/report"

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
      report) format=json; report="$temporary_directory/report-link/result.json" ;;
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
