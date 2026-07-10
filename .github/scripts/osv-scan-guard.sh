# shellcheck shell=bash
set -euo pipefail

policy_phase="${OSV_POLICY_PHASE:-scan}"
fail_on_vuln="${FAIL_ON_VULN:-}"
osv_results_dir="${OSV_RESULTS_DIR:-}"

set_policy_output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "$1=$2" >>"$GITHUB_OUTPUT"
  fi
}

report_policy_problem() {
  local message="$1"
  if [[ "$fail_on_vuln" == true ]]; then
    echo "::error::$message"
    return 1
  fi
  echo "::warning::$message"
}

if [[ "$fail_on_vuln" != true && "$fail_on_vuln" != false ]]; then
  echo "::error::fail-on-vuln must resolve to true or false."
  exit 1
fi

regular_file_in_results() {
  local candidate="$1"
  local resolved_candidate
  local resolved_root

  if [[ ! -d "$osv_results_dir" || -L "$osv_results_dir" || ! -f "$candidate" || -L "$candidate" ]]; then
    printf 'false\n'
    return
  fi
  if ! resolved_root="$(realpath -e -- "$osv_results_dir")"; then
    printf 'false\n'
    return
  fi
  if ! resolved_candidate="$(realpath -e -- "$candidate")"; then
    printf 'false\n'
    return
  fi
  if [[ "${resolved_candidate%/*}" == "$resolved_root" ]]; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

case "$policy_phase" in
  scan)
    allow_no_lockfiles="${ALLOW_NO_LOCKFILES:-}"
    scan_exit="${SCAN_EXIT:-}"
    results_json="$osv_results_dir/results.json"
    if [[ "$allow_no_lockfiles" != true && "$allow_no_lockfiles" != false ]]; then
      echo "::error::allow-no-lockfiles must resolve to true or false."
      exit 1
    fi
    if [[ ! "$scan_exit" =~ ^[0-9]+$ ]]; then
      echo "::error::OSV-Scanner did not report a numeric container exit code."
      exit 1
    fi

    set_policy_output reportable false
    case "$scan_exit" in
      0 | 1)
        results_json_is_regular="$(regular_file_in_results "$results_json")"
        if [[ "$results_json_is_regular" == true ]] &&
          jq -e '.results | type == "array"' "$results_json" >/dev/null 2>&1; then
          set_policy_output reportable true
          echo "Scan completed: at least one dependency source was scanned."
        elif [[ "$scan_exit" == 0 && "$allow_no_lockfiles" == true && "$results_json_is_regular" == true ]] &&
          jq -e '.results == null' "$results_json" >/dev/null 2>&1; then
          echo "Empty scan accepted: the caller declared the repo dependency-less (allow-no-lockfiles)."
        else
          report_policy_problem "OSV-Scanner exited $scan_exit but did not produce a valid regular completed-scan JSON result."
        fi
        ;;
      128)
        if [[ "$allow_no_lockfiles" == true ]]; then
          echo "Empty scan accepted: the caller declared the repo dependency-less (allow-no-lockfiles)."
        else
          report_policy_problem "OSV-Scanner found no supported dependency sources (exit 128). Add a supported manifest/lockfile, correct scan-args, or set allow-no-lockfiles: true only for a dependency-less repository."
        fi
        ;;
      *)
        report_policy_problem "OSV-Scanner failed with operational exit code $scan_exit; results are not trusted."
        ;;
    esac
    ;;
  sarif)
    results_sarif="$osv_results_dir/results.sarif"
    set_policy_output uploadable false
    results_sarif_is_regular="$(regular_file_in_results "$results_sarif")"
    if [[ "$results_sarif_is_regular" == true ]] &&
      jq -e '.version == "2.1.0" and (.runs | type == "array")' "$results_sarif" >/dev/null 2>&1; then
      set_policy_output uploadable true
      echo "SARIF artifact is a regular file inside the isolated results directory."
    else
      report_policy_problem "OSV reporter did not produce a valid regular in-directory SARIF artifact; upload suppressed."
    fi
    ;;
  *)
    echo "::error::Unknown OSV output policy phase: $policy_phase"
    exit 1
    ;;
esac
