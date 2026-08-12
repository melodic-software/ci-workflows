#!/usr/bin/env bash
# shellcheck shell=bash
# Compare this repository's version TAGS against its published RELEASES and
# report every way the two disagree.
#
# Why this exists: melodic-software/ci-workflows publishes its version through
# two artefacts that nothing kept in agreement.
#
#   - `release.yml` used to compute the next version from the newest TAG.
#   - `standards/components/claude-lanes/repin-callers.sh resolve` reads the
#     newest RELEASE.
#
# So a tag with no Release still advanced the version counter while being
# invisible to the fleet's re-pin lane. That is exactly what happened to
# `v0.13.0` (tagged at 036c390, never released): the next `minor` bump produced
# `v0.14.0`, the fleet never saw `v0.13.0`, and nothing alarmed. `release.yml`
# now computes from the newest RELEASE — Releases are the single source of
# truth — and this script is the alarm that says so out loud when the two
# artefacts stop agreeing.
#
# Pure by construction: it reads two newline-separated lists from files and
# touches no network, so release-tag-drift.test.sh can drive every verdict.
#
#   usage: release-tag-drift.sh <tag-list-file> <release-list-file>
#
# Writes a Markdown report to stdout in every case (the workflow files it as a
# rolling tracking issue body). Exit codes are the verdict:
#
#   0  the two artefacts agree
#   1  they disagree — the report names every divergence
#   2  usage or malformed input
#
# `1` is deliberately distinct from `2` so a broken invocation can never read
# as "no drift".
set -euo pipefail

readonly MARKER='<!-- ci-workflows:release-tag-drift-check:v1:active -->'
readonly SEMVER_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

usage() {
  cat >&2 <<'USAGE'
usage: release-tag-drift.sh <tag-list-file> <release-list-file>

Both files hold one tag name per line (e.g. v0.14.0). Reports to stdout;
exits 0 in sync, 1 on drift, 2 on a usage error.
USAGE
}

[[ $# -eq 2 ]] || {
  usage
  exit 2
}

tag_file="$1"
release_file="$2"

for file in "$tag_file" "$release_file"; do
  [[ -r "$file" ]] || {
    echo "release-tag-drift.sh: cannot read '${file}'" >&2
    exit 2
  }
done

# `sed` strips the `refs/tags/` prefix so the caller may pass either the raw
# ref names the git-refs API returns or bare tag names.
normalize() {
  sed -e 's|^refs/tags/||' -e 's|[[:space:]]*$||' "$1" | grep -v '^$' | sort -u || true
}

tags="$(normalize "$tag_file")"
releases="$(normalize "$release_file")"

# Only full-SemVer names participate in the set comparison: `release.yml`
# computes over `v*.*.*` and the pin-comment convention accepts nothing else
# (components/pin-comment-convention/README.md in melodic-software/standards),
# so a differently shaped tag is not a version this repository publishes.
semver_only() { grep -E "$SEMVER_RE" <<<"${1:-}" || true; }

semver_tags="$(semver_only "$tags")"
semver_releases="$(semver_only "$releases")"

# A published Release whose tag is NOT full SemVer is drift on its own: the
# re-pin lane hard-fails on it rather than re-pinning the fleet.
odd_releases="$(grep -Ev "$SEMVER_RE" <<<"${releases:-}" | grep -v '^$' || true)"

tags_without_release="$(comm -23 <(printf '%s\n' "$semver_tags" | grep -v '^$' || true) \
  <(printf '%s\n' "$semver_releases" | grep -v '^$' || true))"
releases_without_tag="$(comm -13 <(printf '%s\n' "$semver_tags" | grep -v '^$' || true) \
  <(printf '%s\n' "$semver_releases" | grep -v '^$' || true))"

newest() { printf '%s\n' "${1:-}" | grep -v '^$' | sort -V | tail -n1 || true; }

newest_tag="$(newest "$semver_tags")"
newest_release="$(newest "$semver_releases")"

# `if` rather than `[[ ... ]] && drift=1`: under `set -e` a trailing test that
# happens to be false is itself a failing command and would abort the report.
drift=0
if [[ -n "$tags_without_release" ]]; then drift=1; fi
if [[ -n "$releases_without_tag" ]]; then drift=1; fi
if [[ -n "$odd_releases" ]]; then drift=1; fi
if [[ "$newest_tag" != "$newest_release" ]]; then drift=1; fi

# Every prose block below is a QUOTED heredoc (`<<'MD'`), never a single-quoted
# `echo`: the report is Markdown full of backticks, and ShellCheck reads a
# backtick inside a single-quoted string as an unexpanded command substitution
# (SC2016). A quoted heredoc says "literal" to both the shell and the linter.
bullets() {
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    # `\`` inside a double-quoted format string is a literal backtick.
    printf -- "- \`%s\`\n" "$line"
  done <<<"${1:-}"
}

printf '%s\n\n' "$MARKER"

if [[ "$drift" -eq 0 ]]; then
  cat <<'MD'
## Release/tag agreement: in sync

MD
  printf "Every \`v*.*.*\` tag has a published Release and vice versa; newest of both is \`%s\`.\n" \
    "${newest_tag:-none}"
  exit 0
fi

cat <<'MD'
## Release/tag divergence

This repository publishes its version through two artefacts, and they no
longer agree. `release.yml` computes the next version from the newest
published **Release** (the single source of truth); the Claude-lane re-pin
in `melodic-software/standards` also reads Releases. A version tag with no
Release is therefore invisible to the whole fleet while still occupying a
version number — the shape of the 2026-08-12 `v0.13.0` incident.

MD

if [[ "$newest_tag" != "$newest_release" ]]; then
  cat <<'MD'
### Newest tag and newest Release disagree

MD
  printf -- "- newest \`v*.*.*\` tag: \`%s\`\n" "${newest_tag:-none}"
  printf -- "- newest published Release: \`%s\`\n\n" "${newest_release:-none}"
  cat <<'MD'
> [!WARNING]
> This is the loud signal, and it is TRANSIENT — the next release cutting
> a higher version silences it while the orphan below persists. The set
> comparison is the durable invariant.

MD
fi

if [[ -n "$tags_without_release" ]]; then
  cat <<'MD'
### Version tags with no published Release

MD
  bullets "$tags_without_release"
  cat <<'MD'

Each of these occupies a version number the fleet can never reach. Resolve
every one by either publishing the missing Release or deleting the tag —
both are operator decisions on a published ref, so neither is automated here.

MD
fi

if [[ -n "$releases_without_tag" ]]; then
  cat <<'MD'
### Published Releases with no matching tag

MD
  bullets "$releases_without_tag"
  cat <<'MD'

A Release whose tag was deleted leaves every consumer pin dangling.

MD
fi

if [[ -n "$odd_releases" ]]; then
  cat <<'MD'
### Published Releases whose tag is not full SemVer

MD
  bullets "$odd_releases"
  cat <<'MD'

The re-pin lane hard-fails on these rather than re-pinning the fleet: the
pin-comment convention has no form for a partial version.

MD
fi

cat <<'MD'
---
*Updated automatically by `.github/workflows/release-tag-drift-check.yml`.*
*Closing this issue without reconciling the two artefacts reopens it on the next run.*
MD
exit 1
