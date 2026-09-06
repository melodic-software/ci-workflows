#!/usr/bin/env bash
# Verify every tracked file whose content starts with a shebang (#! at byte 0)
# has git index mode 100755. A shebang file committed as 100644 loses its
# executable bit on clone/checkout, so anything that execs it (CI hooks,
# bootstrap scripts, tooling) fails with "Permission denied". The check is
# extension-agnostic: shebangs appear in .py / .js / .ts / .sh / .rb and more.
#
# Deliberately NOT `set -e`: git grep's "no matches" exit 1 is a legitimate
# clean result, distinguished from a fatal error by hand below.
set -uo pipefail

# Scan pathspec (word-split; default '.' = whole repo).
read -ra paths <<<"${PATHS:-.}"

failed=0
# Two-process shebang detection — extension-agnostic, no per-file Git forks.
#
# The previous shape listed candidates with `git grep -l` and then, for each
# path, forked `git ls-files --stage` plus `git cat-file blob` to read the
# whole object into a bash variable and test bytes 0-1. On a docs-heavy tree
# that is one blob-load per markdown file that merely mentions `#!` in a fence:
# 800 such files measured 2.38s here, and the org CI profile recorded 5.9s on
# claude-code-plugins (github-iac docs/topics/ci-perf/research/PROFILE-ccp-scripts.md).
#
# Git's own batch family (git-cat-file --batch) exists to collapse that
# per-object spawn (https://git-scm.com/docs/git-cat-file). This gate can skip
# the blob entirely: for a non-binary (`-I`) blob, line 1 matching `^#!` is
# the same predicate as `blob[0:2] == '#!'`. A BOM-prefixed shebang matches
# neither; a fenced example on a later line matches grep but is not byte 0.
#
#   1. One `git grep --cached -z -n --max-count=1 -IE '^#!'` emits at most one
#      record per file, the lowest matching line, as `path\0lineno\0content\n`
#      (`-z` + `-n` on git 2.43; `--max-count` is the documented cap).
#   2. One `git ls-files --stage -z` builds a path→mode map. Only a line-1
#      hit with index mode 100644 is a finding; 100755 never fails, and any
#      other mode is skipped as before.
#
# `-z` / `core.quotePath=false` keep filenames with non-ASCII / tabs /
# newlines intact. `-I` still skips binaries.
#
# Pre-seed grep output into a tempfile so the exit code can be read before
# consuming it:
#   0   = at least one match
#   1   = no matches (legitimate — zero shebang files)
#   128 (or other) = fatal (object read, promisor fetch, corrupt index). A
#         blob:none checkout can surface real read errors here, so fail CLOSED
#         rather than swallow them into a silent pass.
candidates=$(mktemp)
errfile=$(mktemp)
trap 'rm -f "$candidates" "$errfile"' EXIT
grep_rc=0
# stderr to its own file: $candidates is parsed as NUL-delimited records, so a
# stderr line merged in would corrupt an adjacent record and silently drop a
# real shebang file. stderr is only needed for the fatal-error report.
git -c core.quotePath=false grep --cached -z -n --max-count=1 -IE '^#!' -- "${paths[@]}" \
  >"$candidates" 2>"$errfile" || grep_rc=$?
if [[ "$grep_rc" -ne 0 && "$grep_rc" -ne 1 ]]; then
  echo "::error::git grep failed (exit $grep_rc) — refusing to pass the exec-bit gate without a full candidate scan."
  echo "::group::git grep stderr"
  cat "$errfile"
  echo "::endgroup::"
  exit 1
fi

# First-line shebang paths (NUL-delimited). A later-line `#!` is a grep hit
# that is not byte 0, so it never reaches the mode check.
line1=$(mktemp)
trap 'rm -f "$candidates" "$errfile" "$line1"' EXIT
: >"$line1"
while IFS= read -r -d '' path && IFS= read -r -d '' lineno && IFS= read -r _content; do
  [[ -n "$path" ]] || continue
  [[ "$lineno" == 1 ]] || continue
  printf '%s\0' "$path" >>"$line1"
done <"$candidates"

if [[ ! -s "$line1" ]]; then
  echo "All shebang files are mode 100755 in the index."
  exit 0
fi

# One stage listing for the whole index. Entry format is
# "<mode> <hash> <stage>\t<path>\0"; the metadata half never contains tabs,
# and `-z` keeps a newline inside the path from splitting a record.
stage=$(mktemp)
trap 'rm -f "$candidates" "$errfile" "$line1" "$stage"' EXIT
ls_rc=0
git -c core.quotePath=false ls-files --stage -z >"$stage" 2>"$errfile" || ls_rc=$?
if [[ "$ls_rc" -ne 0 ]]; then
  echo "::error::git ls-files failed (exit $ls_rc) — refusing to pass the exec-bit gate without a full mode scan."
  echo "::group::git ls-files stderr"
  cat "$errfile"
  echo "::endgroup::"
  exit 1
fi

declare -A mode_by_path=()
while IFS= read -r -d '' entry; do
  [[ -n "$entry" ]] || continue
  rest=${entry%%$'\t'*}
  staged_path=${entry#*$'\t'}
  read -r mode _hash _stage <<<"$rest"
  mode_by_path["$staged_path"]=$mode
done <"$stage"

while IFS= read -r -d '' path; do
  [[ -n "$path" ]] || continue
  mode="${mode_by_path[$path]-}"
  case "$mode" in
  100644)
    echo "::error file=$path::$path has a shebang but git index mode is 100644; run: git update-index --chmod=+x -- \"$path\""
    failed=1
    ;;
  100755) ;;
  *) ;;
  esac
done <"$line1"

if [[ "$failed" -eq 0 ]]; then
  echo "All shebang files are mode 100755 in the index."
fi
exit "$failed"
