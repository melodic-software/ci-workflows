#!/usr/bin/env bash
# Advisory soak of the kjanat/actionlint fork beside the pinned rhysd release
# (#788 phase 1). Installs both binaries into $RUNNER_TEMP/ci-workflows/bin; a
# later step without a token runs actionlint-kjanat-soak.cjs on them. The fork's
# archive is downloaded, checksum-verified and has its SLSA provenance verified
# against the recorded release commit before anything extracts or runs it; the
# shared installer then takes its cache-hit path, re-checks the checksum and
# installs it.
#
# Required env: KJANAT_VERSION (names the release asset only; the trust anchors
# are KJANAT_SHA256 and KJANAT_COMMIT), KJANAT_COMMIT, KJANAT_SHA256, a gh token
# (GH_TOKEN in CI), and the runner variables install-release.sh requires:
# RUNNER_TEMP, GITHUB_PATH, RUNNER_OS, RUNNER_ARCH.
set -euo pipefail

: "${KJANAT_VERSION:?actionlint-kjanat-soak: KJANAT_VERSION is required}"
: "${KJANAT_COMMIT:?actionlint-kjanat-soak: KJANAT_COMMIT is required}"
: "${KJANAT_SHA256:?actionlint-kjanat-soak: KJANAT_SHA256 is required}"
: "${RUNNER_TEMP:?actionlint-kjanat-soak: RUNNER_TEMP is required}"
if [[ ! "$KJANAT_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "actionlint-kjanat-soak: KJANAT_COMMIT must be a full 40-character commit SHA" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
cd -- "$root"
installer=.github/actions/_shared/install-release.sh
cache="${RUNNER_TEMP%/}/actionlint-kjanat-soak"

# The baseline reads the gating lane's pin, so the two cannot drift.
input_default() {
  awk -v key="  $1:" '
    $0 == key { in_input=1; next }
    in_input && /^  [^ ]/ { exit }
    in_input && /^    default: / { sub(/^    default: /, ""); print; exit }
  ' .github/actions/actionlint/action.yml
}
rhysd_version="$(input_default version)"
rhysd_sha256="$(input_default sha256)"

echo "Installing the rhysd/actionlint ${rhysd_version} baseline"
URL="https://github.com/rhysd/actionlint/releases/download/v${rhysd_version}/actionlint_${rhysd_version}_linux_amd64.tar.gz" \
  SHA256="$rhysd_sha256" BIN=actionlint ARCHIVE_MEMBER=actionlint \
  ASSET_CACHE_DIR="$cache/rhysd" bash "$installer"

kjanat_url="https://github.com/kjanat/actionlint/releases/download/v${KJANAT_VERSION}/actionlint_${KJANAT_VERSION}_linux_amd64.tar.gz"
kjanat_asset="$cache/kjanat/asset"

echo "Downloading kjanat/actionlint ${KJANAT_VERSION} (commit ${KJANAT_COMMIT})"
install -d -m 0755 -- "$cache/kjanat"
curl -q --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 120 \
  --retry 8 --retry-all-errors --retry-max-time 300 \
  --output "$kjanat_asset" -- "$kjanat_url"
printf '%s  %s\n' "$KJANAT_SHA256" "$kjanat_asset" | sha256sum -c -

echo "Verifying the SLSA provenance of the kjanat archive"
gh attestation verify "$kjanat_asset" \
  --repo kjanat/actionlint \
  --signer-workflow kjanat/actionlint/.github/workflows/release.yml \
  --source-ref "refs/tags/v${KJANAT_VERSION}" \
  --source-digest "$KJANAT_COMMIT" \
  --deny-self-hosted-runners \
  --format json \
  --jq '.[].verificationResult.signature.certificate | {sourceRepositoryURI, sourceRepositoryRef, sourceRepositoryDigest, buildSignerURI, runnerEnvironment}'
echo "Attestation verified: the archive was built from kjanat/actionlint@${KJANAT_COMMIT}"

echo "Installing the verified kjanat archive"
URL="$kjanat_url" SHA256="$KJANAT_SHA256" BIN=actionlint-kjanat ARCHIVE_MEMBER=actionlint \
  ASSET_CACHE_DIR="$cache/kjanat" bash "$installer"
