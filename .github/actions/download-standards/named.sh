#!/usr/bin/env bash
# shellcheck shell=bash
# Reads a repository's docs/conventions/source-control.yaml on stdin and prints
# the repository its standards_repository key names, empty when it names none.
# Exits 0 only when that is melodic-software/standards, the repository this
# action reads; otherwise it says why on stderr and exits 1, and the caller
# reads no standards file. The value is read as org-standards.sh reads it: the
# first top-level key, a trailing comment and one pair of quotes dropped,
# compared without case.
set -euo pipefail

readonly STANDARDS_REPOSITORY=melodic-software/standards

named=$(sed -n -e '/^standards_repository:/{s/^standards_repository:[[:space:]]*//' \
  -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e "s/^\"\(.*\)\"$/\1/" \
  -e "s/^'\(.*\)'$/\1/" -e 'p;q;}')
printf '%s\n' "$named"
if [[ ${named,,} != "$STANDARDS_REPOSITORY" ]]; then
  echo "docs/conventions/source-control.yaml names ${named:-no standards_repository}, not $STANDARDS_REPOSITORY" >&2
  exit 1
fi
