#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

files="${FILES:-}"
paths="${PATHS:-}"
extra_globs="${EXTRA_GLOBS:-}"
extra_exclude_codes="${EXTRA_EXCLUDE_CODES:-}"
rcfile="${RCFILE:-.shellcheckrc}"
exclude="${EXCLUDE:-}"
severity="${SEVERITY:-}"
# action.yml pins these on the step; the env reads exist for run.test.sh.
# cpu.max is read directly: nproc before coreutils 9.8 ignores cgroup v2 quotas.
batch_size="${SHELLCHECK_BATCH_SIZE:-40}"
jobs="${SHELLCHECK_JOBS:-}"
if [[ -z "$jobs" ]]; then
  # nproc honors OMP_NUM_THREADS/OMP_THREAD_LIMIT, which a caller's env
  # could otherwise use to steer the fan-out.
  jobs="$(env -u OMP_NUM_THREADS -u OMP_THREAD_LIMIT nproc)"
  if read -r quota period <"${SHELLCHECK_CPU_MAX_FILE:-/sys/fs/cgroup/cpu.max}" 2>/dev/null &&
    [[ "$quota" =~ ^[1-9][0-9]*$ && "$period" =~ ^[1-9][0-9]*$ ]]; then
    quota_cpus=$(((quota + period - 1) / period))
    ((quota_cpus >= jobs)) || jobs=$quota_cpus
  fi
  ((jobs <= 4)) || jobs=4
fi

if [[ ! -f "$rcfile" ]]; then
  echo "::error::shellcheck: rcfile not found: $rcfile"
  exit 2
fi
if [[ ! "$batch_size" =~ ^[1-9][0-9]*$ || ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::shellcheck: SHELLCHECK_BATCH_SIZE and SHELLCHECK_JOBS must be positive integers (got '$batch_size' and '$jobs')."
  exit 2
fi

# Newline- or space-separated; `read -r -a` splits without globbing, so a
# caller's metacharacter is never evaluated, and a path cannot contain a space.
explicit_files=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  if [[ -n "${line//[[:space:]]/}" ]]; then
    read -r -a line_words <<<"$line"
    explicit_files+=("${line_words[@]}")
  fi
done <<<"$files"

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
if [[ ${#explicit_files[@]} -gt 0 ]]; then
  # An explicit list wins over `paths`. Non-shell paths drop here and deleted
  # ones in filter_files, so a raw `git diff --name-only` is valid input.
  mapfile -d '' -t normal_files < <(
    for file in "${explicit_files[@]}"; do
      if [[ "$file" == *.sh || "$file" == *.bash ]]; then
        printf '%s\0' "$file"
      fi
    done | sort -zu
  )
elif [[ -z "${paths//[[:space:]]/}" ]]; then
  # Tracked files only, so ignored or generated scripts are never gated.
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
  # Extra inputs stay Git-tracked even when primary discovery walks raw roots.
  discover_tracked_files extra "${extra_pathspecs[@]}"
  extra_files=("${git_files[@]}")
  if [[ ${#explicit_files[@]} -gt 0 ]]; then
    # `files` promises exactly the listed files, so the extra lane narrows to
    # them instead of matching the whole index.
    declare -A listed_paths=()
    for file in "${explicit_files[@]}"; do
      listed_paths["$file"]=1
    done
    listed_extra_files=()
    for file in "${extra_files[@]}"; do
      [[ -z "${listed_paths[$file]+present}" ]] || listed_extra_files+=("$file")
    done
    extra_files=("${listed_extra_files[@]}")
  fi
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

# A path in both lanes stays in the ordinary lane, so extra-exclude-codes never
# weakens a *.sh/*.bash file.
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
  # Separate messages so the log tells an empty caller list apart from a
  # repository with no scripts.
  if [[ ${#explicit_files[@]} -gt 0 ]]; then
    printf '::notice::shellcheck: files listed %d path(s); none of them is an existing shell script. Nothing to check.\n' \
      "${#explicit_files[@]}"
  else
    echo 'No shell scripts to check.'
  fi
  exit 0
fi

args=(--rcfile="$rcfile")
# Empty severity omits the flag, leaving ShellCheck's own default (style).
if [[ -n "${severity//[[:space:]]/}" ]]; then
  args+=(--severity="$severity")
fi

# run_shellcheck <shellcheck-args...> -- <files...>
# Returns the MAX batch status (1 findings, 2-4 errors), not xargs's 123-125,
# so a clean batch never masks an operational failure.
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
  # xargs appends one batch-list path as the worker's last positional; the body
  # is single-quoted so it expands in the worker shell.
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
  ((extra_status <= status)) || status=$extra_status
fi

exit "$status"
