#!/usr/bin/env bash
# Installs the bubblewrap and socat that CLAUDE_CODE_SUBPROCESS_ENV_SCRUB needs
# on Linux and fails closed without them; with REMOVE_SUDO=true it then makes
# the docker socket root-only and drops the runner user's sudoers entry.
#
# Env: BUDGET_SECONDS (every apt-get and dpkg call and backoff shares it, so
# the install ends within it plus a 2 s kill grace), REMOVE_SUDO,
# RUNNER_HOSTING (runner.environment; the AppArmor sysctl is lifted only on
# github-hosted runners, which are discarded after the job).
set -uo pipefail

have() { command -v bwrap >/dev/null && command -v socat >/dev/null; }

if command -v apt-get >/dev/null && ! have; then
  # The image's own apt settings fail over from its Azure mirror to
  # archive.ubuntu.com in seconds, so no Acquire override is passed.
  deadline=$((SECONDS + ${BUDGET_SECONDS:-540}))
  # Seconds left in the budget, capped at $1.
  left() {
    local remaining=$((deadline - SECONDS))
    echo $((remaining < $1 ? remaining : $1))
  }
  apt_get() {
    local secs
    secs=$(left 180)
    [[ $secs -gt 0 ]] || return 1
    sudo timeout -k 2 "$secs" apt-get -o DPkg::Lock::Timeout=60 "$@"
  }
  apt_install() { apt_get install -y --no-install-recommends bubblewrap socat; }
  # A killed install can leave dpkg half-configured, which fails the next try.
  repair() {
    local secs
    secs=$(left 40)
    [[ $secs -gt 0 ]] || return 0
    sudo timeout -k 2 "$secs" dpkg --configure -a || true
  }
  # The image's lists need only the package files; an index refresh, the slow
  # part of a stalled mirror, runs only when the install from them fails.
  echo "$(date -u +%T) installing bubblewrap and socat from the image's package lists"
  apt_install || repair
  for i in 1 2 3; do
    have && break
    [[ $SECONDS -lt $deadline ]] || break
    echo "$(date -u +%T) refreshing the package lists, attempt $i"
    apt_get update -qq && apt_install && break
    repair
    if [[ $i -lt 3 ]] && ((deadline - SECONDS > i * 10)); then
      sleep $((i * 10))
    fi
  done
fi

# Ubuntu 24.04 restricts unprivileged user namespaces via AppArmor.
if [[ ${RUNNER_HOSTING:-} == github-hosted ]] &&
  [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
if ! have; then
  echo "::error::bubblewrap or socat is not installed; Claude Code cannot scrub its subprocess environment"
  exit 1
fi

[[ ${REMOVE_SUDO:-false} == true ]] || exit 0
sock=/var/run/docker.sock
if [[ -e $sock ]]; then
  sudo chmod 600 "$sock"
fi
sudo rm -f /etc/sudoers.d/runner
if sudo -n true 2>/dev/null; then
  echo "::error::sudo still works for the runner user"
  exit 1
fi
if [[ -e $sock ]] && { [[ -r $sock ]] || [[ -w $sock ]]; }; then
  echo "::error::the docker socket is still open to the runner user"
  exit 1
fi
