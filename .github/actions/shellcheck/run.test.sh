#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

action_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
repository="$temporary_directory/repository with spaces"
fake_bin="$temporary_directory/bin"
captures="$temporary_directory/captures"
mkdir -p -- "$repository/empty" "$repository/nested" "$repository/raw" "$fake_bin" "$captures"

cat >"$fake_bin/shellcheck" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -f "$CAPTURE_DIR/count" ]] || read -r count <"$CAPTURE_DIR/count"
count=$((count + 1))
printf '%s\n' "$count" >"$CAPTURE_DIR/count"
printf '%s\0' "$@" >"$CAPTURE_DIR/$count.args"
exit "${FAKE_STATUS:-0}"
FAKE
chmod +x "$fake_bin/shellcheck"

printf 'shell=bash\n' >"$repository/.shellcheckrc"
printf '#!/usr/bin/env bash\ntrue\n' >"$repository/script.sh"
printf '#!/usr/bin/env bash\ntrue\n' >"$repository/nested/tool.bash"
printf 'source ~/.bashrc.local\n' >"$repository/dot_bashrc"
printf 'source ~/.bash_profile.local\n' >"$repository/dot bash profile"
printf '#!/usr/bin/env bash\ntrue\n' >"$repository/raw/untracked.sh"
printf 'ignored*\nraw/\n' >"$repository/.gitignore"
printf 'source ignored\n' >"$repository/ignored_extensionless"

git -C "$repository" init -q
git -C "$repository" -c core.autocrlf=false add \
  .shellcheckrc script.sh nested/tool.bash dot_bashrc 'dot bash profile' .gitignore

reset_captures() {
  rm -f -- "$captures"/*
}

run_action() {
  local expected_status="$1"
  shift
  local actual_status output
  reset_captures
  set +e
  output="$(
    cd "$repository"
    env \
      CAPTURE_DIR="$captures" \
      EXCLUDE='' \
      EXTRA_EXCLUDE_CODES='' \
      EXTRA_GLOBS='' \
      FAKE_STATUS=0 \
      PATH="$fake_bin:$PATH" \
      PATHS='' \
      RCFILE=.shellcheckrc \
      SEVERITY='' \
      "$@" \
      bash "$action_directory/run.sh" 2>&1
  )"
  actual_status=$?
  set -e
  if [[ "$actual_status" != "$expected_status" ]]; then
    printf 'FAIL: expected status %s, got %s\n%s\n' "$expected_status" "$actual_status" "$output" >&2
    return 1
  fi
  ACTION_OUTPUT="$output"
}

load_args() {
  local invocation="$1"
  captured_args=()
  mapfile -d '' -t captured_args <"$captures/$invocation.args"
}

assert_contains() {
  local name="$1" expected="$2"
  shift 2
  local actual
  for actual in "$@"; do
    [[ "$actual" != "$expected" ]] || {
      printf 'PASS: %s\n' "$name"
      return 0
    }
  done
  printf 'FAIL: %s did not contain %q\n' "$name" "$expected" >&2
  return 1
}

assert_not_contains() {
  local name="$1" unexpected="$2"
  shift 2
  local actual
  for actual in "$@"; do
    [[ "$actual" != "$unexpected" ]] || {
      printf 'FAIL: %s unexpectedly contained %q\n' "$name" "$unexpected" >&2
      return 1
    }
  done
  printf 'PASS: %s\n' "$name"
}

run_action 0
load_args 1
[[ ! -e "$captures/2.args" ]]
assert_contains 'default discovery keeps tracked .sh' script.sh "${captured_args[@]}"
assert_contains 'default discovery keeps tracked .bash' nested/tool.bash "${captured_args[@]}"
assert_not_contains 'default discovery skips extensionless files' dot_bashrc "${captured_args[@]}"
assert_not_contains 'default discovery skips raw untracked files' raw/untracked.sh "${captured_args[@]}"

run_action 0 \
  EXTRA_GLOBS=$'dot_bash*\ndot bash*' \
  EXTRA_EXCLUDE_CODES=SC1090,SC1091 \
  SEVERITY=warning
load_args 1
assert_contains 'standard lane retains configured severity' --severity=warning "${captured_args[@]}"
assert_not_contains 'standard lane does not inherit extra suppressions' --exclude=SC1090,SC1091 "${captured_args[@]}"
load_args 2
assert_contains 'extra glob selects extensionless file' dot_bashrc "${captured_args[@]}"
assert_contains 'one pathspec line preserves spaces' 'dot bash profile' "${captured_args[@]}"
assert_contains 'extra lane receives scoped suppressions' --exclude=SC1090,SC1091 "${captured_args[@]}"

run_action 0 \
  PATHS=empty \
  EXTRA_GLOBS=dot_bashrc \
  EXTRA_EXCLUDE_CODES=SC1090,SC1091
load_args 1
[[ ! -e "$captures/2.args" ]]
assert_contains 'extra-only discovery checks an extensionless file' dot_bashrc "${captured_args[@]}"
assert_contains 'extra-only discovery keeps scoped suppressions' --exclude=SC1090,SC1091 "${captured_args[@]}"

run_action 0 PATHS=empty EXTRA_GLOBS=does-not-match
[[ ! -e "$captures/1.args" ]]
grep -F 'No shell scripts to check.' <<<"$ACTION_OUTPUT" >/dev/null
printf 'PASS: empty primary and extra discovery exits cleanly\n'

run_action 0 EXTRA_GLOBS=$'*.sh\ndot_bash*'
load_args 1
assert_contains 'overlap keeps normal file in strict lane' script.sh "${captured_args[@]}"
load_args 2
assert_not_contains 'overlap removes normal file from extra lane' script.sh "${captured_args[@]}"
assert_contains 'overlap still keeps extensionless extra' dot_bashrc "${captured_args[@]}"

run_action 0 EXTRA_GLOBS='ignored*'
load_args 1
[[ ! -e "$captures/2.args" ]]
assert_not_contains 'extra discovery does not include ignored untracked files' ignored_extensionless "${captured_args[@]}"

run_action 0 PATHS=raw
load_args 1
assert_contains 'explicit roots preserve raw untracked discovery' raw/untracked.sh "${captured_args[@]}"

run_action 0 \
  EXCLUDE=profile \
  EXTRA_GLOBS=$'dot_bash*\ndot bash*'
load_args 2
assert_contains 'path exclusion retains other extras' dot_bashrc "${captured_args[@]}"
assert_not_contains 'path exclusion also filters extras' 'dot bash profile' "${captured_args[@]}"

run_action 2 EXTRA_EXCLUDE_CODES=SC1090,SC1091
[[ ! -e "$captures/1.args" ]]
grep -F 'extra-exclude-codes requires at least one extra-globs entry' <<<"$ACTION_OUTPUT" >/dev/null
printf 'PASS: orphaned extra suppressions fail closed\n'

run_action 2 EXTRA_GLOBS=dot_bashrc EXTRA_EXCLUDE_CODES='SC1090, SC1091'
[[ ! -e "$captures/1.args" ]]
grep -F 'must be comma-separated SC codes' <<<"$ACTION_OUTPUT" >/dev/null
printf 'PASS: malformed suppression list fails closed\n'

run_action 2 EXTRA_GLOBS=':(attr'
[[ ! -e "$captures/1.args" ]]
grep -F 'Git-tracked extra discovery failed' <<<"$ACTION_OUTPUT" >/dev/null
printf 'PASS: invalid extra pathspec fails closed before ShellCheck\n'

run_action 1 EXTRA_GLOBS=dot_bashrc FAKE_STATUS=1
[[ -e "$captures/1.args" && -e "$captures/2.args" ]]
printf 'PASS: ShellCheck findings propagate after both lanes run\n'

grep -F "EXTRA_GLOBS: \${{ inputs.extra-globs }}" "$action_directory/action.yml" >/dev/null
grep -F "EXTRA_EXCLUDE_CODES: \${{ inputs.extra-exclude-codes }}" "$action_directory/action.yml" >/dev/null
grep -F "run: bash \"\$GITHUB_ACTION_PATH/run.sh\"" "$action_directory/action.yml" >/dev/null
printf 'PASS: action metadata forwards the new inputs to the tested runner\n'
