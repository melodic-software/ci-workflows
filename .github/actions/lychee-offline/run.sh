#!/usr/bin/env bash
# shellcheck shell=bash
# Inputs (environment): CONFIG, EXCLUDE, GLOBS and STANDARDS_REF, as action.yml
# documents them.
set -euo pipefail
CONFIG="${CONFIG:?}"
EXCLUDE="${EXCLUDE:-}"
GLOBS="${GLOBS:?}"

# On the default path, standards' canonical lychee.toml is always the first
# --config, and the caller's own lychee.toml, when present, the second: lychee
# 0.24.0 and later merge repeated --config files, later ones winning, so the
# caller's file extends or partly overrides standards without copying it. A
# caller that names another path runs that file alone, a complete override,
# and lacking it is misconfigured.
if [[ $CONFIG == lychee.toml ]]; then
  checkout="$(bash "$(dirname -- "${BASH_SOURCE[0]}")/../download-standards/checkout.sh")" || exit 2
  if [[ ! -f $checkout/lychee.toml ]]; then
    echo "::error::melodic-software/standards at ${checkout##*/} has no lychee.toml" >&2
    exit 2
  fi
  configs=("$checkout/lychee.toml")
  if [[ -e $CONFIG || -L $CONFIG ]]; then
    configs+=("$CONFIG")
  fi
elif [[ -e $CONFIG || -L $CONFIG ]]; then
  configs=("$CONFIG")
else
  echo "::error::config file not found: $CONFIG" >&2
  exit 2
fi
echo "lychee-offline: config ${configs[*]}"

# Anchor checks come from the ruleset's include_fragments (lychee's CLI
# default is off); the config is intentionally not overridden here.
args=(--offline --no-progress)
for c in "${configs[@]}"; do
  args+=(--config "$c")
done
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
