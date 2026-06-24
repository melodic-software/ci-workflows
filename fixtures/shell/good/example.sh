#!/usr/bin/env bash
# Conforming shell fixture: passes ShellCheck (against modules/shellcheck) and
# shfmt (reading this repo's .editorconfig). The shfmt and shellcheck dogfood
# lanes exercise the actions against this file.
set -euo pipefail

greet() {
  local name="${1:-world}"
  if [[ -z "$name" ]]; then
    echo "name must not be empty" >&2
    return 1
  fi
  printf 'hello, %s\n' "$name"
}

greet "$@"
