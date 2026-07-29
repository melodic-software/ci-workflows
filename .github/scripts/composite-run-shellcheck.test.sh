# shellcheck shell=bash
# Pin the properties a green composite-run-shellcheck run cannot prove on its
# own: that a broken `run:` block fails the check, that the expression
# substitution actually runs — and spans the right bytes when an expression
# crosses lines, carries a `}}` in a string literal, or is never closed at all —
# that a step ShellCheck cannot read is announced, that every tracked composite
# is reached — including
# one carrying no shell at all — that a malformed `runs.steps` shape is refused
# rather than extracted from, and that a file set yielding no block fails rather
# than passing empty. Without these, a selector matching nothing — or nearly
# nothing — is indistinguishable from a clean scan.
set -euo pipefail

check=.github/scripts/composite-run-shellcheck.sh
temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

# The caret lines ShellCheck attached to one reported line — one per code, and
# the only lines a code appears on — for a caller to grep. A fixed -A count
# instead stops covering the block as soon as a line draws a second code, and an
# assertion on what it then cannot see reads as a pass. The source line between
# the header and the carets is skipped unread, so a finding whose source line is
# blank (ShellCheck reports one at end of file) still yields its codes.
findings_at() {
  awk -v header="In $1 line $2:" '
    $0 == header { inside = 1; source = 1; next }
    inside && source { source = 0; next }
    inside && /^ *\^/ { print; next }
    inside { inside = 0 }
  ' "$3"
}

# Guards every assertion that reads a code off a given line: that line number
# only proves a span was substituted correctly if the span produced nothing of
# its own. A span ending one byte short leaks a `}` that draws its own finding
# while leaving every other line number where it was, so the code and the line
# both still match and the assertion passes.
expect_findings() {
  if [[ "$(grep -cF "In $1 line " "$3")" -ne "$2" ]]; then
    echo "Expected exactly $2 finding(s) in $1." >&2
    exit 1
  fi
}

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

# GitHub's custom-shell form (`command [...options] {0}`) is run with the
# leading command word, so actionlint resolves the dialect by prefix and this
# check must too — matching only the bare names would leave a block GitHub runs
# with bash unchecked while the job stayed green. Asserted as `check` lines, not
# merely as an exit code: the count guard only compares two selectors, so it
# agrees when both are wrong.
custom="$temp/composite-run-shellcheck-custom-shell.txt"
bash "$check" fixtures/composite-action/custom-shell/action.yml >"$custom" 2>&1
cat -- "$custom"
grep -F 'runs.steps[1] (shell: bash)' "$custom"
grep -F 'runs.steps[2] (shell: sh)' "$custom"
grep -F 'runs.steps[3]: shell is pwsh, not bash/sh' "$custom"
if [[ "$(grep -c '^check fixtures/composite-action/custom-shell/' "$custom")" -ne 3 ]]; then
  echo 'Expected exactly three checked blocks in the custom-shell fixture.' >&2
  exit 1
fi

# The span shapes the expression-spans fixture carries, which it describes.
# Neither is a gate hole — both make the check go red — so the assertions are on
# WHERE and WHETHER a real finding is reported, never on the exit status alone.
spans="$temp/composite-run-shellcheck-expression-spans.txt"
if bash "$check" fixtures/composite-action/expression-spans/action.yml >"$spans" 2>&1; then
  echo 'The expression-spans fixture unexpectedly passed.' >&2
  exit 1
fi
cat -- "$spans"

# An expression spanning lines must consume its newline without deleting it.
# `set -eo pipefail` occupies line 1 and the block's fifth line carries the
# SC2086, so it is reported at line 6; collapsing the expression onto one line
# reports 5 and shifts every later finding in the block by the same amount.
spanning=fixtures/composite-action/expression-spans/action.yml.step-0.bash
expect_findings "$spanning" 1 "$spans"
findings_at "$spanning" 6 "$spans" | grep -F 'SC2086'

# A `}}` inside the expression's own string literal must not end the span.
# Ending there leaks the literal's remainder into the script, and the unbalanced
# quoting stops ShellCheck analysing the file — so the SC2086 on the line below,
# reported at line 7, is reported at all only because the span survived intact.
literal=fixtures/composite-action/expression-spans/action.yml.step-1.bash
expect_findings "$literal" 1 "$spans"
findings_at "$literal" 7 "$spans" | grep -F 'SC2086'
# The parse errors a truncated span produces. Asserted absent by code rather
# than by the SC2086 above alone: those codes are what masks it, and naming them
# keeps the failure legible when the substitution regresses. File-global, so
# the shape that legitimately produces them gets a fixture and a run of its own
# below rather than a step here.
if grep -E 'SC107[23]' "$spans"; then
  echo 'A truncated expression span left ShellCheck unable to parse the block.' >&2
  exit 1
fi

# The unterminated `${{`, whose handling the check chooses for itself rather
# than following the runner — see the header of the script under test. Nothing
# in the toolchain would catch a wrong choice, so both halves of it are pinned.
unterminated="$temp/composite-run-shellcheck-unterminated.txt"
if bash "$check" fixtures/composite-action/unterminated-expression/action.yml \
  >"$unterminated" 2>&1; then
  echo 'The unterminated-expression fixture unexpectedly passed.' >&2
  exit 1
fi
cat -- "$unterminated"

# The opener stops the scan rather than extending it to the next expression's
# `}}`. Extending it underscores that well-formed expression and the `ls` after
# it, leaving the block's stray `"` to swallow what remains — so the SC2086 on
# the sixth line of the body, reported at line 7, is absent exactly when the
# opener has silently consumed the real shell around it.
swallowed=fixtures/composite-action/unterminated-expression/action.yml.step-0.bash
expect_findings "$swallowed" 1 "$unterminated"
findings_at "$swallowed" 7 "$unterminated" | grep -F 'SC2086'

# The opener itself survives into the extracted script, so ShellCheck reports it
# rather than the block parsing cleanly and saying nothing. Third line of the
# body, reported at line 4.
intact=fixtures/composite-action/unterminated-expression/action.yml.step-1.bash
findings_at "$intact" 4 "$unterminated" | grep -F 'SC1073'

# A path is reused as both the extracted script's location under the temp
# workdir and the argument ShellCheck reads back after cd'ing there, so only a
# repo-relative one makes the two coincide. Refused up front: an absolute path
# otherwise surfaces as a ShellCheck "does not exist" having linted nothing,
# and a `..` one writes outside the workdir, past the cleanup trap. Purely
# syntactic, so the paths below need not exist.
outside="$temp/composite-run-shellcheck-outside.txt"
for bad in "$PWD/fixtures/composite-action/bad/action.yml" ../action.yml; do
  if bash "$check" "$bad" >"$outside" 2>&1; then
    echo "A path that is not repo-relative was unexpectedly accepted: $bad" >&2
    exit 1
  fi
  cat -- "$outside"
  grep -F 'must be a repo-relative path' "$outside"
done

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
