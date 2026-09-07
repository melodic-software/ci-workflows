#!/usr/bin/env bash
set -euo pipefail

# Matches a PR's changed-file listing against named filter groups and emits a
# `results` JSON object mapping each group name to "true" / "false" strings.
# The matcher reuses the hardened relevance semantics of
# claude-security-review.yml's `changes` job — root-anchored gitignore
# matching via `git check-ignore` in a scratch repository, `!` / `?` / `+`
# rejected before matching, every operational fault failing OPEN to "true" —
# generalized to many named groups with one shared file listing. That
# workflow's inline comments carry the full reasoning behind each guard.

# Environment contract (see action.yml). `:?` doubles as the SC2154
# unassigned-uppercase satisfaction and a loud failure on a miswired caller.
filters_config="${FILTERS:?FILTERS is required}"
event_name="${EVENT_NAME:?EVENT_NAME is required}"
github_output="${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
files_list_path="${FILES_LIST_PATH:-}"
files_list_failed="${FILES_LIST_FAILED:-}"

scratch="$(mktemp -d)"
# Persistent self-hosted runners accumulate /tmp; clean up on any exit.
# Single quotes defer expansion to trap time (avoids SC2064).
trap 'rm -rf "$scratch"' EXIT

# --- Parse the filter configuration BEFORE any fallback branch: a broken
# config is a hard error even on runs that would fall back to
# run-everything, so a misconfigured filter can never ride the fallback
# path to green unnoticed.

names=()
group_files=()
current_file=""
while IFS= read -r line; do
  line="${line%$'\r'}"
  trimmed="${line#"${line%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  [[ -n "$trimmed" ]] || continue
  case "$trimmed" in
  \#*) continue ;;
  *) ;;
  esac
  if [[ "$trimmed" == *: ]]; then
    # A header-shaped line that was INDENTED is ambiguous: headers are
    # unindented and patterns are indented, so this is either a mistyped
    # pattern or a misplaced header — and accepting it as a header would
    # silently steal every following pattern from the intended group (the
    # underfilter direction). Reject loudly instead of guessing.
    if [[ "$line" =~ ^[[:space:]] ]]; then
      echo "::error::Indented line '${trimmed}' ends in ':' — group headers must be unindented and patterns must not end in ':'."
      exit 1
    fi
    name="${trimmed%:}"
    if ! [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
      echo "::error::Invalid filter group name '${name}': use letters, digits, '_' and '-' only, starting with a letter or digit."
      exit 1
    fi
    for existing in "${names[@]}"; do
      if [[ "$existing" == "$name" ]]; then
        echo "::error::Duplicate filter group '${name}'."
        exit 1
      fi
    done
    names+=("$name")
    current_file="$scratch/patterns-${#names[@]}"
    : >"$current_file"
    group_files+=("$current_file")
    continue
  fi
  if [[ -z "$current_file" ]]; then
    echo "::error::Pattern '${trimmed}' appears before any 'name:' group header."
    exit 1
  fi
  printf '%s\n' "$trimmed" >>"$current_file"
done <<<"$filters_config"

if [[ "${#names[@]}" -eq 0 ]]; then
  echo '::error::filters declared no groups; each group is a line ending in a colon followed by its patterns.'
  exit 1
fi

# Reject the pattern characters this matcher cannot honor as GitHub Actions
# defines them. `?` and `+` fail in the DANGEROUS direction — the pattern
# silently matches fewer files than the caller wrote, so a lane that should
# have run reads as out-of-scope — which is exactly the failure mode this
# action exists to prevent. See claude-security-review.yml's `changes` job
# for the full per-character reasoning. Parsing already trimmed each line,
# so the guards anchor on the pattern itself.
for file in "${group_files[@]}"; do
  if grep -qE '^!' "$file"; then
    echo "::error::A filter pattern uses '!' negation. This matcher uses gitignore rules, where '!' does not re-include as GitHub Actions defines it. Narrow the positive patterns instead."
    exit 1
  fi
  if grep -qE '[?+]' "$file"; then
    echo "::error::A filter pattern contains '?' or '+'. Both are valid GitHub Actions path-filter syntax but mean something different under this matcher's gitignore rules, and they silently match FEWER files — which would skip a lane that should have run. Rewrite with '*' / '**' globs."
    exit 1
  fi
done

emit_results() {
  local results="{" index
  for index in "${!names[@]}"; do
    [[ "$index" -eq 0 ]] || results+=","
    results+="\"${names[$index]}\":\"${values[$index]}\""
    echo "${names[$index]}: ${values[$index]}"
  done
  results+="}"
  echo "results=${results}" >>"$github_output"
}

emit_all_relevant() {
  # One "true" per group, index-aligned with `names` the way `emit_results`
  # reads the two arrays. The `*` pattern matches each whole name, so every
  # element is rewritten to the constant.
  values=("${names[@]/*/true}")
  emit_results
}

# --- Fallback branches: outside a pull_request there is no PR listing to
# scope by, and a failed or truncated listing must not be matched — both
# fall OPEN to every group relevant.

if [[ "$event_name" != pull_request ]]; then
  echo "Not a pull_request event; every filter group is relevant."
  emit_all_relevant
  exit 0
fi

if [[ "$files_list_failed" == "true" || -z "$files_list_path" || ! -f "$files_list_path" ]]; then
  echo '::warning::Changed-file listing unavailable; treating every filter group as relevant.'
  emit_all_relevant
  exit 0
fi

# --- Match each group in a throwaway repository — no checkout of the
# caller's code. Actions `paths:` patterns are root-anchored; gitignore
# patterns without a leading slash match at any depth, so anchor each
# pattern with a leading '/'.

matcher="$scratch/matcher"
git init -q "$matcher"
: >"$matcher/.gitignore"
values=()
# Per-group check-ignore is a process-per-group fork. Groups are independent
# (each has its own pattern set), so they can run concurrently against one
# scratch repo via core.excludesFile — check-ignore is read-only. Results are
# collected and then folded in `names` order so emit_results and the warnings
# stay in the same sequence as the serial loop. An empty pattern file is the
# vacuous-filter fail-OPEN (no usable patterns); check-ignore exit 0 = at
# least one match, 1 = none, >1 = fatal (also fail OPEN, never "no match").
for index in "${!names[@]}"; do
  ignore="$scratch/ignore-$index"
  : >"$ignore"
  while IFS= read -r pattern; do
    case "$pattern" in
    /*) printf '%s\n' "$pattern" >>"$ignore" ;;
    *) printf '/%s\n' "$pattern" >>"$ignore" ;;
    esac
  done <"${group_files[$index]}"
done
# Cap at 4, matching the hosted runner's vCPU count and the ShellCheck /
# shfmt fan-outs in this same change. Unbounded `& … wait` oversubscribes
# a filters.yml that grows past a handful of groups; xargs -P reaps.
jobs=4
worker_indices=()
for index in "${!names[@]}"; do
  ignore="$scratch/ignore-$index"
  if [[ ! -s "$ignore" ]]; then
    printf 'empty\n' >"$scratch/rc-$index"
    continue
  fi
  worker_indices+=("$index")
done
if ((${#worker_indices[@]} > 0)); then
  # Each xargs invocation appends ONE group index after `_`. The worker
  # body is a single-quoted script on purpose: its expansions belong to
  # the worker shell. Completion marker is the rc file: write matches
  # first so a kill between the two writes cannot leave rc=0 (had
  # matches) with an absent matches file, which the parent would read as
  # "no match" and skip the lane.
  # shellcheck disable=SC2016
  printf '%s\0' "${worker_indices[@]}" | xargs -0 -n 1 -P "$jobs" -r env \
    MATCHER="$matcher" \
    SCRATCH="$scratch" \
    FILES_LIST="$files_list_path" \
    bash -c '
      index="$1"
      ignore="$SCRATCH/ignore-$index"
      matches="$(git -C "$MATCHER" -c core.excludesFile="$ignore" check-ignore --stdin --no-index <"$FILES_LIST")" && rc=0 || rc=$?
      printf %s "$matches" >"$SCRATCH/matches-$index"
      printf %s\\n "$rc" >"$SCRATCH/rc-$index"
    ' _
fi
for index in "${!names[@]}"; do
  name="${names[$index]}"
  # A worker that was killed, or never wrote a status, is an operational
  # fault: fail OPEN the same way check-ignore exit >1 does, never as "no
  # match", so a parallel-scheduler glitch cannot silently skip a lane.
  if [[ ! -f "$scratch/rc-$index" ]]; then
    echo "::warning::check-ignore produced no status for group '${name}'; treating it as relevant."
    values+=("true")
    continue
  fi
  rc="$(<"$scratch/rc-$index")"
  if [[ "$rc" == empty ]]; then
    echo "::warning::Filter group '${name}' has no usable patterns; treating it as relevant."
    values+=("true")
    continue
  fi
  if [[ "$rc" -gt 1 ]]; then
    echo "::warning::check-ignore failed for group '${name}' (rc=${rc}); treating it as relevant."
    values+=("true")
    continue
  fi
  if [[ -s "$scratch/matches-$index" ]]; then
    values+=("true")
  else
    values+=("false")
  fi
done

emit_results
