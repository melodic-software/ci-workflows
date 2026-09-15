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

cat >"$fake_bin/shfmt" <<'FAKE'
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
printf 'fake shfmt invocation %s\n' "$count"
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
chmod +x "$fake_bin/shfmt"

printf '#!/usr/bin/env bash\ntrue\n' >"$repository/script.sh"
printf '#!/usr/bin/env bash\ntrue\n' >"$repository/nested/tool.bash"
printf '#!/usr/bin/env bash\ntrue\n' >"$repository/raw/untracked.sh"
printf 'ignored*\nraw/\n' >"$repository/.gitignore"

git -C "$repository" init -q
git -C "$repository" -c core.autocrlf=false add script.sh nested/tool.bash .gitignore

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
      FAKE_STATUS=0 \
      FAKE_STATUS_MATCH='' \
      PATH="$fake_bin:$PATH" \
      PATHS='' \
      SHFMT_BATCH_SIZE=40 \
      SHFMT_JOBS=4 \
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
assert_not_contains 'default discovery skips raw untracked files' raw/untracked.sh "${captured_args[@]}"
assert_contains 'single-batch invocation passes -d' -d "${captured_args[@]}"

run_action 0 EXCLUDE=nested
load_args 1
assert_contains 'exclude keeps the unexcluded script' script.sh "${captured_args[@]}"
assert_not_contains 'exclude drops a matching substring' nested/tool.bash "${captured_args[@]}"

run_action 0 PATHS=empty
[[ ! -e "$captures/1.args" ]]
grep -F 'No shell scripts to check.' <<<"$ACTION_OUTPUT" >/dev/null
printf 'PASS: empty discovery exits cleanly\n'

run_action 0 PATHS=raw
load_args 1
assert_contains 'explicit roots see untracked files' raw/untracked.sh "${captured_args[@]}"

run_action 2 SHFMT_JOBS=0
[[ ! -e "$captures/1.args" ]]
grep -F 'must be positive integers' <<<"$ACTION_OUTPUT" >/dev/null
printf 'PASS: a non-positive fan-out knob fails closed before shfmt\n'

for hostile in auto -1 '4 4' ' ' 04x 1e3; do
  run_action 2 SHFMT_JOBS="$hostile"
  [[ ! -e "$captures/1.args" ]]
  grep -F 'must be positive integers' <<<"$ACTION_OUTPUT" >/dev/null
  run_action 2 SHFMT_BATCH_SIZE="$hostile"
  [[ ! -e "$captures/1.args" ]]
  grep -F 'must be positive integers' <<<"$ACTION_OUTPUT" >/dev/null
done
printf 'PASS: a hostile ambient fan-out value fails closed on either knob\n'

run_action 0 SHFMT_JOBS='' SHFMT_BATCH_SIZE=''
grep -F 'Checking 2 file(s):' <<<"$ACTION_OUTPUT" >/dev/null
printf 'PASS: an empty ambient fan-out value reads as unset and takes the default\n'

mkdir -p -- "$repository/fanout"
for i in $(seq -w 1 85); do
  printf '#!/usr/bin/env bash\ntrue\n' >"$repository/fanout/f$i.sh"
done
git -C "$repository" -c core.autocrlf=false add fanout
run_action 0
[[ -e "$captures/3.args" && ! -e "$captures/4.args" ]]
all_files=()
for invocation in 1 2 3; do
  load_args "$invocation"
  assert_contains "batch $invocation passes -d" -d "${captured_args[@]}"
  for arg in "${captured_args[@]}"; do
    [[ "$arg" == --* || "$arg" == -d ]] || all_files+=("$arg")
  done
done
assert_contains 'fan-out covers the first new file' fanout/f01.sh "${all_files[@]}"
assert_contains 'fan-out covers the last new file' fanout/f85.sh "${all_files[@]}"
assert_contains 'fan-out keeps the pre-existing scripts' script.sh "${all_files[@]}"
if [[ ${#all_files[@]} -ne 87 || "$(printf '%s\n' "${all_files[@]}" | sort -u | wc -l | tr -d ' ')" -ne 87 ]]; then
  printf 'FAIL: expected 87 distinct files across the batches, got %s\n' "${#all_files[@]}" >&2
  exit 1
fi
if [[ "$(grep -c '^fake shfmt invocation' <<<"$ACTION_OUTPUT")" -ne 3 ]]; then
  printf 'FAIL: expected 3 fake shfmt invocations in the log\n%s\n' "$ACTION_OUTPUT" >&2
  exit 1
fi
printf 'PASS: 87 files fan out into 3 batches of 40\n'

run_action 2 FAKE_STATUS_MATCH='fanout/f50.sh=2,fanout/f01.sh=1'
printf 'PASS: the most severe batch status is the action status\n'
run_action 1 FAKE_STATUS_MATCH='fanout/f50.sh=1'
printf 'PASS: diffs in one batch fail the action when the other batches are clean\n'

grep -F "run: bash \"\$GITHUB_ACTION_PATH/run.sh\"" "$action_directory/action.yml" >/dev/null
grep -F "SHFMT_BATCH_SIZE: '40'" "$action_directory/action.yml" >/dev/null
grep -F "SHFMT_JOBS: '4'" "$action_directory/action.yml" >/dev/null
printf 'PASS: action metadata pins the fan-out knobs against the caller environment\n'

echo 'All shfmt runner tests passed.'
