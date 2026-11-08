#!/usr/bin/env bash
# A pin whose source digest is tampered must fail on the attestation, not on
# some unrelated network or auth error.
set -euo pipefail

here="$(dirname "$0")"
work="$(mktemp -d)"
tampered=0000000000000000000000000000000000000000
awk -v tampered="$tampered" '
  $0 == "  attestation-source-digest:" { in_input=1 }
  in_input && /^    default: / { $0 = "    default: " tampered; in_input=0 }
  { print }
' "$here/../actions/actionlint/action.yml" >"$work/action.yml"
if ! grep -qx "    default: $tampered" "$work/action.yml"; then
  echo '::error::Could not tamper the attestation-source-digest default.'
  exit 1
fi
if bash "$here/verify-actionlint-attestation.sh" "$work/action.yml" >"$work/out.txt" 2>&1; then
  cat "$work/out.txt"
  echo '::error::A tampered source digest unexpectedly passed attestation verification.'
  exit 1
fi
cat "$work/out.txt"
grep -F "expected SourceRepositoryDigest to be $tampered" "$work/out.txt"
