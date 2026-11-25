#!/usr/bin/env bash
# shellcheck shell=bash
# Prints the path of the dependabot policy the check applies: standards'
# components/dependabot-policy/policy.json at the commit download-standards
# resolves for STANDARDS_REF, read only when ROOT's
# docs/conventions/source-control.yaml names that standards repository. A
# synced copy in the repository is never read. Every way to end with no
# policy exits 2, the config error the check documents.
set -euo pipefail

: "${ROOT:=.}"
standards="$(dirname -- "${BASH_SOURCE[0]}")/../download-standards"
config="$ROOT/docs/conventions/source-control.yaml"
source_control=""
if [[ -f $config && ! -L $config ]]; then
  source_control="$(<"$config")"
fi
# The command substitution keeps named.sh's stderr (its reason) and drops its stdout.
if ! reason="$(bash "$standards/named.sh" <<<"$source_control" 2>&1 >/dev/null)"; then
  echo "::error::$reason, so no dependabot policy is read" >&2
  exit 2
fi
checkout="$(bash "$standards/checkout.sh")" || exit 2
policy="$checkout/components/dependabot-policy/policy.json"
if [[ ! -f $policy ]]; then
  echo "::error::melodic-software/standards at ${checkout##*/} has no components/dependabot-policy/policy.json" >&2
  exit 2
fi
printf '%s\n' "$policy"
