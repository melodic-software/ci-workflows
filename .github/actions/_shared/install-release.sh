#!/usr/bin/env bash
# Download a pinned release asset, verify its SHA-256, and install a single
# binary from it to /usr/local/bin. Shared by the checksum-pinned tool-install
# lanes so the download → verify → install → version-print sequence is
# maintained in one place instead of copied per action. A consumer pins a lane
# action by SHA, which checks out this whole repo at that SHA, so this sibling
# script is always present alongside the lane that sources it.
#
# Driven entirely by env (keeps the call site a plain `env:` block, like the
# lane steps it replaces):
#   URL              Release asset URL (required).
#   SHA256           Expected SHA-256 of the downloaded asset (required).
#   BIN              Install the binary as /usr/local/bin/$BIN (required).
#   ARCHIVE_MEMBER   Path of the binary inside a .tar.gz to extract and install.
#                    Empty (unset) means URL is the raw binary itself, no tar.
#   STRIP_COMPONENTS Leading path components tar strips from ARCHIVE_MEMBER
#                    (passed to --strip-components); default 0.
#   VERSION_CMD      Subcommand/flag that prints the version for the install log
#                    (default --version; e.g. gitleaks wants the verb `version`).
set -euo pipefail

: "${URL:?install-release: URL is required}"
: "${SHA256:?install-release: SHA256 is required}"
: "${BIN:?install-release: BIN is required}"
member="${ARCHIVE_MEMBER:-}"
strip="${STRIP_COMPONENTS:-0}"
version_cmd="${VERSION_CMD:---version}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

if [[ -z "$member" ]]; then
  # Raw binary download: the asset IS the executable, no archive to unpack.
  curl -fsSL "$URL" -o "$BIN"
  echo "${SHA256}  ${BIN}" | sha256sum -c -
  src="$BIN"
else
  curl -fsSL "$URL" -o asset.tar.gz
  echo "${SHA256}  asset.tar.gz" | sha256sum -c -
  tar -xzf asset.tar.gz --strip-components="$strip" "$member"
  # tar drops $strip leading components, so the on-disk path is ARCHIVE_MEMBER
  # with that many leading components removed.
  src="$member"
  for ((i = 0; i < strip; i++)); do src="${src#*/}"; done
fi

sudo install "$src" "/usr/local/bin/${BIN}"
"$BIN" "$version_cmd"
