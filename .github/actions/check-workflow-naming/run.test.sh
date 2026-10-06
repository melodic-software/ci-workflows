#!/usr/bin/env bash
# shellcheck shell=bash
# Contract tests for the check-workflow-naming runner.
#
# Always: run.sh against a stub analyzer, which pins argument mapping, mode
# validation, exit-status propagation and the step summary.
#
# When REAL_STANDARDS_ROOT names a melodic-software/standards checkout whose
# components/github-actions-conventions dependencies are installed: run.sh
# against the real analyzer over fixtures/workflow-naming, so a good tree
# passes enforcing, and a misnamed workflow fails enforcing but passes advisory.
set -euo pipefail

action_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$action_directory/../../.." && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

stub_root="$temporary_directory/standards"
component="$stub_root/components/github-actions-conventions"
captures="$temporary_directory/captures"
check_root="$temporary_directory/repo with spaces"
mkdir -p -- "$component" "$captures" "$check_root"

cat >"$component/naming-lint.mjs" <<'STUB'
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE_FILE, process.argv.slice(2).join("\0"));
process.stdout.write(`stub finding\nnaming-lint (stub): 1 finding(s), 0 blocking.\n`);
process.exitCode = Number(process.env.STUB_STATUS ?? "0");
STUB

failures=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

# run_runner <expected status> <standards root> <mode> <root> <repository>
run_runner() {
  local expected="$1" standards="$2" mode="$3" root="$4" repo="$5"
  local status=0
  : >"$captures/summary"
  rm -f -- "$captures/args"
  env \
    MODE="$mode" \
    ROOT="$root" \
    REPOSITORY="$repo" \
    STANDARDS_ROOT="$standards" \
    CAPTURE_FILE="$captures/args" \
    GITHUB_STEP_SUMMARY="$captures/summary" \
    bash "$action_directory/run.sh" >"$captures/out" 2>&1 || status=$?
  if [[ "$status" != "$expected" ]]; then
    fail "mode=$mode root=$root: expected exit $expected, got $status"
    sed 's/^/  | /' "$captures/out" >&2
  fi
}

args_are() {
  local expected actual
  expected="$(printf '%s\n' "$@")"
  actual="$(tr '\0' '\n' <"$captures/args")"
  [[ "$actual" == "$expected" ]] || fail "argv: expected [$expected], got [$actual]"
}

# Argument mapping: every input reaches the analyzer, text format is fixed.
run_runner 0 "$stub_root" enforcing "$check_root" owner/name
args_are --root "$check_root" --mode enforcing --format text --repository owner/name
grep -qxF '### naming-lint (enforcing)' "$captures/summary" || fail "summary heading missing"
grep -qxF 'stub finding' "$captures/summary" || fail "summary does not carry the report"
grep -qxF 'stub finding' "$captures/out" || fail "log does not carry the report"

run_runner 0 "$stub_root" advisory "$check_root" owner/name
args_are --root "$check_root" --mode advisory --format text --repository owner/name

# An empty repository leaves the analyzer's $GITHUB_REPOSITORY default alone.
run_runner 0 "$stub_root" enforcing "$check_root" ''
args_are --root "$check_root" --mode enforcing --format text

# A blocking finding (1) and an analyzer configuration error (2) both fail.
STUB_STATUS=1 run_runner 1 "$stub_root" enforcing "$check_root" owner/name
grep -qF '::error::naming-lint found blocking naming findings' "$captures/out" ||
  fail "exit 1 does not name the blocking findings"
STUB_STATUS=2 run_runner 2 "$stub_root" enforcing "$check_root" owner/name
grep -qF '::error::naming-lint could not run (exit 2)' "$captures/out" ||
  fail "exit 2 does not say the analyzer could not run"

# Fail closed before the analyzer runs.
run_runner 1 "$stub_root" Enforcing "$check_root" owner/name
[[ ! -e "$captures/args" ]] || fail "an unknown mode still ran the analyzer"
run_runner 1 "$stub_root" '' "$check_root" owner/name
run_runner 1 "$stub_root" enforcing "$check_root/missing" owner/name
run_runner 1 "$temporary_directory/no-standards" enforcing "$check_root" owner/name

if [[ -n "${REAL_STANDARDS_ROOT:-}" ]]; then
  fixtures="$repository_root/fixtures/workflow-naming"
  run_runner 0 "$REAL_STANDARDS_ROOT" enforcing "$fixtures/good" owner/name
  grep -qF '0 blocking' "$captures/out" || fail "good fixture reported blocking findings"
  run_runner 1 "$REAL_STANDARDS_ROOT" enforcing "$fixtures/bad" owner/name
  grep -qF 'workflow-filename' "$captures/out" || fail "bad fixture: no workflow-filename finding"
  run_runner 0 "$REAL_STANDARDS_ROOT" advisory "$fixtures/bad" owner/name
  grep -qF 'warning: workflow-filename' "$captures/out" || fail "advisory did not downgrade to a warning"
  run_runner 0 "$REAL_STANDARDS_ROOT" enforcing "$repository_root" melodic-software/ci-workflows
else
  echo "REAL_STANDARDS_ROOT unset: skipped the real-analyzer fixture cases."
fi

if ((failures > 0)); then
  echo "$failures check-workflow-naming runner test(s) failed." >&2
  exit 1
fi
echo "check-workflow-naming runner tests passed."
