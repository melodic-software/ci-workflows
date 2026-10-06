#!/usr/bin/env bash
# Run the standards naming-lint analyzer over ROOT and report its findings.
set -uo pipefail

: "${MODE:?MODE is required}"
: "${ROOT:?ROOT is required}"
: "${STANDARDS_ROOT:?STANDARDS_ROOT is required}"

case "$MODE" in
advisory | enforcing) ;;
*)
  echo "::error::mode must be 'advisory' or 'enforcing', got '$MODE'."
  exit 1
  ;;
esac

if [[ ! -d "$ROOT" ]]; then
  echo "::error::root '$ROOT' is not a directory."
  exit 1
fi

lint="$STANDARDS_ROOT/components/github-actions-conventions/naming-lint.mjs"
if [[ ! -f "$lint" ]]; then
  echo "::error::naming-lint.mjs missing under $STANDARDS_ROOT."
  exit 1
fi

args=(--root "$ROOT" --mode "$MODE" --format text)
# An empty repository falls back to the analyzer's own $GITHUB_REPOSITORY.
if [[ -n "${REPOSITORY:-}" ]]; then
  args+=(--repository "$REPOSITORY")
fi

# Findings go to the step summary and the log, not annotations: GitHub shows
# only ten annotations per step, and a root other than the checkout would
# place them on the wrong files. Exit 1 is a blocking finding in enforcing
# mode; exit 2 is a bad argument or vocabulary. Both fail the step.
report="$(mktemp)"
trap 'rm -f "$report"' EXIT
status=0
node "$lint" "${args[@]}" >"$report" 2>&1 || status=$?

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### naming-lint ($MODE)"
    echo '```text'
    cat "$report"
    echo '```'
  } >>"$GITHUB_STEP_SUMMARY"
fi
cat "$report"

if ((status != 0)); then
  if ((status == 1)); then
    echo "::error::naming-lint found blocking naming findings in $ROOT; see the log or step summary. Rename per melodic-software/standards components/github-actions-conventions, or add the word to its vocabulary."
  else
    echo "::error::naming-lint could not run (exit $status); see the log."
  fi
fi
exit "$status"
