#!/usr/bin/env bash
# Tests run.sh against throwaway repositories of passing, failing and untracked
# test files.
set -euo pipefail

runner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run.sh"
sandbox="$(mktemp -d)"
trap 'rm -rf -- "$sandbox"' EXIT

failures=0
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

# new_repo NAME FILE=BODY...: a repository with each FILE staged holding BODY, at
# mode 100644 so the runner must invoke bash rather than the shebang.
new_repo() {
  repo="$sandbox/$1"
  shift
  git init -q "$repo"
  local spec
  for spec in "$@"; do
    mkdir -p "$repo/$(dirname "${spec%%=*}")"
    printf '%s\n' "${spec#*=}" >"$repo/${spec%%=*}"
  done
  git -C "$repo" add -A
}

run() {
  status=0
  output="$(cd "$repo" && bash "$runner" 2>&1)" || status=$?
}

new_repo pass 'a.test.sh=echo ran-a' 'sub dir/b.test.sh=[[ -f a.test.sh ]] && echo ran-b-from-root'
run
[[ "$status" -eq 0 ]] || fail "passing tests: exit $status: $output"
[[ "$output" == *ran-a* && "$output" == *ran-b-from-root* ]] ||
  fail "passing tests: not every test ran from the root: $output"
[[ "$output" == *"2 test files, 0 failed."* ]] || fail "passing tests: summary missing: $output"

# A failure does not stop the later tests.
new_repo mixed 'a.test.sh=exit 3' 'b.test.sh=echo ran-b'
run
[[ "$status" -eq 1 ]] || fail "failing test: expected exit 1, got $status"
[[ "$output" == *"::error file=a.test.sh::a.test.sh exited 3."* ]] || fail "failing test: not named: $output"
[[ "$output" == *ran-b* ]] || fail "failing test: later test did not run: $output"
[[ "$output" == *"2 test files, 1 failed."* ]] || fail "failing test: summary missing: $output"

new_repo untracked 'tracked.test.sh=echo ran-tracked'
printf 'exit 1\n' >"$repo/untracked.test.sh"
run
[[ "$status" -eq 0 ]] || fail "untracked test file ran: $output"

new_repo empty 'README=none'
run
[[ "$status" -eq 1 && "$output" == *"No tracked *.test.sh files"* ]] || fail "no tests: expected a failure, got $status: $output"

if [[ "$failures" -gt 0 ]]; then
  printf '%d failure(s)\n' "$failures" >&2
  exit 1
fi
echo "run-shell-tests: all tests passed"
