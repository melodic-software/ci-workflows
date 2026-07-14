#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard="$root/govulncheck-sarif-guard.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

base_sarif() {
  local results="$1"
  printf '%s\n' "{\"version\":\"2.1.0\",\"runs\":[{\"tool\":{\"driver\":{\"name\":\"govulncheck\",\"semanticVersion\":\"v1.6.0\",\"rules\":[],\"properties\":{\"protocol_version\":\"v1.0.0\",\"scanner_name\":\"govulncheck\",\"scanner_version\":\"v1.6.0\",\"db\":\"https://vuln.go.dev\",\"scan_level\":\"symbol\",\"scan_mode\":\"source\"}}},\"results\":$results}]}"
}

run_case() {
  local name="$1" scanner_exit="$2" sarif="$3" expected="$4" pattern="$5"
  local input="$temporary_directory/$name.sarif" output="$temporary_directory/$name.out"
  printf '%s\n' "$sarif" >"$input"
  set +e
  GOVULNCHECK_EXIT_CODE="$scanner_exit" \
    GOVULNCHECK_SARIF="$input" \
    GOVULNCHECK_VERSION=1.6.0 \
    bash "$guard" >"$output" 2>&1
  status=$?
  set -e
  if [[ "$status" != "$expected" ]] || ! grep -Fq -- "$pattern" "$output"; then
    printf 'FAIL: %s (status %s, expected %s)\n' "$name" "$status" "$expected" >&2
    cat "$output" >&2
    exit 1
  fi
  printf 'PASS: %s\n' "$name"
}

clean='[]'
informational='[{"ruleId":"GO-1","level":"warning","message":{"text":"imported"}},{"ruleId":"GO-2","level":"note","message":{"text":"module"}}]'
finding='[{"ruleId":"GO-3","level":"error","message":{"text":"reachable"}}]'
unknown='[{"ruleId":"GO-4","level":"none","message":{"text":"unknown"}}]'

run_case clean 0 "$(base_sarif "$clean")" 0 "no reachable vulnerable-symbol findings"
run_case informational 0 "$(base_sarif "$informational")" 0 "neither is a reachable symbol finding"
run_case finding 0 "$(base_sarif "$finding")" 1 "reachable vulnerable-symbol result"
run_case scanner-error 1 "$(base_sarif "$clean")" 2 "scanner exited 1"
run_case malformed 0 '{' 2 "SARIF is malformed"
run_case unknown-level 0 "$(base_sarif "$unknown")" 2 "violates the pinned provenance schema"
run_case wrong-provenance 0 "$(base_sarif "$clean" | sed 's#https://vuln.go.dev#https://example.invalid#')" 2 "violates the pinned provenance schema"
run_case missing-results 0 '{"version":"2.1.0","runs":[{}]}' 2 "violates the pinned provenance schema"
