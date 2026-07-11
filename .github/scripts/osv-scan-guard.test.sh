# shellcheck shell=bash
set -euo pipefail

guard="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/osv-scan-guard.sh"
temporary_directory="$(mktemp -d)"
results_json="$temporary_directory/results.json"
results_sarif="$temporary_directory/results.sarif"
sarif_target="$temporary_directory/sarif-target"
github_output="$temporary_directory/github-output"
trap 'rm -f "$results_json" "$results_sarif" "$sarif_target" "$github_output"; rmdir "$temporary_directory"' EXIT

run_case() {
  local name="$1"
  local expected_exit="$2"
  local scan_exit="$3"
  local allow_no_lockfiles="$4"
  local fail_on_vuln="$5"
  local result_shape="$6"
  local expected_reportable="$7"
  local output
  local actual_exit
  local actual_reportable

  rm -f "$results_json" "$github_output"
  case "$result_shape" in
    array) printf '{"results":[]}\n' >"$results_json" ;;
    null) printf '{"results":null}\n' >"$results_json" ;;
    absent) ;;
    *)
      echo "unknown result shape: $result_shape" >&2
      return 2
      ;;
  esac

  set +e
  output="$(
    ALLOW_NO_LOCKFILES="$allow_no_lockfiles" \
      FAIL_ON_VULN="$fail_on_vuln" \
      GITHUB_OUTPUT="$github_output" \
      OSV_RESULTS_DIR="$temporary_directory" \
      SCAN_EXIT="$scan_exit" \
      bash "$guard" 2>&1
  )"
  actual_exit=$?
  set -e

  if [[ "$actual_exit" != "$expected_exit" ]]; then
    echo "$name: expected exit $expected_exit, got $actual_exit" >&2
    echo "$output" >&2
    return 1
  fi
  actual_reportable="$(grep '^reportable=' "$github_output" | tail -1 | cut -d= -f2-)"
  if [[ "$actual_reportable" != "$expected_reportable" ]]; then
    echo "$name: expected reportable=$expected_reportable, got $actual_reportable" >&2
    echo "$output" >&2
    return 1
  fi
  echo "ok: $name"
}

run_sarif_case() {
  local name="$1"
  local expected_exit="$2"
  local fail_on_vuln="$3"
  local result_shape="$4"
  local expected_uploadable="$5"
  local output
  local actual_exit
  local actual_uploadable

  rm -f "$results_sarif" "$sarif_target" "$github_output"
  case "$result_shape" in
    regular) printf '{"version":"2.1.0","runs":[]}\n' >"$results_sarif" ;;
    absent) ;;
    symlink)
      printf '{"version":"2.1.0","runs":[]}\n' >"$sarif_target"
      ln -s "$sarif_target" "$results_sarif"
      ;;
    *)
      echo "unknown SARIF shape: $result_shape" >&2
      return 2
      ;;
  esac

  set +e
  output="$(
    FAIL_ON_VULN="$fail_on_vuln" \
      GITHUB_OUTPUT="$github_output" \
      OSV_POLICY_PHASE=sarif \
      OSV_RESULTS_DIR="$temporary_directory" \
      bash "$guard" 2>&1
  )"
  actual_exit=$?
  set -e

  if [[ "$actual_exit" != "$expected_exit" ]]; then
    echo "$name: expected exit $expected_exit, got $actual_exit" >&2
    echo "$output" >&2
    return 1
  fi
  actual_uploadable="$(grep '^uploadable=' "$github_output" | tail -1 | cut -d= -f2-)"
  if [[ "$actual_uploadable" != "$expected_uploadable" ]]; then
    echo "$name: expected uploadable=$expected_uploadable, got $actual_uploadable" >&2
    echo "$output" >&2
    return 1
  fi
  echo "ok: $name"
}

run_case "clean scan" 0 0 false true array true
run_case "findings defer to reporter" 0 1 false true array true
run_case "advisory operational error warns" 0 127 false false array false
run_case "blocking operational error fails" 1 127 false true array false
run_case "advisory no-packages warns" 0 128 false false absent false
run_case "blocking no-packages fails" 1 128 false true absent false
run_case "declared dependency-less scan accepts null results without reporting" 0 0 true true null false
run_case "declared dependency-less exit 128 stays green without reporting" 0 128 true true absent false
run_sarif_case "regular SARIF can upload" 0 true regular true
run_sarif_case "advisory missing SARIF suppresses upload" 0 false absent false
run_sarif_case "blocking missing SARIF fails and suppresses upload" 1 true absent false
if [[ "$(uname -s)" == Linux ]]; then
  run_sarif_case "symlink SARIF suppresses upload" 0 false symlink false
fi
