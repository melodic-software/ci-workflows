#!/usr/bin/env bash
# Full-tree comment-hygiene scan. A coarse `git grep` prefilter narrows to
# candidate comment lines; the policy library (sourced from PATTERNS_FILE) then
# authoritatively validates each hit. This two-pass shape keeps the scan fast on
# large trees — looping the library over every file would be O(files × lines).
#
# Emits "path:lineno:kind:detail" per violation.
# Exit: 0 = clean, 1 = violations, 2 = environment error.
set -euo pipefail

PATTERNS_FILE="${PATTERNS_FILE:?comment-hygiene: PATTERNS_FILE is required}"
if [[ ! -f "$PATTERNS_FILE" ]]; then
  echo "comment-hygiene: patterns file not found: $PATTERNS_FILE" >&2
  exit 2
fi
# shellcheck source=/dev/null
source "$PATTERNS_FILE"

read -ra scan_globs <<<"${EXTENSIONS:-}"
read -ra excludes <<<"${EXCLUDE:-}"

# Coarse comment-marker prefilter — a SUPERSET of chp::scan_text's triggers
# (case-insensitive via -i), so it never drops a real violation; chp::scan_text
# filters the false positives (non-comment context, partial tokens). Comment
# prefixes and triggers mirror the widened policy: //, #, /*, * and <!-- lines
# carrying a marker, cc-issue, GH-N, any #N, owner/repo#N, or issue/tracked N.
COARSE_RE='^[[:space:]]*(//|#|/\*|\*|<!--).*(TODO|FIXME|HACK|XXX|cc-issue|GH-[0-9]|#[0-9]|/[A-Za-z0-9._-]+#[0-9]|(issues?|tracked)[[:space:]]*:?[[:space:]]*[0-9])'

# Run the prefilter into a tempfile so the git grep exit code can be read before
# consuming output:
#   0 = matches, 1 = no matches (clean), anything else = fatal. Fail CLOSED on a
#   fatal grep rather than passing an incomplete scan.
matches=$(mktemp)
trap 'rm -f "$matches"' EXIT
grep_rc=0
git grep -niE "$COARSE_RE" -- "${scan_globs[@]}" "${excludes[@]}" >"$matches" 2>&1 || grep_rc=$?
if [[ "$grep_rc" -ne 0 && "$grep_rc" -ne 1 ]]; then
  echo "comment-hygiene: git grep failed (exit $grep_rc):" >&2
  cat "$matches" >&2
  exit 2
fi

violations=0
while IFS= read -r match; do
  [[ -z "$match" ]] && continue
  file="${match%%:*}"
  rest="${match#*:}"
  lineno="${rest%%:*}"
  content="${rest#*:}"

  scan_out=""
  scan_rc=0
  scan_out="$(chp::scan_text "$content")" || scan_rc=$?
  if [[ "$scan_rc" -eq 0 ]]; then
    continue
  fi

  while IFS= read -r detail_line; do
    [[ -z "$detail_line" ]] && continue
    # The library prefixes its own (single-line) lineno; replace it with the
    # real git-grep file line number.
    detail="${detail_line#*:}"
    printf '%s:%s:%s\n' "$file" "$lineno" "$detail"
    violations=$((violations + 1))
  done <<<"$scan_out"
done <"$matches"

if [[ "$violations" -eq 0 ]]; then
  echo "comment-hygiene: clean" >&2
  exit 0
fi
echo "comment-hygiene: $violations violation(s)" >&2
exit 1
