#!/usr/bin/env bash
# Download a pinned release asset, verify its SHA-256, and install one binary
# into a job-scoped directory. Shared by the checksum-pinned tool-install lanes.
#
# Platform contract: GitHub Actions Linux X64 runners with GNU userland.
# Required env: URL, SHA256, BIN, RUNNER_TEMP, GITHUB_PATH, RUNNER_OS,
# RUNNER_ARCH.
# Optional env: ARCHIVE_MEMBER, STRIP_COMPONENTS (default 0), VERSION_CMD
# (default --version).
set -euo pipefail

: "${URL:?install-release: URL is required}"
: "${SHA256:?install-release: SHA256 is required}"
: "${BIN:?install-release: BIN is required}"
: "${RUNNER_TEMP:?install-release: RUNNER_TEMP is required}"
: "${GITHUB_PATH:?install-release: GITHUB_PATH is required}"
: "${RUNNER_OS:?install-release: RUNNER_OS is required}"
: "${RUNNER_ARCH:?install-release: RUNNER_ARCH is required}"

if [[ "$RUNNER_OS" != Linux || "$RUNNER_ARCH" != X64 ]]; then
  echo "install-release: only GitHub Actions Linux X64 runners are supported" >&2
  exit 2
fi

member="${ARCHIVE_MEMBER:-}"
strip="${STRIP_COMPONENTS:-0}"
version_cmd="${VERSION_CMD:---version}"

if [[ ! "$SHA256" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "install-release: SHA256 must be exactly 64 hexadecimal characters" >&2
  exit 2
fi
case "$BIN" in
  . | .. | */* | *\\*)
    echo "install-release: BIN must be a filename, not a path" >&2
    exit 2
    ;;
esac
if [[ ! "$strip" =~ ^[0-9]+$ ]]; then
  echo "install-release: STRIP_COMPONENTS must be a non-negative integer" >&2
  exit 2
fi
if [[ -n "$member" ]]; then
  case "/$member/" in
    //* | */../*)
      echo "install-release: ARCHIVE_MEMBER must be a relative path without '..'" >&2
      exit 2
      ;;
  esac
fi

runtime_root="${RUNNER_TEMP%/}/ci-workflows"
bin_dir="$runtime_root/bin"
install -d -m 0755 -- "$bin_dir"

umask 077
work="$(mktemp -d "$runtime_root/install-${BIN}.XXXXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT
  rm -rf -- "$work" || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

asset="$work/asset"
curl -q --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 120 \
  --retry 2 --retry-max-time 300 \
  --output "$asset" -- "$URL"
printf '%s  %s\n' "$SHA256" "$asset" | sha256sum -c -

if [[ -z "$member" ]]; then
  src="$asset"
else
  extract_root="$work/extract"
  mkdir -- "$extract_root"
  tar -xzf "$asset" -C "$extract_root" \
    --strip-components="$strip" -- "$member"
  src_rel="$member"
  for ((i = 0; i < strip; i++)); do
    src_rel="${src_rel#*/}"
  done
  src="$extract_root/$src_rel"
  if [[ ! -f "$src" ]]; then
    echo "install-release: archive member did not produce a regular file" >&2
    exit 2
  fi
fi

destination="$bin_dir/$BIN"
install -m 0755 -- "$src" "$destination"
if [[ ":${PATH:-}:" != *":${bin_dir}:"* ]] &&
  { [[ ! -f "$GITHUB_PATH" ]] || ! grep -Fqx -- "$bin_dir" "$GITHUB_PATH"; }; then
  printf '%s\n' "$bin_dir" >>"$GITHUB_PATH"
fi

# Use the exact verified destination; a preinstalled PATH binary must not
# shadow the release that this step just installed.
"$destination" "$version_cmd"
