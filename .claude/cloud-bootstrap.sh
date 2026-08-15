#!/usr/bin/env bash
# Cloud bootstrap: install the plugin catalog this repo enables.
# Declaring a marketplace is gated on workspace trust and cloud sessions arrive
# untrusted, so the declaration alone can load nothing there.
# Two callers, both in cloud sessions only (hence the CLAUDE_CODE_REMOTE guard):
#   1. The account environment's setup script, after clone and before the
#      session process launches. Claude Code builds its plugin registry at
#      process start and never re-reads it, so this pre-launch call is the only
#      path that gets plugins loaded at turn one.
#   2. The SessionStart hook (startup|resume) in .claude/settings.json, as
#      drift repair against a stale environment cache; installs from this
#      caller go live at the next resume.
# Idempotent and best effort: a failed plugin costs its skills, not the session.
set -euo pipefail

[[ "${CLAUDE_CODE_REMOTE:-}" == "true" ]] || exit 0

repo_root="${CLAUDE_PROJECT_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
cd -- "$repo_root"

# --- Repo toolchain ---------------------------------------------------------
# Ahead of the plugin-CLI guards below on purpose: those `command -v` checks
# exit 0 when `claude` or `jq` is missing, and the toolchain must not be
# collateral damage of an unrelated CLI being absent. The cloud VM is a fresh
# Ubuntu image with no .NET at all, so a session here cannot build or analyze
# the .NET surface these actions target — the failure a live cloud
# verification run confirmed across the fleet.
#
# The subshell sets its own errexit posture and ends in an explicit `exit 0`
# rather than being wrapped in `|| true`: this file runs under `set -e`, and
# wrapping would put every call inside it in an `||` context.
(
  set +e

  toolchain_warn() { printf 'cloud-bootstrap: %s\n' "$*" >&2; }

  # env_line <export-line> — append to the session env file once. Dedup-guarded
  # because SessionStart fires again on resume.
  env_line() {
    [[ -n "${CLAUDE_ENV_FILE:-}" ]] || return 0
    grep -qxF "$1" "$CLAUDE_ENV_FILE" 2>/dev/null || printf '%s\n' "$1" >>"$CLAUDE_ENV_FILE"
  }

  # .NET SDK exactly as global.json pins, repo-local.
  if [[ -f global.json ]] && command -v jq >/dev/null 2>&1; then
    sdk="$(jq -r '.sdk.version // empty' global.json 2>/dev/null)"
    if [[ -n "$sdk" ]]; then
      # -F: the version is a literal, and its dots are not regex wildcards.
      if [[ ! -x .dotnet/dotnet ]] || ! .dotnet/dotnet --list-sdks 2>/dev/null | grep -qF "$sdk "; then
        installer=/tmp/dotnet-install.sh
        # The cloud egress proxy can return an error body with HTTP 200 from
        # dot.net, which `curl -f` cannot catch (-f only trips on >= 400), so a
        # real installer's shebang is checked before it is executed.
        # --proto/--proto-redir pin the redirect chain (dot.net -> aka.ms ->
        # builds.dotnet.microsoft.com) to HTTPS end to end.
        if curl -fsSL --proto '=https' --proto-redir '=https' \
          --retry 2 --retry-delay 3 https://dot.net/v1/dotnet-install.sh -o "$installer" 2>/dev/null &&
          [[ -s "$installer" ]] &&
          head -c 2 "$installer" 2>/dev/null | grep -q '^#!' &&
          bash "$installer" --version "$sdk" --install-dir .dotnet >/dev/null 2>&1; then
          :
        else
          toolchain_warn "dotnet $sdk install failed — check the environment's network allowlist (dot.net, aka.ms, builds.dotnet.microsoft.com, download.visualstudio.microsoft.com)"
        fi
        rm -f "$installer"
      fi
      if [[ -x .dotnet/dotnet ]]; then
        env_line "export DOTNET_ROOT=\"$PWD/.dotnet\""
        # shellcheck disable=SC2016
        env_line "export PATH=\"$PWD/.dotnet:\$PATH\""
      fi
    fi
  fi

  exit 0
)

command -v claude >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# The marketplace name is the join key: it is the suffix of every enabledPlugins
# entry this script installs. Its source is read from the same declaration the
# settings file already carries, so repointing the marketplace there propagates
# here rather than leaving this script on a stale repo.
marketplace="melodic-software"
# `|| true` keeps set -e from turning an unreadable settings file into a failed
# bootstrap: the assignment inherits the substitution's exit status.
source_repo=$(
  jq -r --arg n "$marketplace" \
    '.extraKnownMarketplaces[$n].source.repo // empty' \
    .claude/settings.json 2>/dev/null || true
)
source_repo="${source_repo:-melodic-software/claude-code-plugins}"

if ! claude plugin marketplace list --json 2>/dev/null |
  jq -e --arg n "$marketplace" 'any(.[]; .name == $n)' >/dev/null; then
  claude plugin marketplace add "$source_repo" --scope user >/dev/null || {
    echo "cloud-bootstrap: could not add the $marketplace marketplace" >&2
    exit 0
  }
fi

# Read loops rather than mapfile: mapfile is bash 4.0+, and a hand-run on a
# stock macOS bash is 3.2, where set -e would abort here before a single
# plugin was installed.
wanted=()
while IFS= read -r id; do
  [[ -n "$id" ]] || continue
  wanted+=("$id")
done < <(
  jq -r --arg n "$marketplace" \
    '.enabledPlugins // {} | to_entries[]
     | select(.value == true and (.key | endswith("@" + $n))) | .key' \
    .claude/settings.json 2>/dev/null
)

have=()
while IFS= read -r id; do
  [[ -n "$id" ]] || continue
  have+=("$id")
done < <(claude plugin list --json 2>/dev/null | jq -r '.[].id' 2>/dev/null)

installed=0
for id in "${wanted[@]-}"; do
  [[ -n "$id" ]] || continue
  if [[ " ${have[*]-} " == *" $id "* ]]; then continue; fi
  if claude plugin install "$id" --scope user -y >/dev/null 2>&1; then
    installed=$((installed + 1))
  else
    echo "cloud-bootstrap: install failed: $id" >&2
  fi
done
echo "cloud-bootstrap: ${#wanted[@]} enabled, $installed newly installed"
