#!/usr/bin/env bash
# shellcheck shell=bash
# Inputs (environment): GLOBS, CONFIG, ANNOTATIONS, VERSION, MATCHER and
# STANDARDS_REF, as action.yml documents them.
set -euo pipefail
GLOBS="${GLOBS:?}"
CONFIG="${CONFIG:?}"
ANNOTATIONS="${ANNOTATIONS:-true}"
VERSION="${VERSION:?}"
MATCHER="${MATCHER:-}"

# The caller's own config wins while present. Only the default path falls
# back to standards' copy; a caller that names another path and lacks it is
# misconfigured (exit 2).
# shellcheck source=../download-standards/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/../download-standards/lib.sh"
CONFIG="$(standards_config "$CONFIG" .markdownlint-cli2.jsonc .markdownlint-cli2.jsonc)"
echo "markdownlint: config $CONFIG"

if [[ "$ANNOTATIONS" == "true" ]]; then echo "::add-matcher::$MATCHER"; fi
rc=0
# -d '' takes the whole value so a multi-line input still splits; read hits
# EOF without finding that delimiter, hence the `|| true`.
globs=()
read -r -d '' -a globs <<<"$GLOBS" || true
npx --yes "markdownlint-cli2@$VERSION" --config "$CONFIG" "${globs[@]}" || rc=$?
if [[ "$ANNOTATIONS" == "true" ]]; then echo "::remove-matcher owner=markdownlint-cli2::"; fi
exit $rc
