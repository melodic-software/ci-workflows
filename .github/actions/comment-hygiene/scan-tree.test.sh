#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

failures=0
run_case() {
  local name="$1" expected="$2" repo="$3" patterns="$4"
  local status
  set +e
  CASE_STDOUT="$(
    cd "$repo"
    env PATTERNS_FILE="$patterns" EXTENSIONS='*.sh' bash "$action_dir/scan-tree.sh" 2>"$temporary_directory/stderr"
  )"
  status=$?
  set -e
  CASE_STDERR="$(<"$temporary_directory/stderr")"
  if [[ "$status" != "$expected" ]]; then
    printf 'FAIL: %s: expected status %s, got %s\nstdout:\n%s\nstderr:\n%s\n' \
      "$name" "$expected" "$status" "$CASE_STDOUT" "$CASE_STDERR" >&2
    failures=$((failures + 1))
    return 0
  fi
  printf 'PASS: %s (status %s)\n' "$name" "$expected"
}

expect_stdout() {
  local name="$1" needle="$2"
  if [[ "$CASE_STDOUT" != *"$needle"* ]]; then
    printf 'FAIL: %s: stdout did not contain %q\n%s\n' "$name" "$needle" "$CASE_STDOUT" >&2
    failures=$((failures + 1))
    return 0
  fi
  printf 'PASS: %s\n' "$name"
}

expect_stderr() {
  local name="$1" needle="$2"
  if [[ "$CASE_STDERR" != *"$needle"* ]]; then
    printf 'FAIL: %s: stderr did not contain %q\n%s\n' "$name" "$needle" "$CASE_STDERR" >&2
    failures=$((failures + 1))
    return 0
  fi
  printf 'PASS: %s\n' "$name"
}

init_repo() {
  local repo="$1"
  mkdir -p -- "$repo"
  git -C "$repo" init -q
  git -C "$repo" -c core.autocrlf=false checkout -q -b main
}

commit_all() {
  local repo="$1"
  git -C "$repo" add -A
  git -C "$repo" -c user.name='CI Test' -c user.email='ci-test@example.invalid' commit -qm 'test'
}

printf_scanner="$temporary_directory/printf-scanner.sh"
cat >"$printf_scanner" <<'SCANNER'
# shellcheck shell=bash
# Replacement policy that follows the public contract only: print
# lineno:kind:detail and return 1. It never calls chp::_record_violation.
chp::scan_text() {
  printf '%s\n' '1:warning-marker:TODO'
  return 1
}
SCANNER

recorder_scanner="$temporary_directory/recorder-scanner.sh"
cat >"$recorder_scanner" <<'SCANNER'
# shellcheck shell=bash
chp::_record_violation() {
  printf '%s:%s:%s\n' "$1" "$2" "$3"
}
chp::scan_text() {
  chp::_record_violation 1 warning-marker TODO
  return 1
}
SCANNER

dirty="$temporary_directory/dirty"
init_repo "$dirty"
printf '# TODO leftover\necho ok\n' >"$dirty/app.sh"
commit_all "$dirty"

run_case 'printf-only replacement scanner is collected' 1 "$dirty" "$printf_scanner"
expect_stdout 'printf scanner emits rewritten path:lineno:kind:detail' 'app.sh:1:warning-marker:TODO'
expect_stderr 'printf scanner counts the hit' 'comment-hygiene: 1 violation(s)'

run_case 'replacement recorder that only prints is collected via the override' 1 "$dirty" "$recorder_scanner"
expect_stdout 'recorder override emits rewritten path:lineno:kind:detail' 'app.sh:1:warning-marker:TODO'
expect_stderr 'recorder override counts the hit' 'comment-hygiene: 1 violation(s)'

run_case 'bundled policy flags TODO' 1 "$dirty" "$action_dir/comment-hygiene-patterns.sh"
expect_stdout 'bundled policy emits rewritten path:lineno:kind:detail' 'app.sh:1:warning-marker:TODO'
expect_stderr 'bundled policy counts the hit' 'comment-hygiene: 1 violation(s)'

clean="$temporary_directory/clean"
init_repo "$clean"
printf '# nothing deferred\necho ok\n' >"$clean/app.sh"
commit_all "$clean"
run_case 'clean tree is clean' 0 "$clean" "$action_dir/comment-hygiene-patterns.sh"
expect_stderr 'clean tree prints the success line' 'comment-hygiene: clean'

if [[ "$failures" -ne 0 ]]; then
  printf 'FAIL: %s scan-tree test(s) failed\n' "$failures" >&2
  exit 1
fi
echo 'All scan-tree tests passed.'
