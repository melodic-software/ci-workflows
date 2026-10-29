# shellcheck shell=bash
# Rate-limit readings from a job's own API responses: each reading comes from
# the x-ratelimit-* headers of a response the job already got, never from
# a rate-limit endpoint, which reports a different bucket. A reading is one
# line in $RUNNER_TEMP/api-budget/<token>:
#   <status> <limit> <remaining> <used> <reset epoch> <resource>
# (`na` for a missing value). api-budget.cjs appends the same lines from
# Octokit's request hooks, one line per request. Keep the three functions
# identical to those in claude-code-plugins'
# .github/actions/log-api-budget/api-budget.bash, so the notices are the lines
# the hub collector reads from every repository's runs. Never fails the caller.
#
#   api_budget_read <token> <file>
#                               gh api -i output: the header block at the start
#                               becomes a reading, the body goes to stdout byte
#                               for byte
#   api_budget_emit <token>...  the hub collector's notice for each refused
#                               (403/429) reading and for the last reading of
#                               each resource, core last; cost is
#                               the rise in used since the first earlier reading
#                               with the same reset and resource, else na
#   api_budget_emit_calls <token>...
#                               the hub's api-calls notice for each token,
#                               `<token>=N not-modified=M graphql=K`: N is the
#                               job's own requests, M its 304 answers, which
#                               GitHub does not count, and K the GraphQL ones
#                               among N, which spend their own pool; 0 for a
#                               token with no reading

api_budget_read() {
  local state=${RUNNER_TEMP:-}/api-budget/${1:-} lines
  if [[ -z ${RUNNER_TEMP:-} || ! ${1:-} =~ ^[a-z][a-z0-9-]{0,39}$ ]] || ! mkdir -p "${state%/*}" 2>/dev/null; then
    state=/dev/null
  fi
  # Only the block at the very start is headers, so a body line shaped like a
  # status line stays body. awk reads the block and prints its line count;
  # tail then writes the body byte for byte.
  lines=$(awk -v state="$state" '
    function val(k, re) { return (k in h && h[k] ~ re) ? h[k] : "na" }
    function flush() {
      printf "%s %s %s %s %s %s\n", status, val("limit", "^[0-9]+$"), val("remaining", "^[0-9]+$"),
        val("used", "^[0-9]+$"), val("reset", "^[0-9]+$"), val("resource", "^[a-z_]+$") >>state
      close(state)
      print NR
      done = 1
      exit
    }
    NR == 1 && !/^HTTP\/[0-9.]+ [0-9][0-9][0-9]/ { print 0; done = 1; exit }
    NR == 1 { status = $2; next }
    {
      line = $0
      sub(/\r$/, "", line)
      if (line == "") flush()
      if (tolower(line) ~ /^x-ratelimit-(limit|remaining|used|reset|resource):/) {
        k = tolower(line); sub(/^x-ratelimit-/, "", k); sub(/:.*/, "", k)
        v = line; sub(/^[^:]*:[ \t]*/, "", v)
        h[k] = v
      }
    }
    END { if (!done && NR) flush(); if (!done) print 0 }
  ' "$2") || lines=0
  tail -n +"$((${lines:-0} + 1))" "$2"
}

api_budget_emit_calls() {
  local token file
  for token; do
    file=${RUNNER_TEMP:-}/api-budget/$token
    [[ -n ${RUNNER_TEMP:-} && $token =~ ^[a-z][a-z0-9-]{0,39}$ ]] || continue
    [[ -s $file ]] || file=/dev/null
    awk '$1 != 304 { n++ } $1 == 304 { m++ } $6 == "graphql" || $2 == "graphql" { g++ } END { printf "::notice title=api-calls::%s=%d not-modified=%d graphql=%d\n", token, n, m, g }' token="$token" "$file"
  done
  return 0
}

api_budget_emit() {
  local token file where workflow=${GITHUB_WORKFLOW_REF:-}
  workflow=${workflow%%@*}
  workflow=${workflow#*/*/}
  where="workflow=${workflow:-na} job=${GITHUB_JOB:-na} run=${GITHUB_RUN_ID:-na} attempt=${GITHUB_RUN_ATTEMPT:-na}"
  for token; do
    file=${RUNNER_TEMP:-}/api-budget/$token
    [[ -n ${RUNNER_TEMP:-} && -s $file ]] || continue
    awk -v token="$token" -v where="$where" '
      NF == 6 { n++; s[n] = $1; l[n] = $2; r[n] = $3; u[n] = $4; t[n] = $5; res[n] = $6 }
      function line(i,   j, cost) {
        cost = "na"
        if (u[i] != "na" && t[i] != "na") {
          for (j = 1; j < i; j++) if (t[j] == t[i] && res[j] == res[i] && u[j] != "na") break
          if (j < i && u[i] + 0 >= u[j] + 0) cost = u[i] - u[j]
        }
        printf "::notice title=api-budget::token=%s %s limit=%s remaining=%s used=%s reset=%s resource=%s cost=%s\n",
          token, where, l[i], r[i], u[i], t[i], res[i], cost
      }
      END {
        for (i = 1; i <= n; i++) last[res[i]] = i
        for (i = 1; i <= n; i++) if ((s[i] == 403 || s[i] == 429) && last[res[i]] != i) line(i)
        for (i = 1; i <= n; i++) if (last[res[i]] == i && res[i] != "core") line(i)
        if ("core" in last) line(last["core"])
      }' "$file"
  done
  return 0
}
