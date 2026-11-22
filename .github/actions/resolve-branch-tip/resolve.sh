#!/usr/bin/env bash
# Reads TIP_BRANCH, TIP_REPOSITORY and TIP_TOKEN; writes sha and
# unambiguous-sha to GITHUB_OUTPUT. The token reaches git only through
# GIT_CONFIG_* variables, so it is never in an argument list or a file.
set -euo pipefail

branch="${TIP_BRANCH:-}" repository="${TIP_REPOSITORY:-}" token="${TIP_TOKEN:-}"
unset TIP_TOKEN
output="${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set}"

fail() {
  echo "::error::resolve-branch-tip: $*"
  exit 1
}

[[ $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "repository '$repository' is not owner/name"
if [[ -z $branch ]] || ! git check-ref-format "refs/heads/$branch"; then
  fail "branch '$branch' is not a valid branch name"
fi
[[ -n $token ]] || fail "the token input is empty"

header="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
echo "::add-mask::$header"
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $header"
unset token header

export TIP_HEAD="refs/heads/$branch" TIP_TAG="refs/tags/$branch"
url="https://github.com/$repository.git"
err="$(mktemp "${RUNNER_TEMP:-/tmp}/resolve-branch-tip.XXXXXX")"
trap 'rm -f "$err"' EXIT

attempt=0
while :; do
  status=0
  listing="$(timeout 60 git -C "${RUNNER_TEMP:-/tmp}" ls-remote "$url" "$TIP_HEAD" "$TIP_TAG" 2>"$err")" || status=$?
  sed 's/^/git: /' "$err" >&2
  if ((status == 0)); then
    # ls-remote matches a pattern as a ref's tail, so only an exact name counts.
    sha="$(awk '$2 == ENVIRON["TIP_HEAD"] { print $1 }' <<<"$listing")"
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || fail "$repository has no branch $branch"
    echo "sha=$sha" >>"$output"
    if ! awk '$2 == ENVIRON["TIP_TAG"] || $2 == ENVIRON["TIP_TAG"] "^{}" { found = 1 } END { exit !found }' <<<"$listing"; then
      echo "unambiguous-sha=$sha" >>"$output"
    fi
    echo "Resolved $TIP_HEAD of $repository to $sha."
    exit 0
  fi
  if ((status == 124)); then
    why="timed out after 60 s"
  elif grep -qE 'returned error: 40[13]|HTTP 40[13]' "$err"; then
    fail "GitHub refused the token for $repository (HTTP 401/403): the job's token needs contents: read"
  elif grep -qE 'returned error: 5[0-9]{2}|HTTP 5[0-9]{2}' "$err"; then
    why="got a server error"
  else
    fail "git ls-remote of $repository failed with exit $status"
  fi
  ((++attempt < 3)) || fail "the tip of $branch did not resolve: try 3 $why"
  echo "::warning::resolve-branch-tip: try $attempt $why; retrying"
  sleep "$((RANDOM % (2 * attempt + 1)))"
done
