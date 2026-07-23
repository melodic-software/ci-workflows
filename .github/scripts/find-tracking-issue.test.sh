# shellcheck shell=bash
set -euo pipefail

core="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/find-tracking-issue.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
github_output="$temporary_directory/output"

MARKER='<!-- marker:v1 -->'
TITLE='[Alert] Tracked'
OTHER='<!-- marker:other -->'
# The bot identity every consumer authors its rolling issue as; the core only
# ever adopts an issue this login (a Bot) created.
AUTHOR='github-actions[bot]'

# gh api --paginate --slurp yields an array of pages; each page is an array of
# issues. The core flattens with `.[][]`, so fixtures wrap issues in one page.
page() { jq -cn --argjson issues "[$1]" '[$issues]'; }
issue() { # number body title [is_pr] [login] [type]
  jq -cn --argjson n "$1" --arg b "$2" --arg t "$3" --argjson pr "${4:-false}" \
    --arg login "${5:-$AUTHOR}" --arg type "${6:-Bot}" \
    'if $pr then {number:$n, body:$b, title:$t, user:{login:$login,type:$type}, pull_request:{}}
     else {number:$n, body:$b, title:$t, user:{login:$login,type:$type}} end'
}

run() { # open_issues_json -> sets status, out, number
  set +e
  out="$(open_issues="$1" MARKER="$MARKER" ISSUE_TITLE="$TITLE" ISSUE_AUTHOR_LOGIN="$AUTHOR" GITHUB_OUTPUT="$github_output" \
    bash "$core" 2>&1)"
  status=$?
  set -e
  number="$(sed -n 's/^issue-number=//p' "$github_output" 2>/dev/null || true)"
  rm -f -- "$github_output"
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# 1. Exactly one marker match resolves to that issue number.
run "$(page "$(issue 42 "prefix $MARKER suffix" 'Anything')")"
[[ "$status" == 0 ]] || fail "marker match: expected exit 0, got $status ($out)"
[[ "$number" == 42 ]] || fail "marker match: expected 42, got '$number'"

# 2. No marker, but exact-title fallback resolves to that issue number.
run "$(page "$(issue 7 'no marker here' "$TITLE")")"
[[ "$status" == 0 ]] || fail "title fallback: expected exit 0, got $status ($out)"
[[ "$number" == 7 ]] || fail "title fallback: expected 7, got '$number'"

# 3. No marker and no title match yields an empty issue-number.
run "$(page "$(issue 5 'unrelated' 'Unrelated title')")"
[[ "$status" == 0 ]] || fail "no match: expected exit 0, got $status ($out)"
[[ -z "$number" ]] || fail "no match: expected empty, got '$number'"

# 4. A pull request carrying the marker is never adopted (empty result).
run "$(page "$(issue 9 "$MARKER" 'PR' true)")"
[[ "$status" == 0 ]] || fail "pr excluded: expected exit 0, got $status ($out)"
[[ -z "$number" ]] || fail "pr excluded: expected empty, got '$number'"

# 5. A marker match wins even when a different issue matches the title fallback.
run "$(page "$(issue 3 "$MARKER" 'x'),$(issue 4 'y' "$TITLE")")"
[[ "$status" == 0 ]] || fail "marker precedence: expected exit 0, got $status ($out)"
[[ "$number" == 3 ]] || fail "marker precedence: expected 3, got '$number'"

# 6. Two marker matches fail closed for manual reconciliation.
run "$(page "$(issue 1 "$MARKER" 'a'),$(issue 2 "$MARKER" 'b')")"
[[ "$status" == 1 ]] || fail "duplicate marker: expected exit 1, got $status"
grep -F 'reconcile them manually' <<<"$out" >/dev/null || fail "duplicate marker: missing error"

# 7. Two title-fallback matches (no marker) fail closed.
run "$(page "$(issue 1 'no' "$TITLE"),$(issue 2 'no' "$TITLE")")"
[[ "$status" == 1 ]] || fail "duplicate title: expected exit 1, got $status"
grep -F 'pre-marker issues titled' <<<"$out" >/dev/null || fail "duplicate title: missing error"

# 8. Only the OTHER marker present (not ours) yields empty.
run "$(page "$(issue 8 "$OTHER" 'x')")"
[[ "$status" == 0 ]] || fail "foreign marker: expected exit 0, got $status ($out)"
[[ -z "$number" ]] || fail "foreign marker: expected empty, got '$number'"

# 9. A marker decoy authored by a human user (public marker string) is never
#    adopted: the author restriction filters it out before marker matching.
run "$(page "$(issue 91 "$MARKER" 'x' false 'attacker' 'User')")"
[[ "$status" == 0 ]] || fail "marker decoy (user): expected exit 0, got $status ($out)"
[[ -z "$number" ]] || fail "marker decoy (user): expected empty, got '$number'"

# 10. A marker decoy authored by a DIFFERENT bot is not adopted: the login must
#     match this workflow's own identity exactly, not merely be a Bot.
run "$(page "$(issue 92 "$MARKER" 'x' false 'dependabot[bot]' 'Bot')")"
[[ "$status" == 0 ]] || fail "marker decoy (other bot): expected exit 0, got $status ($out)"
[[ -z "$number" ]] || fail "marker decoy (other bot): expected empty, got '$number'"

# 11. A title-fallback decoy authored by a user is not adopted either.
run "$(page "$(issue 93 'no marker' "$TITLE" false 'attacker' 'User')")"
[[ "$status" == 0 ]] || fail "title decoy (user): expected exit 0, got $status ($out)"
[[ -z "$number" ]] || fail "title decoy (user): expected empty, got '$number'"

# 12. A user decoy carrying our marker cannot trip the fail-closed ambiguity
#     guard to suppress the real report: the decoy is filtered out, so the one
#     own-authored issue is still resolved rather than failing on a false
#     duplicate.
run "$(page "$(issue 10 "$MARKER" 'x'),$(issue 11 "$MARKER" 'x' false 'attacker' 'User')")"
[[ "$status" == 0 ]] || fail "decoy ambiguity: expected exit 0, got $status ($out)"
[[ "$number" == 10 ]] || fail "decoy ambiguity: expected 10, got '$number'"

# 13. An unset required input fails closed instead of matching every issue with
#     an empty needle (an empty MARKER would otherwise adopt an unrelated issue;
#     an empty ISSUE_AUTHOR_LOGIN would drop the author restriction).
fixture="$(page "$(issue 8 "$MARKER" 'x')")"
run_unset() { # env-assignments... -> sets status, out
  set +e
  out="$(env "$@" GITHUB_OUTPUT="$github_output" bash "$core" 2>&1)"
  status=$?
  set -e
  rm -f -- "$github_output"
}
run_unset "open_issues=$fixture" "ISSUE_TITLE=$TITLE" "ISSUE_AUTHOR_LOGIN=$AUTHOR" # MARKER unset
[[ "$status" != 0 ]] || fail "unset MARKER: expected non-zero exit, got 0 ($out)"
run_unset "open_issues=$fixture" "MARKER=$MARKER" "ISSUE_AUTHOR_LOGIN=$AUTHOR" # ISSUE_TITLE unset
[[ "$status" != 0 ]] || fail "unset ISSUE_TITLE: expected non-zero exit, got 0 ($out)"
run_unset "open_issues=$fixture" "MARKER=$MARKER" "ISSUE_TITLE=$TITLE" # ISSUE_AUTHOR_LOGIN unset
[[ "$status" != 0 ]] || fail "unset ISSUE_AUTHOR_LOGIN: expected non-zero exit, got 0 ($out)"
run_unset "MARKER=$MARKER" "ISSUE_TITLE=$TITLE" "ISSUE_AUTHOR_LOGIN=$AUTHOR" # open_issues unset
[[ "$status" != 0 ]] || fail "unset open_issues: expected non-zero exit, got 0 ($out)"

echo "find-tracking-issue.sh: all cases passed"
