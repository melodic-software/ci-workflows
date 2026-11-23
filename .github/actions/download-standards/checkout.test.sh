#!/usr/bin/env bash
# shellcheck shell=bash
# Exercises resolve.sh, checkout.sh and lib.sh's standards_config against a
# local stand-in for melodic-software/standards, with no network.
set -euo pipefail

action_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

failures=0
fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

upstream="$temporary_directory/standards"
git -c init.defaultBranch=main init -q "$upstream"
git -C "$upstream" config uploadpack.allowAnySHA1InWant true
commit() {
  printf '%s\n' "$2" >"$upstream/$1"
  git -C "$upstream" add -- "$1"
  git -C "$upstream" -c user.name=t -c user.email=t@example.invalid commit -q -m "$1"
  git -C "$upstream" rev-parse HEAD
}
first="$(commit .gitleaks.toml first)"

export STANDARDS_URL="file://$upstream"
export GITHUB_STEP_SUMMARY="$temporary_directory/summary"
# new_job: each job starts with an empty RUNNER_TEMP.
new_job() {
  export RUNNER_TEMP="$temporary_directory/job-$1"
  mkdir -p -- "$RUNNER_TEMP"
  : >"$GITHUB_STEP_SUMMARY"
}

# run <script>: sets rc, out (stdout) and err (stderr).
run() {
  rc=0
  out="$(bash "$action_directory/$1" 2>"$temporary_directory/err")" || rc=$?
  err="$(<"$temporary_directory/err")"
}

# A branch resolves to its tip, recorded once in the step summary.
new_job 1
STANDARDS_REF=main run resolve.sh
[[ $rc -eq 0 ]] || fail "resolve main: exit $rc ($err)"
[[ $out == "$first" ]] || fail "resolve main: got '$out', want $first"
grep -qF "\`$first\`" "$GITHUB_STEP_SUMMARY" || fail "resolve main: the summary does not record $first"

# The checkout is that commit, outside the workspace, with no remote stored.
STANDARDS_REF=main run checkout.sh
[[ $rc -eq 0 ]] || fail "checkout main: exit $rc ($err)"
[[ $out == "$RUNNER_TEMP/ci-workflows-standards/$first" ]] || fail "checkout main: path '$out'"
[[ "$(git -C "$out" rev-parse HEAD)" == "$first" ]] || fail "checkout main: HEAD is not $first"
[[ -z "$(git -C "$out" remote)" ]] || fail "checkout main: a remote is configured"
[[ "$(<"$out/.gitleaks.toml")" == first ]] || fail "checkout main: wrong content"
[[ "$(grep -c . "$GITHUB_STEP_SUMMARY")" -eq 1 ]] || fail "checkout main: the commit was recorded twice"

# main moves mid-job: the job keeps the commit it resolved first.
second="$(commit .gitleaks.toml second)"
STANDARDS_REF=main run checkout.sh
[[ $out == "$RUNNER_TEMP/ci-workflows-standards/$first" ]] || fail "same job: main moved under the job ($out)"

# Another job given the first job's SHA reads that commit, not main's tip.
new_job 2
STANDARDS_REF="$first" run checkout.sh
[[ $rc -eq 0 ]] || fail "passed SHA: exit $rc ($err)"
[[ "$(<"$out/.gitleaks.toml")" == first ]] || fail "passed SHA: did not read $first"
grep -qF "\`$first\`" "$GITHUB_STEP_SUMMARY" || fail "passed SHA: the summary does not record $first"

# A fresh job on main reads the new tip.
new_job 3
STANDARDS_REF=main run checkout.sh
[[ "$(git -C "$out" rev-parse HEAD)" == "$second" ]] || fail "new job: did not read the new tip"

# A checkout already in the job is reused without the network.
STANDARDS_URL="file://$temporary_directory/absent" STANDARDS_REF="$second" run checkout.sh
[[ $rc -eq 0 ]] || fail "reuse: exit $rc ($err)"

# Not a branch name, a missing branch, or an unreachable source fails.
new_job 4
STANDARDS_REF='bad..ref' run resolve.sh
[[ $rc -ne 0 && $err == *"neither a full commit SHA nor a branch name"* ]] || fail "bad ref: exit $rc ($err)"
STANDARDS_REF=absent run resolve.sh
[[ $rc -ne 0 && $err == *"has no branch absent"* ]] || fail "missing branch: exit $rc ($err)"
STANDARDS_URL="file://$temporary_directory/absent" STANDARDS_REF="$second" run checkout.sh
[[ $rc -ne 0 && $err == *"failed after 3 tries"* ]] || fail "unreachable: exit $rc ($err)"

# standards_config: the fallback order a reader's config follows.
caller="$temporary_directory/caller"
mkdir -p -- "$caller/docs"
# config <given> <default> <source>: sets rc, out and err from the caller tree.
config() {
  rc=0
  out="$(cd "$caller" && bash -c 'source "$1/lib.sh"; standards_config "$2" "$3" "$4"' _ \
    "$action_directory" "$@" 2>"$temporary_directory/err")" || rc=$?
  err="$(<"$temporary_directory/err")"
}
new_job 5
export STANDARDS_REF="$first"

printf 'own\n' >"$caller/.gitleaks.toml"
config .gitleaks.toml .gitleaks.toml .gitleaks.toml
[[ $rc -eq 0 && $out == .gitleaks.toml ]] || fail "in-tree copy: got '$out' (exit $rc)"
[[ ! -d $RUNNER_TEMP/ci-workflows-standards/$first ]] || fail "in-tree copy: standards was fetched"

ln -s missing "$caller/link.toml"
config link.toml link.toml .gitleaks.toml
[[ $rc -eq 0 && $out == link.toml ]] || fail "in-tree symlink: got '$out' (exit $rc)"

rm -- "$caller/.gitleaks.toml"
config .gitleaks.toml .gitleaks.toml .gitleaks.toml
[[ $rc -eq 0 && $out == "$RUNNER_TEMP/ci-workflows-standards/$first/.gitleaks.toml" ]] ||
  fail "no in-tree copy: got '$out' (exit $rc, $err)"
[[ $err == *"using .gitleaks.toml from melodic-software/standards at $first"* ]] ||
  fail "no in-tree copy: the log does not name the standards commit"

config docs/.gitleaks.toml .gitleaks.toml .gitleaks.toml
[[ $rc -eq 2 && -z $out ]] || fail "missing non-default path: got '$out' (exit $rc)"

config .gitleaks.toml .gitleaks.toml absent.toml
[[ $rc -eq 2 && $err == *"has no absent.toml"* ]] || fail "missing standards file: exit $rc ($err)"

if ((failures > 0)); then
  printf '%d download-standards test(s) failed\n' "$failures"
  exit 1
fi
echo 'download-standards tests passed'
