#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

paths="${PATHS:-}"
exclude="${EXCLUDE:-}"
# Fan-out shape. shfmt has no file-level parallelism of its own, so one
# process over a large tree is a serial wall. Batches of 40 files across 4
# processes measured 1.51x faster on a 2500-file tree; 4 matches the hosted
# runner's vCPU count. action.yml sets both names on the step with these
# same values, so a caller's inherited environment can never change the
# fan-out or abort the action with a malformed value; the reads below exist
# for the self-test, which runs this script directly. The action exposes
# neither as an input.
batch_size="${SHFMT_BATCH_SIZE:-40}"
jobs="${SHFMT_JOBS:-4}"

if [[ ! "$batch_size" =~ ^[1-9][0-9]*$ || ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::shfmt: SHFMT_BATCH_SIZE and SHFMT_JOBS must be positive integers (got '$batch_size' and '$jobs')."
  exit 2
fi

if [[ -z "${paths// /}" ]]; then
  # Git-tracked discovery (default): tracked *.sh/*.bash only, so ignored
  # or generated scripts in a dirty tree are never gated. NUL-delimited so
  # any path is safe; ls-files output is already sorted.
  mapfile -d '' -t files < <(git ls-files -z -- '*.sh' '*.bash')
else
  # Explicit roots opt into a raw filesystem walk that does not consult
  # .gitignore. Split into an array so each root reaches find as its own
  # path operand: an unquoted $PATHS would let bash pathname-expand a
  # root first, and find treats a stray operand as a -exec-capable
  # expression rather than a mere argument. -d '' takes the whole value
  # (a newline is an IFS separator too, so a caller-authored multi-line
  # input still splits correctly); read hits EOF without finding that
  # delimiter, hence the `|| true`.
  path_roots=()
  read -r -d '' -a path_roots <<<"$paths" || true
  mapfile -t files < <(find "${path_roots[@]}" -type f \( -name '*.sh' -o -name '*.bash' \) -not -path '*/.git/*' | sort)
fi

# Keep only on-disk files: a sparse checkout leaves tracked-but-absent
# (skip-worktree) entries that shfmt cannot open. Drop excluded substrings
# (space-separated, fixed-string match) in the same pass with bash
# `[[ == *sub* ]]` rather than forking `grep -vF` per exclude — the same
# filter_files shape the ShellCheck action uses, so a path containing a
# newline cannot re-split and an emptied list cannot become a spurious
# empty-string element.
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
# No formatting flags: shfmt reads each file's .editorconfig for indent
# width, switch-case indent, and binary-next-line. Passing any -i/-ci/-bn
# would make shfmt IGNORE .editorconfig entirely, so formatting policy
# stays externalized in the caller's .editorconfig. -d prints a unified
# diff and exits non-zero when a file is not already formatted.
#
# One process when the list fits a single batch: identical to the previous
# inline `shfmt -d "${files[@]}"`. Otherwise split like shellcheck/run.sh so
# diffs replay in batch (file) order and the exit status is the maximum over
# batches (1 = diffs, 2+ = operational).
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
  # Each xargs invocation appends ONE batch-list path after `_`, so inside
  # the worker it is the last positional. The worker body is a single-quoted
  # script on purpose: its expansions belong to the worker shell, not to
  # this one.
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
