#!/usr/bin/env bash
# Extract one GitHub-reported release-asset SHA-256 digest. Unavailable,
# malformed, duplicate, or unsupported digest metadata is advisory and
# produces no output.
set -euo pipefail

asset="${1:?release asset name is required}"
jq -er --arg asset "$asset" '
  (.assets? // []) as $assets
  | select($assets | type == "array")
  | [$assets[] | select(.name == $asset) | .digest]
  | select(length == 1)
  | .[0]
  | strings
  | select(test("^sha256:[0-9a-f]{64}$"))
  | sub("^sha256:"; "")
' 2>/dev/null || true
