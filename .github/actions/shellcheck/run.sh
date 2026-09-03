#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

paths="${PATHS:-}"
extra_globs="${EXTRA_GLOBS:-}"
extra_exclude_codes="${EXTRA_EXCLUDE_CODES:-}"
rcfile="${RCFILE:-.shellcheckrc}"
exclude="${EXCLUDE:-}"
severity="${SEVERITY:-}"
# Fan-out shape. ShellCheck has no file-level parallelism of its own, so one
# process over a large tree is a serial wall: 747 files took 254 s on a hosted
# runner. Batches of 40 files across 4 processes measured 2.85x faster on that
# tree (github-iac docs/topics/ci-perf/research/PROFILE-ccp-scripts.md, 3b);
# 4 matches the hosted runner's vCPU count. action.yml sets both names on the
# step with these same values, so a caller's inherited environment can never
# change the fan-out or abort the action with a malformed value; the reads
# below exist for the self-test, which runs this script directly. The action
# exposes neither as an input.
batch_size="${SHELLCHECK_BATCH_SIZE:-40}"
jobs="${SHELLCHECK_JOBS:-4}"

if [[ ! -f "$rcfile" ]]; then
  echo "::error::shellcheck: rcfile not found: $rcfile"
  exit 2
fi
if [[ ! "$batch_size" =~ ^[1-9][0-9]*$ || ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::shellcheck: SHELLCHECK_BATCH_SIZE and SHELLCHECK_JOBS must be positive integers (got '$batch_size' and '$jobs')."
  exit 2
fi

# Parse one pathspec per line instead of word-splitting. Git pathspecs can
# contain spaces, and keeping each caller-supplied line as one argv entry also
# prevents shell metacharacters from being evaluated by this action.
extra_pathspecs=()
while IFS= read -r pathspec || [[ -n "$pathspec" ]]; do
  pathspec="${pathspec%$'\r'}"
  [[ -z "${pathspec//[[:space:]]/}" ]] || extra_pathspecs+=("$pathspec")
done <<<"$extra_globs"

if [[ -n "${extra_exclude_codes//[[:space:]]/}" && ${#extra_pathspecs[@]} -eq 0 ]]; then
  echo '::error::shellcheck: extra-exclude-codes requires at least one extra-globs entry.'
  exit 2
fi
if [[ -n "${extra_exclude_codes//[[:space:]]/}" && ! "$extra_exclude_codes" =~ ^SC[0-9]{4}(,SC[0-9]{4})*$ ]]; then
  echo '::error::shellcheck: extra-exclude-codes must be comma-separated SC codes (for example, SC1090,SC1091).'
  exit 2
fi

discover_tracked_files() {
  local label="$1" output
  shift
  output="$(mktemp)"
  if ! git ls-files -z -- "$@" >"$output"; then
    rm -f -- "$output"
    echo "::error::shellcheck: Git-tracked $label discovery failed."
    return 2
  fi
  git_files=()
  mapfile -d '' -t git_files <"$output"
  rm -f -- "$output"
}

normal_files=()
if [[ -z "${paths//[[:space:]]/}" ]]; then
  # Git-tracked discovery (default): tracked *.sh/*.bash only, so ignored or
  # generated scripts in a dirty tree are never gated. NUL-delimited so any
  # path is safe; ls-files output is already sorted.
  discover_tracked_files primary '*.sh' '*.bash'
  normal_files=("${git_files[@]}")
else
  # Space-separated roots preserve the existing input contract. Explicit roots
  # opt into a raw filesystem walk that does not consult .gitignore.
  read -r -a path_roots <<<"$paths"
  mapfile -d '' -t normal_files < <(
    find "${path_roots[@]}" -type f \( -name '*.sh' -o -name '*.bash' \) \
      -not -path '*/.git/*' -print0 | sort -z
  )
fi

extra_files=()
if [[ ${#extra_pathspecs[@]} -gt 0 ]]; then
  # Extra inputs deliberately remain Git-tracked even when primary discovery
  # uses raw roots. `--` keeps a leading dash in a pathspec from becoming an
  # option; the quoted array prevents shell expansion or code execution.
  discover_tracked_files extra "${extra_pathspecs[@]}"
  extra_files=("${git_files[@]}")
fi

filter_files() {
  local array_name="$1" file substring
  local -a kept=()
  local -n candidates="$array_name"

  for file in "${candidates[@]}"; do
    # Sparse checkouts can leave tracked, skip-worktree entries absent on disk.
    [[ -f "$file" ]] || continue
    for substring in $exclude; do
      [[ "$file" == *"$substring"* ]] && continue 2
    done
    kept+=("$file")
  done
  candidates=("${kept[@]}")
}

filter_files normal_files
filter_files extra_files

# A path selected by both lanes stays in the ordinary lane. That preserves the
# existing strict result instead of weakening a normal *.sh/*.bash file with an
# exception intended only for extensionless extras. Also deduplicate repeated
# or overlapping extra pathspecs.
declare -A normal_seen=() extra_seen=()
for file in "${normal_files[@]}"; do
  normal_seen["$file"]=1
done
deduplicated_extra_files=()
for file in "${extra_files[@]}"; do
  [[ -n "${normal_seen[$file]+present}" || -n "${extra_seen[$file]+present}" ]] && continue
  extra_seen["$file"]=1
  deduplicated_extra_files+=("$file")
done
extra_files=("${deduplicated_extra_files[@]}")

if [[ ${#normal_files[@]} -eq 0 && ${#extra_files[@]} -eq 0 ]]; then
  echo 'No shell scripts to check.'
  exit 0
fi

args=(--rcfile="$rcfile")
# Empty severity omits the flag, leaving ShellCheck's own default (style).
if [[ -n "${severity//[[:space:]]/}" ]]; then
  args+=(--severity="$severity")
fi

# run_shellcheck <shellcheck-args...> -- <files...>
#
# Splits the file list into numbered batches of $batch_size and runs
# `shellcheck <args> <batch>` over them with $jobs processes at a time. Each
# batch writes its own output and exit status to files; once every batch has
# finished the outputs are replayed in batch order, so findings from concurrent
# batches never interleave line by line and the log reads the same as one
# serial process would have written it. The exit status is the MAXIMUM over
# the batches: ShellCheck reserves 1 for a completed scan with findings and 2-4
# for processing or invocation errors, so a later clean batch must never mask
# an earlier operational failure, and xargs's own 123/124/125 summary codes
# (which collapse exactly those distinctions) are deliberately not used. A
# batch that leaves no status file (killed, or the shell itself failed) counts
# as 2 rather than as clean.
run_shellcheck() {
  local -a sc_args=()
  while (($# > 0)); do
    if [[ "$1" == -- ]]; then
      shift
      break
    fi
    sc_args+=("$1")
    shift
  done
  local capture batch=0 index=0 count=$# status=0 list log rc
  capture="$(mktemp -d)"
  while ((index < count)); do
    printf '%s\0' "${@:index+1:batch_size}" >"$capture/$(printf '%06d' "$batch").files"
    index=$((index + batch_size))
    batch=$((batch + 1))
  done
  # Each xargs invocation appends ONE batch-list path after the fixed linter
  # arguments, so inside the worker it is the last positional. The worker body
  # is a single-quoted script on purpose: its expansions belong to the worker
  # shell, not to this one.
  # shellcheck disable=SC2016
  printf '%s\0' "$capture"/*.files | xargs -0 -n 1 -P "$jobs" bash -c '
    list="${!#}"
    set -- "${@:1:$#-1}"
    mapfile -d "" -t batch <"$list"
    shellcheck "$@" "${batch[@]}" >"${list%.files}.log" 2>&1
    echo "$?" >"${list%.files}.rc"
  ' _ "${sc_args[@]}"
  for list in "$capture"/*.files; do
    log="${list%.files}.log"
    [[ ! -f "$log" ]] || cat -- "$log"
    if [[ -f "${list%.files}.rc" ]]; then
      rc="$(<"${list%.files}.rc")"
    else
      echo "::error::shellcheck: batch ${list##*/} finished without reporting a status."
      rc=2
    fi
    ((rc <= status)) || status=$rc
  done
  rm -rf -- "$capture"
  return "$status"
}

status=0
if [[ ${#normal_files[@]} -gt 0 ]]; then
  printf 'Checking %d standard shell file(s) in batches of %d across %d process(es):\n' \
    "${#normal_files[@]}" "$batch_size" "$jobs"
  printf '  %s\n' "${normal_files[@]}"
  # The function records every batch status itself and never relies on errexit,
  # so capturing its return here is the intended path, not a suppressed exit.
  # shellcheck disable=SC2310
  run_shellcheck "${args[@]}" -- "${normal_files[@]}" || status=$?
fi

if [[ ${#extra_files[@]} -gt 0 ]]; then
  printf 'Checking %d extra shell file(s):\n' "${#extra_files[@]}"
  printf '  %s\n' "${extra_files[@]}"
  extra_args=("${args[@]}")
  if [[ -n "${extra_exclude_codes//[[:space:]]/}" ]]; then
    extra_args+=(--exclude="$extra_exclude_codes")
  fi
  extra_status=0
  # Same intended capture as the standard lane above.
  # shellcheck disable=SC2310
  run_shellcheck "${extra_args[@]}" -- "${extra_files[@]}" || extra_status=$?
  # ShellCheck reserves 1 for completed scans with findings and 2-4 for
  # processing/invocation errors. Keep the more severe result if the two lanes
  # differ instead of masking an operational failure behind a finding code.
  ((extra_status <= status)) || status=$extra_status
fi

exit "$status"
