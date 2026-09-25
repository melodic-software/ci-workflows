#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

paths="${PATHS:-}"
exclude="${EXCLUDE:-}"
# action.yml pins these on the step; the env reads exist for run.test.sh.
batch_size="${SHFMT_BATCH_SIZE:-40}"
jobs="${SHFMT_JOBS:-4}"

if [[ ! "$batch_size" =~ ^[1-9][0-9]*$ || ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::shfmt: SHFMT_BATCH_SIZE and SHFMT_JOBS must be positive integers (got '$batch_size' and '$jobs')."
  exit 2
fi

if [[ -z "${paths// /}" ]]; then
  # Tracked files only, so ignored or generated scripts are never gated.
  mapfile -d '' -t files < <(git ls-files -z -- '*.sh' '*.bash')
else
  # An array keeps each root one find operand, never pathname-expanded. read
  # hits EOF without the '' delimiter, hence `|| true`.
  path_roots=()
  read -r -d '' -a path_roots <<<"$paths" || true
  mapfile -t files < <(find "${path_roots[@]}" -type f \( -name '*.sh' -o -name '*.bash' \) -not -path '*/.git/*' | sort)
fi

# Sparse checkouts can leave tracked, skip-worktree entries absent on disk.
kept=()
for file in ${files[@]+"${files[@]}"}; do
  [[ -f "$file" ]] || continue
  for substring in $exclude; do
    [[ "$file" == *"$substring"* ]] && continue 2
  done
  kept+=("$file")
done
files=("${kept[@]+"${kept[@]}"}")

if [[ ${#files[@]} -eq 0 ]]; then
  echo 'No shell scripts to check.'
  exit 0
fi
printf 'Checking %d file(s):\n' "${#files[@]}"
printf '  %s\n' "${files[@]}"
# No -i/-ci/-bn: any formatting flag makes shfmt ignore the caller's
# .editorconfig entirely.
if ((${#files[@]} <= batch_size)); then
  shfmt -d "${files[@]}"
  exit $?
fi

run_shfmt() {
  local capture batch=0 index=0 count=$# status=0 list log rc
  capture="$(mktemp -d)"
  while ((index < count)); do
    printf '%s\0' "${@:index+1:batch_size}" >"$capture/$(printf '%06d' "$batch").files"
    index=$((index + batch_size))
    batch=$((batch + 1))
  done
  # xargs appends one batch-list path as the worker's last positional; the body
  # is single-quoted so it expands in the worker shell.
  # shellcheck disable=SC2016
  printf '%s\0' "$capture"/*.files | xargs -0 -n 1 -P "$jobs" bash -c '
    list="${!#}"
    mapfile -d "" -t batch <"$list"
    shfmt -d "${batch[@]}" >"${list%.files}.log" 2>&1
    echo "$?" >"${list%.files}.rc"
  ' _
  for list in "$capture"/*.files; do
    log="${list%.files}.log"
    [[ ! -f "$log" ]] || cat -- "$log"
    if [[ -f "${list%.files}.rc" ]]; then
      rc="$(<"${list%.files}.rc")"
    else
      echo "::error::shfmt: batch ${list##*/} finished without reporting a status."
      rc=2
    fi
    ((rc <= status)) || status=$rc
  done
  rm -rf -- "$capture"
  return "$status"
}

# The function records every batch status itself and never relies on errexit,
# so capturing its return here is the intended path, not a suppressed exit.
# shellcheck disable=SC2310
run_shfmt "${files[@]}" || exit $?
exit 0
