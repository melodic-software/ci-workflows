#!/usr/bin/env bash
set -euo pipefail

good=.github/actions/lefthook-validate/fixtures/good/lefthook.yml
bad=.github/actions/lefthook-validate/fixtures/bad/lefthook.yml

LEFTHOOK_CONFIG="$good" lefthook validate

output="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lefthook-validate-bad.txt"
if LEFTHOOK_CONFIG="$bad" lefthook validate >"$output" 2>&1; then
  echo "The invalid extended fragment unexpectedly passed Lefthook validation." >&2
  exit 1
fi
cat -- "$output"
grep -E 'validation failed for (main|secondary) config' "$output"
