#!/usr/bin/env bash
# Fail every tracked file starting with `#!` whose index mode is 100644: it
# loses its exec bit on checkout. Not `set -e`: grep's no-match exit 1 is clean.
set -uo pipefail

read -ra paths <<<"${PATHS:-.}"

failed=0
# Line 1 of a non-binary (-I) blob matching `^#!` is the same test as byte 0, so
# no blob is read. A grep exit other than 0/1 (blob:none read error) fails closed.
candidates=$(mktemp)
errfile=$(mktemp)
trap 'rm -f "$candidates" "$errfile"' EXIT
grep_rc=0
# stderr merged into the NUL-delimited records could silently drop a file.
git -c core.quotePath=false grep --cached -z -n --max-count=1 -IE '^#!' -- "${paths[@]}" \
  >"$candidates" 2>"$errfile" || grep_rc=$?
if [[ "$grep_rc" -ne 0 && "$grep_rc" -ne 1 ]]; then
  echo "::error::git grep failed (exit $grep_rc) — refusing to pass the exec-bit gate without a full candidate scan."
  echo "::group::git grep stderr"
  cat "$errfile"
  echo "::endgroup::"
  exit 1
fi

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

# Entry: "<mode> <hash> <stage>\t<path>\0"; the metadata half has no tabs.
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
