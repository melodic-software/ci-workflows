# shellcheck shell=bash
# Sourced by resolve.sh, checkout.sh and the composites whose config falls
# back to the standards copy. Defines no variable outside a function.

standards_fail() {
  echo "::error::download-standards: $*" >&2
  exit 1
}

# standards_retry <what> <command...>: up to 3 tries of 60 s each, with
# full-jitter waits of 0-2 s and 0-4 s between them. standards is public, so
# no failure is an authorization answer worth stopping on early.
standards_retry() {
  local what="$1" attempt=0 status
  shift
  while :; do
    status=0
    timeout 60 "$@" || status=$?
    ((status == 0)) && return 0
    ((++attempt < 3)) || standards_fail "$what failed after 3 tries (exit $status)"
    echo "::warning::download-standards: $what failed on try $attempt (exit $status); retrying" >&2
    sleep "$((RANDOM % (2 * attempt + 1)))"
  done
}

# standards_config <given> <default> <source>: prints the config file a reader
# uses. <given> wins when the repository has it (a symlink counts, so the
# reader's own checks still see it). When it is absent and is the reader's
# default path, the standards copy at <source> in the checkout of
# STANDARDS_REF is used instead. A missing non-default path stays an error
# (exit 2): the caller named a file it does not have.
standards_config() {
  local given="$1" default="$2" source="$3" checkout
  if [[ -e $given || -L $given ]]; then
    printf '%s\n' "$given"
    return 0
  fi
  if [[ $given != "$default" ]]; then
    echo "::error::config file not found: $given" >&2
    return 2
  fi
  checkout="$(bash "${BASH_SOURCE[0]%/*}/checkout.sh")" || return 1
  if [[ ! -f $checkout/$source ]]; then
    echo "::error::the repository has no $given, and melodic-software/standards at ${checkout##*/} has no $source" >&2
    return 2
  fi
  echo "The repository has no $given; using $source from melodic-software/standards at ${checkout##*/}." >&2
  printf '%s\n' "$checkout/$source"
}
