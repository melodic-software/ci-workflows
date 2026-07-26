# shellcheck shell=bash
# Pin the properties a green composite-run-shellcheck run cannot prove on its
# own: that a broken `run:` block fails the check, that the expression
# substitution actually runs, that every tracked composite is reached, and that
# a file set yielding no block fails rather than passing empty. Without these, a
# selector matching nothing — or nearly nothing — is indistinguishable from a
# clean scan.
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
grep -F "ls \$PATHS" "$broken"
# The fixture interpolates an expression inline, which no real action.yml here
# does. Left unsubstituted it parses as a bad parameter expansion (SC2296), so
# its ABSENCE is what proves the substitution ran — SC2296 is non-fatal, and the
# findings above are reported either way.
if grep -F 'SC2296' "$broken"; then
  echo 'An inline GitHub expression reached ShellCheck unsubstituted.' >&2
  exit 1
fi
# A step ShellCheck cannot analyse is announced, never silently dropped.
grep -F 'shell is pwsh, not bash/sh' "$broken"

# Coverage floor. The check reports one line per step it accepts or skips, so
# every tracked composite must appear by name: discovery that quietly reaches
# one action instead of all of them is otherwise a clean green.
covered="$temp/composite-run-shellcheck-covered.txt"
bash "$check" >"$covered" 2>&1
while IFS= read -r action; do
  if ! grep -Fq "$action runs.steps[" "$covered"; then
    echo "No run: block was reached in $action." >&2
    exit 1
  fi
done < <(git ls-files -- '.github/actions/*/action.yml')

empty="$temp/composite-run-shellcheck-empty.txt"
if bash "$check" .github/workflows/ci.yml >"$empty" 2>&1; then
  echo 'A file set containing no composite run: block unexpectedly passed.' >&2
  exit 1
fi
cat -- "$empty"
grep -F 'no bash/sh run: block was extracted' "$empty"
