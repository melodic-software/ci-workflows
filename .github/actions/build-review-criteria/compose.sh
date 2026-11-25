#!/usr/bin/env bash
# The criteria step of pr-review-cli and pr-review: the review criteria in effect, per the
# standards contract's "Review criteria: REVIEW.md" in claude-code-plugins
# (docs/contracts/standards/README.md). The composition is that repository's
# own org-standards.sh, run from the clone the plugin step made, so this lane
# and the review skill reading its output come from the same commit. Runs in
# the head checkout. Any miss writes no line, and the review reads the
# repository's REVIEW.md as before.
set -euo pipefail

# Inherited workflow and step environment variables.
: "${CRITERIA_FILE:=}"
: "${GITHUB_OUTPUT:=}"
: "${ORG_COPY:=}"
: "${SOURCE:=}"
: "${STANDARDS_DIR:=}"
: "${STANDARDS_SHA:=}"

ORG_REPOSITORY=melodic-software/standards

# The org layer is opt-in: the checkout's docs/conventions/source-control.yaml
# names the standards repository, read as org-standards.sh reads it.
config=docs/conventions/source-control.yaml
named=""
if [[ -f "$config" ]] && [[ ! -L "$config" ]]; then
  named=$(sed -n 's/^standards_repository:[[:space:]]*//p' "$config" | head -n 1 |
    sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e "s/^\"\(.*\)\"$/\1/" -e "s/^'\(.*\)'$/\1/")
fi
if [[ "${named,,}" != "$ORG_REPOSITORY" ]]; then
  echo "No org layer: $config names ${named:-no standards_repository}, not $ORG_REPOSITORY; the review reads the repository's REVIEW.md alone."
  exit 0
fi
if [[ -z "$STANDARDS_DIR" ]] || [[ ! -d "$STANDARDS_DIR" ]]; then
  echo "::warning::the $ORG_REPOSITORY checkout is missing; the review reads the repository's REVIEW.md alone"
  exit 0
fi
script="$SOURCE/plugins/review/scripts/org-standards.sh"
if [[ ! -f "$script" ]]; then
  echo "::warning::claude-code-plugins has no $script; the review reads the repository's REVIEW.md alone"
  exit 0
fi
if [[ -L .claude-lane ]] || [[ -L REVIEW.md ]] || { [[ -e REVIEW.md ]] && [[ ! -f REVIEW.md ]]; }; then
  echo "::warning::the head's REVIEW.md or .claude-lane is not a regular path; the review reads the repository's REVIEW.md alone"
  exit 0
fi

mkdir -p "$(dirname "$CRITERIA_FILE")"
status=0
STANDARDS_DIR=$STANDARDS_DIR bash "$script" review --root "$PWD" >"$CRITERIA_FILE.tmp" || status=$?
case $status in
  0) mv "$CRITERIA_FILE.tmp" "$CRITERIA_FILE" ;;
  3)
    rm -f "$CRITERIA_FILE.tmp"
    echo "Neither $ORG_REPOSITORY nor the repository has a REVIEW.md."
    ;;
  *)
    rm -f "$CRITERIA_FILE.tmp"
    echo "::warning::org-standards.sh review exited $status; the review reads the repository's REVIEW.md alone"
    exit 0
    ;;
esac

# The org parts the criteria cite, as claude-code-plugins' pr-review-main
# lane copies them: the review has no shell to read the checkout itself.
mkdir -p "$ORG_COPY"
for part in REVIEW.md .claude/standards.yaml docs/standards standards; do
  if [[ -e "$STANDARDS_DIR/$part" ]]; then
    mkdir -p "$(dirname "$ORG_COPY/$part")"
    cp -R "$STANDARDS_DIR/$part" "$ORG_COPY/$part"
  fi
done

if [[ "$status" -eq 0 ]]; then
  echo "note=REVIEW CRITERIA: $CRITERIA_FILE holds the review criteria in effect: the organization's REVIEW.md with this repository's appended, or this repository's alone. Read it in place of REVIEW.md." >>"$GITHUB_OUTPUT"
fi
echo "org-note=ORG STANDARDS: $ORG_COPY holds the organization's standards from $ORG_REPOSITORY@${STANDARDS_SHA:-main}." >>"$GITHUB_OUTPUT"
