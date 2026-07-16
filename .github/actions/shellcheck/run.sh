#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

paths="${PATHS:-}"
extra_globs="${EXTRA_GLOBS:-}"
extra_exclude_codes="${EXTRA_EXCLUDE_CODES:-}"
rcfile="${RCFILE:-.shellcheckrc}"
exclude="${EXCLUDE:-}"
severity="${SEVERITY:-}"

if [[ ! -f "$rcfile" ]]; then
  echo "::error::shellcheck: rcfile not found: $rcfile"
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

  for file in ${candidates[@]+"${candidates[@]}"}; do
    # Sparse checkouts can leave tracked, skip-worktree entries absent on disk.
    [[ -f "$file" ]] || continue
    for substring in $exclude; do
      [[ "$file" == *"$substring"* ]] && continue 2
    done
    kept+=("$file")
  done
  candidates=(${kept[@]+"${kept[@]}"})
}

filter_files normal_files
filter_files extra_files

# A path selected by both lanes stays in the ordinary lane. That preserves the
# existing strict result instead of weakening a normal *.sh/*.bash file with an
# exception intended only for extensionless extras. Also deduplicate repeated
# or overlapping extra pathspecs.
declare -A normal_seen=() extra_seen=()
for file in ${normal_files[@]+"${normal_files[@]}"}; do
  normal_seen["$file"]=1
done
deduplicated_extra_files=()
for file in ${extra_files[@]+"${extra_files[@]}"}; do
  [[ -n "${normal_seen[$file]+present}" || -n "${extra_seen[$file]+present}" ]] && continue
  extra_seen["$file"]=1
  deduplicated_extra_files+=("$file")
done
extra_files=(${deduplicated_extra_files[@]+"${deduplicated_extra_files[@]}"})

if [[ ${#normal_files[@]} -eq 0 && ${#extra_files[@]} -eq 0 ]]; then
  echo 'No shell scripts to check.'
  exit 0
fi

args=(--rcfile="$rcfile")
# Empty severity omits the flag, leaving ShellCheck's own default (style).
if [[ -n "${severity//[[:space:]]/}" ]]; then
  args+=(--severity="$severity")
fi

status=0
if [[ ${#normal_files[@]} -gt 0 ]]; then
  printf 'Checking %d standard shell file(s):\n' "${#normal_files[@]}"
  printf '  %s\n' "${normal_files[@]}"
  shellcheck "${args[@]}" "${normal_files[@]}" || status=$?
fi

if [[ ${#extra_files[@]} -gt 0 ]]; then
  printf 'Checking %d extra shell file(s):\n' "${#extra_files[@]}"
  printf '  %s\n' "${extra_files[@]}"
  extra_args=("${args[@]}")
  if [[ -n "${extra_exclude_codes//[[:space:]]/}" ]]; then
    extra_args+=(--exclude="$extra_exclude_codes")
  fi
  extra_status=0
  shellcheck "${extra_args[@]}" "${extra_files[@]}" || extra_status=$?
  # ShellCheck reserves 1 for completed scans with findings and 2-4 for
  # processing/invocation errors. Keep the more severe result if the two lanes
  # differ instead of masking an operational failure behind a finding code.
  ((extra_status <= status)) || status=$extra_status
fi

exit "$status"
