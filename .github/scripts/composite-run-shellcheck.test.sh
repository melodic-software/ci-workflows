# shellcheck shell=bash
# Pin the properties a green composite-run-shellcheck run cannot prove on its
# own: that a broken `run:` block fails the check, that the expression
# substitution actually runs, that a step ShellCheck cannot read is announced,
# that every tracked composite is reached — including one carrying no shell at
# all — that a malformed `runs.steps` shape is refused rather than extracted
# from, and that a file set yielding no block fails rather than passing empty.
# Without these, a selector matching nothing — or nearly nothing — is
# indistinguishable from a clean scan.
set -euo pipefail

check=.github/scripts/composite-run-shellcheck.sh
temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

broken="$temp/composite-run-shellcheck-broken.txt"
if bash "$check" \
  fixtures/composite-action/bad/action.yml \
  fixtures/composite-action/uses-only/action.yml >"$broken" 2>&1; then
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
# A composite whose steps are all `uses:` emits no step line at all, so only the
# visit line keeps it out of the coverage floor's false-negative bucket below.
grep -F 'visit fixtures/composite-action/uses-only/action.yml' "$broken"

# `runs.steps` as a mapping makes the step key an author-supplied string that
# would otherwise reach a write path and an interpolated yq expression. The
# shape is refused, not extracted from.
mapping="$temp/composite-run-shellcheck-mapping.txt"
if bash "$check" fixtures/composite-action/mapping-steps/action.yml >"$mapping" 2>&1; then
  echo 'A mapping-shaped runs.steps was unexpectedly accepted.' >&2
  exit 1
fi
cat -- "$mapping"
grep -F 'runs.steps is not a sequence' "$mapping"

# Coverage floor. The check announces every file discovery reaches, so every
# tracked composite must appear by name: discovery that quietly reaches one
# action instead of all of them is otherwise a clean green. Keyed on the visit
# line rather than a step line so an action carrying no shell still counts as
# reached.
covered="$temp/composite-run-shellcheck-covered.txt"
bash "$check" >"$covered" 2>&1
while IFS= read -r action; do
  if ! grep -Fq "visit $action" "$covered"; then
    echo "Discovery never reached $action." >&2
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
