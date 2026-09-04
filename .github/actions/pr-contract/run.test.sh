#!/usr/bin/env bash
# shellcheck shell=bash
# Fixture harness for the pr-contract runner: Conventional Commits title, the
# do-not-merge label gate, and the ported issue-linkage rule with its advisory
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
pull_key="GET_repos_melodic-software_ci-workflows_pulls_${pr_number}"
comments_key="repos_melodic-software_ci-workflows_issues_${pr_number}_comments"
labels_key="repos_melodic-software_ci-workflows_issues_${pr_number}_labels"

# A `gh` shim first on PATH: it serves fixture JSON keyed by method plus API
# path, records every call and every request body so the harness can assert on
# writes that did and did not happen, and can fail a keyed call on demand.
cat >"$shim_directory/gh" <<'SHIM'
#!/usr/bin/env bash
set -uo pipefail

printf '%s\n' "$*" >>"$GH_LOG"

method=GET
path=""
input=""
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

if [[ -f "$GH_FIXTURES/${key}.json" ]]; then
  cat "$GH_FIXTURES/${key}.json"
  exit 0
fi

echo '{}'
SHIM
chmod +x "$shim_directory/gh"

# set_pull <title> <body> <author> <labels-csv>
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
      draft: false,
      user: {login: $author},
      labels: ($labels | if . == "" then [] else split(",") end | map({name: .}))
    }' >"$fixtures/${pull_key}.json"
}

set_comments() {
  printf '%s' "$1" >"$fixtures/GET_${comments_key}.json"
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
  rm -rf -- "$calls"
  mkdir -p "$calls"
  set +e
  env \
    PATH="$shim_directory:$PATH" \
    GH_LOG="$gh_log" \
    GH_FIXTURES="$fixtures" \
    GH_CALLS="$calls" \
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

expect_log() {
  local expected="$1"
  if ! grep -qF -- "$expected" "$log_file"; then
    echo "FAIL: expected log to contain '$expected', got:"
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
expect_no_gh_call 'gh api'

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
expect_log "::error::pr-contract: could not read repos/${repository}/pulls/${pr_number} (HTTP 404)"
rm -f -- "$fixtures/${pull_key}.err"
mv -- "$fixtures/${pull_key}.json.bak" "$fixtures/${pull_key}.json"

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
expect_no_gh_call 'gh api'

echo 'case: a non-numeric pr-number is rejected before any API call'
run_case 1 PR_NUMBER='7/../8'
expect_log '::error::pr-contract: pr-number must be a positive integer'
expect_no_gh_call 'gh api'

echo 'case: a do-not-merge-label carrying a path separator is rejected'
run_case 1 DO_NOT_MERGE_LABEL='../../x'
expect_log "::error::pr-contract: do-not-merge-label must be free of '/', '?', '#' and whitespace"
expect_no_gh_call 'gh api'

echo 'case: a linkage-label carrying whitespace is rejected'
run_case 1 'LINKAGE_LABEL=needs issue linkage'
expect_log "::error::pr-contract: linkage-label must be free of '/', '?', '#' and whitespace"
expect_no_gh_call 'gh api'

# --- metadata contract -----------------------------------------------------

echo 'case: action.yml still wires every input this harness exercises'
action_metadata="$script_directory/action.yml"
for input_name in token repository pr-number types require-scope do-not-merge-label exempt-authors linkage-label linkage-mode; do
  if ! grep -qE "^  ${input_name}:" "$action_metadata"; then
    echo "FAIL: action.yml declares no '${input_name}' input"
    failures=$((failures + 1))
  fi
done
for environment_name in GH_TOKEN REPOSITORY PR_NUMBER TYPES REQUIRE_SCOPE DO_NOT_MERGE_LABEL EXEMPT_AUTHORS LINKAGE_LABEL LINKAGE_MODE; do
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

if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed."
  exit 1
fi
echo 'All pr-contract tests passed.'
