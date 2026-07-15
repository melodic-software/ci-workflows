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
  local message="${2-$'unsafe%value\n::error::raw-message'}"
  jq -n --arg uri "$1" --arg message "$message" '
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
  string-results) printf '{"version":"2.1.0","runs":[{"results":"not an array"}]}\n' >"$results" ;;
  missing-results) printf '{"version":"2.1.0","runs":[{}]}\n' >"$results" ;;
  empty-runs) printf '{"version":"2.1.0","runs":[]}\n' >"$results" ;;
  findings) write_finding 'src/a:b.js' ;;
  encoded-file) write_finding "file://${workspace}/src/encoded%20space.lock" ;;
  malformed-uri) write_finding 'src/uri-sentinel-malformed%2G.lock' ;;
  nul-uri) write_finding 'src/uri-sentinel-nul%00.lock' ;;
  encoded-control) write_finding 'src/uri-sentinel-control%1B.lock' ;;
  encoded-del) write_finding 'src/uri-sentinel-del%7F.lock' ;;
  raw-control) write_finding $'src/uri-sentinel-control\e.lock' ;;
  raw-del) write_finding $'src/uri-sentinel-del\x7f.lock' ;;
  raw-backslash) write_finding 'src\uri-sentinel-backslash.lock' ;;
  query-uri) write_finding 'src/a:b.js?uri-sentinel-query' ;;
  fragment-uri) write_finding 'src/a:b.js#uri-sentinel-fragment' ;;
  traversal-uri) write_finding '../uri-sentinel-outside.lock' ;;
  symlink-outside) write_finding 'src/uri-sentinel-outside-link.lock' ;;
  outside-uri) write_finding "file://${temporary_directory}/uri-sentinel-outside.lock" ;;
  foreign-scheme) write_finding 'https://example.invalid/uri-sentinel-foreign.lock' ;;
  foreign-host) write_finding 'file://example.invalid/uri-sentinel-host.lock' ;;
  unsafe-message) write_finding 'src/a:b.js' $'message-sentinel\evalue' ;;
  locationless)
    jq -n --arg message $'locationless%secret\n::error::injected' '
      {version: "2.1.0", runs: [{results: [{message: {text: $message}}]}]}
    ' >"$results"
    ;;
  non-string-uri)
    jq -n --arg message $'locationless%secret\n::error::injected' '
      {version: "2.1.0", runs: [{results: [{
        message: {text: $message},
        locations: [{physicalLocation: {artifactLocation: {uri: {secret: "uri-sentinel"}}}}]
      }]}]}
    ' >"$results"
    ;;
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
    malformed-uri | nul-uri | encoded-control | encoded-del | raw-control | raw-del | raw-backslash | query-uri | fragment-uri | traversal-uri | symlink-outside | outside-uri | foreign-scheme | foreign-host)
      grep -F '::warning::unsafe%25value' <<<"$output" >/dev/null
      if grep -F 'file=' <<<"$output" >/dev/null || grep -F 'uri-sentinel' <<<"$output" >/dev/null; then
        echo "$name: unsafe URI leaked into annotation output" >&2
        return 1
      fi
      ;;
    unsafe-message)
      grep -F '::warning file=src/a%3Ab.js,line=4::OSV vulnerability finding' <<<"$output" >/dev/null
      if grep -F 'message-sentinel' <<<"$output" >/dev/null; then
        echo "$name: unsafe raw message leaked into annotation output" >&2
        return 1
      fi
      ;;
    locationless | non-string-uri)
      grep -E '::warning::locationless%25secret(%0D)?%0A::error::injected' <<<"$output" >/dev/null
      if grep -E '(^|[ ,])(file|line)=' <<<"$output" >/dev/null || grep -F 'locationless%secret' <<<"$output" >/dev/null || grep -F 'uri-sentinel' <<<"$output" >/dev/null || grep -Fx '::error::injected' <<<"$output" >/dev/null; then
        echo "$name: empty or non-string location leaked or shifted framed fields" >&2
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
run_case 'encoded ESC keeps warning without a file' 0 1 false false encoded-control
run_case 'encoded DEL keeps warning without a file' 0 1 false false encoded-del
run_case 'raw ESC keeps warning without a file' 0 1 false false raw-control
run_case 'raw DEL keeps warning without a file' 0 1 false false raw-del
run_case 'raw backslash keeps warning without a file' 0 1 false false raw-backslash
run_case 'query URI keeps warning without a file' 0 1 false false query-uri
run_case 'fragment URI keeps warning without a file' 0 1 false false fragment-uri
run_case 'traversal URI keeps warning without a file' 0 1 false false traversal-uri
run_case 'outside file URI keeps warning without a file' 0 1 false false outside-uri
run_case 'foreign scheme keeps warning without a file' 0 1 false false foreign-scheme
run_case 'foreign file host keeps warning without a file' 0 1 false false foreign-host
run_case 'unsafe raw message becomes a generic warning' 0 1 false false unsafe-message
run_case 'locationless finding keeps its escaped message without metadata' 0 1 false false locationless
run_case 'non-string URI keeps its escaped message without metadata' 0 1 false false non-string-uri
run_case 'operational error always fails closed' 7 7 false false absent
run_case 'missing result always fails closed' 2 0 false false absent
run_case 'invalid result always fails closed' 2 0 false false invalid
run_case 'string results fail closed' 2 0 false false string-results
run_case 'missing results fail closed' 2 0 false false missing-results
run_case 'empty runs fail closed' 2 0 false false empty-runs
run_case 'exit and result mismatch fails closed' 2 0 false false findings
run_case 'advisory empty scan warns' 0 128 false false absent
run_case 'blocking empty scan fails' 1 128 false true absent
run_case 'declared dependency-less empty scan passes' 0 128 true true absent
if [[ "$(uname -s)" == Linux ]]; then
  ln -s -- "$temporary_directory/uri-sentinel-outside.lock" "$workspace/src/uri-sentinel-outside-link.lock"
  run_case 'outside symlink keeps warning without a file' 0 1 false false symlink-outside
  run_case 'symlink result fails closed' 2 0 false false symlink
fi
