# shellcheck shell=bash
set -euo pipefail

guard="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/osv-scan-guard.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
results="$temporary_directory/results.sarif"

write_results() {
  case "$1" in
  clean) printf '{"version":"2.1.0","runs":[{"results":[]}]}\n' >"$results" ;;
  findings) printf '{"version":"2.1.0","runs":[{"results":[{"message":{"text":"unsafe%%value\\nnext"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/a:b.js"},"region":{"startLine":4}}}]}]}]}\n' >"$results" ;;
  invalid) printf '{not json}\n' >"$results" ;;
  absent) rm -f -- "$results" ;;
  symlink) printf '{"version":"2.1.0","runs":[]}' >"$temporary_directory/target"; ln -s "$temporary_directory/target" "$results" ;;
  *) return 2 ;;
  esac
}

run_case() {
  local name="$1" expected="$2" scan_exit="$3" allow="$4" fail="$5" shape="$6"
  local output status
  rm -f -- "$results" "$temporary_directory/target"
  write_results "$shape"
  set +e
  output="$(ALLOW_NO_LOCKFILES="$allow" FAIL_ON_VULN="$fail" OSV_RESULTS="$results" SCAN_EXIT="$scan_exit" bash "$guard" 2>&1)"
  status=$?
  set -e
  if [[ "$status" != "$expected" ]]; then
    echo "$name: expected $expected, got $status" >&2
    echo "$output" >&2
    return 1
  fi
  if [[ "$shape" == findings && "$scan_exit" == 1 ]]; then
    grep -F '::warning file=src/a%3Ab.js,line=4::unsafe%25value' <<<"$output" >/dev/null
  fi
  echo "ok: $name"
}

run_case 'clean scan' 0 0 false true clean
run_case 'advisory findings remain green' 0 1 false false findings
run_case 'blocking findings fail' 1 1 false true findings
run_case 'operational error always fails closed' 7 7 false false absent
run_case 'missing result always fails closed' 2 0 false false absent
run_case 'invalid result always fails closed' 2 0 false false invalid
run_case 'exit and result mismatch fails closed' 2 0 false false findings
run_case 'advisory empty scan warns' 0 128 false false absent
run_case 'blocking empty scan fails' 1 128 false true absent
run_case 'declared dependency-less empty scan passes' 0 128 true true absent
if [[ "$(uname -s)" == Linux ]]; then
  run_case 'symlink result fails closed' 2 0 false false symlink
fi
