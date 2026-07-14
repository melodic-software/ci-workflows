#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 2
}

for command in cp diff go mktemp rm; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done

[[ -f go.mod && ! -L go.mod ]] || fail "go.mod must be a regular reviewed file"
if [[ -e go.sum || -L go.sum ]]; then
  [[ -f go.sum && ! -L go.sum ]] || fail "go.sum must be a regular reviewed file when present"
fi

alternate_mod="$(mktemp .ci-tidy.XXXXXXXX.mod)"
alternate_sum="${alternate_mod%.mod}.sum"
cleanup() {
  rm -f -- "$alternate_mod" "$alternate_sum"
}
trap cleanup EXIT

cp -- go.mod "$alternate_mod"
if [[ -f go.sum ]]; then
  cp -- go.sum "$alternate_sum"
fi

set +e
go mod tidy -modfile="$alternate_mod"
tidy_status=$?
set -e
if ((tidy_status != 0)); then
  fail "go mod tidy execution failed with status $tidy_status; rerun after resolving infrastructure or module errors"
fi

dirty=0
compare_snapshot() {
  local name="$1" current="$2" tidy="$3" status
  if [[ -f "$current" && -f "$tidy" ]]; then
    if diff --unified --label "current/$name" --label "tidy/$name" -- "$current" "$tidy"; then
      return 0
    else
      status=$?
    fi
  elif [[ -f "$current" ]]; then
    if diff --unified --label "current/$name" --label "tidy/$name" -- "$current" /dev/null; then
      return 0
    else
      status=$?
    fi
  elif [[ -f "$tidy" ]]; then
    if diff --unified --label "current/$name" --label "tidy/$name" -- /dev/null "$tidy"; then
      return 0
    else
      status=$?
    fi
  else
    return 0
  fi

  case "$status" in
  1) dirty=1 ;;
  *) fail "diff failed while comparing $name with status $status" ;;
  esac
}

compare_snapshot go.mod go.mod "$alternate_mod"
compare_snapshot go.sum go.sum "$alternate_sum"
if ((dirty != 0)); then
  printf '::error::go.mod or go.sum requires go mod tidy.\n' >&2
  exit 1
fi

printf 'Go module metadata is tidy.\n'
