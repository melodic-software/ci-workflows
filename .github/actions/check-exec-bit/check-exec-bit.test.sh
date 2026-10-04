#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

failures=0
run_case() {
  local name="$1" expected="$2" repo="$3"
  shift 3
  local output status
  set +e
  output="$(
    cd "$repo"
    env PATHS="${PATHS:-.}" bash "$action_dir/check-exec-bit.sh" "$@" 2>&1
  )"
  status=$?
  set -e
  if [[ "$status" != "$expected" ]]; then
    printf 'FAIL: %s: expected status %s, got %s\n%s\n' "$name" "$expected" "$status" "$output" >&2
    failures=$((failures + 1))
    return 0
  fi
  CASE_OUTPUT="$output"
  printf 'PASS: %s (status %s)\n' "$name" "$expected"
}

expect_contains() {
  local name="$1" needle="$2"
  if [[ "$CASE_OUTPUT" != *"$needle"* ]]; then
    printf 'FAIL: %s: output did not contain %q\n%s\n' "$name" "$needle" "$CASE_OUTPUT" >&2
    failures=$((failures + 1))
    return 0
  fi
  printf 'PASS: %s\n' "$name"
}

expect_not_contains() {
  local name="$1" needle="$2"
  if [[ "$CASE_OUTPUT" == *"$needle"* ]]; then
    printf 'FAIL: %s: output unexpectedly contained %q\n%s\n' "$name" "$needle" "$CASE_OUTPUT" >&2
    failures=$((failures + 1))
    return 0
  fi
  printf 'PASS: %s\n' "$name"
}

init_repo() {
  local repo="$1"
  mkdir -p -- "$repo"
  git -C "$repo" init -q
  git -C "$repo" -c core.autocrlf=false checkout -q -b main
}

commit_all() {
  local repo="$1"
  git -C "$repo" add -A
  git -C "$repo" -c user.name='CI Test' -c user.email='ci-test@example.invalid' commit -qm 'test'
}

# 100755 shebang script is clean.
good="$temporary_directory/good"
init_repo "$good"
printf '#!/usr/bin/env bash\necho ok\n' >"$good/tool.sh"
chmod +x "$good/tool.sh"
commit_all "$good"
run_case '100755 shebang is clean' 0 "$good"
expect_contains 'success message on a clean tree' 'All shebang files are mode 100755 in the index.'

# 100644 shebang script fails with the exact annotation.
bad="$temporary_directory/bad"
init_repo "$bad"
printf '#!/usr/bin/env bash\necho bad\n' >"$bad/tool.sh"
commit_all "$bad"
run_case '100644 shebang fails' 1 "$bad"
expect_contains 'exact error annotation' '::error file=tool.sh::tool.sh has a shebang but git index mode is 100644; run: git update-index --chmod=+x -- "tool.sh"'

# 100644 file with #! only on a later line (markdown fence) is not byte 0.
docs="$temporary_directory/docs"
init_repo "$docs"
cat >"$docs/readme.md" <<'MARKDOWN'
# Title

```bash
#!/usr/bin/env bash
echo hi
```
MARKDOWN
commit_all "$docs"
run_case 'later-line #! in 100644 markdown is clean' 0 "$docs"
expect_contains 'docs with a fenced shebang pass' 'All shebang files are mode 100755 in the index.'

# Path containing a space.
space="$temporary_directory/space"
init_repo "$space"
mkdir -p -- "$space/bin dir"
printf '#!/usr/bin/env bash\necho space\n' >"$space/bin dir/run me.sh"
commit_all "$space"
run_case '100644 shebang whose path contains a space fails' 1 "$space"
expect_contains 'space path in the annotation' '::error file=bin dir/run me.sh::bin dir/run me.sh has a shebang but git index mode is 100644'

# PATHS pathspec that excludes the bad file.
scoped="$temporary_directory/scoped"
init_repo "$scoped"
mkdir -p -- "$scoped/keep" "$scoped/skip"
printf '#!/usr/bin/env bash\necho keep\n' >"$scoped/keep/ok.sh"
chmod +x "$scoped/keep/ok.sh"
printf '#!/usr/bin/env bash\necho skip\n' >"$scoped/skip/bad.sh"
commit_all "$scoped"
PATHS='keep' run_case 'PATHS excludes an out-of-scope 100644 shebang' 0 "$scoped"
expect_contains 'scoped scan is clean' 'All shebang files are mode 100755 in the index.'
unset PATHS
PATHS='skip' run_case 'PATHS still fails an in-scope 100644 shebang' 1 "$scoped"
expect_contains 'scoped scan reports skip/bad.sh' '::error file=skip/bad.sh::'
unset PATHS

# Empty repo / no shebang files.
empty="$temporary_directory/empty"
init_repo "$empty"
printf 'plain text\n' >"$empty/notes.txt"
commit_all "$empty"
run_case 'no shebang files is clean' 0 "$empty"
expect_contains 'empty shebang set prints success' 'All shebang files are mode 100755 in the index.'

# Mixed: one good 100755 and one bad 100644.
mixed="$temporary_directory/mixed"
init_repo "$mixed"
printf '#!/usr/bin/env bash\necho good\n' >"$mixed/good.sh"
chmod +x "$mixed/good.sh"
printf '#!/usr/bin/env bash\necho bad\n' >"$mixed/bad.sh"
cat >"$mixed/notes.md" <<'MARKDOWN'
# not a script

```
#!/usr/bin/env bash
```
MARKDOWN
commit_all "$mixed"
run_case 'mixed tree fails only the 100644 shebang' 1 "$mixed"
expect_contains 'mixed reports bad.sh' '::error file=bad.sh::bad.sh has a shebang but git index mode is 100644'
expect_not_contains 'mixed does not report good.sh' 'file=good.sh'
expect_not_contains 'mixed does not report the fenced markdown' 'file=notes.md'

if [[ "$failures" -ne 0 ]]; then
  printf 'FAIL: %s exec-bit test(s) failed\n' "$failures" >&2
  exit 1
fi
echo 'All exec-bit tests passed.'
