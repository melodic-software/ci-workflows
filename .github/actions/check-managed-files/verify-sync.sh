#!/usr/bin/env bash
# Sync mode: prove the PR holds exactly what `sync-manifest.sh apply` at the
# synced standards SHA produces. Changed paths must be managed destinations,
# added or modified only, and applying the SHA onto the PR head must leave no
# byte or mode difference.
set -euo pipefail

: "${REPOSITORY:?REPOSITORY is required}"
: "${BASE_REF:?BASE_REF is required}"
: "${HEAD_REF:?HEAD_REF is required}"
: "${STANDARDS_ROOT:?STANDARDS_ROOT is required}"
SYNC_SHA="${SYNC_SHA:-}"

# Workflow commands read `%`, CR and LF, so escape them in PR-controlled text.
escape() {
  local value="${1//'%'/%25}"
  value="${value//$'\r'/%0D}"
  printf '%s' "${value//$'\n'/%0A}"
}

fail() {
  {
    echo "::error::Standards-sync PR does not match standards@${SYNC_SHA:-unknown}."
    for line in "$@"; do
      echo "::error::  - $(escape "$line")"
    done
    echo "::error::Re-run the standards sync to regenerate this PR; do not hand-edit a sync PR."
  } >&2
  exit 1
}

[[ "$SYNC_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "no verified 40-hex standards SHA was resolved"

if ! checked_out="$(git -C "$STANDARDS_ROOT" rev-parse HEAD)" ||
  [[ "$checked_out" != "$SYNC_SHA" ]]; then
  fail "standards checkout is at '${checked_out:-unreadable}', not $SYNC_SHA"
fi

[[ -f "$STANDARDS_ROOT/distribution/sync-manifest.mjs" ]] ||
  fail "standards@$SYNC_SHA predates the Node sync engine (distribution/sync-manifest.mjs)"
engine="$STANDARDS_ROOT/distribution/sync-manifest.sh"

if ! dest_paths="$(
  bash "$engine" dest-paths --source-root "$STANDARDS_ROOT" --target "$REPOSITORY"
)"; then
  fail "could not resolve managed destination paths for $REPOSITORY"
fi
declare -A managed_set=()
while IFS= read -r path; do
  [[ -n "$path" ]] && managed_set["$path"]=1
done <<<"$dest_paths"
((${#managed_set[@]} > 0)) || fail "$REPOSITORY is not a sync-manifest target at this SHA"

scratch="$(mktemp -d)"
worktree="$scratch/head"
cleanup() {
  git worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

problems=()

# NUL-separated output read with `mapfile -d ''`, so no byte in a path can
# shift the status/path pairing.
git diff --name-status -z --find-renames "$BASE_REF...$HEAD_REF" >"$scratch/diff" ||
  fail "could not diff $BASE_REF...$HEAD_REF"
mapfile -d '' -t diff_fields <"$scratch/diff"
i=0
while ((i < ${#diff_fields[@]})); do
  status="${diff_fields[i]}"
  if [[ "$status" == R* || "$status" == C* ]]; then
    problems+=("${diff_fields[i + 1]} -> ${diff_fields[i + 2]}: change type $status; sync never renames or copies")
    ((i += 3))
    continue
  fi
  path="${diff_fields[i + 1]}"
  ((i += 2))
  case "$status" in
    A | M)
      [[ -n "${managed_set[$path]+x}" ]] ||
        problems+=("$path: not a managed destination for $REPOSITORY")
      ;;
    D) problems+=("$path: deleted; sync never deletes") ;;
    *) problems+=("$path: change type $status; sync only adds or modifies files") ;;
  esac
done

git worktree add --quiet --detach "$worktree" "$HEAD_REF" ||
  fail "could not check out $HEAD_REF into a scratch worktree"

if ! bash "$engine" apply --source-root "$STANDARDS_ROOT" \
  --target "$REPOSITORY" --target-root "$worktree" >/dev/null; then
  problems+=("sync-manifest apply at $SYNC_SHA failed on the PR head")
elif ! git -C "$worktree" -c core.fileMode=true status --porcelain -z \
  --untracked-files=all >"$scratch/status"; then
  problems+=("could not read the scratch worktree status")
else
  mapfile -d '' -t status_fields <"$scratch/status"
  i=0
  while ((i < ${#status_fields[@]})); do
    entry="${status_fields[i]}"
    problems+=("${entry:3}: bytes or mode differ from apply at $SYNC_SHA (${entry:0:2})")
    # A staged rename or copy carries its source path as the next field.
    case "$entry" in R* | C*) ((i += 2)) ;; *) ((i += 1)) ;; esac
  done
fi

((${#problems[@]} == 0)) || fail "${problems[@]}"
echo "Sync PR matches standards@$SYNC_SHA exactly."
