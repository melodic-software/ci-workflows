# shellcheck shell=bash

# Resolve the one open tracking issue this workflow owns into issue-number
# (empty if none), given open_issues (gh api --slurp JSON), MARKER,
# ISSUE_TITLE, ISSUE_AUTHOR_LOGIN. More than one match is never
# auto-resolvable, so it fails closed.
#
# The marker and title strings are public in workflow source, so matching on
# them alone would let anyone able to open an issue in the repo craft a decoy
# this automation adopts — then overwrites or closes — or a duplicate decoy
# that trips the fail-closed ambiguity guard to suppress a real report.
# Candidates are first restricted to issues authored by this workflow's own
# token identity (ISSUE_AUTHOR_LOGIN, a Bot), so an issue it did not author is
# never a candidate whatever text it carries.
#
# All four inputs are required: an unset MARKER would match every issue body
# (an empty needle) and an unset ISSUE_AUTHOR_LOGIN would drop the author
# restriction, so assert them up front to keep the fail-closed posture set -u
# gave the pre-extraction inline blocks.
: "${MARKER:?MARKER is required}"
: "${ISSUE_TITLE:?ISSUE_TITLE is required}"
: "${ISSUE_AUTHOR_LOGIN:?ISSUE_AUTHOR_LOGIN is required}"
: "${open_issues:?open_issues is required}"
matches="$(jq -ce --arg marker "$MARKER" --arg author "$ISSUE_AUTHOR_LOGIN" '
  [.[][]
    | select(.pull_request? == null)
    | select(.user.login == $author and .user.type == "Bot")
    | select((.body // "") | contains($marker))
    | .number]
' <<<"$open_issues")"
count="$(jq -r 'length' <<<"$matches")"
if ((count > 1)); then
  echo "::error::found ${count} issues carrying marker '${MARKER}'; reconcile them manually."
  exit 1
fi
if ((count == 0)); then
  # One-time migration fallback: a still-open issue created by the pre-marker,
  # title-search version of this workflow has no marker yet, so the search above
  # can't find it. Adopt it by exact title match so the update step below reuses
  # (and marker-backfills) that issue instead of orphaning it behind a newly
  # opened duplicate.
  matches="$(jq -ce --arg title "$ISSUE_TITLE" --arg author "$ISSUE_AUTHOR_LOGIN" '
    [.[][]
      | select(.pull_request? == null)
      | select(.user.login == $author and .user.type == "Bot")
      | select(.title == $title)
      | .number]
  ' <<<"$open_issues")"
  count="$(jq -r 'length' <<<"$matches")"
  if ((count > 1)); then
    echo "::error::found ${count} pre-marker issues titled '${ISSUE_TITLE}'; reconcile them manually."
    exit 1
  fi
fi
jq -r 'if length == 1 then "issue-number=" + (.[0] | tostring) else "issue-number=" end' <<<"$matches" >>"${GITHUB_OUTPUT:?}"
