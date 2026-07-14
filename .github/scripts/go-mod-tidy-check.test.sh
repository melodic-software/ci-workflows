#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$script_directory/go-mod-tidy-check.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

mock_bin="$temporary_directory/bin"
module="$temporary_directory/module"
output="$temporary_directory/output"
snapshot="$temporary_directory/snapshot"
mkdir -p "$mock_bin"

cat >"$mock_bin/go" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

[[ "${GOWORK:-}" == off ]] || exit 93
[[ "${1:-}" == mod && "${2:-}" == tidy ]] || exit 90
case "${3:-}" in
  -modfile=*) alternate_mod="${3#-modfile=}" ;;
  *) exit 91 ;;
esac
alternate_sum="${alternate_mod%.mod}.sum"

case "${MOCK_TIDY_BEHAVIOR:?MOCK_TIDY_BEHAVIOR is required}" in
  clean) ;;
  change-mod) printf '\nrequire example.com/new v1.0.0\n' >>"$alternate_mod" ;;
  change-sum) printf 'example.com/new v1.0.0 h1:changed\n' >>"$alternate_sum" ;;
  create-sum) printf 'example.com/new v1.0.0 h1:created\n' >"$alternate_sum" ;;
  remove-sum) rm -f -- "$alternate_sum" ;;
  fail)
    printf '\npartial tool output\n' >>"$alternate_mod"
    exit 73
    ;;
  *) exit 92 ;;
esac
MOCK
chmod +x "$mock_bin/go"

reset_module() {
  local sum_state="$1"
  rm -rf -- "$module" "$snapshot"
  mkdir -p "$module" "$snapshot"
  printf 'module example.com/tidy-test\n\ngo 1.21.0\n' >"$module/go.mod"
  if [[ "$sum_state" == present ]]; then
    printf 'example.com/existing v1.0.0 h1:existing\n' >"$module/go.sum"
  fi
  cp -- "$module/go.mod" "$snapshot/go.mod"
  if [[ -f "$module/go.sum" ]]; then
    cp -- "$module/go.sum" "$snapshot/go.sum"
  fi
}

assert_originals_unchanged() {
  cmp -s -- "$snapshot/go.mod" "$module/go.mod" || {
    printf 'FAIL: original go.mod changed\n' >&2
    exit 1
  }
  if [[ -f "$snapshot/go.sum" ]]; then
    if [[ ! -f "$module/go.sum" ]] || ! cmp -s -- "$snapshot/go.sum" "$module/go.sum"; then
      printf 'FAIL: original go.sum changed or disappeared\n' >&2
      exit 1
    fi
  elif [[ -e "$module/go.sum" ]]; then
    printf 'FAIL: original absent go.sum was created\n' >&2
    exit 1
  fi
}

assert_cleanup() {
  if compgen -G "$module/.ci-tidy.*" >/dev/null; then
    printf 'FAIL: temporary tidy files were not cleaned\n' >&2
    find "$module" -maxdepth 1 -name '.ci-tidy.*' -print >&2
    exit 1
  fi
}

run_case() {
  local name="$1" behavior="$2" sum_state="$3" expected_status="$4" expected_output="$5"
  local status
  reset_module "$sum_state"
  set +e
  (
    cd "$module"
    MOCK_TIDY_BEHAVIOR="$behavior" PATH="$mock_bin:$PATH" bash "$check"
  ) >"$output" 2>&1
  status=$?
  set -e
  if [[ "$status" != "$expected_status" ]] || ! grep -Fq -- "$expected_output" "$output"; then
    printf 'FAIL: %s (status %s, expected %s)\n' "$name" "$status" "$expected_status" >&2
    cat "$output" >&2
    exit 1
  fi
  assert_originals_unchanged
  assert_cleanup
  printf 'PASS: %s\n' "$name"
}

run_case clean clean present 0 'Go module metadata is tidy.'
run_case changed-go-mod change-mod present 1 'tidy/go.mod'
run_case changed-go-sum change-sum present 1 'tidy/go.sum'
run_case created-go-sum create-sum absent 1 'tidy/go.sum'
run_case removed-go-sum remove-sum present 1 'current/go.sum'
run_case tidy-tool-failure fail present 2 'go mod tidy execution failed with status 73'

# Cleanup is asserted after every success, finding, and tool-failure path above.
reset_module present
MOCK_TIDY_BEHAVIOR=clean PATH="$mock_bin:$PATH" bash -c 'cd "$1" && bash "$2"' _ "$module" "$check" >"$output" 2>&1
assert_cleanup
printf 'PASS: temporary tidy files are always cleaned\n'

printf 'Go module tidy behavioral tests passed.\n'
