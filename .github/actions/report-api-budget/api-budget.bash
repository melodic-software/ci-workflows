# shellcheck shell=bash
# Rate-limit readings from a job's own API responses: each reading comes from
# the x-ratelimit-* headers of a response the job already got, never from
# a rate-limit endpoint, which reports a different bucket. A reading is one
# line in $RUNNER_TEMP/api-budget/<token>:
#   <status> <limit> <remaining> <used> <reset epoch> <resource> <route>
# (`na` for a missing value; a line written before the route field holds six
# fields and counts as route `other`). api-budget.cjs appends the same lines
# from Octokit's request hooks. Keep these functions identical to those in
# claude-code-plugins' .github/actions/log-api-budget/api-budget.bash, so each
# notice is the line the hub collector reads from every repository's runs;
# api_budget_emit differs only in grouping by resource alone.
# Never fails the caller.
#
#   api_budget_read <token> <file> [route]
#                               gh api -i output: the header block at the start
#                               becomes a reading under route (`other` when
#                               unset), the body goes to stdout byte for byte
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
#   api_budget_emit_routes <token>...
#                               the api-routes notice for each token,
#                               `<token> <route>=<count> ... rest=<count>`:
#                               the N above by route, most first (ties by
#                               route), at most 15 routes and 1000 bytes, the
#                               rest summed; `other` for a line with no route

# Awk functions, api-budget.cjs's routeOf and routeOk: api_route gives a
# request's URL or gh api path as a route that holds no query, name or token,
# by routeOf's rules (a URL on a host other than api.github.com and
# uploads.github.com is other, unless its path starts with /api/, as on
# GHES); api_route_ok says whether a route has only REST path words
# (api-budget.cjs's REST_PATH_WORDS, the same list: report-api-budget.test.cjs
# checks) and placeholders.
# shellcheck disable=SC2016 # an awk program
API_BUDGET_ROUTE='function api_words(   w, i, n) {
    if (api_words_read) return
    n = split("api v3 repos orgs users user installation app graphql pulls issues comments reviews requested_reviewers git refs ref heads tags trees blobs commits compare merges merge check-runs check-suites statuses status labels assignees milestones events timeline actions runs jobs attempts artifacts logs rerun rerun-failed-jobs workflows dispatches variables secrets contents branches protection rules rulesets collaborators permission teams members hooks deployments environments releases search code reactions files rate_limit annotations repositories installations access_tokens pending_deployments cancel update-branch dismissals readme matching-refs languages notifications", w, " ")
    for (i = 1; i <= n; i++) API_WORD[w[i]] = 1
    API_WORD["{n}"] = API_WORD["{sha}"] = API_WORD["{repo}"] = API_WORD["{x}"] = 1
    api_words_read = 1
  }
  function api_hex(seg) { return length(seg) >= 7 && seg ~ /^[0-9A-Fa-f]+$/ }
  function api_route_ok(r,   n, s, i) {
    if (r == "graphql" || r == "other") return 1
    if (r == "" || length(r) > 80) return 0
    api_words()
    n = split(r, s, "/")
    for (i = 1; i <= n; i++) if (!(s[i] in API_WORD)) return 0
    return 1
  }
  function api_route(u,   n, s, i, seg, out, tail, name, host, rest) {
    api_words()
    sub(/[?#].*$/, "", u)
    if (u ~ /^[A-Za-z][A-Za-z0-9+.-]*:\/\//) {
      rest = u
      sub(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "", rest)
      host = rest
      sub(/\/.*$/, "", host)
      sub(/^[^\/]*/, "", rest)
      if (tolower(host) != "api.github.com" && tolower(host) != "uploads.github.com" && rest !~ /^\/api\//) return "other"
      u = rest
    }
    sub(/^\/+/, "", u)
    sub(/^api\/(v3\/)?/, "", u)
    sub(/\/+$/, "", u)
    if (u == "graphql") return "graphql"
    if (u == "") return "other"
    n = split(u, s, "/")
    out = ""
    tail = name = 0
    for (i = 1; i <= n; i++) {
      seg = s[i]
      if (tail || name) { seg = (seg ~ /^[0-9]+$/) ? "{n}" : api_hex(seg) ? "{sha}" : "{x}"; name = 0 }
      else if (i == 2 && s[1] == "repos" && n >= 3) { seg = "{repo}"; i++ }
      else if (seg ~ /^[0-9]+$/) seg = "{n}"
      else if (api_hex(seg)) seg = "{sha}"
      else if (!(seg in API_WORD) || seg ~ /^(api|v3|graphql|[{].*)$/) seg = "{x}"
      else if (seg ~ /^(contents|ref|refs|matching-refs|readme|compare|trees)$/) tail = 1
      else if (seg ~ /^(labels|branches|tags|users|orgs|teams|members|collaborators|assignees|environments|secrets|variables|workflows|commits|blobs|statuses|releases)$/) name = 1
      out = out (out == "" ? "" : "/") seg
    }
    return length(out) > 80 ? "other" : out
  }'

api_budget_read() {
  local state=${RUNNER_TEMP:-}/api-budget/${1:-} lines
  if [[ -z ${RUNNER_TEMP:-} || ! ${1:-} =~ ^[a-z][a-z0-9-]{0,39}$ ]] || ! mkdir -p "${state%/*}" 2>/dev/null; then
    state=/dev/null
  fi
  # Only the block at the very start is headers, so a body line shaped like a
  # status line stays body. awk reads the block and prints its line count;
  # tail then writes the body byte for byte.
  lines=$(awk -v state="$state" -v route="${3:-other}" "$API_BUDGET_ROUTE"'
    function val(k, re) { return (k in h && h[k] ~ re) ? h[k] : "na" }
    function flush() {
      if (!api_route_ok(route)) route = "other"
      printf "%s %s %s %s %s %s %s\n", status, val("limit", "^[0-9]+$"), val("remaining", "^[0-9]+$"),
        val("used", "^[0-9]+$"), val("reset", "^[0-9]+$"), val("resource", "^[a-z_]+$"), route >>state
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

api_budget_emit_routes() {
  local token file
  for token; do
    file=${RUNNER_TEMP:-}/api-budget/$token
    [[ -n ${RUNNER_TEMP:-} && $token =~ ^[a-z][a-z0-9-]{0,39}$ ]] || continue
    [[ -s $file ]] || file=/dev/null
    # The route is the last field of a `request` line and the seventh of a
    # reading; a line without one, or with one not in the route's shape, is other.
    awk "$API_BUDGET_ROUTE"' $1 == 304 { next }
      { r = "other" }
      $1 == "request" && NF >= 2 { r = $NF }
      $1 != "request" && NF == 7 { r = $7 }
      { if (!api_route_ok(r)) r = "other"; n[r]++ }
      END { for (r in n) print n[r], r }' "$file" | LC_ALL=C sort -k1,1nr -k2,2 |
      awk -v head="::notice title=api-routes::$token" '
        { add = " " $2 "=" $1 }
        !full && NR <= 15 && length(head line add) + 16 <= 1000 { line = line add; next }
        { full = 1; rest += $1 }
        END { printf "%s%s rest=%d\n", head, line, rest }'
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
      NF == 6 || NF == 7 { n++; s[n] = $1; l[n] = $2; r[n] = $3; u[n] = $4; t[n] = $5; res[n] = $6 }
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
