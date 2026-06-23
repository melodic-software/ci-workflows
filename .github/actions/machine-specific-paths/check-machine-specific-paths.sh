#!/usr/bin/env bash
# Fail when tracked files contain machine-specific absolute paths — a
# developer's checkout root or user-home directory. Portable placeholders such
# as C:\Users\<user>\ and <repo-root>/ are allowed (the negative character
# classes exclude '<').
#
# POSIX ERE only (grep -E) for cross-platform parity — never grep -P (macOS BSD
# grep lacks it).
set -euo pipefail

# Per-OS machine-path regex BODIES. DEFINE single-quoted, EXPAND double-quoted
# ("$WIN_USER_BODY"): a double-quoted definition would collapse the escaped-repo
# body's doubled backslashes and silently change what grep matches.
#
# The Windows bodies match the separator as single-backslash, forward-slash, OR
# doubled-backslash (JSON-escaped) at every position — (/|\\\\?) is fwd-slash or
# one-to-two backslashes — and accept an 8.3 short-name segment ending ~<digit>
# (e.g. ALICE~1) via the optional (~[0-9]+). The negative class still excludes a
# bare ~ so a tilde-shorthand segment stays clean. macOS/Linux bodies carry the
# drive-letter / leading-slash anchor differently, so they get the PATH_BOUNDARY
# prefix below; the Windows bodies are self-anchored by `[A-Za-z]:`.
WIN_USER_BODY='[A-Za-z]:(/|\\\\?)Users(/|\\\\?)[^/\\$<{~]+(~[0-9]+)?(/|\\\\?)'
MACOS_USER_BODY='/Users/[^/$<{~]+/'
LINUX_USER_BODY='/home/[^/$<{~]+/'
WIN_REPO_BODY='[A-Za-z]:(/|\\\\?)repos(/|\\\\?)[^/\\$<{~]+(~[0-9]+)?(/|\\\\?)'
# SC1003 false positive: the trailing \\\\ is a deliberate literal-backslash ERE
# (matches a JSON-escaped path separator), not a botched single-quote escape.
# shellcheck disable=SC1003
ESCAPED_WIN_REPO_BODY='[A-Za-z]:\\\\repos\\\\[^\\$<{~]+(~[0-9]+)?\\\\'

# Boundary for the slash-rooted macOS/Linux bodies so a substring like
# "doc/Users/guide" inside a longer word does not false-match.
PATH_BOUNDARY="(^|[[:space:]\"'\`(=]|file://)"
MACOS_PATTERN="${PATH_BOUNDARY}${MACOS_USER_BODY}"
LINUX_PATTERN="${PATH_BOUNDARY}${LINUX_USER_BODY}"

read -ra scan_paths <<<"${EXTENSIONS:-}"
read -ra excludes <<<"${EXCLUDE:-}"

failed=0
run_check() {
  local label=$1 pattern=$2 matches
  # `| head -20` caps noise; the `|| true` absorbs git grep's exit 1 (no match)
  # and head's SIGPIPE under pipefail. Empty result => this pattern is clean.
  matches=$(git grep -nIE "$pattern" -- "${scan_paths[@]}" "${excludes[@]}" | head -20 || true)
  if [[ -n "$matches" ]]; then
    echo "Machine-specific path detected (${label}):" >&2
    echo "$matches" >&2
    echo "" >&2
    failed=1
  fi
}

# OS home paths (placeholders excluded by the character class).
run_check "Windows user path" "$WIN_USER_BODY"
run_check "macOS user path" "$MACOS_PATTERN"
run_check "Linux user path" "$LINUX_PATTERN"

# Repo checkout roots (plain and escaped backslash forms).
run_check "Windows repo path" "$WIN_REPO_BODY"
run_check "Escaped Windows repo path" "$ESCAPED_WIN_REPO_BODY"

if [[ "$failed" -ne 0 ]]; then
  echo "Use portable placeholders (<repo-root>, <user>) or relative paths." >&2
  exit 1
fi

echo "No machine-specific absolute paths detected."
