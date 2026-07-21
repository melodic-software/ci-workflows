#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard="$root/zizmor-sarif-guard.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

base_sarif() {
  local results="$1" semver="${2:-1.27.0}"
  printf '%s\n' "{\"version\":\"2.1.0\",\"runs\":[{\"tool\":{\"driver\":{\"name\":\"zizmor\",\"semanticVersion\":\"$semver\",\"rules\":[]}},\"results\":$results}]}"
}

run_case() {
  local name="$1" exit_code="$2" sarif="$3" fail="$4" expected="$5" pattern="$6"
  local input="$temporary_directory/$name.sarif" output="$temporary_directory/$name.out"
  printf '%s\n' "$sarif" >"$input"
  set +e
  ZIZMOR_EXIT_CODE="$exit_code" \
    ZIZMOR_SARIF="$input" \
    ZIZMOR_VERSION=1.27.0 \
    FAIL_ON_SEVERITY="$fail" \
    GITHUB_WORKSPACE='' \
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

located() {
  local rule="$1" level="$2" text="$3" uri="$4" line="$5"
  printf '{"ruleId":"%s","level":"%s","message":{"text":"%s"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"%s"},"region":{"startLine":%s}}}]}' \
    "$rule" "$level" "$text" "$uri" "$line"
}

clean='[]'
high="[$(located zizmor/template-injection error 'code injection' a.yml 8)]"
warning="[$(located zizmor/artipacked warning 'credential persistence' a.yml 3)]"
note="[$(located zizmor/unpinned-uses note 'unpinned action' a.yml 5)]"
mixed="[$(located zizmor/template-injection error 'code injection' a.yml 8),$(located zizmor/artipacked warning 'credential persistence' a.yml 3),$(located zizmor/unpinned-uses note 'unpinned action' a.yml 5)]"
unknown="[$(located zizmor/x none 'unknown' a.yml 1)]"

# Severity gate — blocking set maps FAIL_ON_SEVERITY to SARIF levels.
run_case high-blocks-at-high 0 "$(base_sarif "$high")" high 1 "at or above severity high"
run_case high-passes-at-never 0 "$(base_sarif "$high")" never 0 "advisory mode keeps this lane successful"
run_case warning-passes-at-high 0 "$(base_sarif "$warning")" high 0 "none at or above severity high"
run_case warning-blocks-at-medium 0 "$(base_sarif "$warning")" medium 1 "at or above severity medium"
run_case note-passes-at-high 0 "$(base_sarif "$note")" high 0 "none at or above severity high"
run_case note-passes-at-medium 0 "$(base_sarif "$note")" medium 0 "none at or above severity medium"
run_case note-blocks-at-low 0 "$(base_sarif "$note")" low 1 "at or above severity low"
run_case mixed-blocks-at-high 0 "$(base_sarif "$mixed")" high 1 "zizmor/template-injection"
run_case clean-passes 0 "$(base_sarif "$clean")" high 0 "no findings"

# Infrastructure failures fail closed.
run_case malformed 0 '{' high 2 "malformed or violates the pinned provenance schema"
run_case wrong-name 0 "$(base_sarif "$clean" | sed 's/"zizmor"/"notzizmor"/')" high 2 "malformed or violates the pinned provenance schema"
run_case wrong-version 0 "$(base_sarif "$clean" 9.9.9)" high 2 "malformed or violates the pinned provenance schema"
run_case unknown-level 0 "$(base_sarif "$unknown")" high 2 "malformed or violates the pinned provenance schema"
run_case nonzero-exit 5 "$(base_sarif "$clean")" high 2 "results are not trusted"
run_case bad-severity 0 "$(base_sarif "$clean")" critical 2 "fail-on-severity must resolve"

# Advisory mode still annotates every finding.
mixed_output="$temporary_directory/mixed-advisory.out"
mixed_input="$temporary_directory/mixed-advisory.sarif"
printf '%s\n' "$(base_sarif "$mixed")" >"$mixed_input"
set +e
ZIZMOR_EXIT_CODE=0 ZIZMOR_SARIF="$mixed_input" ZIZMOR_VERSION=1.27.0 \
  FAIL_ON_SEVERITY=never GITHUB_WORKSPACE='' bash "$guard" >"$mixed_output" 2>&1
advisory_status=$?
set -e
if [[ "$advisory_status" != 0 ]] ||
  ! grep -Fq '::error::code injection' "$mixed_output" ||
  ! grep -Fq '::warning::credential persistence' "$mixed_output" ||
  ! grep -Fq '::notice::unpinned action' "$mixed_output"; then
  printf 'FAIL: advisory-annotations (status %s)\n' "$advisory_status" >&2
  cat "$mixed_output" >&2
  exit 1
fi
printf 'PASS: advisory-annotations\n'

# Resolved workspace-relative URIs keep file/line in the annotation.
workspace="$temporary_directory/workspace"
mkdir -p -- "$workspace"
touch -- "$workspace/a.yml"
located_output="$temporary_directory/located.out"
located_input="$temporary_directory/located.sarif"
printf '%s\n' "$(base_sarif "$high")" >"$located_input"
set +e
ZIZMOR_EXIT_CODE=0 ZIZMOR_SARIF="$located_input" ZIZMOR_VERSION=1.27.0 \
  FAIL_ON_SEVERITY=never GITHUB_WORKSPACE="$workspace" bash "$guard" >"$located_output" 2>&1
located_status=$?
set -e
if [[ "$located_status" != 0 ]] ||
  ! grep -Fq '::error file=a.yml,line=8::code injection' "$located_output"; then
  printf 'FAIL: located-annotation (status %s)\n' "$located_status" >&2
  cat "$located_output" >&2
  exit 1
fi
printf 'PASS: located-annotation\n'
