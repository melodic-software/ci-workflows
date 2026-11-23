#!/usr/bin/env bash
# shellcheck shell=bash
# Prints the commit of melodic-software/standards that STANDARDS_REF (default
# main) names. A full SHA is taken as given; a branch is resolved with one
# anonymous git ls-remote the first time a job asks, and every later call in
# the job reads that answer, so one job never sees two commits. The first time
# a job uses a commit, a line in the step summary records it.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

ref="${STANDARDS_REF:-main}"
url="${STANDARDS_URL:-https://github.com/melodic-software/standards.git}"
root="${STANDARDS_DIR:-${RUNNER_TEMP:?RUNNER_TEMP is not set}/ci-workflows-standards}"

mkdir -p "$root"
if [[ $ref =~ ^[0-9a-f]{40}$ ]]; then
  sha="$ref"
else
  git check-ref-format "refs/heads/$ref" ||
    standards_fail "standards ref '$ref' is neither a full commit SHA nor a branch name"
  memo="$root/ref-${ref//\//%}"
  if [[ -f $memo ]]; then
    sha="$(<"$memo")"
  else
    export WANT="refs/heads/$ref"
    listing="$(standards_retry "git ls-remote of standards $ref" git ls-remote "$url" "$WANT")"
    # ls-remote matches a pattern as a ref's tail, so only an exact name counts.
    sha="$(awk '$2 == ENVIRON["WANT"] { print $1 }' <<<"$listing")"
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || standards_fail "melodic-software/standards has no branch $ref"
    printf '%s\n' "$sha" >"$memo"
  fi
fi

recorded="$root/recorded-$sha"
if [[ ! -e $recorded ]]; then
  : >"$recorded"
  echo "download-standards: melodic-software/standards $ref is $sha" >&2
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
    # shellcheck disable=SC2016 # The backticks are Markdown code spans.
    printf 'Standards: melodic-software/standards at [`%s`](https://github.com/melodic-software/standards/tree/%s) (ref `%s`).\n' \
      "$sha" "$sha" "$ref" >>"$GITHUB_STEP_SUMMARY"
  fi
fi
printf '%s\n' "$sha"
