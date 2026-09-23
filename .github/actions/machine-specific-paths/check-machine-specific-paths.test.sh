#!/usr/bin/env bash
# Self-check for the machine-specific-paths match filter.
#
# The driver re-extracts every git-grep span and drops a line only when every
# span is a punctuation-only child or the macOS /Users/Shared guardrail, or when
# the line carries the machine-path:allow marker. tests/, CHANGELOG.md, evals/,
# and *.test.* are not exemptions, and short usernames stay findings.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
driver="$here/check-machine-specific-paths.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

failures=0
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

init_repo() {
  local repo=$1
  mkdir -p -- "$repo"
  git -C "$repo" init -q
  git -C "$repo" -c core.autocrlf=false checkout -q -b main
}

commit_all() {
  local repo=$1
  git -C "$repo" add -A
  git -C "$repo" -c user.name='CI Test' -c user.email='ci-test@example.invalid' -c commit.gpgsign=false commit -qm 'test'
}

run_driver() {
  local repo=$1 output status
  set +e
  output="$(
    cd "$repo"
    env EXTENSIONS='.' bash "$driver" 2>&1
  )"
  status=$?
  set -e
  SCAN_OUTPUT="$output"
  SCAN_STATUS="$status"
}

# desc, line, optional repo-relative path. A fresh git repo keeps cases apart.
scan_case() {
  local desc=$1 line=$2 relpath=${3:-notes.md}
  local repo
  if [[ -z "$desc" ]]; then
    fail "missing case description"
    return
  fi
  repo="$(mktemp -d "$temporary_directory/case.XXXXXX")"
  init_repo "$repo"
  mkdir -p -- "$repo/$(dirname -- "$relpath")"
  printf '%s\n' "$line" >"$repo/$relpath"
  commit_all "$repo"
  run_driver "$repo"
}

assert_caught() {
  local desc=$1 line=$2 relpath=${3:-notes.md}
  scan_case "$desc" "$line" "$relpath"
  if [[ "$SCAN_STATUS" -ne 1 ]]; then
    fail "expected a machine-specific path [$desc] (status $SCAN_STATUS): $line"
    printf '%s\n' "$SCAN_OUTPUT" >&2
    return
  fi
  printf 'PASS: caught [%s]\n' "$desc"
}

assert_clean() {
  local desc=$1 line=$2 relpath=${3:-notes.md}
  scan_case "$desc" "$line" "$relpath"
  if [[ "$SCAN_STATUS" -ne 0 ]]; then
    fail "expected a clean line [$desc] (status $SCAN_STATUS): $line"
    printf '%s\n' "$SCAN_OUTPUT" >&2
    return
  fi
  if [[ "$SCAN_OUTPUT" == *"Machine-specific path detected"* ]]; then
    fail "clean line still reported a path [$desc]: $line"
    printf '%s\n' "$SCAN_OUTPUT" >&2
    return
  fi
  printf 'PASS: clean [%s]\n' "$desc"
}

# Real paths, including under trees that must not be exempted.
assert_caught 'Windows backslash user' 'C:\Users\Alice\project'
assert_caught 'Windows forward-slash user' 'C:/Users/alice/project'
assert_caught 'Windows escaped user' 'C:\\Users\\Alice\\project'
assert_caught 'Windows 8.3 short name' 'C:\Users\ALICE~1\AppData'
assert_caught 'macOS user' '/Users/alice'
assert_caught 'macOS user with child' '/Users/alice/project'
assert_caught 'Linux user' '/home/alice'
assert_caught 'Windows repo' 'D:\repos\acme\project'
assert_caught 'percent-digit user' 'C:\Users\build%2026\project'
assert_caught 'single-letter macOS user' '/Users/k'
assert_caught 'single-letter Windows repo' 'D:/repos/x'
assert_caught 'me Windows user' 'C:\Users\me'
assert_caught 'me Linux user' '/home/me'
assert_caught 'escaped Projects example' 'C:\\Projects\\example'
assert_caught 'escaped repos knowledge-corpus' 'D:\\repos\\knowledge-corpus'
assert_caught 'SharedStuff' '/Users/SharedStuff'
assert_caught 'Shared.foo stays a finding' '/Users/Shared.foo'
assert_caught 'Shared percent-digit stays a finding' '/Users/Shared%2026'
assert_caught 'Windows Shared is not exempt' 'C:\Users\Shared'
assert_caught 'Linux Shared is not exempt' '/home/Shared'
assert_caught 'ellipsis does not hide a macOS user' 'C:/Users/... and /Users/alice'
assert_caught 'under tests/' '/Users/alice' 'tests/sample.md'
assert_caught 'CHANGELOG.md' 'C:\Users\Alice\project' 'CHANGELOG.md'
assert_caught 'under evals/' '/home/alice' 'evals/sample.md'
assert_caught 'foo.test.sh' 'D:\repos\acme\project' 'foo.test.sh'
assert_caught 'non-Latin Windows user' 'C:/Users/用户/project'
assert_caught 'non-Latin Linux user' '/home/δοκιμή/project'
assert_caught 'non-Latin macOS user' '/Users/δοκιμή'

# Punctuation-only children and the macOS Shared guardrail.
assert_clean 'Windows forward ellipsis' 'C:/Users/...'
assert_clean 'Windows backslash ellipsis' 'C:\Users\...'
assert_clean 'Windows repo ellipsis' 'D:\repos\...'
assert_clean 'unicode ellipsis' 'C:/Projects/…'
assert_clean 'punctuation-only child' 'C:/Users/...).'
# Backticks are literal path punctuation, not command substitution.
# shellcheck disable=SC2016
assert_clean 'backtick Shared' '`/Users/Shared`'
assert_clean 'Shared sentence period' '/Users/Shared.'
assert_clean 'only ellipsis spans' 'C:/Users/... plus C:\Users\... plus D:\repos\...'

# Per-line marker: unmarked real paths stay findings, marked lines do not.
assert_caught 'unmarked Windows user' 'C:\Users\someone\project'
assert_caught 'unmarked macOS user' '/Users/someone/project'
assert_caught 'unmarked Linux user' '/home/someone/project'
assert_caught 'unmarked Windows repo' 'D:\repos\thing'
assert_caught 'unmarked JSON-escaped user' '"C:\\Users\\someone\\project"' 'fixture.json'
assert_caught 'unmarked JSON-escaped repo' '"D:\\repos\\thing"' 'fixture.json'
assert_caught 'unmarked 8.3 short name' 'C:\Users\SOMEON~1\AppData'
assert_caught 'marker text without the colon' 'C:\Users\someone\project # machine-path allow'
assert_clean 'marked Windows user' 'C:\Users\someone\project # machine-path:allow'
assert_clean 'marked macOS user' '/Users/someone/project <!-- machine-path:allow -->'
assert_clean 'marked Linux user' '/home/someone/project // machine-path:allow'
assert_clean 'marked Windows repo' 'D:\repos\thing # machine-path:allow'
assert_clean 'marked escaped repo' '"D:\\repos\\thing" # machine-path:allow'
assert_clean 'marked 8.3 short name' 'C:\Users\SOMEON~1\AppData # machine-path:allow'

# The marker covers only its own line.
marked="$temporary_directory/marked"
init_repo "$marked"
printf '%s\n' '/home/someone/project # machine-path:allow' '/home/someone/project' >"$marked/notes.md"
commit_all "$marked"
run_driver "$marked"
if [[ "$SCAN_STATUS" -ne 1 || "$SCAN_OUTPUT" != *"notes.md:2:/home/someone/project"* || "$SCAN_OUTPUT" == *"notes.md:1:"* ]]; then
  fail "the marker must suppress only its own line (status $SCAN_STATUS)"
  printf '%s\n' "$SCAN_OUTPUT" >&2
else
  printf 'PASS: marker suppresses only its own line\n'
fi

# A same-pattern real span keeps the original line, ellipsis and all.
mixed="$temporary_directory/mixed"
init_repo "$mixed"
printf '%s\n' 'C:/Users/... and C:/Users/alice/project' >"$mixed/notes.md"
commit_all "$mixed"
run_driver "$mixed"
if [[ "$SCAN_STATUS" -ne 1 || "$SCAN_OUTPUT" != *"C:/Users/... and C:/Users/alice/project"* ]]; then
  fail "a surviving span must report the original line (status $SCAN_STATUS)"
  printf '%s\n' "$SCAN_OUTPUT" >&2
else
  printf 'PASS: original line kept when any span survives\n'
fi

# head -20 applies to surviving lines. Ellipsis noise before the real path
# must not hide it.
buried="$temporary_directory/buried"
init_repo "$buried"
{
  buried_index=0
  while [[ "$buried_index" -lt 25 ]]; do
    printf '%s\n' 'C:/Users/...'
    buried_index=$((buried_index + 1))
  done
  printf '%s\n' 'C:/Users/alice/project'
} >"$buried/notes.md"
commit_all "$buried"
run_driver "$buried"
if [[ "$SCAN_STATUS" -eq 0 || "$SCAN_OUTPUT" != *"C:/Users/alice/project"* || "$SCAN_OUTPUT" == *"C:/Users/..."* ]]; then
  fail "ellipsis lines before a real path must not hide it (status $SCAN_STATUS)"
  printf '%s\n' "$SCAN_OUTPUT" >&2
else
  printf 'PASS: real path survives a screen of ellipsis lines\n'
fi

# End to end: a repo with both a real path and an ellipsis prints only the
# real path. A repo with only the ellipsis exits 0.
both="$temporary_directory/both"
init_repo "$both"
printf '%s\n' 'C:/Users/alice/project' >"$both/real.md"
printf '%s\n' 'C:/Users/...' >"$both/placeholder.md"
commit_all "$both"
run_driver "$both"
if [[ "$SCAN_STATUS" -eq 0 ]]; then
  fail "repo with a real path and an ellipsis exited 0"
  printf '%s\n' "$SCAN_OUTPUT" >&2
elif [[ "$SCAN_OUTPUT" != *"C:/Users/alice/project"* || "$SCAN_OUTPUT" == *"C:/Users/..."* ]]; then
  fail "repo printed something other than the real path"
  printf '%s\n' "$SCAN_OUTPUT" >&2
else
  printf 'PASS: mixed repo prints only the real path (status %s)\n' "$SCAN_STATUS"
fi

only="$temporary_directory/only"
init_repo "$only"
printf '%s\n' 'C:/Users/...' >"$only/placeholder.md"
commit_all "$only"
run_driver "$only"
if [[ "$SCAN_STATUS" -ne 0 ]]; then
  fail "ellipsis-only repo exited $SCAN_STATUS"
  printf '%s\n' "$SCAN_OUTPUT" >&2
else
  printf 'PASS: ellipsis-only repo exits 0\n'
fi

# A grep hit whose span extractor returns nothing is still a finding.
fail_closed="$(
  # shellcheck source=machine-path-patterns.sh
  source "$here/machine-path-patterns.sh"
  # shellcheck source=check-machine-specific-paths.sh
  source "$here/check-machine-specific-paths.sh"
  filter_machine_path_hits "$HPP_WIN_USER_BODY" <<<"notes.md:1:nothing to see here"
)"
if [[ "$fail_closed" != "notes.md:1:nothing to see here" ]]; then
  fail "span extractor returning nothing must stay a finding: ${fail_closed:-<empty>}"
else
  printf 'PASS: extractor miss fails closed\n'
fi

if [[ "$failures" -gt 0 ]]; then
  printf '%d assertion(s) failed.\n' "$failures" >&2
  exit 1
fi
echo 'machine-specific path span filter matches the driver contract.'
