#!/usr/bin/env bash
# shellcheck shell=bash
# Config resolution of the markdownlint runner against a fake npx and a local
# stand-in for melodic-software/standards, with no network.
set -euo pipefail

action_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
caller="$temporary_directory/caller"
fake_bin="$temporary_directory/bin"
mkdir -p -- "$caller" "$fake_bin"

# The fake records its arguments, one per line, and exits FAKE_STATUS.
cat >"$fake_bin/npx" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$CAPTURE"
exit "${FAKE_STATUS:-0}"
FAKE
chmod +x "$fake_bin/npx"
capture="$temporary_directory/args"

# A local repository stands in for melodic-software/standards.
standards="$temporary_directory/standards"
git -c init.defaultBranch=main init -q "$standards"
git -C "$standards" config uploadpack.allowAnySHA1InWant true
printf '{ "config": { "MD013": false } }\n' >"$standards/.markdownlint-cli2.jsonc"
git -C "$standards" add .markdownlint-cli2.jsonc
git -C "$standards" -c user.name=t -c user.email=t@example.invalid commit -qm standards
standards_sha="$(git -C "$standards" rev-parse HEAD)"
export STANDARDS_REF=main STANDARDS_URL="file://$standards" RUNNER_TEMP="$temporary_directory/runner-temp" GITHUB_STEP_SUMMARY=''
mkdir -p -- "$RUNNER_TEMP"
standards_copy="$RUNNER_TEMP/ci-workflows-standards/$standards_sha/.markdownlint-cli2.jsonc"

failures=0
fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

# run <config>: runs in the caller tree; sets rc and out.
run() {
  rc=0
  rm -f -- "$capture"
  out="$(cd "$caller" && PATH="$fake_bin:$PATH" CAPTURE="$capture" CONFIG="$1" \
    ANNOTATIONS=true VERSION=0.0.0 MATCHER=/matcher.json GLOBS='**/*.md !fixtures/**' \
    bash "$action_directory/run.sh" 2>&1)" || rc=$?
}

config_argument() {
  grep -A1 -x -- '--config' "$capture" | tail -n 1
}

# The caller's own config wins when present; globs pass through unexpanded.
printf '{}\n' >"$caller/.markdownlint-cli2.jsonc"
run .markdownlint-cli2.jsonc
[[ "$rc" -eq 0 ]] || fail "caller config: exit $rc ($out)"
used="$(config_argument)"
[[ "$used" == .markdownlint-cli2.jsonc ]] || fail "caller config: markdownlint-cli2 got --config $used"
grep -qx -F -- 'markdownlint-cli2@0.0.0' "$capture" || fail "caller config: the pinned version was not run"
grep -qx -F -- '!fixtures/**' "$capture" || fail "caller config: a glob was expanded or dropped"
[[ ! -d "$RUNNER_TEMP/ci-workflows-standards/$standards_sha" ]] || fail "caller config: standards was fetched"

# Without one, the default path falls back to standards' copy.
rm -- "$caller/.markdownlint-cli2.jsonc"
run .markdownlint-cli2.jsonc
[[ "$rc" -eq 0 ]] || fail "standards config: exit $rc ($out)"
used="$(config_argument)"
[[ "$used" == "$standards_copy" ]] || fail "standards config: markdownlint-cli2 got --config $used"
[[ "$out" == *"config $standards_copy"* ]] || fail "standards config: the log does not name the config used"

# Findings fail the step, and the matcher is removed either way.
FAKE_STATUS=1 run .markdownlint-cli2.jsonc
[[ "$rc" -eq 1 ]] || fail "findings: exit $rc, want 1"
[[ "$out" == *"::remove-matcher owner=markdownlint-cli2::"* ]] || fail "findings: the matcher was left registered"

# A non-default path that does not exist fails without running markdownlint-cli2.
run docs/.markdownlint-cli2.jsonc
[[ "$rc" -eq 2 ]] || fail "missing custom config: exit $rc, want 2"
[[ ! -f "$capture" ]] || fail "missing custom config: markdownlint-cli2 ran"

# A standards commit without the config fails loudly rather than running unconfigured.
git -C "$standards" rm -q .markdownlint-cli2.jsonc
git -C "$standards" -c user.name=t -c user.email=t@example.invalid commit -qm 'drop config'
STANDARDS_REF="$(git -C "$standards" rev-parse HEAD)" run .markdownlint-cli2.jsonc
[[ "$rc" -eq 2 ]] || fail "missing standards config: exit $rc, want 2"
[[ "$out" == *"has no .markdownlint-cli2.jsonc"* ]] || fail "missing standards config: unexpected message ($out)"
[[ ! -f "$capture" ]] || fail "missing standards config: markdownlint-cli2 ran"

grep -qF "STANDARDS_REF: \${{ inputs.standards-ref }}" "$action_directory/action.yml" ||
  fail "action.yml does not forward standards-ref"
grep -qF "run: bash \"\$GITHUB_ACTION_PATH/run.sh\"" "$action_directory/action.yml" ||
  fail "action.yml does not run the tested runner"

if [[ "$failures" -ne 0 ]]; then
  printf '%s failure(s)\n' "$failures"
  exit 1
fi
echo "markdownlint run.sh: all checks passed"
