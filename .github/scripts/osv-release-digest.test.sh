#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/osv-release-digest.sh"
digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

extract() {
  printf '%s' "$1" | bash "$script" osv-scanner_linux_amd64
}

[[ "$(extract "{\"assets\":[{\"name\":\"osv-scanner_linux_amd64\",\"digest\":\"sha256:${digest}\"}]}")" == "$digest" ]]
[[ -z "$(extract '')" ]]
[[ -z "$(extract '{not json}')" ]]
[[ -z "$(extract '{"assets":null}')" ]]
[[ -z "$(extract '{"assets":[]}')" ]]
[[ -z "$(extract '{"assets":[{"name":"osv-scanner_linux_amd64","digest":null}]}')" ]]
[[ -z "$(extract '{"assets":[{"name":"osv-scanner_linux_amd64","digest":"sha256:ABC"}]}')" ]]
[[ -z "$(extract "{\"assets\":[{\"name\":\"osv-scanner_linux_amd64\",\"digest\":\"sha256:${digest}\"},{\"name\":\"osv-scanner_linux_amd64\",\"digest\":\"sha256:${digest}\"}]}")" ]]

echo 'ok: OSV release digest parsing fails soft on unavailable, malformed, duplicate, or unsupported metadata'
