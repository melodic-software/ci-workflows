#!/usr/bin/env bash
set -euo pipefail

fail_infrastructure() {
  printf '::error::govulncheck infrastructure failure: %s; rerun the job.\n' "$*" >&2
  exit 2
}

: "${GOVULNCHECK_EXIT_CODE:?GOVULNCHECK_EXIT_CODE is required}"
: "${GOVULNCHECK_SARIF:?GOVULNCHECK_SARIF is required}"
: "${GOVULNCHECK_VERSION:?GOVULNCHECK_VERSION is required}"

[[ "$GOVULNCHECK_EXIT_CODE" =~ ^[0-9]+$ ]] ||
  fail_infrastructure "process exit code is malformed"
((GOVULNCHECK_EXIT_CODE == 0)) ||
  fail_infrastructure "scanner exited $GOVULNCHECK_EXIT_CODE"
[[ -f "$GOVULNCHECK_SARIF" && ! -L "$GOVULNCHECK_SARIF" ]] ||
  fail_infrastructure "SARIF output is missing or is not a regular file"

expected_version="v${GOVULNCHECK_VERSION#v}"
if ! jq -e --arg version "$expected_version" '
  type == "object" and
  .version == "2.1.0" and
  (.runs | type == "array" and length == 1) and
  (.runs[0].tool.driver | type == "object") and
  .runs[0].tool.driver.name == "govulncheck" and
  .runs[0].tool.driver.semanticVersion == $version and
  (.runs[0].tool.driver.rules | type == "array") and
  (.runs[0].tool.driver.properties | type == "object") and
  .runs[0].tool.driver.properties.protocol_version == "v1.0.0" and
  .runs[0].tool.driver.properties.scanner_name == "govulncheck" and
  .runs[0].tool.driver.properties.scanner_version == $version and
  .runs[0].tool.driver.properties.db == "https://vuln.go.dev" and
  .runs[0].tool.driver.properties.scan_level == "symbol" and
  .runs[0].tool.driver.properties.scan_mode == "source" and
  ((.runs[0].tool.driver.properties.db_last_modified? // "") | type == "string") and
  (.runs[0].results | type == "array") and
  all(.runs[0].results[];
    type == "object" and
    (.ruleId | type == "string" and length > 0) and
    (.level == "error" or .level == "warning" or .level == "note") and
    (.message.text | type == "string" and length > 0)
  )
' "$GOVULNCHECK_SARIF" >/dev/null 2>&1; then
  fail_infrastructure "SARIF is malformed or violates the pinned provenance schema"
fi

read -r error_count warning_count note_count < <(jq -r '
  [
    ([.runs[0].results[] | select(.level == "error")] | length),
    ([.runs[0].results[] | select(.level == "warning")] | length),
    ([.runs[0].results[] | select(.level == "note")] | length)
  ] | @tsv
' "$GOVULNCHECK_SARIF")

if ((warning_count > 0 || note_count > 0)); then
  printf '::notice::govulncheck reported %s imported-package warning(s) and %s vulnerable-module note(s); neither is a reachable symbol finding.\n' \
    "$warning_count" "$note_count"
fi
if ((error_count > 0)); then
  ids="$(jq -r '[.runs[0].results[] | select(.level == "error") | .ruleId] | unique | join(", ")' "$GOVULNCHECK_SARIF")"
  printf '::error::govulncheck found %s reachable vulnerable-symbol result(s): %s\n' \
    "$error_count" "$ids" >&2
  exit 1
fi

printf 'govulncheck completed with no reachable vulnerable-symbol findings.\n'
