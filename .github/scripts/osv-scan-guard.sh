# shellcheck shell=bash
set -euo pipefail

case "${FAIL_ON_VULN:-}" in true | false) ;; *)
  echo '::error::fail-on-vuln must resolve to true or false.'
  exit 2
  ;;
esac
case "${ALLOW_NO_LOCKFILES:-}" in true | false) ;; *)
  echo '::error::allow-no-lockfiles must resolve to true or false.'
  exit 2
  ;;
esac
if [[ ! "${SCAN_EXIT:-}" =~ ^[0-9]+$ ]]; then
  echo '::error::OSV-Scanner did not report a numeric exit code.'
  exit 2
fi

valid_sarif=false
if [[ -f "${OSV_RESULTS:-}" && ! -L "${OSV_RESULTS:-}" ]] &&
  jq -e '.version == "2.1.0" and (.runs | type == "array") and ([.runs[].results[]?] | type == "array")' "$OSV_RESULTS" >/dev/null 2>&1; then
  valid_sarif=true
fi

annotate_findings() {
  local file line message normalized_file
  escape_property() {
    local v="$1"
    v=${v//'%'/'%25'}
    v=${v//$'\r'/'%0D'}
    v=${v//$'\n'/'%0A'}
    v=${v//':'/'%3A'}
    v=${v//','/'%2C'}
    printf '%s' "$v"
  }
  escape_data() {
    local v="$1"
    v=${v//'%'/'%25'}
    v=${v//$'\r'/'%0D'}
    v=${v//$'\n'/'%0A'}
    printf '%s' "$v"
  }
  normalize_sarif_uri() {
    local uri="$1" encoded decoded='' remainder prefix hex byte
    local workspace candidate resolved relative

    [[ -n "$uri" && -n "${GITHUB_WORKSPACE:-}" ]] || return 1
    workspace="$(realpath -e -- "$GITHUB_WORKSPACE" 2>/dev/null)" || return 1
    [[ -d "$workspace" ]] || return 1

    if [[ "$uri" == file:///* ]]; then
      encoded="${uri#file://}"
    elif [[ "$uri" == file://* || "$uri" =~ ^[A-Za-z][A-Za-z0-9+.-]*: ]]; then
      return 1
    elif [[ "$uri" == /* ]]; then
      return 1
    else
      encoded="$uri"
    fi
    [[ -n "$encoded" && "$encoded" != *'?'* && "$encoded" != *'#'* ]] || return 1

    remainder="$encoded"
    while [[ "$remainder" == *%* ]]; do
      prefix="${remainder%%\%*}"
      remainder="${remainder#*\%}"
      [[ "$remainder" =~ ^([0-9A-Fa-f]{2}) ]] || return 1
      hex="${BASH_REMATCH[1]}"
      if ((16#$hex < 32 || 16#$hex == 127)); then
        return 1
      fi
      printf -v byte '%b' "\\x$hex"
      decoded+="$prefix$byte"
      remainder="${remainder:2}"
    done
    decoded+="$remainder"
    [[ -n "$decoded" ]] || return 1

    if [[ "$uri" == file:///* ]]; then
      candidate="$decoded"
    else
      candidate="$workspace/$decoded"
    fi
    resolved="$(realpath -e -- "$candidate" 2>/dev/null)" || return 1
    [[ "$resolved" == "$workspace" || "$resolved" == "$workspace/"* ]] || return 1
    if [[ "$resolved" == "$workspace" ]]; then
      relative='.'
    else
      relative="${resolved#"$workspace/"}"
    fi
    printf '%s' "$relative"
  }
  while IFS=$'\t' read -r file line message; do
    [[ -z "$message" ]] && continue
    message="$(escape_data "$message")"
    # shellcheck disable=SC2310 # normalization returns status; fallible body commands are checked.
    if normalized_file="$(normalize_sarif_uri "$file")"; then
      file="$(escape_property "$normalized_file")"
      [[ "$line" =~ ^[1-9][0-9]*$ ]] || line=1
      line="$(escape_property "$line")"
      echo "::warning file=$file,line=$line::$message"
    else
      echo "::warning::$message"
    fi
  done < <(jq -r '[.runs[].results[]?][:50][] | [(.locations[0].physicalLocation.artifactLocation.uri // ""), (.locations[0].physicalLocation.region.startLine // 1), (.message.text // "OSV vulnerability finding")] | @tsv' "$OSV_RESULTS")
}

case "$SCAN_EXIT" in
0 | 1)
  if [[ "$valid_sarif" != true ]]; then
    echo "::error::OSV-Scanner exited $SCAN_EXIT without a valid regular SARIF result."
    exit 2
  fi
  finding_count="$(jq '[.runs[].results[]?] | length' "$OSV_RESULTS")"
  if [[ "$SCAN_EXIT" == 0 && "$finding_count" != 0 ]] || [[ "$SCAN_EXIT" == 1 && "$finding_count" == 0 ]]; then
    echo "::error::OSV-Scanner exit $SCAN_EXIT disagrees with SARIF finding count $finding_count."
    exit 2
  fi
  if [[ "$SCAN_EXIT" == 1 ]]; then
    annotate_findings
    if [[ "$FAIL_ON_VULN" == true ]]; then
      echo "::error::OSV-Scanner reported $finding_count vulnerability finding(s)."
      exit 1
    fi
    echo "::notice::OSV-Scanner reported $finding_count finding(s); advisory mode remains successful."
  else
    echo 'OSV-Scanner completed without vulnerability findings.'
  fi
  ;;
128)
  if [[ "$ALLOW_NO_LOCKFILES" == true ]]; then
    echo 'Empty OSV scan accepted because the caller declared the repository dependency-less.'
  elif [[ "$FAIL_ON_VULN" == true ]]; then
    echo '::error::OSV-Scanner found no supported dependency sources (exit 128).'
    exit 1
  else
    echo '::warning::OSV-Scanner found no supported dependency sources (exit 128).'
  fi
  ;;
*)
  echo "::error::OSV-Scanner failed operationally (exit $SCAN_EXIT); results are not trusted."
  exit "$SCAN_EXIT"
  ;;
esac
