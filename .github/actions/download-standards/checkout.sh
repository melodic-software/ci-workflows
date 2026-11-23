#!/usr/bin/env bash
# shellcheck shell=bash
# Prints the path of a checkout of melodic-software/standards at the commit
# resolve.sh gives for STANDARDS_REF. The first call in a job fetches that one
# commit, anonymously and at depth 1, into $RUNNER_TEMP, outside the workspace
# so no scan of the workspace reads it; later calls reuse it. No remote and no
# credential is stored in the checkout.
set -euo pipefail
here="$(dirname -- "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source "$here/lib.sh"

url="${STANDARDS_URL:-https://github.com/melodic-software/standards.git}"
root="${STANDARDS_DIR:-${RUNNER_TEMP:?RUNNER_TEMP is not set}/ci-workflows-standards}"

sha="$(bash "$here/resolve.sh")"
dest="$root/$sha"
if [[ ! -d $dest ]]; then
  work="$(mktemp -d "$root/fetch.XXXXXX")"
  git -c init.defaultBranch=standards init -q "$work"
  standards_retry "git fetch of standards $sha" git -C "$work" fetch -q --depth 1 --no-tags "$url" "$sha"
  git -C "$work" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
  [[ "$(git -C "$work" rev-parse HEAD)" == "$sha" ]] || standards_fail "the fetched commit is not $sha"
  mv -T -- "$work" "$dest"
fi
printf '%s\n' "$dest"
