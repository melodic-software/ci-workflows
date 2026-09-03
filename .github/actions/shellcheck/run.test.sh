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
# Batches run concurrently under the fan-out, so the invocation counter is
# taken under a mkdir lock (atomic on every filesystem the runners use).
until mkdir "$CAPTURE_DIR/.lock" 2>/dev/null; do sleep 0.01; done
count=0
[[ ! -f "$CAPTURE_DIR/count" ]] || read -r count <"$CAPTURE_DIR/count"
count=$((count + 1))
printf '%s\n' "$count" >"$CAPTURE_DIR/count"
rmdir "$CAPTURE_DIR/.lock"
printf '%s\0' "$@" >"$CAPTURE_DIR/$count.args"
printf 'fake shellcheck invocation %s\n' "$count"
# FAKE_STATUS applies to every invocation. With FAKE_STATUS_MATCH set to
# `substring=code[,substring=code...]`, an invocation exits with the code of
# the first pair whose substring appears in its arguments and 0 otherwise, so
# one fan-out run can give different batches different results.
if [[ -n "${FAKE_STATUS_MATCH:-}" ]]; then
  IFS=',' read -r -a pairs <<<"$FAKE_STATUS_MATCH"
  for pair in "${pairs[@]}"; do
    for arg in "$@"; do
      [[ "$arg" == *"${pair%%=*}"* ]] && exit "${pair#*=}"
    done
  done
  exit 0
fi
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
      FAKE_STATUS_MATCH='' \
      PATH="$fake_bin:$PATH" \
      PATHS='' \
      RCFILE=.shellcheckrc \
      SEVERITY='' \
      SHELLCHECK_BATCH_SIZE=40 \
      SHELLCHECK_JOBS=4 \
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

# --- fan-out ------------------------------------------------------------------

run_action 2 SHELLCHECK_JOBS=0
[[ ! -e "$captures/1.args" ]]
grep -F 'must be positive integers' <<<"$ACTION_OUTPUT" >/dev/null
printf 'PASS: a non-positive fan-out knob fails closed before ShellCheck\n'

# A batch size of 1 makes the batch count observable: two standard files are two
# invocations, and the extra lane still runs after the whole standard lane.
run_action 0 SHELLCHECK_BATCH_SIZE=1 SHELLCHECK_JOBS=2 EXTRA_GLOBS=dot_bashrc
[[ -e "$captures/3.args" && ! -e "$captures/4.args" ]]
batch_files=()
for invocation in 1 2; do
  load_args "$invocation"
  assert_contains "single-file batch $invocation keeps the rcfile" --rcfile=.shellcheckrc "${captured_args[@]}"
  for arg in "${captured_args[@]}"; do
    [[ "$arg" == --* ]] || batch_files+=("$arg")
  done
done
[[ ${#batch_files[@]} -eq 2 ]]
assert_contains 'single-file batches cover script.sh' script.sh "${batch_files[@]}"
assert_contains 'single-file batches cover nested/tool.bash' nested/tool.bash "${batch_files[@]}"
load_args 3
assert_contains 'extra lane starts only after the standard batches finish' dot_bashrc "${captured_args[@]}"

# 85 more tracked scripts make 87 standard files: three batches at the default
# size of 40, run four at a time, then the extra lane as a fourth invocation.
mkdir -p -- "$repository/fanout"
for i in $(seq -w 1 85); do
  printf '#!/usr/bin/env bash\ntrue\n' >"$repository/fanout/f$i.sh"
done
git -C "$repository" -c core.autocrlf=false add fanout
run_action 0 EXTRA_GLOBS=dot_bashrc
[[ -e "$captures/4.args" && ! -e "$captures/5.args" ]]
grep -F 'in batches of 40 across 4 process(es)' <<<"$ACTION_OUTPUT" >/dev/null
all_files=()
for invocation in 1 2 3; do
  load_args "$invocation"
  assert_contains "batch $invocation carries the rcfile" --rcfile=.shellcheckrc "${captured_args[@]}"
  for arg in "${captured_args[@]}"; do
    [[ "$arg" == --* ]] || all_files+=("$arg")
  done
done
assert_contains 'fan-out covers the first new file' fanout/f01.sh "${all_files[@]}"
assert_contains 'fan-out covers the last new file' fanout/f85.sh "${all_files[@]}"
assert_contains 'fan-out keeps the pre-existing scripts' script.sh "${all_files[@]}"
if [[ ${#all_files[@]} -ne 87 || "$(printf '%s\n' "${all_files[@]}" | sort -u | wc -l | tr -d ' ')" -ne 87 ]]; then
  printf 'FAIL: expected 87 distinct files across the batches, got %s\n' "${#all_files[@]}" >&2
  exit 1
fi
printf 'PASS: batches partition the file list without duplication\n'
load_args 4
assert_contains 'extra lane runs after the fanned-out standard lane' dot_bashrc "${captured_args[@]}"
# Batch outputs are replayed in batch order once every batch has finished, so
# the three invocation lines appear in the log in one block rather than
# interleaved with each other.
if [[ "$(grep -c '^fake shellcheck invocation' <<<"$ACTION_OUTPUT")" -ne 4 ]]; then
  printf 'FAIL: expected every batch output to be replayed once\n%s\n' "$ACTION_OUTPUT" >&2
  exit 1
fi
printf 'PASS: every batch output is replayed exactly once\n'

# The exit status is the maximum over the batches: a processing error (2) in
# one batch outranks findings (1) in another and a clean third batch, and
# findings alone still fail the action when every other batch is clean.
run_action 2 FAKE_STATUS_MATCH='fanout/f50.sh=2,fanout/f01.sh=1'
printf 'PASS: the most severe batch status is the action status\n'
run_action 1 FAKE_STATUS_MATCH='fanout/f50.sh=1'
printf 'PASS: findings in one batch fail the action when the other batches are clean\n'

grep -F "EXTRA_GLOBS: \${{ inputs.extra-globs }}" "$action_directory/action.yml" >/dev/null
grep -F "EXTRA_EXCLUDE_CODES: \${{ inputs.extra-exclude-codes }}" "$action_directory/action.yml" >/dev/null
grep -F "run: bash \"\$GITHUB_ACTION_PATH/run.sh\"" "$action_directory/action.yml" >/dev/null
printf 'PASS: action metadata forwards the new inputs to the tested runner\n'
