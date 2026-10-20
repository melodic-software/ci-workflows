#!/usr/bin/env bash
# Run every tracked `*.test.sh` with bash from the repository root, run them all,
# and fail when any exits non-zero or when none is tracked.
set -uo pipefail

mapfile -d '' tests < <(git -c core.quotePath=false ls-files -z -- '*.test.sh')
if [[ "${#tests[@]}" -eq 0 ]]; then
  echo "::error::No tracked *.test.sh files; turn the shell-tests toggle off instead."
  exit 1
fi

failed=()
for test in "${tests[@]}"; do
  echo "::group::$test"
  bash "$test"
  status=$?
  echo "::endgroup::"
  if [[ "$status" -ne 0 ]]; then
    echo "::error file=$test::$test exited $status."
    failed+=("$test")
  fi
done

echo "${#tests[@]} test files, ${#failed[@]} failed."
[[ "${#failed[@]}" -eq 0 ]]
