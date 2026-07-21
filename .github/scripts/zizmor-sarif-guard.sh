# shellcheck shell=bash
set -euo pipefail

: "${ZIZMOR_EXIT_CODE:?ZIZMOR_EXIT_CODE is required}"
: "${ZIZMOR_SARIF:?ZIZMOR_SARIF is required}"
: "${ZIZMOR_VERSION:?ZIZMOR_VERSION is required}"
: "${FAIL_ON_SEVERITY:?FAIL_ON_SEVERITY is required}"

case "$FAIL_ON_SEVERITY" in
never | low | medium | high) ;;
*)
  echo '::error::fail-on-severity must resolve to never, low, medium, or high.'
  exit 2
  ;;
esac

if [[ ! "$ZIZMOR_EXIT_CODE" =~ ^[0-9]+$ ]]; then
  echo '::error::zizmor did not report a numeric exit code.'
  exit 2
fi
# zizmor exits 0 in SARIF mode regardless of findings, so any nonzero code is an
# infrastructure failure (download, argument, or collection error), not a
# finding signal; fail closed rather than trust a partial result.
if ((ZIZMOR_EXIT_CODE != 0)); then
  echo "::error::zizmor exited $ZIZMOR_EXIT_CODE in SARIF mode; results are not trusted."
  exit 2
fi
if [[ ! -f "$ZIZMOR_SARIF" || -L "$ZIZMOR_SARIF" ]]; then
  echo '::error::zizmor SARIF output is missing or is not a regular file.'
  exit 2
fi

# zizmor's SARIF driver reports the plain X.Y.Z semanticVersion (no leading v),
# so strip any caller-supplied prefix before pinning provenance.
expected_version="${ZIZMOR_VERSION#v}"
if ! jq -e --arg version "$expected_version" '
  type == "object" and
  .version == "2.1.0" and
  (.runs | type == "array" and length == 1) and
  (.runs[0].tool.driver | type == "object") and
  .runs[0].tool.driver.name == "zizmor" and
  .runs[0].tool.driver.semanticVersion == $version and
  (.runs[0].results | type == "array") and
  all(.runs[0].results[];
    type == "object" and
    (.ruleId | type == "string" and length > 0) and
    (.level == "error" or .level == "warning" or .level == "note") and
    (.message.text | type == "string" and length > 0)
  )
' "$ZIZMOR_SARIF" >/dev/null 2>&1; then
  echo '::error::zizmor SARIF is malformed or violates the pinned provenance schema.'
  exit 2
fi

annotate_findings() {
  local level kind file line message normalized_file uri_safe uri_base64 message_safe message_base64
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
  decode_base64_field() {
    local encoded="$1" target="$2" decoded status
    decoded="$(
      set +e
      jq -jnr --arg encoded "$encoded" '$encoded | @base64d' 2>/dev/null
      status=$?
      printf '\036'
      exit "$status"
    )" || return 1
    decoded="${decoded%$'\036'}"
    printf -v "$target" '%s' "$decoded"
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
    [[ "${encoded,,}" != *'%00'* ]] || return 1

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
    [[ -n "$decoded" && "$decoded" != *\\* ]] || return 1
    if printf '%s' "$decoded" | LC_ALL=C grep -q '[[:cntrl:]]'; then
      return 1
    fi

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
  while IFS='|' read -r level uri_safe uri_base64 line message_safe message_base64; do
    message_base64="${message_base64%$'\r'}"
    case "$level" in
    error) kind=error ;;
    warning) kind=warning ;;
    note) kind=notice ;;
    *) kind=error ;;
    esac
    if [[ "$message_safe" == true ]]; then
      # shellcheck disable=SC2310 # decoder status selects a safe fallback explicitly.
      if ! decode_base64_field "$message_base64" message; then
        message='zizmor finding'
      fi
    else
      message='zizmor finding'
    fi
    message="$(escape_data "$message")"
    # shellcheck disable=SC2310 # normalization returns status; fallible body commands are checked.
    if [[ "$uri_safe" == true ]] && decode_base64_field "$uri_base64" file && normalized_file="$(normalize_sarif_uri "$file")"; then
      file="$(escape_property "$normalized_file")"
      [[ "$line" =~ ^[1-9][0-9]*$ ]] || line=1
      line="$(escape_property "$line")"
      echo "::$kind file=$file,line=$line::$message"
    else
      echo "::$kind::$message"
    fi
  done < <(jq -r '
    [.runs[0].results[]][:50][]
    | (.locations[0].physicalLocation.artifactLocation.uri // "") as $uri
    | (.message.text // "zizmor finding") as $message
    | [
        .level,
        (if ($uri | type) == "string" then ($uri | explode | all(. >= 32 and . != 127)) else false end),
        ($uri | if type == "string" then @base64 else "" end),
        (.locations[0].physicalLocation.region.startLine // 1 | if type == "number" and . >= 1 and . == floor then tostring else "1" end),
        (if ($message | type) == "string" then ($message | explode | all((. >= 32 or . == 9 or . == 10 or . == 13) and . != 127)) else false end),
        ($message | if type == "string" then @base64 else ("zizmor finding" | @base64) end)
      ]
    | join("|")
  ' "$ZIZMOR_SARIF")
}

annotate_findings

# Emit annotations for every finding above, then gate on severity. The blocking
# level set maps FAIL_ON_SEVERITY to SARIF result levels (high->error,
# medium->warning, low|informational->note); never blocks on nothing.
case "$FAIL_ON_SEVERITY" in
never) blocking_levels='[]' ;;
low) blocking_levels='["error","warning","note"]' ;;
medium) blocking_levels='["error","warning"]' ;;
high) blocking_levels='["error"]' ;;
*)
  echo '::error::fail-on-severity must resolve to never, low, medium, or high.'
  exit 2
  ;;
esac

total_count="$(jq '.runs[0].results | length' "$ZIZMOR_SARIF")"
blocking_count="$(jq --argjson levels "$blocking_levels" '
  [.runs[0].results[] | select(.level as $l | $levels | index($l))] | length
' "$ZIZMOR_SARIF")"

if ((blocking_count > 0)); then
  ids="$(jq -r --argjson levels "$blocking_levels" '
    [.runs[0].results[] | select(.level as $l | $levels | index($l)) | .ruleId] | unique | join(", ")
  ' "$ZIZMOR_SARIF")"
  echo "::error::zizmor reported $blocking_count finding(s) at or above severity $FAIL_ON_SEVERITY: $ids"
  exit 1
fi

if ((total_count == 0)); then
  echo 'zizmor completed with no findings.'
elif [[ "$FAIL_ON_SEVERITY" == never ]]; then
  echo "::notice::zizmor reported $total_count finding(s); advisory mode keeps this lane successful."
else
  echo "::notice::zizmor reported $total_count finding(s); none at or above severity $FAIL_ON_SEVERITY."
fi
