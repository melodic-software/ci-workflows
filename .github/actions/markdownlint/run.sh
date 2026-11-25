#!/usr/bin/env bash
# shellcheck shell=bash
# Inputs (environment): GLOBS, CONFIG, ANNOTATIONS, VERSION, MATCHER and
# STANDARDS_REF, as action.yml documents them.
set -euo pipefail
GLOBS="${GLOBS:?}"
CONFIG="${CONFIG:?}"
ANNOTATIONS="${ANNOTATIONS:-true}"
VERSION="${VERSION:?}"
MATCHER="${MATCHER:-}"

# On the default path, standards' canonical .markdownlint-cli2.jsonc is always
# the --config base, and markdownlint-cli2 reads the caller's own in-tree
# .markdownlint-cli2.jsonc, when present, over it natively: each rule the
# caller sets, and each top-level option such as `ignores`, replaces
# standards'; the rest of standards' still applies. A caller that names another
# path runs that file as the base instead of standards', and lacking it is
# misconfigured (exit 2).
if [[ $CONFIG == .markdownlint-cli2.jsonc ]]; then
  checkout="$(bash "$(dirname -- "${BASH_SOURCE[0]}")/../download-standards/checkout.sh")" || exit 2
  if [[ ! -f $checkout/.markdownlint-cli2.jsonc ]]; then
    echo "::error::melodic-software/standards at ${checkout##*/} has no .markdownlint-cli2.jsonc" >&2
    exit 2
  fi
  CONFIG="$checkout/.markdownlint-cli2.jsonc"
elif [[ ! -e $CONFIG && ! -L $CONFIG ]]; then
  echo "::error::config file not found: $CONFIG" >&2
  exit 2
fi
echo "markdownlint: config $CONFIG"

if [[ "$ANNOTATIONS" == "true" ]]; then echo "::add-matcher::$MATCHER"; fi
rc=0
# -d '' takes the whole value so a multi-line input still splits; read hits
# EOF without finding that delimiter, hence the `|| true`.
globs=()
read -r -d '' -a globs <<<"$GLOBS" || true
npx --yes "markdownlint-cli2@$VERSION" --config "$CONFIG" "${globs[@]}" || rc=$?
if [[ "$ANNOTATIONS" == "true" ]]; then echo "::remove-matcher owner=markdownlint-cli2::"; fi
exit $rc
