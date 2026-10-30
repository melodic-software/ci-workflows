#!/usr/bin/env bash
# shellcheck shell=bash
# Inputs (environment): CONFIG, EXCLUDE, GLOBS, as action.yml documents them.
set -euo pipefail
CONFIG="${CONFIG:?}"
EXCLUDE="${EXCLUDE:-}"
GLOBS="${GLOBS:?}"

# This repository's root lychee.toml is the canonical ruleset, kept current by
# the standards sync (sync-manifest component `lychee`). The action runs from a
# full copy of this repository, so the file sits three levels above this one.
bundled="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)/lychee.toml"

# A caller with no lychee.toml of its own gets the canonical one: repositories
# outside the standards sync (and so without a synced copy) use the same rules
# with no repo-local copy to drift. Only the default path falls back; a caller
# that names another path and lacks it is misconfigured.
if [[ ! -f "$CONFIG" ]]; then
  if [[ "$CONFIG" != lychee.toml ]]; then
    echo "::error::lychee-offline: config file not found: $CONFIG"
    exit 2
  fi
  if [[ ! -f "$bundled" ]]; then
    echo "::error::lychee-offline: no lychee.toml in the caller, and the bundled canonical copy is missing: $bundled"
    exit 2
  fi
  CONFIG="$bundled"
fi
echo "lychee-offline: config $CONFIG"

# Anchor checks come from the ruleset's include_fragments (lychee's CLI
# default is off); the config is intentionally not overridden here.
args=(--offline --no-progress --config "$CONFIG")
# $EXCLUDE entries are REGEXES; without set -f bash would pathname-expand
# an entry containing a metacharacter before lychee sees it.
set -f
for e in $EXCLUDE; do
  args+=(--exclude-path "$e")
done
set +f
# -d '' takes the whole value so a multi-line input still splits; read hits
# EOF without finding that delimiter, hence the `|| true`.
globs=()
read -r -d '' -a globs <<<"$GLOBS" || true
lychee "${args[@]}" "${globs[@]}"
