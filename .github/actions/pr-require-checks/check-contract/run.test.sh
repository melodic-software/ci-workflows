#!/usr/bin/env bash
# shellcheck shell=bash
# Fixture harness for the pr-contract runner: Conventional Commits title, the
# do-not-merge label gate, and the issue-linkage rule with its advisory
# comment/label upsert.
#
# Every case names, in a comment, the check it would pass without. A case that
# still passes with its check removed proves nothing and does not belong here.
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

failures=0
log_file="$temporary_directory/log"
output_file="$temporary_directory/github-output"
gh_log="$temporary_directory/gh-calls.log"
fixtures="$temporary_directory/fixtures"
calls="$temporary_directory/calls"
shim_directory="$temporary_directory/bin"
mkdir -p "$fixtures" "$calls" "$shim_directory"

repository=melodic-software/ci-workflows
pr_number=7
# The pull request and its comments are one GraphQL read, the step's only one.
pull_key="POST_graphql"
comments_key="repos_melodic-software_ci-workflows_issues_${pr_number}_comments"
labels_key="repos_melodic-software_ci-workflows_issues_${pr_number}_labels"

# A `gh` shim first on PATH: it serves fixture JSON keyed by method plus API
# path, records every call and every request body so the harness can assert on
# writes that did and did not happen, and can fail a keyed call on demand.
# Under `-i` it prints `<key>.<n>.headers` or `<key>.headers` (a status line
# and header lines) before the output, as `gh api -i` does, and
# `<key>.<n>.err` fails only the Nth call with that stderr.
cat >"$shim_directory/gh" <<'SHIM'
#!/usr/bin/env bash
set -uo pipefail

printf '%s\n' "$*" >>"$GH_LOG"

method=GET
path=""
input=""
slurp=false
include=false
seen_api=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    api)
      seen_api=true
      shift
      ;;
    -X)
      method="$2"
      shift 2
      ;;
    --input)
      input="$2"
      shift 2
      ;;
    --slurp)
      slurp=true
      shift
      ;;
    -i | --include)
      include=true
      shift
      ;;
    --paginate | --silent)
      shift
      ;;
    -*)
      shift
      ;;
    *)
      if [[ "$seen_api" == true && -z "$path" ]]; then
        path="$1"
      fi
      shift
      ;;
  esac
done

# Fixture keys ignore the query string, so a paginated read does not need a
# fixture of its own.
path="${path%%\?*}"
key="${method}_${path//\//_}"
if [[ -n "$input" && -f "$input" ]]; then
  cp -- "$input" "$GH_CALLS/${key}.input.json"
elif [[ "$input" == "-" ]]; then
  cat >"$GH_CALLS/${key}.input.json"
fi

count_file="$GH_CALLS/${key}.count"
call_number=1
if [[ -f "$count_file" ]]; then
  call_number="$(($(cat "$count_file") + 1))"
fi
printf '%s\n' "$call_number" >"$count_file"

if [[ "$include" == true ]]; then
  for headers in "$GH_FIXTURES/${key}.${call_number}.headers" "$GH_FIXTURES/${key}.headers"; do
    if [[ -f "$headers" ]]; then
      cat "$headers"
      printf '\r\n'
      break
    fi
  done
fi

if [[ -f "$GH_FIXTURES/${key}.${call_number}.err" ]]; then
  cat "$GH_FIXTURES/${key}.${call_number}.err" >&2
  exit 1
fi

fail_times="$GH_FIXTURES/${key}.fail-times"
if [[ -f "$fail_times" ]]; then
  remaining="$(cat "$fail_times")"
  if [[ "$remaining" -gt 0 ]]; then
    printf '%s\n' "$((remaining - 1))" >"$fail_times"
    echo "gh: Internal Server Error (HTTP 500)" >&2
    exit 1
  fi
fi

if [[ -f "$GH_FIXTURES/${key}.err" ]]; then
  cat "$GH_FIXTURES/${key}.err" >&2
  exit 1
fi

# Pagination as `gh` does it: `<key>.pages.json` holds an array of pages, which
# `--slurp` prints as one array and a bare `--paginate` prints one page after
# another. A one-page fixture is wrapped the same way under `--slurp`.
if [[ -f "$GH_FIXTURES/${key}.pages.json" ]]; then
  if [[ "$slurp" == true ]]; then
    cat "$GH_FIXTURES/${key}.pages.json"
  else
    jq -c '.[]' "$GH_FIXTURES/${key}.pages.json"
  fi
  exit 0
fi

body='{}'
if [[ -f "$GH_FIXTURES/${key}.${call_number}.json" ]]; then
  body="$(cat "$GH_FIXTURES/${key}.${call_number}.json")"
elif [[ -f "$GH_FIXTURES/${key}.json" ]]; then
  body="$(cat "$GH_FIXTURES/${key}.json")"
fi
if [[ "$slurp" == true ]]; then
  printf '[%s]\n' "$body"
else
  printf '%s\n' "$body"
fi
# A GraphQL body with an `errors` array, as gh 2.102.0 prints one: the body on
# stdout, `gh: <first message>` with no "(HTTP nnn)" on stderr, and exit 1.
# `<key>.exit0` serves it with exit 0 instead, so a case can show the runner
# fails on the `errors` entry itself, not on gh's exit status.
if [[ ! -f "$GH_FIXTURES/${key}.exit0" ]] && jq -e 'type == "object" and ((.errors // []) | length > 0)' <<<"$body" >/dev/null 2>&1; then
  printf 'gh: %s\n' "$(jq -r '.errors[0].message // ""' <<<"$body")" >&2
  exit 1
fi
SHIM
chmod +x "$shim_directory/gh"

# A `sleep` that only logs, and a `date` that reads a fixed clock, so a
# rate-limit wait is asserted without taking it.
sleep_log="$temporary_directory/sleep.log"
cat >"$shim_directory/sleep" <<'SLEEP_SHIM'
#!/usr/bin/env bash
printf '%s\n' "$1" >>"$SLEEP_LOG"
SLEEP_SHIM
chmod +x "$shim_directory/sleep"
cat >"$shim_directory/date" <<'DATE_SHIM'
#!/usr/bin/env bash
if [[ "$*" != '+%s' ]]; then
  echo "date shim: only +%s is supported, got: $*" >&2
  exit 1
fi
echo 0
DATE_SHIM
chmod +x "$shim_directory/date"

# The GraphQL read is composed from the pull request and its comments, each
# set on its own, in the shapes GitHub returned for a real pull request: a Bot
# author's login has no `[bot]` suffix, and a comment's REST `id` and
# `user.type` are its `databaseId` and `author.__typename`.
graphql_pull="$fixtures/graphql-pull.json"
graphql_comments="$fixtures/graphql-comments.json"
compose_pull_read() {
  jq -n --slurpfile pr "$graphql_pull" --slurpfile comments "$graphql_comments" \
    '{data: {repository: {pullRequest: ($pr[0] + {comments: $comments[0]})}}}' >"$fixtures/${pull_key}.json"
}

printf '{"totalCount":0,"nodes":[]}' >"$graphql_comments"

# set_pull <title> <body> <author> <labels-csv>
# An author ending `[bot]` is a Bot, as REST names one.
set_pull() {
  local title="$1" body="$2" author="$3" labels="$4"
  jq -n \
    --arg title "$title" \
    --arg body "$body" \
    --arg author "$author" \
    --arg labels "$labels" \
    '{
      title: $title,
      body: $body,
      author: (if ($author | endswith("[bot]")) then {__typename: "Bot", login: ($author | rtrimstr("[bot]"))} else {__typename: "User", login: $author} end),
      labels: ($labels | if . == "" then [] else split(",") end | {totalCount: length, nodes: map({name: .})})
    }' >"$graphql_pull"
  compose_pull_read
}

# set_comments <json-array-of-rest-comments>
# The REST listing, and the same comments as the GraphQL read's one page.
set_comments() {
  printf '%s' "$1" >"$fixtures/GET_${comments_key}.json"
  jq '{totalCount: length, nodes: map({databaseId: .id, body, author: {__typename: .user.type}})}' <<<"$1" >"$graphql_comments"
  if [[ -f "$graphql_pull" ]]; then
    compose_pull_read
  fi
}

# The GraphQL read's one page of comments holds fewer than the pull request
# has, so the marker lookup lists them over REST.
comments_beyond_one_page() {
  jq '.totalCount = 101' <"$graphql_comments" >"$graphql_comments.tmp"
  mv -- "$graphql_comments.tmp" "$graphql_comments"
  compose_pull_read
}

bot_comment() {
  # bot_comment <id> <body>
  printf '{"id":%s,"user":{"type":"Bot"},"body":"%s"}' "$1" "$2"
}

user_comment() {
  # user_comment <id> <body>
  printf '{"id":%s,"user":{"type":"User"},"body":"%s"}' "$1" "$2"
}

# run_case <expected-status> [NAME=VALUE ...]
run_case() {
  local expected_status="$1"
  shift
  local actual_status
  : >"$gh_log"
  : >"$output_file"
  : >"$sleep_log"
  rm -rf -- "$calls"
  mkdir -p "$calls"
  set +e
  env \
    PATH="$shim_directory:$PATH" \
    GH_LOG="$gh_log" \
    GH_FIXTURES="$fixtures" \
    GH_CALLS="$calls" \
    SLEEP_LOG="$sleep_log" \
    GH_TOKEN=fixture-token \
    GITHUB_OUTPUT="$output_file" \
    REPOSITORY="$repository" \
    PR_NUMBER="$pr_number" \
    TYPES='build,chore,ci,docs,feat,fix,perf,refactor,revert,security,style,test' \
    REQUIRE_SCOPE=false \
    DO_NOT_MERGE_LABEL=do-not-merge \
    EXEMPT_AUTHORS='' \
    LINKAGE_LABEL=needs-issue-linkage \
    LINKAGE_MODE=advisory \
    ISSUE_REF_PATTERN='' \
    "$@" \
    bash "$script_directory/run.sh" >"$log_file" 2>&1
  actual_status=$?
  set -e
  if [[ "$actual_status" -ne "$expected_status" ]]; then
    echo "FAIL: expected exit $expected_status, got $actual_status"
    cat "$log_file"
    # Record and continue: the suite accumulates failures and reports them all.
    failures=$((failures + 1))
  fi
}

expect_output() {
  local expected="$1"
  if ! grep -qxF -- "$expected" "$output_file"; then
    echo "FAIL: expected output '$expected', got:"
    cat "$output_file"
    cat "$log_file"
    failures=$((failures + 1))
  fi
}

expect_no_output() {
  local unexpected="$1"
  if grep -qxF -- "$unexpected" "$output_file"; then
    echo "FAIL: expected NO output '$unexpected', got:"
    cat "$output_file"
    cat "$log_file"
    failures=$((failures + 1))
  fi
}

expect_log() {
  local expected="$1"
  if ! grep -qF -- "$expected" "$log_file"; then
    echo "FAIL: expected log to contain '$expected', got:"
    cat "$log_file"
    failures=$((failures + 1))
  fi
}

expect_no_log() {
  local unexpected="$1"
  if grep -qF -- "$unexpected" "$log_file"; then
    echo "FAIL: expected log NOT to contain '$unexpected', got:"
    cat "$log_file"
    failures=$((failures + 1))
  fi
}

expect_gh_call() {
  local expected="$1"
  if ! grep -qF -- "$expected" "$gh_log"; then
    echo "FAIL: expected a gh call matching '$expected', got:"
    cat "$gh_log"
    failures=$((failures + 1))
  fi
}

expect_no_gh_call() {
  local unexpected="$1"
  if grep -qF -- "$unexpected" "$gh_log"; then
    echo "FAIL: expected NO gh call matching '$unexpected', got:"
    cat "$gh_log"
    failures=$((failures + 1))
  fi
}

# The shim logs `$*`, which never contains the literal `gh api` — it starts at
# `api -X GET …` — so asserting on that string could never fire. Assert the log
# is empty instead.
expect_no_gh_calls_at_all() {
  if [[ -s "$gh_log" ]]; then
    echo 'FAIL: expected NO gh calls at all, got:'
    cat "$gh_log"
    failures=$((failures + 1))
  fi
}

expect_comment_body() {
  local key="$1" expected="$2"
  local payload="$calls/${key}.input.json"
  if [[ ! -f "$payload" ]]; then
    echo "FAIL: expected a recorded request body for ${key}, none written"
    cat "$gh_log"
    failures=$((failures + 1))
    return
  fi
  if ! jq -r '.body' <"$payload" | grep -qF -- "$expected"; then
    echo "FAIL: expected the ${key} body to contain '$expected', got:"
    jq -r '.body' <"$payload"
    failures=$((failures + 1))
  fi
}

conforming_body=$'No related issue: melodic-software/github-iac#396 tracks the phase\n\n## Summary\n\nAdds the pr-contract composite.\n\n## Fix\n\nPorts three gates into one step.\n\n## Verification\n\nBoth harnesses pass locally.\n\n## Related\n\nRefs: melodic-software/github-iac#378\n'

set_comments '[]'

# --- step 0: no pull request in this event ---------------------------------

# Without the empty-pr-number short circuit this fails on the missing PR fetch.
echo 'case: an event with no pull request skips every check'
set_pull 'feat: something' "$conforming_body" someone ''
run_case 0 PR_NUMBER=''
expect_log '::notice::pr-contract: no pull request in this event; nothing to check'
expect_output 'title=skipped'
expect_output 'do-not-merge=skipped'
expect_output 'linkage=skipped'
expect_no_gh_calls_at_all

# --- merge group -------------------------------------------------------------

queue_ref="refs/heads/gh-readonly-queue/main/pr-${pr_number}-0123456789abcdef0123456789abcdef01234567"

# Without the merge-group branch an empty pr-number skips, so the label passes.
echo 'case: a merge group fails when the queued pull request carries do-not-merge'
set_pull 'feat: add pr-contract' "$conforming_body" someone 'do-not-merge'
run_case 1 PR_NUMBER='' EVENT_NAME=merge_group MERGE_GROUP_HEAD_REF="$queue_ref"
expect_output 'do-not-merge=fail'
expect_output 'title=pass'
expect_output 'linkage=skipped'
expect_log "this PR carries the 'do-not-merge' label"
expect_log "queued pull request #${pr_number} fails the contract"
expect_gh_call "-F number=${pr_number} -i"

# Without the early exit the failing linkage and its writes would run here.
echo 'case: a merge group with a good title passes, skips linkage, and writes nothing'
set_pull 'feat: add pr-contract' 'no linkage' someone ''
run_case 0 PR_NUMBER='' EVENT_NAME=merge_group MERGE_GROUP_HEAD_REF="$queue_ref"
expect_output 'title=pass'
expect_output 'do-not-merge=pass'
expect_output 'linkage=skipped'
expect_no_gh_call '-X POST repos/'
expect_no_gh_call '-X DELETE'

# Without the title check on merge_group a title edited after enqueue would land.
echo 'case: a merge group with a non-conventional title fails and writes nothing'
set_pull 'wip: no conventional title' 'no linkage' someone ''
run_case 1 PR_NUMBER='' EVENT_NAME=merge_group MERGE_GROUP_HEAD_REF="$queue_ref"
expect_output 'title=fail'
expect_output 'do-not-merge=pass'
expect_output 'linkage=skipped'
expect_log 'does not follow Conventional Commits: "wip: no conventional title"'
expect_no_gh_call '-X POST repos/'
expect_no_gh_call '-X DELETE'

# Without the fail-closed parse a ref with no pull request would skip and pass.
echo 'case: a merge group with an unparsable head ref fails closed'
for bad_ref in '' refs/heads/main 'refs/heads/gh-readonly-queue/main/pr-x-0123456789abcdef0123456789abcdef01234567' 'gh-readonly-queue/main/pr-7-abc'; do
  run_case 1 PR_NUMBER="$pr_number" EVENT_NAME=merge_group MERGE_GROUP_HEAD_REF="$bad_ref"
  expect_output 'do-not-merge=fail'
  expect_log 'cannot read a pull request number from the merge-group head ref'
  expect_no_gh_calls_at_all
done

# Without the read-failure exit an unreadable pull request would pass the label.
echo 'case: a merge group whose pull request cannot be read fails closed'
printf '%s\n' 'gh: Not Found (HTTP 404)' >"$fixtures/${pull_key}.err"
run_case 1 PR_NUMBER='' EVENT_NAME=merge_group MERGE_GROUP_HEAD_REF="$queue_ref"
expect_log "could not read pull request ${repository}#${pr_number} (HTTP 404)"
rm -f -- "$fixtures/${pull_key}.err"

# --- title check -----------------------------------------------------------

# Without the title regex an unknown type would pass, so each accepted type has
# to be shown accepted individually.
echo 'case: every configured type is accepted, including security'
for type in build chore ci docs feat fix perf refactor revert security style test; do
  set_pull "${type}: do the thing" "$conforming_body" someone ''
  run_case 0
  expect_output 'title=pass'
done

# Without the type alternation this passes.
echo 'case: an unknown type fails and the error names the allowed types'
set_pull 'wip: do the thing' "$conforming_body" someone ''
run_case 1
expect_output 'title=fail'
expect_log 'does not follow Conventional Commits: "wip: do the thing"'
expect_log 'allowed types: build, chore, ci, docs, feat, fix, perf, refactor, revert, security, style, test'

# Without the literal ': ' in the regex this passes.
echo 'case: a missing colon fails the title check'
set_pull 'feat do the thing' "$conforming_body" someone ''
run_case 1
expect_output 'title=fail'

# Without the `[^[:space:]]` subject anchor an empty subject passes.
echo 'case: an empty subject fails the title check'
set_pull 'feat: ' "$conforming_body" someone ''
run_case 1
expect_output 'title=fail'

# Without the optional `!` in the regex a breaking-change title fails.
echo 'case: the breaking-change marker is accepted with and without a scope'
set_pull 'feat!: drop the legacy input' "$conforming_body" someone ''
run_case 0
expect_output 'title=pass'
set_pull 'feat(api)!: drop the legacy input' "$conforming_body" someone ''
run_case 0
expect_output 'title=pass'

# Without the optional scope group a scoped title fails.
# Without `: +` in the regex this goes red, and a title the semantic-pr gate
# accepts today would start failing.
echo 'case: more than one space after the colon is accepted'
set_pull 'feat:  two spaces' "$conforming_body" someone ''
run_case 0
expect_output 'title=pass'

echo 'case: a scope is optional when require-scope is false'
set_pull 'feat(actions): add pr-contract' "$conforming_body" someone ''
run_case 0
expect_output 'title=pass'
set_pull 'feat: add pr-contract' "$conforming_body" someone ''
run_case 0
expect_output 'title=pass'

# Without the require-scope branch the unscoped title passes here too.
echo 'case: a scope is mandatory when require-scope is true'
set_pull 'feat(actions): add pr-contract' "$conforming_body" someone ''
run_case 0 REQUIRE_SCOPE=true
expect_output 'title=pass'
set_pull 'feat: add pr-contract' "$conforming_body" someone ''
run_case 1 REQUIRE_SCOPE=true
expect_output 'title=fail'
expect_log 'a scope is REQUIRED'

# --- do-not-merge label ----------------------------------------------------

# Without the label check this exits 0.
echo 'case: the do-not-merge label fails the step'
set_pull 'feat: add pr-contract' "$conforming_body" someone 'do-not-merge'
run_case 1
expect_output 'do-not-merge=fail'
expect_log "::error::pr-contract: this PR carries the 'do-not-merge' label; remove it to merge."

# Without the exact-label match any label would block.
echo 'case: an unrelated label does not block'
set_pull 'feat: add pr-contract' "$conforming_body" someone 'documentation,do-not-merge-later'
run_case 0
expect_output 'do-not-merge=pass'

# Without the configurable label input the custom label is ignored.
echo 'case: the blocking label name is configurable'
set_pull 'feat: add pr-contract' "$conforming_body" someone 'hold'
run_case 1 DO_NOT_MERGE_LABEL=hold
expect_output 'do-not-merge=fail'

# --- linkage: closing keywords --------------------------------------------

# Without the nine-form closing-keyword regex the past-tense and singular forms
# fail linkage.
echo 'case: every closing-keyword form satisfies linkage'
for keyword in Close Closes Closed Fix Fixes Fixed Resolve Resolves Resolved; do
  body="${keyword} #12"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n'
  set_pull 'feat: add pr-contract' "$body" someone ''
  run_case 0
  expect_output 'linkage=pass'
done

# Without the owner/repo alternative a cross-repository closer fails linkage.
echo 'case: a cross-repository closing reference satisfies linkage'
set_pull 'feat: add pr-contract' "Closes melodic-software/github-iac#396"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=pass'

# Without the `\b` guard on the keyword, "prefixes #12" would count as a closer.
echo 'case: a keyword embedded in a longer word does not satisfy linkage'
set_pull 'feat: add pr-contract' "This prefixes #12 nothing"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=fail'
expect_log 'Missing a native closing keyword'

# --- linkage: no-issue markers and Refs ------------------------------------

# Without the no-issue marker both phrasings fail linkage.
echo 'case: both no-issue markers satisfy linkage'
for marker in 'No linked issue' 'No related issue: nothing to close'; do
  set_pull 'feat: add pr-contract' "${marker}"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
  run_case 0
  expect_output 'linkage=pass'
done

# Without the non-closing marker branch a `Refs:` line fails linkage.
echo 'case: a Refs marker satisfies linkage without counting as a closer'
set_pull 'feat: add pr-contract' "Refs: #12"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=pass'
set_pull 'feat: add pr-contract' "Relates to: melodic-software/github-iac#396"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=pass'

# Without the strict marker shape (colon required, own line) ordinary prose
# containing "refs" would satisfy a merge gate.
echo 'case: a Refs marker without a colon does not satisfy linkage'
set_pull 'feat: add pr-contract' "Refs #12"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=fail'
expect_log 'Missing a native closing keyword'

echo 'case: a Refs marker with trailing prose does not satisfy linkage'
set_pull 'feat: add pr-contract' "Refs: #12 and some prose"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=fail'

# --- linkage: negated closers ----------------------------------------------

# Without the negation window a disclaimer would pass while GitHub still closes
# the issue on merge.
echo 'case: a negated closing reference fails linkage outright'
set_pull 'feat: add pr-contract' "This does not close #12."$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n\nNo linked issue\n' someone ''
run_case 0
expect_output 'linkage=fail'
expect_log 'Negated closing reference ("close #12" (trigger "not"))'

# Without the "not only" exemption this affirmative sentence would be rejected.
echo 'case: a correlative "not only ... but" closer is affirmative'
set_pull 'feat: add pr-contract' "This not only documents but fixes #12"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=pass'

# Without the sentence-break cut an unrelated earlier clause would negate the
# closer.
echo 'case: a negation before a sentence break does not reach the keyword'
set_pull 'feat: add pr-contract' "There is no ambiguity. This closes #12"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=pass'

# Without the contracted-negation branch "doesn't close" would pass.
echo 'case: a contracted negation is detected'
set_pull 'feat: add pr-contract' "It doesn't close #12"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n\nNo linked issue\n' someone ''
run_case 0
expect_output 'linkage=fail'
expect_log 'trigger "doesn'"'"'t"'

# Without the typographic-apostrophe normalization "doesn<U+2019>t" would not
# read as a negation. LC_ALL=C runs the byte-oriented path, where awk sees
# U+2019 as three characters; without the scan treating them as one apostrophe,
# "doesn<U+2019>t" would count as two words and fall out of the five-word window.
typographic_apostrophe=$'\xe2\x80\x99'
for locale in C.UTF-8 C; do
  echo "case: a contracted negation with a typographic apostrophe is detected (LC_ALL=${locale})"
  set_pull 'feat: add pr-contract' "It doesn${typographic_apostrophe}t in any way really close #12"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n\nNo linked issue\n' someone ''
  run_case 0 LC_ALL="$locale"
  expect_output 'linkage=fail'
  expect_log 'trigger "doesn'"'"'t"'
done

# Without the five-word bound the scan would reach any earlier negation on the
# line; without the window at all the nearer one would be missed.
echo 'case: a negation five words before the keyword is detected'
set_pull 'feat: add pr-contract' "Not one two three four closes #12"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n\nNo linked issue\n' someone ''
run_case 0
expect_output 'linkage=fail'
expect_log 'trigger "Not"'

echo 'case: a negation six words before the keyword is not detected'
set_pull 'feat: add pr-contract' "Not one two three four five closes #12"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=pass'

# Without the bounded backward scan in negation_trigger, and the single gsub
# pass in scan_line, one long unpunctuated line of closing keywords costs
# super-quadratic time: about 111 s at 4000 repeats, against the ci-status job's
# 5-minute timeout. Linear work keeps the 8000/4000 ratio near 2; best of two
# runs damps runner noise.
# time_repeats <repeats>: sets best_time to the faster of two runs, in seconds.
time_repeats() {
  local repeats="$1" body elapsed started
  printf -v body '%*s' "$repeats" ''
  body="${body// /closes #1 }"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n'
  set_pull 'feat: add pr-contract' "$body" someone ''
  best_time=''
  for _ in 1 2; do
    started="$EPOCHREALTIME"
    run_case 0
    elapsed="$(awk -v a="$started" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.3f", b - a }')"
    expect_output 'linkage=pass'
    if [[ -z "$best_time" ]] || awk -v a="$elapsed" -v b="$best_time" 'BEGIN { exit !(a < b) }'; then
      best_time="$elapsed"
    fi
  done
}
echo "case: a long line of closing keywords scans in linear time ($(awk -W version 2>&1 | head -n 1))"
time_repeats 4000
time_4000="$best_time"
time_repeats 8000
time_8000="$best_time"
echo "  4000 repeats: ${time_4000} s; 8000 repeats: ${time_8000} s"
if ! awk -v t="$time_4000" 'BEGIN { exit !(t < 5) }'; then
  echo "FAIL: 4000 repeats took ${time_4000} s, expected under 5 s"
  failures=$((failures + 1))
fi
if ! awk -v a="$time_4000" -v b="$time_8000" 'BEGIN { exit !(b < 3 * a) }'; then
  echo "FAIL: 8000 repeats took ${time_8000} s, at least 3x the ${time_4000} s for 4000"
  failures=$((failures + 1))
fi

# --- linkage: issue-ref-pattern --------------------------------------------

sections=$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n'
tracker_pattern='[a-z][a-z0-9]*-[0-9]+'

# Without the default grammar a tracker id would satisfy every caller that sets
# nothing; an explicitly empty input must mean that same default.
echo 'case: the default pattern rejects a tracker id and keeps the #N message'
set_pull 'feat: add pr-contract' "Closes ENG-123${sections}" someone ''
run_case 0
expect_output 'linkage=fail'
expect_log 'Missing a native closing keyword (Closes/Fixes/Resolves #N).'
run_case 0 ISSUE_REF_PATTERN=''
expect_output 'linkage=fail'
set_pull 'feat: add pr-contract' "Closes #12${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN=''
expect_output 'linkage=pass'

# Without the pattern reaching the closing and Refs regexes these fail.
echo 'case: a custom pattern accepts its own ids as closers and Refs markers'
set_pull 'feat: add pr-contract' "Closes ENG-123${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN="$tracker_pattern"
expect_output 'linkage=pass'
set_pull 'feat: add pr-contract' "Refs: SW2-1${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN="$tracker_pattern"
expect_output 'linkage=pass'

# Without replacing the GitHub grammar a custom pattern would only widen it.
echo 'case: a custom pattern replaces #N and names itself in the message'
set_pull 'feat: add pr-contract' "Closes #12${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN="$tracker_pattern"
expect_output 'linkage=fail'
expect_log 'Missing a recognized closing keyword (Closes/Fixes/Resolves <ref>).'
expect_log "issue-ref-pattern \`${tracker_pattern}\`"
set_pull 'feat: add pr-contract' "Refs: #12${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN="$tracker_pattern"
expect_output 'linkage=fail'

# Without a required separator after the keyword, "fixture-1" reads as
# "fix" + "ture-1" and a custom pattern passes on an ordinary word.
echo 'case: a custom pattern does not match inside a hyphenated word'
set_pull 'feat: add pr-contract' "Uses fixture-1 and the resolver-3 module.${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN="$tracker_pattern"
expect_output 'linkage=fail'
set_pull 'feat: add pr-contract' "Fixes: ENG-7${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN="$tracker_pattern"
expect_output 'linkage=pass'

# Without folding the case classes, `[:upper:]` matches nothing in the
# lowercased body.
echo 'case: a POSIX case class in a custom pattern still matches'
set_pull 'feat: add pr-contract' "Closes ENG-123${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN='[[:upper:]]+-[0-9]+'
expect_output 'linkage=pass'
set_pull 'feat: add pr-contract' "Refs: ENG-123${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN='[[:upper:]]+-[0-9]+'
expect_output 'linkage=pass'

# Without the trailing-hyphen boundary a longer malformed id passes.
echo 'case: a custom id followed by more hyphenated text is not a match'
set_pull 'feat: add pr-contract' "Closes ENG-123-extra${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN="$tracker_pattern"
expect_output 'linkage=fail'
set_pull 'feat: add pr-contract' "Closes ENG-123.${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN="$tracker_pattern"
expect_output 'linkage=pass'
# Without the custom-only guard the hyphen rule would change the default: a
# `#N` closer followed by a hyphen passed before this input and must still.
set_pull 'feat: add pr-contract' "Closes #12-followup${sections}" someone ''
run_case 0
expect_output 'linkage=pass'

# Without the default branch of the wording, the default negation message
# would lose its GitHub reason and its `Refs: #N` advice.
echo 'case: the default negation message is unchanged'
set_pull 'feat: add pr-contract' "This does not close #12.${sections}"$'\nNo linked issue\n' someone ''
run_case 0
expect_log "GitHub's linkage parser ignores the surrounding words"
expect_log 'use "Refs: #N" (or "Relates to: #N") on its own line instead.'

# Without the negation window on the custom closer this disclaimer passes.
echo 'case: negation handling applies to a custom pattern'
set_pull 'feat: add pr-contract' "This does not close ENG-123.${sections}"$'\nNo linked issue\n' someone ''
run_case 0 ISSUE_REF_PATTERN="$tracker_pattern"
expect_output 'linkage=fail'
expect_log 'Negated closing reference ("close ENG-123" (trigger "not"))'

# Without the opt-out check being pattern-independent this fails.
echo 'case: the no-issue opt-out still passes with a custom pattern'
set_pull 'feat: add pr-contract' "No related issue: tooling only${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN="$tracker_pattern"
expect_output 'linkage=pass'

# Without the compile check awk dies mid-analysis with an opaque error.
echo 'case: an invalid or empty-matching pattern is rejected before any API call'
for bad_pattern in '([a-z' 'a)|(b'; do
  run_case 1 ISSUE_REF_PATTERN="$bad_pattern"
  expect_log 'issue-ref-pattern is not a valid extended regex'
  expect_no_gh_calls_at_all
done
for bad_pattern in '.*' '(#[0-9]+)?'; do
  run_case 1 ISSUE_REF_PATTERN="$bad_pattern"
  expect_log 'issue-ref-pattern matches the empty string'
  expect_no_gh_calls_at_all
done
# Without the anchor check these compile but can never match after a keyword.
for bad_pattern in '^[a-z]+-[0-9]+' '[a-z]+-[0-9]+$'; do
  run_case 1 ISSUE_REF_PATTERN="$bad_pattern"
  expect_log 'issue-ref-pattern must not be anchored'
  expect_no_gh_calls_at_all
done
run_case 1 ISSUE_REF_PATTERN=$'#[0-9]+\n.*'
expect_log 'issue-ref-pattern must be a single line'
expect_no_gh_calls_at_all

# Without passing the pattern through ENVIRON, awk program text spliced from
# the input would run this system() call.
echo 'case: a pattern carrying awk code is data, not code'
injected="$temporary_directory/injected"
set_pull 'feat: add pr-contract' "Closes #12${sections}" someone ''
run_case 0 ISSUE_REF_PATTERN="x\" ~ system(\"touch ${injected}\") ~ \"x"
if [[ -e "$injected" ]]; then
  echo 'FAIL: the issue-ref-pattern input executed as awk code'
  failures=$((failures + 1))
fi

# --- linkage: masking ------------------------------------------------------

# Without HTML-comment masking a PR template's commented-out example satisfies
# the gate vacuously.
echo 'case: a closing keyword only inside an HTML comment does not satisfy linkage'
set_pull 'feat: add pr-contract' "<!-- Closes #12 -->"$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=fail'
expect_log 'Missing a native closing keyword'

# Without fenced-code masking an example in a code block satisfies the gate.
echo 'case: a closing keyword only inside a fenced code block does not satisfy linkage'
set_pull 'feat: add pr-contract' '```'$'\nCloses #12\n''```'$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=fail'

# Without inline-code masking a code span holding a closing reference satisfies
# the gate.
echo 'case: a closing keyword only inside an inline code span does not satisfy linkage'
# shellcheck disable=SC2016 # the backticks are the Markdown code span under test.
set_pull 'feat: add pr-contract' 'Write `Closes #12` in the body.'$'\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=fail'

# --- linkage: contract sections --------------------------------------------

# Without the four-section check a body with only linkage passes.
echo 'case: each missing contract section is reported by name'
for section in Summary Fix Verification Related; do
  body='Closes #12'$'\n'
  for present in Summary Fix Verification Related; do
    if [[ "$present" == "$section" ]]; then
      continue
    fi
    body+=$'\n## '"$present"$'\n\ncontent\n'
  done
  set_pull 'feat: add pr-contract' "$body" someone ''
  run_case 0
  expect_output 'linkage=fail'
  expect_log "Missing a \"## ${section}\" section."
done

# Without the non-empty check a heading with no content passes.
echo 'case: an empty contract section is reported as empty, not missing'
set_pull 'feat: add pr-contract' 'Closes #12'$'\n\n## Summary\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=fail'
expect_log 'The "## Summary" section is empty.'

# Without the same-or-higher-level end rule a nested subsection would close the
# section early and Summary would read as empty.
echo 'case: a nested subsection counts as its parent section content'
set_pull 'feat: add pr-contract' 'Closes #12'$'\n\n## Summary\n\n### Detail\n\nnested content\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nr\n' someone ''
run_case 0
expect_output 'linkage=pass'

# --- linkage: exempt authors ----------------------------------------------

# Without the exempt-author short circuit a bot body fails linkage.
echo 'case: an exempt author skips the linkage check entirely'
set_pull 'build: bump a dependency' 'Bumps a thing.' 'dependabot[bot]' ''
run_case 0 'EXEMPT_AUTHORS=dependabot[bot]'
expect_output 'linkage=exempt'
expect_log 'matches an exempt-authors entry'

# Without exact-login equality a `*[bot]` style match would exempt this author.
echo 'case: a non-listed author is not exempt'
set_pull 'build: bump a dependency' 'Bumps a thing.' 'renovate[bot]' ''
run_case 0 'EXEMPT_AUTHORS=dependabot[bot]'
expect_output 'linkage=fail'

# Without the trailing-newline fix on the list split the last entry is dropped.
echo 'case: the last entry of a multi-author exempt list still matches'
set_pull 'build: bump a dependency' 'Bumps a thing.' 'renovate[bot]' ''
run_case 0 'EXEMPT_AUTHORS=dependabot[bot],renovate[bot]'
expect_output 'linkage=exempt'

# --- advisory outcome ------------------------------------------------------

# Without the create branch no comment is posted on the first failing run.
echo 'case: an advisory failure creates the marker comment and adds the label'
set_comments '[]'
set_pull 'feat: add pr-contract' 'nothing here' someone ''
run_case 0
expect_output 'linkage=fail'
expect_gh_call "POST repos/${repository}/issues/${pr_number}/comments"
expect_comment_body "POST_${comments_key}" '<!-- pr-contract:linkage -->'
expect_comment_body "POST_${comments_key}" 'Missing a "## Summary" section.'
expect_gh_call "POST repos/${repository}/issues/${pr_number}/labels"
expect_log '::warning::pr-contract: Missing a native closing keyword'

# Without the marker lookup a second run posts a second comment.
echo 'case: a second advisory failure edits the existing marker comment'
set_comments "[$(bot_comment 1001 '<!-- pr-contract:linkage -->\nstale text')]"
set_pull 'feat: add pr-contract' 'nothing here' someone ''
run_case 0
expect_gh_call "PATCH repos/${repository}/issues/comments/1001"
expect_no_gh_call "POST repos/${repository}/issues/${pr_number}/comments"

# Without the best-effort wrapper a refused comment write fails the step.
echo 'case: a 403 on the comment write leaves the exit code unchanged'
set_comments '[]'
printf '%s\n' 'gh: Forbidden (HTTP 403)' >"$fixtures/POST_${comments_key}.err"
set_pull 'feat: add pr-contract' 'nothing here' someone ''
run_case 0
expect_log '::notice::pr-contract: upserting the linkage comment was refused (HTTP 403); continuing without it'
rm -f -- "$fixtures/POST_${comments_key}.err"

# Without the best-effort wrapper a refused label write fails the step.
echo 'case: a 403 on the label write leaves the exit code unchanged'
printf '%s\n' 'gh: Forbidden (HTTP 403)' >"$fixtures/POST_${labels_key}.err"
set_pull 'feat: add pr-contract' 'nothing here' someone ''
run_case 0
expect_log '::notice::pr-contract: adding the linkage label was refused (HTTP 403); continuing without it'
rm -f -- "$fixtures/POST_${labels_key}.err"

# Without the pass branch the label stays on a body that now conforms.
echo 'case: a linkage pass removes the label and rewrites the marker comment'
set_comments "[$(bot_comment 1001 '<!-- pr-contract:linkage -->\nstale failure text')]"
set_pull 'feat: add pr-contract' "$conforming_body" someone 'needs-issue-linkage'
run_case 0
expect_output 'linkage=pass'
expect_gh_call "PATCH repos/${repository}/issues/comments/1001"
expect_comment_body 'PATCH_repos_melodic-software_ci-workflows_issues_comments_1001' 'conforms to the issue-linkage contract'
expect_gh_call "DELETE repos/${repository}/issues/${pr_number}/labels/needs-issue-linkage"

# Without the label-presence guard a DELETE fires on every passing run.
echo 'case: a linkage pass with no label present issues no label delete'
set_pull 'feat: add pr-contract' "$conforming_body" someone ''
run_case 0
expect_no_gh_call 'DELETE'

# Without the enforce branch a linkage failure exits 0 here too.
echo 'case: linkage-mode enforce fails the step on a linkage failure'
set_comments '[]'
set_pull 'feat: add pr-contract' 'nothing here' someone ''
run_case 1 LINKAGE_MODE=enforce
expect_output 'linkage=fail'
expect_log '::error::pr-contract: Missing a native closing keyword'

# Without computing every check before exiting, a title failure would leave the
# linkage output unset for the caller.
echo 'case: all three outputs are emitted even when the title check fails'
set_pull 'wip: no type here' "$conforming_body" someone 'do-not-merge'
run_case 1
expect_output 'title=fail'
expect_output 'do-not-merge=fail'
expect_output 'linkage=pass'

# Without the fetch-failure branch an unreadable PR would be read as an empty
# title and body and reported as a contract violation instead of an outage.
echo 'case: an unreadable pull request fails loudly'
mv -- "$fixtures/${pull_key}.json" "$fixtures/${pull_key}.json.bak"
printf '%s\n' 'gh: Not Found (HTTP 404)' >"$fixtures/${pull_key}.err"
run_case 1
expect_log "::error::pr-contract: could not read pull request ${repository}#${pr_number} (HTTP 404)"
rm -f -- "$fixtures/${pull_key}.err"
mv -- "$fixtures/${pull_key}.json.bak" "$fixtures/${pull_key}.json"

# --- rate limits -----------------------------------------------------------

primary_limit_message='gh: API rate limit exceeded for installation ID 1 (HTTP 403)'

# Without the wait the first limited read fails a good pull request red.
echo 'case: a rate-limited pull request read reports its headers, waits until the reset, and retries once'
set_pull 'feat: add pr-contract' "$conforming_body" someone ''
printf '%s\n' "$primary_limit_message" >"$fixtures/${pull_key}.1.err"
printf 'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 20\r\n' >"$fixtures/${pull_key}.1.headers"
run_case 0
expect_log "::warning::POST graphql returned HTTP 403 (rate-limit): API rate limit exceeded for installation ID 1; x-ratelimit-remaining=0 x-ratelimit-reset=20 retry-after=absent"
expect_log 'waiting 20s, then retrying once.'
expect_output 'title=pass'
if [[ "$(cat "$sleep_log")" != 20 ]]; then
  echo "FAIL: expected one 20s sleep, got: $(cat "$sleep_log")"
  failures=$((failures + 1))
fi
rm -f -- "$fixtures/${pull_key}.1.err" "$fixtures/${pull_key}.1.headers"

# Without the cap check the step would sleep past its job timeout.
echo 'case: a pull request read whose reset is beyond the cap fails closed at once'
printf '%s\n' "$primary_limit_message" >"$fixtures/${pull_key}.1.err"
printf 'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 900\r\n' >"$fixtures/${pull_key}.1.headers"
run_case 1 RATE_LIMIT_WAIT_SECONDS=60
expect_log 'needs a 900s wait, more than the 60s left of rate-limit-wait-seconds (60); not waiting. The limit resets at 900 (1970-01-01T00:15:00Z).'
expect_log "::error::pr-contract: could not read pull request ${repository}#${pr_number} (HTTP 403): rate limited past rate-limit-wait-seconds"
if [[ -s "$sleep_log" ]]; then
  echo "FAIL: expected no sleep, got: $(cat "$sleep_log")"
  failures=$((failures + 1))
fi
rm -f -- "$fixtures/${pull_key}.1.err" "$fixtures/${pull_key}.1.headers"

# Without the permission branch a refused write would be reported as a limit.
echo 'case: a permission 403 on an advisory write names no rate limit and keeps the exit code'
set_pull 'feat: add pr-contract' 'no linkage here' someone ''
printf '%s\n' 'gh: Resource not accessible by integration (HTTP 403)' >"$fixtures/POST_${labels_key}.1.err"
printf 'HTTP/2.0 403 Forbidden\r\nX-Accepted-Github-Permissions: issues=write; pull_requests=write\r\n' >"$fixtures/POST_${labels_key}.1.headers"
run_case 0
expect_log 'returned HTTP 403 (permission): Resource not accessible by integration; x-ratelimit-remaining=absent x-ratelimit-reset=absent retry-after=absent x-accepted-github-permissions=issues=write; pull_requests=write'
expect_log '::notice::pr-contract: adding the linkage label was refused (HTTP 403); continuing without it'
rm -f -- "$fixtures/POST_${labels_key}.1.err" "$fixtures/POST_${labels_key}.1.headers"

# Without reading the marker comment outside a command substitution, the wait
# warning is captured as a comment id, and the conforming path posts a comment
# it should only ever edit.
echo 'case: a rate-limited marker comment read on a conforming pull request posts nothing'
set_pull 'feat: add pr-contract' "$conforming_body" someone ''
set_comments '[]'
comments_beyond_one_page
printf '%s\n' "$primary_limit_message" >"$fixtures/GET_${comments_key}.1.err"
run_case 0
expect_log "::warning::GET repos/${repository}/issues/${pr_number}/comments returned HTTP 403 (rate-limit)"
expect_log 'is rate limited; waiting 60s, then retrying once.'
expect_no_gh_call "-X POST repos/${repository}/issues/${pr_number}/comments"
expect_no_gh_call '-X PATCH'
if [[ "$(cat "$sleep_log")" != 60 ]]; then
  echo "FAIL: expected one 60s sleep, got: $(cat "$sleep_log")"
  failures=$((failures + 1))
fi
rm -f -- "$fixtures/GET_${comments_key}.1.err"

# Without the wait counted in the parent shell, the comment read's wait is
# forgotten and the comment write waits a second time, past the step's cap.
echo 'case: the marker comment read and write share one rate-limit-wait-seconds budget'
set_pull 'feat: add pr-contract' 'no linkage here' someone ''
printf '%s\n' "$primary_limit_message" >"$fixtures/GET_${comments_key}.1.err"
printf '%s\n' "$primary_limit_message" >"$fixtures/POST_${comments_key}.1.err"
run_case 0
expect_log 'needs a 60s wait, more than the 0s left of rate-limit-wait-seconds (60); not waiting.'
expect_log '::notice::pr-contract: upserting the linkage comment was refused (HTTP 403); continuing without it'
if [[ "$(cat "$sleep_log")" != 60 ]]; then
  echo "FAIL: expected one 60s sleep, got: $(cat "$sleep_log")"
  failures=$((failures + 1))
fi
rm -f -- "$fixtures/GET_${comments_key}.1.err" "$fixtures/POST_${comments_key}.1.err"
set_comments '[]'

# --- the GraphQL read ------------------------------------------------------

# Without reading the GraphQL `errors` array a primary rate limit, which
# GraphQL answers with HTTP 200, is neither reported nor waited out, and a good
# pull request fails red on its first throttled read.
echo 'case: a GraphQL RATE_LIMITED error on HTTP 200 is reported as a rate limit, waited out, and retried'
set_comments '[]'
set_pull 'feat: add pr-contract' "$conforming_body" someone ''
printf '{"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for installation ID 1."}]}' >"$fixtures/${pull_key}.1.json"
printf 'HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 20\r\nX-Ratelimit-Resource: graphql\r\n' >"$fixtures/${pull_key}.1.headers"
run_case 0
expect_log '::warning::POST graphql returned HTTP 200 with GraphQL error RATE_LIMITED (rate-limit): API rate limit already exceeded for installation ID 1.; x-ratelimit-remaining=0 x-ratelimit-reset=20'
expect_log 'waiting 20s, then retrying once.'
expect_output 'title=pass'
expect_output 'linkage=pass'
if [[ "$(cat "$sleep_log")" != 20 ]]; then
  echo "FAIL: expected one 20s sleep, got: $(cat "$sleep_log")"
  failures=$((failures + 1))
fi

# Without the rate-limit classification, a throttled read past the cap would be
# reported as some other failure; it still fails closed.
echo 'case: a GraphQL RATE_LIMITED error beyond the cap fails closed as a rate limit'
printf 'HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 900\r\n' >"$fixtures/${pull_key}.1.headers"
run_case 1
expect_log "::error::pr-contract: could not read pull request ${repository}#${pr_number} (HTTP 200): rate limited past rate-limit-wait-seconds"
rm -f -- "$fixtures/${pull_key}".1.*

# Without the completeness check a label past the one page the read holds is
# never seen, and a pull request carrying do-not-merge there passes.
echo 'case: a GraphQL label page that does not hold every label fails closed'
set_pull 'feat: add pr-contract' "$conforming_body" someone ''
jq '.data.repository.pullRequest.labels.totalCount = 101' "$fixtures/${pull_key}.json" >"$fixtures/${pull_key}.json.tmp"
mv -- "$fixtures/${pull_key}.json.tmp" "$fixtures/${pull_key}.json"
run_case 1
expect_log "::error::pr-contract: pull request ${repository}#${pr_number} read over GraphQL lacks its title, body or complete label list; failing closed"
expect_no_output 'do-not-merge=pass'

# Without the field checks a read whose labels carry no nodes reads as no
# labels at all, and the do-not-merge gate passes on nothing.
echo 'case: a GraphQL read missing its label nodes fails closed'
set_pull 'feat: add pr-contract' "$conforming_body" someone 'do-not-merge'
jq 'del(.data.repository.pullRequest.labels.nodes)' "$fixtures/${pull_key}.json" >"$fixtures/${pull_key}.json.tmp"
mv -- "$fixtures/${pull_key}.json.tmp" "$fixtures/${pull_key}.json"
run_case 1
expect_log 'read over GraphQL lacks its title, body or complete label list; failing closed'
expect_no_output 'do-not-merge=pass'

# GraphQL answers a pull request it cannot resolve with `null`; that is a
# failed read, not an empty title and body.
echo 'case: a GraphQL read with no pull request in its data fails closed'
printf '{"data":{"repository":{"pullRequest":null}}}' >"$fixtures/${pull_key}.json"
run_case 1
expect_log 'read over GraphQL lacks its title, body or complete label list; failing closed'
expect_no_log 'does not follow Conventional Commits'

# Without failing on every `errors` entry whatever gh's exit status, data
# beside a FORBIDDEN error would be read as the pull request and pass.
echo 'case: a GraphQL FORBIDDEN error beside a complete pull request fails closed'
set_comments '[]'
set_pull 'feat: add pr-contract' "$conforming_body" someone ''
jq '.errors = [{"type":"FORBIDDEN","message":"Resource not accessible by integration"}]' "$fixtures/${pull_key}.json" >"$fixtures/${pull_key}.json.tmp"
mv -- "$fixtures/${pull_key}.json.tmp" "$fixtures/${pull_key}.json"
printf 'HTTP/2.0 200 OK\r\n' >"$fixtures/${pull_key}.headers"
: >"$fixtures/${pull_key}.exit0"
run_case 1
expect_log 'POST graphql returned HTTP 200 with GraphQL error FORBIDDEN (permission)'
expect_log "::error::pr-contract: could not read pull request ${repository}#${pr_number} (HTTP 200)"
expect_no_output 'title=pass'
rm -f -- "$fixtures/${pull_key}.headers" "$fixtures/${pull_key}.exit0"
set_pull 'feat: add pr-contract' "$conforming_body" someone ''

# Without the `[bot]` suffix a Bot author's GraphQL login never equals the
# REST login an exempt-authors entry names.
echo 'case: a Bot author read over GraphQL matches its REST login in exempt-authors'
set_pull 'build: bump a dependency' 'Bumps a thing.' 'dependabot[bot]' ''
run_case 0 'EXEMPT_AUTHORS=dependabot[bot]'
expect_output 'linkage=exempt'

# Without the comments in the GraphQL read, these two cases make REST reads of
# the pull request and its comments: 3 for the passing one (the comments
# twice) and 2 for the failing one at 8b41a59 (origin/main).
echo 'case: a conforming pull request makes no REST read'
set_comments "[$(bot_comment 1001 '<!-- pr-contract:linkage -->\nstale failure text')]"
set_pull 'feat: add pr-contract' "$conforming_body" someone ''
run_case 0
expect_gh_call "PATCH repos/${repository}/issues/comments/1001"
if [[ "$(grep -c -- '-X GET ' "$gh_log" || true)" -ne 0 || "$(grep -c -- '-X POST graphql ' "$gh_log" || true)" -ne 1 ]]; then
  echo 'FAIL: expected no REST read and one GraphQL read, got:'
  cat "$gh_log"
  failures=$((failures + 1))
fi

echo 'case: a failing pull request reads its marker comment from the GraphQL read'
set_pull 'feat: add pr-contract' 'nothing here' someone ''
run_case 0
expect_gh_call "PATCH repos/${repository}/issues/comments/1001"
expect_no_gh_call '-X GET '
set_comments '[]'

# --- comment-upsert capture ------------------------------------------------

# Without the `.user.type == "Bot"` filter the gate edits a stranger's planted
# comment instead of posting its own, and its guidance is never shown.
echo 'case: a planted marker comment from a user account does not capture the upsert'
set_comments "[$(user_comment 900 '<!-- pr-contract:linkage -->\nplanted by a stranger')]"
set_pull 'feat: add pr-contract' 'nothing here' someone ''
run_case 0
expect_gh_call "POST repos/${repository}/issues/${pr_number}/comments"
expect_no_gh_call 'PATCH repos/'

# Without newest-first selection an older bot comment would be edited and the
# newest one left carrying stale text.
echo 'case: the newest bot marker comment is the one edited'
set_comments "[$(bot_comment 900 '<!-- pr-contract:linkage -->\nold'),$(user_comment 950 '<!-- pr-contract:linkage -->\nplanted'),$(bot_comment 1200 '<!-- pr-contract:linkage -->\nnewer')]"
set_pull 'feat: add pr-contract' 'nothing here' someone ''
run_case 0
expect_gh_call "PATCH repos/${repository}/issues/comments/1200"

# Without `--slurp` jq runs once per page and prints one id per page, so the
# PATCH path carries both ids and the newest comment is not the one edited.
echo 'case: the newest bot marker comment is selected across pages'
comments_beyond_one_page
rm -f -- "$fixtures/GET_${comments_key}.json"
printf '[[%s],[%s]]' "$(bot_comment 900 '<!-- pr-contract:linkage -->\nold')" "$(bot_comment 1200 '<!-- pr-contract:linkage -->\nnewer')" \
  >"$fixtures/GET_${comments_key}.pages.json"
run_case 0
expect_gh_call "PATCH repos/${repository}/issues/comments/1200 "
expect_no_gh_call 'comments/900'
rm -f -- "$fixtures/GET_${comments_key}.pages.json"

# --- annotation escaping ---------------------------------------------------

# Without escaping, a title carrying a newline closes the annotation and the
# rest of the title is interpreted as a second workflow command.
echo 'case: an attacker-controlled title is escaped inside the annotation'
set_comments '[]'
set_pull 'wip: 100% broken'$'\n''::set-output name=x::y' "$conforming_body" someone ''
run_case 1
expect_output 'title=fail'
# Asserted as two independent facts: a CRLF title escapes to `%0D%0A`, so
# pinning the pair would make this case platform-dependent.
expect_log '100%25 broken'
expect_log '%0A::set-output'

# --- input validation ------------------------------------------------------
#
# Every one of these values is interpolated into a `gh api` path.

echo 'case: a malformed repository is rejected before any API call'
run_case 1 REPOSITORY='melodic-software/ci-workflows/../other'
expect_log '::error::pr-contract: repository must be OWNER/REPO'
expect_no_gh_calls_at_all

echo 'case: a non-numeric pr-number is rejected before any API call'
run_case 1 PR_NUMBER='7/../8'
expect_log '::error::pr-contract: pr-number must be a positive integer'
expect_no_gh_calls_at_all

# --- labels are not validated ----------------------------------------------
#
# GitHub labels may legally contain spaces and colons. Neither label reaches an
# API path unencoded, so rejecting those characters would break real consumers
# for no gain.

# Without dropping the label validation this run is rejected outright.
echo 'case: a blocking label containing spaces is accepted and matched exactly'
set_comments '[]'
set_pull 'feat: add pr-contract' "$conforming_body" someone 'do not merge'
run_case 1 'DO_NOT_MERGE_LABEL=do not merge'
expect_output 'do-not-merge=fail'
expect_log "::error::pr-contract: this PR carries the 'do not merge' label; remove it to merge."

echo 'case: a similar label containing spaces does not block'
set_pull 'feat: add pr-contract' "$conforming_body" someone 'do not merge yet'
run_case 0 'DO_NOT_MERGE_LABEL=do not merge'
expect_output 'do-not-merge=pass'

# Without `@uri` the encoder emitted code points, so a non-ASCII label reached
# the DELETE path mis-encoded and the label was never removed.
echo 'case: a non-ASCII linkage label is percent-encoded as UTF-8 in the DELETE path'
set_comments '[]'
set_pull 'feat: add pr-contract' "$conforming_body" someone 'needs-issue-linkage-é'
run_case 0 'LINKAGE_LABEL=needs-issue-linkage-é'
expect_output 'linkage=pass'
expect_gh_call "DELETE repos/${repository}/issues/${pr_number}/labels/needs-issue-linkage-%C3%A9"

# --- metadata contract -----------------------------------------------------

echo 'case: action.yml still wires every input this harness exercises'
action_metadata="$script_directory/action.yml"
for input_name in token repository pr-number types require-scope do-not-merge-label exempt-authors linkage-label linkage-mode issue-ref-pattern rate-limit-wait-seconds; do
  if ! grep -qE "^  ${input_name}:" "$action_metadata"; then
    echo "FAIL: action.yml declares no '${input_name}' input"
    failures=$((failures + 1))
  fi
done
for environment_name in GH_TOKEN REPOSITORY PR_NUMBER TYPES REQUIRE_SCOPE DO_NOT_MERGE_LABEL EXEMPT_AUTHORS LINKAGE_LABEL LINKAGE_MODE ISSUE_REF_PATTERN RATE_LIMIT_WAIT_SECONDS EVENT_NAME MERGE_GROUP_HEAD_REF; do
  if ! grep -qF "        ${environment_name}: " "$action_metadata"; then
    echo "FAIL: action.yml does not pass '${environment_name}' to run.sh"
    failures=$((failures + 1))
  fi
done
for output_name in title do-not-merge linkage; do
  if ! grep -qE "^  ${output_name}:" "$action_metadata"; then
    echo "FAIL: action.yml declares no '${output_name}' output"
    failures=$((failures + 1))
  fi
done

# Without this the action.yml default and the runner fallback could drift apart,
# and a caller setting nothing would get a grammar the tests never exercised.
echo 'case: the action.yml issue-ref-pattern default equals the runner default'
metadata_default="$(sed -n '/^  issue-ref-pattern:/,/^  [a-z]/s/^    default: '"'"'\(.*\)'"'"'$/\1/p' "$action_metadata")"
runner_default="$(sed -n "s/^DEFAULT_ISSUE_REF_PATTERN='\(.*\)'\$/\1/p" "$script_directory/run.sh")"
if [[ -z "$metadata_default" || "$metadata_default" != "$runner_default" ]]; then
  echo "FAIL: action.yml default '${metadata_default}' differs from run.sh default '${runner_default}'"
  failures=$((failures + 1))
fi

if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed."
  exit 1
fi
echo 'All pr-contract tests passed.'
