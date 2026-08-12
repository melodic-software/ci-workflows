#!/usr/bin/env bash
# Behavioral tests for release-tag-drift.sh — the alarm that fires when this
# repository's version TAGS and published RELEASES stop agreeing.
#
# The subject is pure (two files in, a report and a verdict out), so every
# case below is exact and none touches the network. The fixtures are the real
# 2026-08-12 state: `v0.13.0` tagged at 036c390 with no Release, `v0.2.0` a
# bootstrap-era tag with no Release, and a newest pair that AGREES — which is
# the case that proves the newest-pair comparison alone would have gone quiet
# by the next morning while the orphan persisted.
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-tag-drift.sh"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

failed=0

# check <name> <expected-exit> <tags> <releases> [needle ...]
check() {
  local name="$1" want="$2" tags="$3" releases="$4"
  shift 4
  printf '%s\n' "$tags" >"$scratch/tags"
  printf '%s\n' "$releases" >"$scratch/releases"
  local out rc=0
  out="$(bash "$script" "$scratch/tags" "$scratch/releases")" || rc=$?
  if [[ "$rc" -ne "$want" ]]; then
    echo "FAIL ${name}: exit ${rc}, expected ${want}" >&2
    failed=1
    return
  fi
  local needle
  for needle in "$@"; do
    if [[ "$out" != *"$needle"* ]]; then
      echo "FAIL ${name}: report is missing '${needle}'" >&2
      echo "$out" >&2
      failed=1
      return
    fi
  done
  echo "ok: ${name}"
}

# check_absent <name> <tags> <releases> <needle>
check_absent() {
  local name="$1" tags="$2" releases="$3" needle="$4"
  printf '%s\n' "$tags" >"$scratch/tags"
  printf '%s\n' "$releases" >"$scratch/releases"
  local out rc=0
  out="$(bash "$script" "$scratch/tags" "$scratch/releases")" || rc=$?
  if [[ "$out" == *"$needle"* ]]; then
    echo "FAIL ${name}: report should not contain '${needle}'" >&2
    failed=1
    return
  fi
  echo "ok: ${name}"
}

# ------------------------------------------------------------------ in sync

check 'a repository whose tags and releases match is in sync' 0 \
  'v0.1.0
v0.2.0
v0.10.0' \
  'v0.2.0
v0.10.0
v0.1.0' \
  'in sync' 'v0.10.0'

# SemVer ordering, not lexical: v0.10.0 is newer than v0.9.1.
check 'the newest pair is compared by SemVer, not lexically' 0 \
  'v0.9.1
v0.10.0' \
  'v0.9.1
v0.10.0' \
  "newest of both is \`v0.10.0\`"

# ---------------------------------------------------- THE INCIDENT FIXTURE

# The real 2026-08-12 state. v0.13.0 was tagged and never released; v0.2.0
# pre-dates release.yml. The newest of each set is v0.14.0 either way, so the
# newest-pair comparison PASSES here — only set equality catches the orphan.
incident_tags='v0.1.0
v0.2.0
v0.12.0
v0.13.0
v0.14.0'
incident_releases='v0.1.0
v0.12.0
v0.14.0'

check 'the 2026-08-12 orphan-tag state is drift' 1 \
  "$incident_tags" "$incident_releases" \
  'Version tags with no published Release' "\`v0.13.0\`" "\`v0.2.0\`"

check_absent 'the 2026-08-12 state does NOT trip the newest-pair signal' \
  "$incident_tags" "$incident_releases" \
  'Newest tag and newest Release disagree'

# The transient half of the incident: for the ~12 hours between tagging
# v0.13.0 and releasing v0.14.0, the newest pair DID disagree.
check 'a tag ahead of the newest Release trips the newest-pair signal' 1 \
  'v0.12.0
v0.13.0' \
  'v0.12.0' \
  'Newest tag and newest Release disagree' "newest \`v*.*.*\` tag: \`v0.13.0\`" \
  "newest published Release: \`v0.12.0\`"

# --------------------------------------------------------- other divergences

check 'a Release whose tag was deleted is drift' 1 \
  'v0.1.0' \
  'v0.1.0
v0.2.0' \
  'Published Releases with no matching tag' "\`v0.2.0\`"

check 'a published Release outside full SemVer is drift' 1 \
  'v0.1.0' \
  'v0.1.0
v0.2' \
  'not full SemVer' "\`v0.2\`"

# A non-SemVer TAG is not a version this repository publishes and must not be
# reported: `release.yml` never computes over it and no consumer can pin it.
check 'a non-SemVer tag is ignored rather than reported' 0 \
  'v0.1.0
nightly
v1.2.3-rc1' \
  'v0.1.0' \
  'in sync'

# refs/tags/ prefixes (what the git-refs API returns) are accepted verbatim.
check 'refs/tags/ prefixes are normalized' 0 \
  'refs/tags/v0.1.0
refs/tags/v0.2.0' \
  'v0.1.0
v0.2.0' \
  'in sync'

# An empty repository has nothing to disagree about.
check 'no tags and no releases is in sync' 0 '' '' 'in sync' 'none'

# Every report carries the marker the rolling tracking issue is found by.
check 'the report always carries the tracking marker' 0 'v0.1.0' 'v0.1.0' \
  '<!-- ci-workflows:release-tag-drift-check:v1:active -->'

# ---------------------------------------------------------------- controls

# A usage error must be distinguishable from "no drift" AND from "drift", or a
# broken invocation in the workflow would read as a clean run forever.
rc=0
bash "$script" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 2 ]] || {
  echo "FAIL: no arguments should exit 2, got ${rc}" >&2
  failed=1
}
rc=0
bash "$script" "$scratch/tags" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 2 ]] || {
  echo "FAIL: one argument should exit 2, got ${rc}" >&2
  failed=1
}
rc=0
bash "$script" "$scratch/nonexistent" "$scratch/releases" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 2 ]] || {
  echo "FAIL: an unreadable file should exit 2, got ${rc}" >&2
  failed=1
}
echo 'ok: usage errors exit 2, never 0 or 1'

[[ "$failed" -eq 0 ]] || exit 1
echo 'ok: release/tag drift detection'
