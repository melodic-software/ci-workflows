#!/usr/bin/env bash
# Cloud Agent environment bootstrap for ci-workflows.
#
# Installs the two runtime toolchains this repository pins at the repo level so
# the dogfood test/lint inner loop is runnable end to end:
#   * Node   — from .node-version, the runtime for the `node --test` suites and
#              the tsc/biome action contracts.
#   * .NET   — from global.json, the SDK the dotnet-build / dotnet-format
#              fixtures compile against.
#
# Go and Python already ship in the base image. The per-tool lint binaries
# (lefthook, shellcheck, shfmt, actionlint, biome, typos, gitleaks, lychee,
# ruff, pyright, pwsh) are intentionally NOT installed here: each composite
# action installs its own pinned, checksum-verified version at run time, so
# pre-seeding them in the environment would duplicate and drift from those
# action contracts.
#
# Idempotent by design: it is safe to run repeatedly and skips work already in
# place. It must terminate and never launch a long-running process.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$repo_root"

log() { printf 'install: %s\n' "$*"; }

# env_line <line> — append an export to a persisted profile once, so every
# future non-login and login shell inherits the toolchain on PATH.
profile="$HOME/.bashrc"
env_line() {
  [[ -f "$profile" ]] || : >"$profile"
  grep -qxF "$1" "$profile" 2>/dev/null || printf '%s\n' "$1" >>"$profile"
}

# --- Node, from .node-version via nvm --------------------------------------
if [[ -f .node-version ]]; then
  node_pin="$(tr -d '[:space:]' <.node-version)"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    log "nvm not found at $NVM_DIR; installing nvm"
    mkdir -p "$NVM_DIR"
    # Pinned nvm installer (v0.40.3), fetched over an https-only redirect chain.
    curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --retry-delay 3 \
      https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash
  fi

  set +u # nvm.sh reads intentionally-unset variables under `set -u`
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  if [[ "$(nvm version "$node_pin" 2>/dev/null)" != "v$node_pin" ]]; then
    log "installing Node $node_pin"
    nvm install "$node_pin"
  else
    log "Node $node_pin already installed"
  fi
  nvm alias default "$node_pin" >/dev/null
  set -u

  node_bin="$NVM_DIR/versions/node/v$node_pin/bin"
  if [[ -d "$node_bin" ]]; then
    # Prepend the pinned Node bin so `node`/`npm`/`npx` resolve to the pin in
    # every future shell regardless of what the base image put on PATH first.
    env_line "export NVM_DIR=\"$NVM_DIR\""
    env_line "export PATH=\"$node_bin:\$PATH\""
    log "active node: $("$node_bin/node" --version)"
  fi
fi

# --- .NET SDK, from global.json --------------------------------------------
if [[ -f global.json ]] && command -v jq >/dev/null 2>&1; then
  sdk="$(jq -r '.sdk.version // empty' global.json)"
  dotnet_root="$HOME/.dotnet"
  if [[ -n "$sdk" ]]; then
    if [[ -x "$dotnet_root/dotnet" ]] && "$dotnet_root/dotnet" --list-sdks 2>/dev/null | grep -qF "$sdk "; then
      log ".NET SDK $sdk already installed"
    else
      log "installing .NET SDK $sdk"
      installer="$(mktemp)"
      # dot.net can return an error body with HTTP 200 (which `curl -f` cannot
      # catch), so verify a real installer shebang before executing it. The
      # --proto flags pin the dot.net -> aka.ms -> builds.dotnet redirect chain
      # to https end to end.
      curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --retry-delay 3 \
        https://dot.net/v1/dotnet-install.sh -o "$installer"
      head -c2 "$installer" | grep -q '^#!'
      bash "$installer" --version "$sdk" --install-dir "$dotnet_root"
      rm -f "$installer"
    fi
    if [[ -x "$dotnet_root/dotnet" ]]; then
      export DOTNET_ROOT="$dotnet_root"
      env_line "export DOTNET_ROOT=\"$dotnet_root\""
      env_line "export PATH=\"$dotnet_root:\$PATH\""
      env_line "export DOTNET_CLI_TELEMETRY_OPTOUT=1"
      env_line "export DOTNET_NOLOGO=1"
      log "active dotnet: $("$dotnet_root/dotnet" --version)"
    fi
  fi
fi

# --- Git history ------------------------------------------------------------
# Several checks diff against origin/main; deepen a shallow clone and make the
# ref resolvable. Best effort — a fetch failure must not fail environment setup.
git_dir="$(git rev-parse --git-dir 2>/dev/null || true)"
if [[ -n "$git_dir" && -f "$git_dir/shallow" ]]; then
  git fetch --quiet --unshallow 2>/dev/null || log "could not unshallow (base-ref diffs may be limited)"
fi
git fetch --quiet origin "+main:refs/remotes/origin/main" 2>/dev/null || log "could not fetch origin/main"

log "environment ready"
