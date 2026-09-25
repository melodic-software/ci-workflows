#!/usr/bin/env bash
# Fail on tracked checkout-root or user-home paths; placeholders and lines marked
# machine-path:allow pass. POSIX ERE only: BSD grep lacks -P; bash =~ is not ERE.
set -euo pipefail

# HPP_* bodies come from the standards-synced machine-path-patterns.sh; change
# them upstream, not here.
# shellcheck source=machine-path-patterns.sh
source "${BASH_SOURCE[0]%/*}/machine-path-patterns.sh"

# Boundary for the slash-rooted macOS/Linux bodies so a substring like
# "doc/Users/guide" inside a longer word does not false-match.
PATH_BOUNDARY="(^|[[:space:]\"'\`(=]|file://)"
MACOS_PATTERN="${PATH_BOUNDARY}${HPP_MACOS_USER_BODY}"
LINUX_PATTERN="${PATH_BOUNDARY}${HPP_LINUX_USER_BODY}"
ALLOW_MARKER='machine-path:allow'

# 0 when the child is a non-empty placeholder (ASCII punctuation or U+2026).
# 1 when it is empty or still contains a letter, digit, or other non-ASCII.
span_child_is_punctuation_only() {
  local child=$1 rest ellipsis
  [[ -n "$child" ]] || return 1
  # Explicit status: this predicate is called from if, which suppresses set -e.
  # A printf or tr failure returns 1 so the span stays a finding.
  rest="$(printf '%s' "$child" | LC_ALL=C tr -d '[:punct:]')" || return 1
  # U+2026 is not in the C-locale punct class. Octal keeps this bash 3.2-safe.
  ellipsis="$(printf '\342\200\246')" || return 1
  rest="${rest//$ellipsis/}"
  [[ -z "$rest" ]]
}

# Keep a git-grep hit unless every re-extracted span is a placeholder; a hit
# that yields no span stays a finding (fail closed).
filter_machine_path_hits() {
  local pattern=$1
  local line rest content spans span child trimmed
  local macos=0 keep extracted
  local -a kept=()
  if [[ "$pattern" == "$MACOS_PATTERN" ]]; then
    macos=1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    case "$line" in
    *:*:*)
      rest="${line#*:}"
      content="${rest#*:}"
      [[ "$content" == *"$ALLOW_MARKER"* ]] && continue
      ;;
    *)
      kept+=("$line")
      continue
      ;;
    esac
    # Exit 1 means the extractor found nothing. That still fails closed below.
    spans="$(printf '%s\n' "$content" | grep -oE -- "$pattern" || true)"
    keep=0
    extracted=0
    if [[ -n "$spans" ]]; then
      while IFS= read -r span || [[ -n "$span" ]]; do
        [[ -z "$span" ]] && continue
        extracted=1
        child="${span##*[/\\]}"
        # shellcheck disable=SC2310 # predicate; a printf or tr failure returns 1 and the span stays a finding.
        if span_child_is_punctuation_only "$child"; then
          continue
        fi
        if [[ "$macos" -eq 1 ]]; then
          # A sentence-final "/Users/Shared." is exempt; "Shared.foo" and
          # "Shared%2026" are not.
          # shellcheck disable=SC2001
          trimmed="$(printf '%s\n' "$child" | LC_ALL=C sed 's/[^A-Za-z0-9._-]*$//')"
          trimmed="${trimmed%.}"
          if [[ "$trimmed" == "Shared" ]]; then
            continue
          fi
        fi
        keep=1
        break
      done <<<"$spans"
    fi
    if [[ "$extracted" -eq 0 || "$keep" -eq 1 ]]; then
      kept+=("$line")
    fi
  done
  if [[ "${#kept[@]}" -eq 0 ]]; then
    return 0
  fi
  printf '%s\n' "${kept[@]}"
}

run_check() {
  local label=$1 pattern=$2 matches rc=0 filtered
  # Not piped to head: that would lose a fatal (>=2) grep status, and only
  # exit 1 (no match) is clean.
  matches=$(git grep -nIE "$pattern" -- "${scan_paths[@]}" "${excludes[@]}") || rc=$?
  if [[ "$rc" -ne 0 && "$rc" -ne 1 ]]; then
    echo "::error::git grep failed (exit $rc) scanning for ${label} — refusing to pass without a full scan." >&2
    exit 1
  fi
  if [[ -n "$matches" ]]; then
    filtered="$(filter_machine_path_hits "$pattern" <<<"$matches")"
    if [[ -n "$filtered" ]]; then
      echo "Machine-specific path detected (${label}):" >&2
      # head caps display noise only, and only after placeholder spans are
      # dropped; the scan status is already validated above.
      printf '%s\n' "$filtered" | head -20 >&2 || true
      echo "" >&2
      failed=1
    fi
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  read -ra scan_paths <<<"${EXTENSIONS:-}"
  read -ra excludes <<<"${EXCLUDE:-}"

  failed=0
  # OS home paths (placeholders excluded by the character class).
  run_check "Windows user path" "$HPP_WIN_USER_BODY"
  run_check "macOS user path" "$MACOS_PATTERN"
  run_check "Linux user path" "$LINUX_PATTERN"

  # Repo checkout roots (plain and escaped backslash forms).
  run_check "Windows repo path" "$HPP_WIN_REPO_BODY"
  run_check "Escaped Windows repo path" "$HPP_ESCAPED_WIN_REPO_BODY"

  if [[ "$failed" -ne 0 ]]; then
    echo "Use portable placeholders (<repo-root>, <user>) or relative paths." >&2
    exit 1
  fi

  echo "No machine-specific absolute paths detected."
fi
