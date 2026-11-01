#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

action_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$action_directory/../../.." && pwd)"
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

# Without one, the default path falls back to this repository's canonical copy.
rm -- "$caller/lychee.toml"
rm -f -- "$capture"
run "$action_directory/run.sh" lychee.toml
[[ "$rc" -eq 0 ]] || fail "bundled config: exit $rc ($out)"
used="$(config_argument)"
[[ "$used" == "$repository_root/lychee.toml" ]] || fail "bundled config: lychee got --config $used"
[[ "$out" == *"config $repository_root/lychee.toml"* ]] || fail "bundled config: the log does not name the config used"

# A non-default path that does not exist fails without running lychee.
rm -f -- "$capture"
run "$action_directory/run.sh" docs/lychee.toml
[[ "$rc" -eq 2 ]] || fail "missing custom config: exit $rc, want 2"
[[ ! -f "$capture" ]] || fail "missing custom config: lychee ran"

# A missing bundled copy fails loudly rather than running unconfigured.
isolated="$temporary_directory/isolated/.github/actions/lychee-offline"
mkdir -p -- "$isolated"
cp -- "$action_directory/run.sh" "$isolated/run.sh"
run "$isolated/run.sh" lychee.toml
[[ "$rc" -eq 2 ]] || fail "missing bundled config: exit $rc, want 2"
[[ "$out" == *"bundled canonical copy is missing"* ]] || fail "missing bundled config: unexpected message ($out)"

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
