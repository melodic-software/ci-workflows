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
