# shellcheck shell=bash
# Pin the two properties a green composite-run-shellcheck run cannot prove:
# that a broken `run:` block fails the check, and that a file set yielding no
# block fails rather than passing empty. Without both, a selector that quietly
# matches nothing is indistinguishable from a clean scan.
set -euo pipefail

check=.github/scripts/composite-run-shellcheck.sh
temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

broken="$temp/composite-run-shellcheck-broken.txt"
if bash "$check" fixtures/composite-action/bad/action.yml >"$broken" 2>&1; then
  echo 'The intentionally broken composite run: block unexpectedly passed.' >&2
  exit 1
fi
cat -- "$broken"
grep -F 'SC2086' "$broken"
# Reporting the offending source line also proves the ${{ }} substitution ran:
# an unsubstituted expression is a bash parse error, and ShellCheck would stop
# at that instead of reaching this finding.
grep -F "ls \$PATHS" "$broken"
# A step ShellCheck cannot analyse is announced, never silently dropped.
grep -F 'shell is pwsh, not bash/sh' "$broken"

empty="$temp/composite-run-shellcheck-empty.txt"
if bash "$check" .github/workflows/ci.yml >"$empty" 2>&1; then
  echo 'A file set containing no composite run: block unexpectedly passed.' >&2
  exit 1
fi
cat -- "$empty"
grep -F 'no bash/sh run: block was extracted' "$empty"
