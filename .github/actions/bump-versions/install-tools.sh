#!/usr/bin/env bash
# Installs the pinned yq, and on request osslsigncode, into a job-scoped directory. Linux X64
# only. osslsigncode publishes no Linux binary, so the Ubuntu 24.04 package is unpacked rather
# than installed: the job needs no root and the hash below still pins the exact file.
set -euo pipefail

: "${RUNNER_TEMP:?}"
: "${GITHUB_PATH:?}"
if [[ "${RUNNER_OS:-}" != Linux || "${RUNNER_ARCH:-}" != X64 ]]; then
  echo '::error::The version-bump tools need a Linux X64 runner.' >&2
  exit 2
fi

yq_version=v4.53.6
yq_sha256=c5f056448f973ae7d39b5401949648a78f2dc1947d6a8eb65be60d5c504b9385
osslsigncode_deb=osslsigncode_2.8-2_amd64.deb
osslsigncode_sha256=1aee7be603102633e80b4c67cd939bba2e16a62813e4a3035696727783f632b0

bin_dir=$(mktemp -d "${RUNNER_TEMP%/}/version-bump-tools.XXXXXXXX")

fetch() {
  curl --fail --location --proto '=https' --silent --show-error \
    --connect-timeout 10 --max-time 120 \
    --retry 8 --retry-all-errors --retry-max-time 300 \
    --output "$2" -- "$1"
}

fetch "https://github.com/mikefarah/yq/releases/download/${yq_version}/yq_linux_amd64" "$bin_dir/yq"
printf '%s  %s\n' "$yq_sha256" "$bin_dir/yq" | sha256sum --check --strict -
chmod 0755 "$bin_dir/yq"

if [[ "${INSTALL_OSSLSIGNCODE:-false}" == true ]]; then
  deb="$bin_dir/$osslsigncode_deb"
  fetch "https://archive.ubuntu.com/ubuntu/pool/universe/o/osslsigncode/$osslsigncode_deb" "$deb"
  printf '%s  %s\n' "$osslsigncode_sha256" "$deb" | sha256sum --check --strict -
  dpkg-deb -x "$deb" "$bin_dir/deb"
  install -m 0755 "$bin_dir/deb/usr/bin/osslsigncode" "$bin_dir/osslsigncode"
  rm -rf -- "${bin_dir:?}/deb" "$deb"
  "$bin_dir/osslsigncode" --version
fi

printf '%s\n' "$bin_dir" >>"$GITHUB_PATH"
