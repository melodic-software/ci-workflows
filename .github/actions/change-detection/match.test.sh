#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

failures=0
output_file="$temporary_directory/github-output"
log_file="$temporary_directory/log"

# run_case <expected-status> <event-name> <files-list-failed> <files-list-path> <filters>
run_case() {
  local expected_status="$1" event_name="$2" files_list_failed="$3" files_list_path="$4" filters="$5"
  local actual_status
  : >"$output_file"
  set +e
  env \
    GITHUB_OUTPUT="$output_file" \
    EVENT_NAME="$event_name" \
    FILTERS="$filters" \
    FILES_LIST_PATH="$files_list_path" \
    FILES_LIST_FAILED="$files_list_failed" \
    bash "$script_directory/match.sh" >"$log_file" 2>&1
  actual_status=$?
  set -e
  if [[ "$actual_status" -ne "$expected_status" ]]; then
    echo "FAIL: expected exit $expected_status, got $actual_status"
    cat "$log_file"
    # Record and continue (return 0): the suite accumulates failures and
    # reports them all; a nonzero return here would abort at the first
    # mismatch under `set -e`.
    failures=$((failures + 1))
  fi
}

expect_results() {
  local expected="results=$1"
  if ! grep -qF -- "$expected" "$output_file"; then
    echo "FAIL: expected output '$expected', got:"
    cat "$output_file"
    cat "$log_file"
    failures=$((failures + 1))
  fi
}

expect_log() {
  local expected="$1"
  if ! grep -qF -- "$expected" "$log_file"; then
    echo "FAIL: expected log to contain '$expected', got:"
    cat "$log_file"
    failures=$((failures + 1))
  fi
}

two_groups=$'markdown:\n  **/*.md\npowershell:\n  **/*.ps1\n  **/*.psd1'

files_markdown="$temporary_directory/files-markdown.txt"
printf '%s\n' 'docs/guide.md' 'README.md' >"$files_markdown"

files_mixed="$temporary_directory/files-mixed.txt"
printf '%s\n' 'scripts/tool.ps1' 'nested/deep/notes.md' >"$files_mixed"

files_none="$temporary_directory/files-none.txt"
printf '%s\n' 'src/app.cs' >"$files_none"

files_empty="$temporary_directory/files-empty.txt"
: >"$files_empty"

echo 'case: non-pull_request event is relevant everywhere'
run_case 0 push false '' "$two_groups"
expect_results '{"markdown":"true","powershell":"true"}'

echo 'case: failed file listing fails open to relevant everywhere'
run_case 0 pull_request true '' "$two_groups"
expect_results '{"markdown":"true","powershell":"true"}'
expect_log 'Changed-file listing unavailable'

echo 'case: missing file-listing path fails open to relevant everywhere'
run_case 0 pull_request false "$temporary_directory/does-not-exist.txt" "$two_groups"
expect_results '{"markdown":"true","powershell":"true"}'

echo 'case: only the matching group is relevant'
run_case 0 pull_request false "$files_markdown" "$two_groups"
expect_results '{"markdown":"true","powershell":"false"}'

echo 'case: globs match at any depth and groups match independently'
run_case 0 pull_request false "$files_mixed" "$two_groups"
expect_results '{"markdown":"true","powershell":"true"}'

echo 'case: no group matches an out-of-scope change'
run_case 0 pull_request false "$files_none" "$two_groups"
expect_results '{"markdown":"false","powershell":"false"}'

echo 'case: an empty file listing matches nothing'
run_case 0 pull_request false "$files_empty" "$two_groups"
expect_results '{"markdown":"false","powershell":"false"}'

echo 'case: patterns are root-anchored like Actions paths filters'
anchored=$'docs:\n  docs/**'
files_lookalike="$temporary_directory/files-lookalike.txt"
printf '%s\n' 'other/docs/page.md' >"$files_lookalike"
run_case 0 pull_request false "$files_lookalike" "$anchored"
expect_results '{"docs":"false"}'
files_docs="$temporary_directory/files-docs.txt"
printf '%s\n' 'docs/page.md' >"$files_docs"
run_case 0 pull_request false "$files_docs" "$anchored"
expect_results '{"docs":"true"}'

echo 'case: comments and blank lines are ignored'
commented=$'# lane filters\n\nmarkdown:\n  # markdown sources\n  **/*.md\n'
run_case 0 pull_request false "$files_markdown" "$commented"
expect_results '{"markdown":"true"}'

echo 'case: a group with no usable patterns fails open with a warning'
vacuous=$'markdown:\n  **/*.md\nempty:\n  # nothing here'
run_case 0 pull_request false "$files_none" "$vacuous"
expect_results '{"markdown":"false","empty":"true"}'
expect_log "Filter group 'empty' has no usable patterns"

echo 'case: negation is a hard configuration error'
run_case 1 pull_request false "$files_markdown" $'markdown:\n  **/*.md\n  !docs/**'
expect_log "uses '!' negation"

echo 'case: ? and + are hard configuration errors'
run_case 1 pull_request false "$files_markdown" $'markdown:\n  **/*.jsx?'
expect_log "contains '?' or '+'"
run_case 1 pull_request false "$files_markdown" $'markdown:\n  v[0-9]+/**'
expect_log "contains '?' or '+'"

echo 'case: a config error fails even on the run-everything fallback path'
run_case 1 push false '' $'markdown:\n  !docs/**'

echo 'case: a pattern before any group header is a configuration error'
run_case 1 pull_request false "$files_markdown" $'**/*.md\nmarkdown:'
expect_log 'appears before any'

echo 'case: an invalid group name is a configuration error'
run_case 1 pull_request false "$files_markdown" $'bad name:\n  **/*.md'
expect_log 'Invalid filter group name'

echo 'case: a duplicate group name is a configuration error'
run_case 1 pull_request false "$files_markdown" $'markdown:\n  **/*.md\nmarkdown:\n  **/*.markdown'
expect_log 'Duplicate filter group'

echo 'case: declaring no groups is a configuration error'
run_case 1 pull_request false "$files_markdown" $'# only a comment\n'
expect_log 'declared no groups'

echo 'case: a listing carrying a rename previous path matches it'
# Exercises only the matcher's handling of a listing that already contains
# both rename sides; the `previous_filename` inclusion itself lives in
# action.yml's github-script step, which this harness does not run.
files_renamed="$temporary_directory/files-renamed.txt"
printf '%s\n' 'scripts/tool.txt' 'scripts/tool.ps1' >"$files_renamed"
run_case 0 pull_request false "$files_renamed" "$two_groups"
expect_results '{"markdown":"false","powershell":"true"}'

echo 'case: an indented header-shaped line is a configuration error'
run_case 1 pull_request false "$files_markdown" $'markdown:\n  docs:\n  **/*.md'
expect_log 'group headers must be unindented'

echo 'case: more groups than the xargs -P cap still match independently'
many_groups=$'g0:
  **/*.md
g1:
  **/*.ps1
g2:
  **/*.cs
g3:
  **/*.ts
g4:
  **/*.py
g5:
  **/*.go
g6:
  **/*.rb
g7:
  **/*.rs
'
files_many="$temporary_directory/files-many.txt"
printf '%s\n' 'docs/a.md' 'lib/a.cs' 'pkg/a.py' 'cmd/a.go' 'app/a.rs' >"$files_many"
run_case 0 pull_request false "$files_many" "$many_groups"
expect_results '{"g0":"true","g1":"false","g2":"true","g3":"false","g4":"true","g5":"true","g6":"false","g7":"true"}'

if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed."
  exit 1
fi
echo 'All change-detection matcher tests passed.'
