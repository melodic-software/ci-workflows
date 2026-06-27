#!/usr/bin/env bash
# Self-check for the comment-hygiene coarse prefilter.
#
# scan-tree.sh runs a fast `git grep -iE` prefilter (chp::coarse_re) and feeds
# only the hits to the policy library (chp::scan_text) for authoritative
# validation. Correctness rests on one invariant: the prefilter must be a
# SUPERSET of the library — every line the library flags must also be admitted
# by the prefilter. If the prefilter under-matches, scan-tree silently drops a
# real violation before the validator sees it (a fail-open gate).
#
# Nothing structural couples the two: the prefilter regex lives in this repo
# while the policy library is vendored from the standards repo and versioned
# independently. This test makes the invariant self-enforcing — it sources both
# and asserts, for a representative line per library rule across all five comment
# prefixes, that the library flags it AND the prefilter admits it. A narrowed
# prefilter, or a library that grows a rule the prefilter misses, turns this red.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=coarse-prefilter.sh
source "$here/coarse-prefilter.sh"
# Policy library left opaque to ShellCheck (it is vendored and linted at its own
# source); following it here would treat chp::scan_text as a known function and
# trip check-set-e-suppressed on the intentional exit-code capture below.
# shellcheck source=/dev/null
source "$here/../../../modules/comment-hygiene/comment-hygiene-patterns.sh"

coarse_re="$(chp::coarse_re)"
failures=0
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

# A line the library flags must also pass the prefilter (the superset guarantee).
assert_caught() {
  local desc=$1 line=$2 scan_rc=0
  chp::scan_text "$line" >/dev/null || scan_rc=$?
  if [[ "$scan_rc" -eq 0 ]]; then
    fail "library did not flag [$desc]: $line"
    return
  fi
  if ! printf '%s\n' "$line" | grep -qiE "$coarse_re"; then
    fail "prefilter dropped a real violation — fail-open [$desc]: $line"
  fi
}

# A clean line guards against a degenerate library that flags everything.
assert_clean() {
  local desc=$1 line=$2 scan_rc=0
  chp::scan_text "$line" >/dev/null || scan_rc=$?
  if [[ "$scan_rc" -ne 0 ]]; then
    fail "library flagged a clean line [$desc]: $line"
  fi
}

# One representative violation per library rule, spread across the five comment
# prefixes (//, #, /*, *, <!--) the policy recognizes.
assert_caught 'TODO marker'              '# TODO refactor this'
assert_caught 'FIXME marker'             '// FIXME later'
assert_caught 'HACK marker'              '/* HACK around the bug */'
assert_caught 'XXX marker'               '   * XXX revisit'
assert_caught 'cc-issue marker'          '<!-- cc-issue pending -->'
assert_caught 'closing keyword fixes'    '# fixes #12'
assert_caught 'closing keyword resolves' '// resolves #42'
assert_caught 'closing keyword closed'   '# closed #7'
assert_caught 'issue reference (no #)'   '# issue 5'
assert_caught 'issues reference (#)'     '# issues: #3'
assert_caught 'tracked reference'        '# tracked #7'
assert_caught 'owner/repo#N reference'   '# org/app#123'
assert_caught 'GH-N reference'           '# GH-42'
assert_caught 'PR #N reference'          '# PR #9'

assert_clean 'plain prose'               '# just a normal comment'
assert_clean 'fix without an issue #'    '# fix the broken handle'

if [[ "$failures" -gt 0 ]]; then
  printf '%d assertion(s) failed.\n' "$failures" >&2
  exit 1
fi
echo 'comment-hygiene prefilter is a superset of the policy library.'
