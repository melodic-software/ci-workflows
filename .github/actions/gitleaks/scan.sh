#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

CONFIG="${CONFIG:-}"
PATH_TO_SCAN="${PATH_TO_SCAN:-}"
REDACT="${REDACT:-}"
REPORT_FORMAT="${REPORT_FORMAT:-}"
REPORT_PATH="${REPORT_PATH:-}"
SCAN_MODE="${SCAN_MODE:-}"

workspace="$(realpath -e -- "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}")" || {
  echo '::error::gitleaks: workspace cannot be resolved'
  exit 2
}
within_workspace() {
  [[ "$1" == "$workspace" || "$1" == "$workspace/"* ]]
}

if [[ ! -f "$CONFIG" || -L "$CONFIG" ]]; then
  echo "::error::gitleaks: config must be a regular, non-symlink file: $CONFIG"
  exit 2
fi
resolved_config="$(realpath -e -- "$CONFIG")"
# shellcheck disable=SC2310 # within_workspace is a predicate with no fallible body commands.
if ! within_workspace "$resolved_config"; then
  echo "::error::gitleaks: config must resolve inside GITHUB_WORKSPACE: $CONFIG"
  exit 2
fi
if [[ ! -e "$PATH_TO_SCAN" || -L "$PATH_TO_SCAN" ]]; then
  echo "::error::gitleaks: scan path must exist and cannot be a symlink: $PATH_TO_SCAN"
  exit 2
fi
resolved_scan="$(realpath -e -- "$PATH_TO_SCAN")"
# shellcheck disable=SC2310 # within_workspace is a predicate with no fallible body commands.
if ! within_workspace "$resolved_scan"; then
  echo "::error::gitleaks: scan path must resolve inside GITHUB_WORKSPACE: $PATH_TO_SCAN"
  exit 2
fi

case "$SCAN_MODE" in
dir | git) ;;
*)
  echo "::error::gitleaks: invalid scan-mode '$SCAN_MODE' (expected dir or git)"
  exit 2
  ;;
esac

case "$REDACT" in
true | false) ;;
*)
  echo "::error::gitleaks: redact must resolve to true or false"
  exit 2
  ;;
esac
if [[ "$REDACT" == false ]]; then
  echo "::notice::gitleaks: redact=false is deprecated and ignored; secret values are always redacted."
fi

if [[ -n "${REPORT_FORMAT// /}" || -n "${REPORT_PATH// /}" ]]; then
  if [[ -z "${REPORT_FORMAT// /}" || -z "${REPORT_PATH// /}" ]]; then
    echo "::error::gitleaks: report-format and report-path must be supplied together"
    exit 2
  fi
  case "$REPORT_FORMAT" in
  json | csv | junit | sarif | template) ;;
  *)
    echo "::error::gitleaks: unsupported report-format '$REPORT_FORMAT'"
    exit 2
    ;;
  esac
  if [[ -e "$REPORT_PATH" || -L "$REPORT_PATH" ]]; then
    echo "::error::gitleaks: refusing to overwrite an existing report path: $REPORT_PATH"
    exit 2
  fi
  report_parent_input="$(dirname -- "$REPORT_PATH")"
  if [[ -L "$report_parent_input" ]]; then
    echo "::error::gitleaks: report parent cannot be a symlink: $REPORT_PATH"
    exit 2
  fi
  report_parent="$(realpath -e -- "$report_parent_input")" || {
    echo "::error::gitleaks: report parent cannot be resolved: $REPORT_PATH"
    exit 2
  }
  # shellcheck disable=SC2310 # within_workspace is a predicate with no fallible body commands.
  if ! within_workspace "$report_parent"; then
    echo "::error::gitleaks: report path must resolve inside GITHUB_WORKSPACE: $REPORT_PATH"
    exit 2
  fi
fi

args=("$SCAN_MODE" "$PATH_TO_SCAN" --config "$CONFIG" --no-banner --redact)
if [[ -n "${REPORT_FORMAT// /}" ]]; then
  args+=(--report-format "$REPORT_FORMAT" --report-path "$REPORT_PATH")
fi

set +e
gitleaks "${args[@]}"
status=$?
set -e

# Gitleaks uses 0 for a clean scan and 1 for findings. Every other status is an
# operational failure and therefore remains blocking in both normal and report
# modes.
if ((status != 0 && status != 1)); then
  echo "::error::gitleaks failed before completing a trustworthy scan (exit $status)."
  exit "$status"
fi

if [[ -n "${REPORT_PATH// /}" ]]; then
  if [[ ! -f "$REPORT_PATH" || -L "$REPORT_PATH" ]]; then
    echo "::error::gitleaks did not produce a regular report file: $REPORT_PATH"
    exit 2
  fi
  case "$REPORT_FORMAT" in
  json)
    jq -e 'type == "array"' "$REPORT_PATH" >/dev/null 2>&1 || {
      echo "::error::gitleaks produced invalid JSON results."
      exit 2
    }
    ;;
  sarif)
    jq -e '.version == "2.1.0" and (.runs | type == "array")' "$REPORT_PATH" >/dev/null 2>&1 || {
      echo "::error::gitleaks produced invalid SARIF results."
      exit 2
    }
    if ((status == 1)); then
      jq -r '
        def escape_property:
          tostring
          | gsub("%"; "%25")
          | gsub("\\r"; "%0D")
          | gsub("\\n"; "%0A")
          | gsub(":"; "%3A")
          | gsub(","; "%2C");
        def escape_data:
          tostring
          | gsub("%"; "%25")
          | gsub("\\r"; "%0D")
          | gsub("\\n"; "%0A");
        .runs[].results[]?
        | "::error file=\((.locations[0].physicalLocation.artifactLocation.uri // "") | escape_property),line=\((.locations[0].physicalLocation.region.startLine // 1) | escape_property)::Secret detected by Gitleaks (rule: \((.ruleId // "unknown") | escape_data))."
      ' "$REPORT_PATH"
    fi
    ;;
  *)
    if [[ ! -s "$REPORT_PATH" ]]; then
      echo "::error::gitleaks produced an empty $REPORT_FORMAT report."
      exit 2
    fi
    ;;
  esac
fi

exit "$status"
