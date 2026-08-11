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
  mapfile -t changed < <(git diff --name-only --diff-filter=ACMRTUXB "$BASE_REF...$HEAD_REF")
else
  mapfile -t changed < <(git diff --name-only --diff-filter=ACMRTUXB "$HEAD_REF")
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
