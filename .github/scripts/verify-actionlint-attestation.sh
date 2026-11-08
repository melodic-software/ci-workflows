#!/usr/bin/env bash
# Verify the pinned kjanat/actionlint release asset against its SHA-256 pin and
# its SLSA build attestation. Usage: verify-actionlint-attestation.sh [action.yml]
# Needs gh with GH_TOKEN set.
set -euo pipefail

action_yml="${1:-.github/actions/actionlint/action.yml}"

input_default() {
  awk -v key="  $1:" '
    $0 == key { in_input=1; next }
    in_input && /^  [^ ]/ { exit }
    in_input && /^    default: / { sub(/^    default: /, ""); print; exit }
  ' "$action_yml"
}

version="$(input_default version)"
sha256="$(input_default sha256)"
signer_workflow="$(input_default attestation-signer-workflow)"
source_digest="$(input_default attestation-source-digest)"
for name in version sha256 signer_workflow source_digest; do
  if [[ -z "${!name}" ]]; then
    echo "::error::No default for $name in $action_yml."
    exit 1
  fi
done

asset="$(mktemp -d)/actionlint_${version}_linux_amd64.tar.gz"
curl -q --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 120 \
  --retry 8 --retry-all-errors --retry-max-time 300 \
  --output "$asset" -- \
  "https://github.com/kjanat/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz"

if ! printf '%s  %s\n' "$sha256" "$asset" | sha256sum -c -; then
  echo "::error::The v$version asset does not match the pinned sha256."
  exit 1
fi

if ! gh attestation verify "$asset" \
  --repo kjanat/actionlint \
  --signer-workflow "$signer_workflow" \
  --source-digest "$source_digest" \
  --source-ref "refs/tags/v$version" \
  --deny-self-hosted-runners; then
  echo "::error::The v$version asset's build attestation does not match the pinned signer workflow, source digest and tag."
  exit 1
fi
echo "v$version: sha256 and build attestation verified (source $source_digest)."
