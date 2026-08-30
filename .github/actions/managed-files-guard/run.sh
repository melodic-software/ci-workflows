#!/usr/bin/env bash
# Reject PR diffs that touch sync-manifest-managed destinations (#208).
set -euo pipefail

: "${REPOSITORY:?REPOSITORY is required}"
: "${BASE_REF:?BASE_REF is required}"
: "${HEAD_REF:?HEAD_REF is required}"
: "${STANDARDS_ROOT:?STANDARDS_ROOT is required}"

engine="$STANDARDS_ROOT/distribution/sync-manifest.sh"
[[ -x "$engine" || -f "$engine" ]] || {
  echo "::error::sync-manifest.sh missing under $STANDARDS_ROOT"
  exit 1
}

if ! dest_paths="$(
  bash "$engine" dest-paths --source-root "$STANDARDS_ROOT" --target "$REPOSITORY"
)"; then
  echo "::error::failed to resolve managed destination paths for $REPOSITORY"
  exit 1
fi

if [[ -z "${dest_paths//[$'\t\r\n ']/}" ]]; then
  echo "Repository $REPOSITORY is not a sync-manifest target — no-op."
  exit 0
fi

mapfile -t managed <<<"$dest_paths"
declare -A managed_set=()
for path in "${managed[@]}"; do
  [[ -n "$path" ]] || continue
  managed_set["$path"]=1
done

# Prefer triple-dot against the merge base so rename/copy detection matches PR
# changed-file semantics. Fall back to HEAD_REF alone when BASE_REF is empty.
if [[ -n "$BASE_REF" && "$BASE_REF" != "$HEAD_REF" ]]; then
  diff_range="$BASE_REF...$HEAD_REF"
else
  diff_range="$HEAD_REF"
fi

# Capture through a command substitution, not `mapfile < <(git …)`: process
# substitution is not reaped, so mapfile reports success even when git failed.
# An unfetched or bogus ref would then yield an empty change list and this
# guard would announce "no hand-edits" and exit 0 — passing precisely when it
# could not see the diff. Same `if ! var="$(…)"` shape the dest-paths call
# above uses, for the same reason.
if ! changed_paths="$(
  git diff --name-only --diff-filter=ACMRTUXB "$diff_range"
)"; then
  echo "::error::failed to diff $diff_range — cannot verify managed-file edits"
  exit 1
fi

# `mapfile <<<""` yields one empty element, so an empty diff must short-circuit
# rather than produce a phantom path.
if [[ -z "$changed_paths" ]]; then
  changed=()
else
  mapfile -t changed <<<"$changed_paths"
fi

hits=()
for path in "${changed[@]}"; do
  [[ -n "$path" ]] || continue
  [[ -n "${managed_set[$path]+x}" ]] || continue
  hits+=("$path")
done

if ((${#hits[@]} == 0)); then
  echo "No managed-file hand-edits in this diff."
  exit 0
fi

{
  echo "::error::This PR edits sync-manifest-managed files. Change them in"
  echo "::error::melodic-software/standards and let standards-sync land the"
  echo "::error::update, or label the PR standards-sync if this IS that sync."
  printf '::error::Managed paths touched:\n'
  for path in "${hits[@]}"; do
    printf '::error::  - %s\n' "$path"
  done
} >&2
exit 1
