#!/usr/bin/env bash
# Every lane here (composite-run-shellcheck.sh, ci.yml's schema step) globs
# action.yml only, so a GitHub-legal action.yaml would be skipped silently.
set -uo pipefail

# :(glob) so `**/` also matches a repository-root action.yaml.
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
