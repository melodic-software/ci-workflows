#!/usr/bin/env bash
# The criteria step of pr-review-cli and pr-review: the review criteria in effect, per the
# standards contract's "Review criteria: REVIEW.md" in claude-code-plugins
# (docs/contracts/standards/README.md). The composition is that repository's
# own org-standards.sh, run from a claude-code-plugins clone the calling job
# makes. Runs in the head checkout. Any miss writes no line, and the review reads the
# repository's REVIEW.md as before.
set -euo pipefail

# Inherited workflow and step environment variables.
: "${GITHUB_OUTPUT:=}"
: "${LANE_DIR:=}"
: "${SOURCE:=}"
: "${STANDARDS_DIR:=}"
: "${STANDARDS_SHA:=}"

ORG_REPOSITORY=melodic-software/standards

# The org layer is opt-in: the checkout's docs/conventions/source-control.yaml
# names the standards repository (download-standards/named.sh).
config=docs/conventions/source-control.yaml
named_sh="$(dirname -- "${BASH_SOURCE[0]}")/../download-standards/named.sh"
source_control=""
if [[ -f "$config" ]] && [[ ! -L "$config" ]]; then
  source_control=$(<"$config")
fi
named=$(bash "$named_sh" <<<"$source_control" 2>/dev/null) || {
  echo "No org layer: $config names ${named:-no standards_repository}, not $ORG_REPOSITORY; the review reads the repository's REVIEW.md alone."
  exit 0
}
if [[ -z "$STANDARDS_DIR" ]] || [[ ! -d "$STANDARDS_DIR" ]]; then
  echo "::warning::the $ORG_REPOSITORY checkout is missing; the review reads the repository's REVIEW.md alone"
  exit 0
fi
script="$SOURCE/plugins/review/scripts/org-standards.sh"
if [[ ! -f "$script" ]]; then
  echo "::warning::claude-code-plugins has no $script; the review reads the repository's REVIEW.md alone"
  exit 0
fi
if [[ -L REVIEW.md ]] || { [[ -e REVIEW.md ]] && [[ ! -f REVIEW.md ]]; }; then
  echo "::warning::the head's REVIEW.md is not a regular file; the review reads the repository's REVIEW.md alone"
  exit 0
fi

# Every write goes into a directory this step creates. The head may commit
# anything under LANE_DIR, symlinks included, so nothing is written to a path
# it could have placed: mktemp -d makes a new directory with an unpredictable
# name and fails rather than reuse one.
if [[ -L "$LANE_DIR" ]] || { [[ -e "$LANE_DIR" ]] && [[ ! -d "$LANE_DIR" ]]; }; then
  echo "::warning::$LANE_DIR is not a directory; the review reads the repository's REVIEW.md alone"
  exit 0
fi
mkdir -p "$LANE_DIR"
out=$(mktemp -d "$LANE_DIR/criteria.XXXXXXXX")
criteria="$out/review-criteria.md"
org="$out/org"

status=0
STANDARDS_DIR=$STANDARDS_DIR bash "$script" review --root "$PWD" >"$criteria" || status=$?
case $status in
  0) ;;
  3)
    rm -f "$criteria"
    echo "Neither $ORG_REPOSITORY nor the repository has a REVIEW.md."
    ;;
  *)
    rm -rf -- "$out"
    echo "::warning::org-standards.sh review exited $status; the review reads the repository's REVIEW.md alone"
    exit 0
    ;;
esac

# The org parts the criteria cite, as claude-code-plugins' pr-review-main
# lane copies them: the review has no shell to read the checkout itself.
mkdir "$org"
for part in REVIEW.md .claude/standards.yaml docs/standards standards; do
  if [[ -e "$STANDARDS_DIR/$part" ]]; then
    mkdir -p "$(dirname "$org/$part")"
    cp -R "$STANDARDS_DIR/$part" "$org/$part"
  fi
done

if [[ "$status" -eq 0 ]]; then
  echo "note=REVIEW CRITERIA: $criteria holds the review criteria in effect: the organization's REVIEW.md with this repository's appended, or this repository's alone. Read it in place of REVIEW.md." >>"$GITHUB_OUTPUT"
fi
echo "org-note=ORG STANDARDS: $org holds the organization's standards from $ORG_REPOSITORY@${STANDARDS_SHA:-main}." >>"$GITHUB_OUTPUT"
