#!/usr/bin/env bash
# shellcheck shell=bash
# Inputs (environment): CONFIG, EXCLUDE, GLOBS and STANDARDS_REF, as action.yml
# documents them.
set -euo pipefail
CONFIG="${CONFIG:?}"
EXCLUDE="${EXCLUDE:-}"
GLOBS="${GLOBS:?}"

# A caller with no lychee.toml of its own gets standards' canonical ruleset,
# so a repository without a synced copy runs the same rules with no copy to
# drift. Only the default path falls back; a caller that names another path
# and lacks it is misconfigured.
# shellcheck source=../checkout-standards/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../checkout-standards/lib.sh"
CONFIG="$(standards_config "$CONFIG" lychee.toml lychee.toml)"
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
