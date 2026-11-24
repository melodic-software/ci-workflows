#!/usr/bin/env bash
# shellcheck shell=bash
# Config resolution of the typos runner against a fake typos and a local
# stand-in for melodic-software/standards, with no network.
set -euo pipefail

action_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
caller="$temporary_directory/caller"
fake_bin="$temporary_directory/bin"
mkdir -p -- "$caller" "$fake_bin"

# The fake appends one line per invocation: its arguments, each ending in a
# unit separator. It prints nothing, so the annotation pass's jq reads no input.
cat >"$fake_bin/typos" <<'FAKE'
#!/usr/bin/env bash
{ printf '%s\x1f' "$@"; printf '\n'; } >>"$CAPTURE"
FAKE
chmod +x "$fake_bin/typos"
capture="$temporary_directory/args"

# A local repository stands in for melodic-software/standards.
standards="$temporary_directory/standards"
git -c init.defaultBranch=main init -q "$standards"
git -C "$standards" config uploadpack.allowAnySHA1InWant true
printf '[default]\nlocale = "en-us"\n' >"$standards/_typos.toml"
git -C "$standards" add _typos.toml
git -C "$standards" -c user.name=t -c user.email=t@example.invalid commit -qm standards
standards_sha="$(git -C "$standards" rev-parse HEAD)"
export STANDARDS_REF=main STANDARDS_URL="file://$standards" RUNNER_TEMP="$temporary_directory/runner-temp" GITHUB_STEP_SUMMARY=''
mkdir -p -- "$RUNNER_TEMP"
standards_copy="$RUNNER_TEMP/ci-workflows-standards/$standards_sha/_typos.toml"

failures=0
fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

# run <config> [annotations]: runs in the caller tree; sets rc and out.
run() {
  rc=0
  rm -f -- "$capture"
  out="$(cd "$caller" && PATH="$fake_bin:$PATH" CAPTURE="$capture" CONFIG="$1" \
    ANNOTATIONS="${2:-false}" PATHS=. bash "$action_directory/run.sh" 2>&1)" || rc=$?
}

# config_arguments: the --config value of each invocation, one per line.
config_arguments() {
  local line
  local -a args
  while IFS= read -r line; do
    IFS=$'\x1f' read -r -a args <<<"$line"
    for i in "${!args[@]}"; do
      [[ ${args[i]} != --config ]] || printf '%s\n' "${args[i + 1]}"
    done
  done <"$capture"
}

# The caller's own _typos.toml wins when present.
printf '[default]\n' >"$caller/_typos.toml"
run _typos.toml
[[ "$rc" -eq 0 ]] || fail "caller config: exit $rc ($out)"
used="$(config_arguments)"
[[ "$used" == _typos.toml ]] || fail "caller config: typos got --config $used"
[[ ! -d "$RUNNER_TEMP/ci-workflows-standards/$standards_sha" ]] || fail "caller config: standards was fetched"

# Without one, the default path falls back to standards' copy, in both the
# annotation and the gate pass.
rm -- "$caller/_typos.toml"
run _typos.toml true
[[ "$rc" -eq 0 ]] || fail "standards config: exit $rc ($out)"
used="$(config_arguments)"
[[ "$used" == "$standards_copy"$'\n'"$standards_copy" ]] || fail "standards config: typos got --config $used"
[[ "$out" == *"config $standards_copy"* ]] || fail "standards config: the log does not name the config used"

# A non-default path that does not exist fails without running typos.
run docs/_typos.toml
[[ "$rc" -eq 2 ]] || fail "missing custom config: exit $rc, want 2"
[[ ! -f "$capture" ]] || fail "missing custom config: typos ran"

# A standards commit without the config fails loudly rather than running unconfigured.
git -C "$standards" rm -q _typos.toml
git -C "$standards" -c user.name=t -c user.email=t@example.invalid commit -qm 'drop _typos.toml'
STANDARDS_REF="$(git -C "$standards" rev-parse HEAD)" run _typos.toml
[[ "$rc" -eq 2 ]] || fail "missing standards config: exit $rc, want 2"
[[ "$out" == *"has no _typos.toml"* ]] || fail "missing standards config: unexpected message ($out)"
[[ ! -f "$capture" ]] || fail "missing standards config: typos ran"

grep -qF "STANDARDS_REF: \${{ inputs.standards-ref }}" "$action_directory/action.yml" ||
  fail "action.yml does not forward standards-ref"
grep -qF "run: bash \"\$GITHUB_ACTION_PATH/run.sh\"" "$action_directory/action.yml" ||
  fail "action.yml does not run the tested runner"

if [[ "$failures" -ne 0 ]]; then
  printf '%s failure(s)\n' "$failures"
  exit 1
fi
echo "typos run.sh: all checks passed"
