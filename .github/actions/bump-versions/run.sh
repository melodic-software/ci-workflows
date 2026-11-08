#!/usr/bin/env bash
# Dispatches the composite's command to bump.py and reports how many bumps prepare left
# for publish. Runs from the caller's repository root.
set -euo pipefail

: "${BUMP_COMMAND:?}"
: "${BUMP_OUT:?}"
: "${GITHUB_OUTPUT:?}"
: "${GITHUB_ACTION_PATH:?}"

engine="$GITHUB_ACTION_PATH/bump.py"
case "$BUMP_COMMAND" in
  prepare)
    : "${BUMP_POLICY:?}"
    args=(--policy "$BUMP_POLICY" --out "$BUMP_OUT" --only "${BUMP_ONLY:-}")
    if [[ "${BUMP_DRY_RUN:-false}" == true ]]; then args+=(--dry-run); fi
    python -B "$engine" prepare "${args[@]}"
    count=$(jq '[.bumps[] | select(.outcome == "prepared" or .outcome == "stale-pr")] | length' \
      "$BUMP_OUT/results.json")
    echo "prepared-count=$count" >>"$GITHUB_OUTPUT"
    ;;
  publish)
    : "${BUMP_APP_SLUG:?publish needs app-slug}"
    python -B "$engine" publish --out "$BUMP_OUT" --app-slug "$BUMP_APP_SLUG"
    ;;
  summary)
    python -B "$engine" summary --out "$BUMP_OUT"
    ;;
  *)
    echo "::error::unknown command: $BUMP_COMMAND" >&2
    exit 2
    ;;
esac
