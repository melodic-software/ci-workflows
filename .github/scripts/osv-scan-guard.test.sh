# shellcheck shell=bash
set -euo pipefail

guard="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/osv-scan-guard.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
results="$temporary_directory/results.sarif"
workspace="$temporary_directory/workspace"
mkdir -p -- "$workspace/src"
touch -- "$workspace/src/a:b.js" "$workspace/src/encoded space.lock" "$temporary_directory/uri-sentinel-outside.lock"

write_finding() {
  jq -n --arg uri "$1" --arg message $'unsafe%value\n::error::raw-message' '
    {
      version: "2.1.0",
      runs: [{
        results: [{
          message: {text: $message},
          locations: [{physicalLocation: {
            artifactLocation: {uri: $uri},
            region: {startLine: 4}
          }}]
        }]
      }]
    }
  ' >"$results"
}

write_results() {
  case "$1" in
  clean) printf '{"version":"2.1.0","runs":[{"results":[]}]}\n' >"$results" ;;
  findings) write_finding 'src/a:b.js' ;;
  encoded-file) write_finding "file://${workspace}/src/encoded%20space.lock" ;;
  malformed-uri) write_finding 'src/uri-sentinel-malformed%2G.lock' ;;
  nul-uri) write_finding 'src/uri-sentinel-nul%00.lock' ;;
  outside-uri) write_finding "file://${temporary_directory}/uri-sentinel-outside.lock" ;;
  foreign-scheme) write_finding 'https://example.invalid/uri-sentinel-foreign.lock' ;;
  foreign-host) write_finding 'file://example.invalid/uri-sentinel-host.lock' ;;
  invalid) printf '{not json}\n' >"$results" ;;
  absent) rm -f -- "$results" ;;
  symlink)
    printf '{"version":"2.1.0","runs":[]}' >"$temporary_directory/target"
    ln -s "$temporary_directory/target" "$results"
    ;;
  *) return 2 ;;
  esac
}

run_case() {
  local name="$1" expected="$2" scan_exit="$3" allow="$4" fail="$5" shape="$6"
  local output status
  rm -f -- "$results" "$temporary_directory/target"
  write_results "$shape"
  set +e
  output="$(ALLOW_NO_LOCKFILES="$allow" FAIL_ON_VULN="$fail" GITHUB_WORKSPACE="$workspace" OSV_RESULTS="$results" SCAN_EXIT="$scan_exit" bash "$guard" 2>&1)"
  status=$?
  set -e
  if [[ "$status" != "$expected" ]]; then
    echo "$name: expected $expected, got $status" >&2
    echo "$output" >&2
    return 1
  fi
  if [[ "$scan_exit" == 1 ]]; then
    case "$shape" in
    findings) grep -F '::warning file=src/a%3Ab.js,line=4::unsafe%25value' <<<"$output" >/dev/null ;;
    encoded-file) grep -F '::warning file=src/encoded space.lock,line=4::unsafe%25value' <<<"$output" >/dev/null ;;
    malformed-uri | nul-uri | outside-uri | foreign-scheme | foreign-host)
      grep -F '::warning::unsafe%25value' <<<"$output" >/dev/null
      if grep -F 'file=' <<<"$output" >/dev/null || grep -F 'uri-sentinel' <<<"$output" >/dev/null; then
        echo "$name: unsafe URI leaked into annotation output" >&2
        return 1
      fi
      ;;
    *) return 2 ;;
    esac
    if grep -F 'unsafe%value' <<<"$output" >/dev/null || grep -Fx '::error::raw-message' <<<"$output" >/dev/null; then
      echo "$name: raw message leaked into workflow commands" >&2
      return 1
    fi
  fi
  echo "ok: $name"
}

run_case 'clean scan' 0 0 false true clean
run_case 'advisory findings remain green' 0 1 false false findings
run_case 'blocking findings fail' 1 1 false true findings
run_case 'encoded local file URI becomes a repository path' 0 1 false false encoded-file
run_case 'malformed URI keeps warning without a file' 0 1 false false malformed-uri
run_case 'encoded NUL keeps warning without a file' 0 1 false false nul-uri
run_case 'outside file URI keeps warning without a file' 0 1 false false outside-uri
run_case 'foreign scheme keeps warning without a file' 0 1 false false foreign-scheme
run_case 'foreign file host keeps warning without a file' 0 1 false false foreign-host
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
