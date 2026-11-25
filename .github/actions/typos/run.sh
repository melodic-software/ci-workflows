#!/usr/bin/env bash
# shellcheck shell=bash
# Inputs (environment): PATHS, CONFIG, EXCLUDE, HIDDEN, FORMAT, REPORT_PATH,
# ANNOTATIONS and STANDARDS_REF, as action.yml documents them.
set -euo pipefail
PATHS="${PATHS:-.}"
CONFIG="${CONFIG:?}"
EXCLUDE="${EXCLUDE:-}"
HIDDEN="${HIDDEN:-false}"
FORMAT="${FORMAT:-}"
REPORT_PATH="${REPORT_PATH:-}"
ANNOTATIONS="${ANNOTATIONS:-true}"

# On the default path, standards' canonical _typos.toml is always the
# --config, and typos discovers the caller's own root _typos.toml, when present,
# and merges it in natively: its words, identifiers, ignore patterns and
# excludes add to standards', and on a key both set, the --config file
# (standards) wins. A caller that names another path runs that file as the
# --config instead of standards', and lacking it is misconfigured (exit 2).
if [[ $CONFIG == _typos.toml ]]; then
  checkout="$(bash "$(dirname -- "${BASH_SOURCE[0]}")/../download-standards/checkout.sh")" || exit 2
  if [[ ! -f $checkout/_typos.toml ]]; then
    echo "::error::melodic-software/standards at ${checkout##*/} has no _typos.toml" >&2
    exit 2
  fi
  CONFIG="$checkout/_typos.toml"
elif [[ ! -e $CONFIG && ! -L $CONFIG ]]; then
  echo "::error::config file not found: $CONFIG" >&2
  exit 2
fi
echo "typos: config $CONFIG"

args=(--config "$CONFIG")
# set -f stops bash from pathname-expanding a gitignore-glob
# (e.g. fixtures/**) before typos sees it.
set -f
for e in $EXCLUDE; do args+=(--exclude "$e"); done
set +f
# In args, so both passes walk the same files. --hidden also descends
# .git/, which is not prose to spell-check.
if [[ "$HIDDEN" == "true" ]]; then args+=(--hidden --exclude '.git/'); fi
# -d '' takes the whole value so a multi-line input still splits; read hits
# EOF without finding that delimiter, hence the `|| true`.
paths=()
read -r -d '' -a paths <<<"$PATHS" || true
# Advisory annotation pass: `|| true` so the gate pass below owns
# pass/fail; col is the 1-based byte offset.
if [[ "$ANNOTATIONS" == "true" ]]; then
  typos "${args[@]}" --format json "${paths[@]}" 2>/dev/null |
    jq -r 'select(.type == "typo")
        | "::warning file=\(.path),line=\(.line_num),col=\(.byte_offset + 1)::\"\(.typo)\" should be \"\(.corrections | join("\", \""))\"."' ||
    true
fi
# Gate pass: respects the caller's format (default long); its exit fails.
if [[ -n "${FORMAT// /}" ]]; then args+=(--format "$FORMAT"); fi
if [[ -n "${REPORT_PATH// /}" ]]; then
  typos "${args[@]}" "${paths[@]}" >"$REPORT_PATH"
else
  typos "${args[@]}" "${paths[@]}"
fi
