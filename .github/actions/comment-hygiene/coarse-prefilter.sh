# shellcheck shell=bash
# CONTRACT: a case-insensitive SUPERSET of every chp::scan_text trigger in any
# caller's library (so bare tracker numbers too); superset-test.sh enforces it.

# chp::coarse_re — print the coarse prefilter ERE. A function (not a bare
# variable) so the sourced fragment lints clean standalone.
chp::coarse_re() {
  printf '%s' '^[[:space:]]*(//|#|/\*|\*|<!--).*(TODO|FIXME|HACK|XXX|cc-issue|GH-[0-9]|#[0-9]|/[A-Za-z0-9._-]+#[0-9]|(issues?|tracked|fix(es|ed)?|close[sd]?|resolve[sd]?)[[:space:]]*:?[[:space:]]*[0-9])'
}
