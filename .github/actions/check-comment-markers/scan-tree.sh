#!/usr/bin/env bash
# Coarse git grep, then PATTERNS_FILE's chp::scan_text validates each hit.
# Emits path:lineno:kind:detail; exit 0 clean, 1 violations, 2 environment.
set -euo pipefail

PATTERNS_FILE="${PATTERNS_FILE:?comment-hygiene: PATTERNS_FILE is required}"
if [[ ! -f "$PATTERNS_FILE" ]]; then
  echo "comment-hygiene: patterns file not found: $PATTERNS_FILE" >&2
  exit 2
fi
# shellcheck source=/dev/null
source "$PATTERNS_FILE"

# Redefined after sourcing so hits collect in-process into a nameref sink; the
# bundled library is a managed payload and is not edited.
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

# shellcheck source=coarse-prefilter.sh
source "$(dirname "${BASH_SOURCE[0]}")/coarse-prefilter.sh"
coarse_re="$(chp::coarse_re)"

matches=$(mktemp)
errfile=$(mktemp)
scan_stdout=$(mktemp)
trap 'rm -f "$matches" "$errfile" "$scan_stdout"' EXIT
grep_rc=0
# stderr kept apart: a git warning in $matches would become a candidate.
git grep -niE "$coarse_re" -- "${scan_globs[@]}" "${excludes[@]}" >"$matches" 2>"$errfile" || grep_rc=$?
if [[ "$grep_rc" -ne 0 && "$grep_rc" -ne 1 ]]; then
  echo "comment-hygiene: git grep failed (exit $grep_rc):" >&2
  cat "$errfile" >&2
  exit 2
fi

violations=0
reported=0
while IFS= read -r match; do
  [[ -z "$match" ]] && continue
  file="${match%%:*}"
  rest="${match#*:}"
  lineno="${rest%%:*}"
  content="${rest#*:}"

  # No `$(…)`: it forks per hit. The stdout redirect is no subshell and still
  # collects a replacement scanner; a non-zero return means findings.
  # shellcheck disable=SC2310
  scan_rc=0
  chp_violation_sink=__chp_scan_hits
  __chp_scan_hits=()
  : >"$scan_stdout"
  {
    chp::scan_text "$content" || scan_rc=$?
  } >"$scan_stdout"
  if [[ "$scan_rc" -eq 0 ]]; then
    continue
  fi

  if ((${#__chp_scan_hits[@]} > 0)); then
    detail_lines=("${__chp_scan_hits[@]}")
  else
    mapfile -t detail_lines <"$scan_stdout"
  fi

  for detail_line in "${detail_lines[@]}"; do
    [[ -z "$detail_line" ]] && continue
    # The library prefixes its own (single-line) lineno; replace it with the
    # real git-grep file line number.
    detail="${detail_line#*:}"
    printf '%s:%s:%s\n' "$file" "$lineno" "$detail"
    reported=$((reported + 1))
  done
done <"$matches"

if [[ "$reported" -eq 0 ]]; then
  echo "comment-hygiene: clean" >&2
  exit 0
fi
echo "comment-hygiene: $reported violation(s)" >&2
exit 1
