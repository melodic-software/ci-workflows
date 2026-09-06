#!/usr/bin/env bash
# Full-tree comment-hygiene scan. A coarse `git grep` prefilter narrows to
# candidate comment lines; the selected policy library (the action-bundled
# default or a caller replacement, sourced from PATTERNS_FILE) then
# authoritatively validates each hit. This two-pass shape keeps the scan fast on
# large trees — looping the library over every file would be O(files × lines).
#
# The per-hit validator runs in-process: calling `chp::scan_text` via command
# substitution (`scan_out="$(chp::scan_text …)"`) forks a subshell on every
# git-grep hit. Hits are collected through a nameref array instead
# (`chp_violation_sink`) so the hot loop does not pay that forks-in-loop cost.
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

# Redefine the recorder after sourcing so a replacement PATTERNS_FILE whose
# chp::_record_violation still only prints to stdout cannot leak un-rewritten
# lines (or drop hits) when we skip `$(chp::scan_text …)`. Command substitution
# of a bash function forks a subshell per git-grep hit; this nameref collector
# keeps the forks-in-loop cost off the hot path. The override is the scan-tree
# contract either way — the bundled library is a managed payload and is not
# edited here.
# shellcheck disable=SC2329 # invoked from chp::scan_text, which this file sources.
chp::_record_violation() {
  local rec
  printf -v rec '%s:%s:%s' "$1" "$2" "$3"
  local -n _chp_sink="$chp_violation_sink"
  _chp_sink+=("$rec")
  violations=$((violations + 1))
}

read -ra scan_globs <<<"${EXTENSIONS:-}"
read -ra excludes <<<"${EXCLUDE:-}"

# Coarse comment-marker prefilter, defined and documented in the sourced fragment
# (shared with superset-test.sh, which enforces its superset contract against the
# policy library).
# shellcheck source=coarse-prefilter.sh
source "$(dirname "${BASH_SOURCE[0]}")/coarse-prefilter.sh"
coarse_re="$(chp::coarse_re)"

# Run the prefilter into a tempfile so the git grep exit code can be read before
# consuming output:
#   0 = matches, 1 = no matches (clean), anything else = fatal. Fail CLOSED on a
#   fatal grep rather than passing an incomplete scan.
matches=$(mktemp)
errfile=$(mktemp)
trap 'rm -f "$matches" "$errfile"' EXIT
grep_rc=0
# Keep stderr out of $matches: it is parsed as path:lineno:content on the
# success path, so a non-fatal git warning merged in would become a spurious
# candidate. stderr is only needed for the fatal-error report below.
git grep -niE "$coarse_re" -- "${scan_globs[@]}" "${excludes[@]}" >"$matches" 2>"$errfile" || grep_rc=$?
if [[ "$grep_rc" -ne 0 && "$grep_rc" -ne 1 ]]; then
  echo "comment-hygiene: git grep failed (exit $grep_rc):" >&2
  cat "$errfile" >&2
  exit 2
fi

violations=0
while IFS= read -r match; do
  [[ -z "$match" ]] && continue
  file="${match%%:*}"
  rest="${match#*:}"
  lineno="${rest%%:*}"
  content="${rest#*:}"

  # In-process collection: do not wrap chp::scan_text in `$(…)` — command
  # substitution of a bash function forks a subshell per git-grep hit
  # (forks-in-loop). A nameref sink lets _record_violation append here.
  # The function's non-zero return is the "has findings" signal, not a
  # suppressed crash, so capturing it here is the intended path.
  # shellcheck disable=SC2310
  scan_rc=0
  chp_violation_sink=__chp_scan_hits
  __chp_scan_hits=()
  chp::scan_text "$content" || scan_rc=$?
  if [[ "$scan_rc" -eq 0 ]]; then
    continue
  fi

  for detail_line in "${__chp_scan_hits[@]}"; do
    [[ -z "$detail_line" ]] && continue
    # The library prefixes its own (single-line) lineno; replace it with the
    # real git-grep file line number.
    detail="${detail_line#*:}"
    printf '%s:%s:%s\n' "$file" "$lineno" "$detail"
    violations=$((violations + 1))
  done
done <"$matches"

if [[ "$violations" -eq 0 ]]; then
  echo "comment-hygiene: clean" >&2
  exit 0
fi
echo "comment-hygiene: $violations violation(s)" >&2
exit 1
