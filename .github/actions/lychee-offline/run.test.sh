#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

action_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
caller="$temporary_directory/caller"
fake_bin="$temporary_directory/bin"
mkdir -p -- "$caller" "$fake_bin"

# The fake records its arguments, one per line, and exits 0.
cat >"$fake_bin/lychee" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$CAPTURE"
FAKE
chmod +x "$fake_bin/lychee"
capture="$temporary_directory/args"

# A local repository stands in for melodic-software/standards.
standards="$temporary_directory/standards"
git -c init.defaultBranch=main init -q "$standards"
git -C "$standards" config uploadpack.allowAnySHA1InWant true
printf 'include_fragments = "full"\n' >"$standards/lychee.toml"
git -C "$standards" add lychee.toml
git -C "$standards" -c user.name=t -c user.email=t@example.invalid commit -qm standards
standards_sha="$(git -C "$standards" rev-parse HEAD)"
export STANDARDS_REF=main STANDARDS_URL="file://$standards" RUNNER_TEMP="$temporary_directory/runner-temp" GITHUB_STEP_SUMMARY=''
mkdir -p -- "$RUNNER_TEMP"
standards_copy="$RUNNER_TEMP/ci-workflows-standards/$standards_sha/lychee.toml"

failures=0
fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

# run <script> <config> [exclude]: runs in the caller tree; sets rc and out.
run() {
  rc=0
  out="$(cd "$caller" && PATH="$fake_bin:$PATH" CAPTURE="$capture" CONFIG="$2" \
    EXCLUDE="${3:-}" GLOBS='**/*.md' bash "$1" 2>&1)" || rc=$?
}

config_argument() {
  grep -A1 -x -- '--config' "$capture" | tail -n 1
}

# The caller's own lychee.toml wins when present.
printf 'include_fragments = "full"\n' >"$caller/lychee.toml"
run "$action_directory/run.sh" lychee.toml
[[ "$rc" -eq 0 ]] || fail "caller config: exit $rc ($out)"
used="$(config_argument)"
[[ "$used" == lychee.toml ]] || fail "caller config: lychee got --config $used"

# Without one, the default path falls back to standards' canonical copy.
rm -- "$caller/lychee.toml"
rm -f -- "$capture"
run "$action_directory/run.sh" lychee.toml
[[ "$rc" -eq 0 ]] || fail "standards config: exit $rc ($out)"
used="$(config_argument)"
[[ "$used" == "$standards_copy" ]] || fail "standards config: lychee got --config $used"
[[ "$out" == *"config $standards_copy"* ]] || fail "standards config: the log does not name the config used"

# A non-default path that does not exist fails without running lychee.
rm -f -- "$capture"
run "$action_directory/run.sh" docs/lychee.toml
[[ "$rc" -eq 2 ]] || fail "missing custom config: exit $rc, want 2"
[[ ! -f "$capture" ]] || fail "missing custom config: lychee ran"

# A standards commit without the ruleset fails loudly rather than running unconfigured.
rm -f -- "$capture"
git -C "$standards" rm -q lychee.toml
git -C "$standards" -c user.name=t -c user.email=t@example.invalid commit -qm 'drop lychee.toml'
STANDARDS_REF="$(git -C "$standards" rev-parse HEAD)" run "$action_directory/run.sh" lychee.toml
[[ "$rc" -eq 2 ]] || fail "missing standards config: exit $rc, want 2"
[[ "$out" == *"has no lychee.toml"* ]] || fail "missing standards config: unexpected message ($out)"
[[ ! -f "$capture" ]] || fail "missing standards config: lychee ran"

# Exclude regexes pass through unexpanded, one --exclude-path each.
run "$action_directory/run.sh" lychee.toml '(^|/)fixtures/ docs/*/captured/'
[[ "$rc" -eq 0 ]] || fail "exclude: exit $rc ($out)"
[[ "$(grep -c -x -- '--exclude-path' "$capture")" -eq 2 ]] || fail "exclude: want two --exclude-path"
grep -q -x -F -- 'docs/*/captured/' "$capture" || fail "exclude: a regex was expanded or dropped"

if [[ "$failures" -ne 0 ]]; then
  printf '%s failure(s)\n' "$failures"
  exit 1
fi
echo "lychee-offline run.sh: all checks passed"
