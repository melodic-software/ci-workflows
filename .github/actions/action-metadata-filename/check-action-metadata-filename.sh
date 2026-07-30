#!/usr/bin/env bash
# GitHub accepts either `action.yml` or `action.yaml` for action metadata
# (docs: metadata-syntax — "The preferred format is action.yml"), but every
# lane in this repo globs action.yml only: composite-run-shellcheck.sh,
# ci.yml's "Validate composite actions" check-jsonschema step, and
# tool-version-drift-check.yml's path filter. A file added as action.yaml
# would be invisible to every one of them, with nothing in the log to notice
# — no visit/skip line, no count mismatch, completely silent.
#
# Ratified: action.yml is enforced as the
# ONLY accepted metadata filename, repo-wide, rather than teaching every
# current and future enumeration site a second pattern for a spelling GitHub
# itself calls non-preferred and nothing here uses. This converts the silent
# miss into a loud, immediate failure at the moment the wrong filename is
# introduced.
#
# Deliberately NOT `set -e`: git ls-files exits 0 whether or not the pathspec
# matched anything, so there is no legitimate non-zero exit to distinguish
# from a fatal one the way exec-bit's git-grep check must.
set -uo pipefail

# Whole tracked tree, not scoped to .github/actions/ — a stray action.yaml
# anywhere (a fixture, a future actions/ subdirectory) still fails loudly.
# :(glob) magic is required for that whole-tree claim: with the default
# pathspec match, a leading `**/` matches nested files only, silently
# missing a repository-root action.yaml; glob magic matches both.
# -z / core.quotePath=false so a path with a space, tab, or non-ASCII byte is
# read back intact rather than split or C-escaped.
candidates=$(mktemp)
errfile=$(mktemp)
trap 'rm -f "$candidates" "$errfile"' EXIT
ls_rc=0
git -c core.quotePath=false ls-files -z -- ':(glob)**/action.yaml' \
  >"$candidates" 2>"$errfile" || ls_rc=$?
if [[ "$ls_rc" -ne 0 ]]; then
  echo "::error::git ls-files failed (exit $ls_rc) — refusing to pass the filename gate without a full scan."
  echo "::group::git ls-files stderr"
  cat "$errfile"
  echo "::endgroup::"
  exit 1
fi

failed=0
while IFS= read -r -d '' path; do
  [[ -n "$path" ]] || continue
  echo "::error file=$path::GitHub Actions metadata must be named action.yml, not action.yaml — this repo enforces action.yml exclusively (melodic-software/ci-workflows#267): rename this file."
  failed=1
done <"$candidates"

if [[ "$failed" -eq 0 ]]; then
  echo 'No action.yaml metadata files found; action.yml is enforced exclusively.'
fi
exit "$failed"
