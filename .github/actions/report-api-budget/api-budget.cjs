"use strict";

// Appends one rate-limit reading per GitHub API response, from its
// x-ratelimit-* headers and its templated route, to
// $RUNNER_TEMP/api-budget/<token> in api-budget.bash's line shape, for the
// job-end notices this action writes. `token` names the bucket
// (`github-token` for the job token). Never throws: a reading is never worth
// failing the job.

const fs = require("node:fs");
const path = require("node:path");

const VALUE = {
  limit: /^\d+$/u,
  remaining: /^\d+$/u,
  used: /^\d+$/u,
  reset: /^\d+$/u,
  resource: /^[a-z_]+$/u,
};

// The GitHub REST path words a route may show; any other segment could be a
// name, a path or planted text. claude-code-plugins'
// .github/actions/log-api-budget/rate-guard.mjs holds the source of
// REST_PATH_WORDS, routeOk and routeOf; keep these the same, and
// api-budget.bash's API_BUDGET_ROUTE their twin (a test checks).
const REST_PATH_WORDS = new Set(
  "api v3 repos orgs users user installation app graphql pulls issues comments reviews requested_reviewers git refs ref heads tags trees blobs commits compare merges merge check-runs check-suites statuses status labels assignees milestones events timeline actions runs jobs attempts artifacts logs rerun rerun-failed-jobs workflows dispatches variables secrets contents branches protection rules rulesets collaborators permission teams members hooks deployments environments releases search code reactions files rate_limit annotations repositories installations access_tokens pending_deployments cancel update-branch dismissals readme matching-refs languages notifications".split(
    " ",
  ),
);
const PLACEHOLDERS = new Set(["{n}", "{sha}", "{repo}", "{x}"]);
// Whether a route has only path words and placeholders.
const routeOk = (route) =>
  typeof route === "string" &&
  route.length <= 80 &&
  (route === "graphql" ||
    route === "other" ||
    route
      .split("/")
      .every((seg) => REST_PATH_WORDS.has(seg) || PLACEHOLDERS.has(seg)));

// A request's URL as a route that holds no query, name or token. A URL on a
// host other than api.github.com and uploads.github.com is other, unless its
// path starts with /api/ (GHES); scheme, host, /api/v3, query and fragment
// go; a GraphQL path is graphql; repos/<owner>/<repo> is repos/{repo}; a
// number is {n}; hex of 7 or more characters {sha}; the segment after one
// that names a thing (labels/<name>) and every segment after one that starts
// a path or ref (contents/<path>) is {x} unless a number; a REST path word
// stays; any other segment is {x}.
const ROUTE_TAIL = /^(contents|ref|refs|matching-refs|readme|compare|trees)$/u;
const ROUTE_NAME =
  /^(labels|branches|tags|users|orgs|teams|members|collaborators|assignees|environments|secrets|variables|workflows|commits|blobs|statuses|releases)$/u;
function routeOf(url) {
  const text = String(url?.url ?? url ?? "");
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/iu.exec(text);
  if (
    host &&
    !/^(api|uploads)\.github\.com$/iu.test(host[1]) &&
    !/^\/api\//u.test(host[2])
  ) {
    return "other";
  }
  const route = text
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/iu, "")
    .replace(/[?#][\s\S]*$/u, "")
    .replace(/^\/+/u, "")
    .replace(/^api\/(v3\/)?/u, "")
    .replace(/\/+$/u, "");
  if (route === "graphql") return "graphql";
  if (route === "") return "other";
  const segments = route.split("/");
  const out = [];
  let tail = false;
  let name = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (tail || name) {
      out.push(
        /^[0-9]+$/u.test(seg)
          ? "{n}"
          : /^[0-9a-f]{7,}$/iu.test(seg)
            ? "{sha}"
            : "{x}",
      );
      name = false;
    } else if (i === 1 && segments[0] === "repos" && segments.length >= 3) {
      out.push("{repo}");
      i++;
    } else if (/^[0-9]+$/u.test(seg)) {
      out.push("{n}");
    } else if (/^[0-9a-f]{7,}$/iu.test(seg)) {
      out.push("{sha}");
    } else if (
      REST_PATH_WORDS.has(seg) &&
      seg !== "api" &&
      seg !== "v3" &&
      seg !== "graphql"
    ) {
      out.push(seg);
      tail = ROUTE_TAIL.test(seg);
      name = ROUTE_NAME.test(seg);
    } else {
      out.push("{x}");
    }
  }
  const joined = out.join("/");
  return joined.length > 80 ? "other" : joined;
}

// Octokit's headers: a plain object with lower-case keys. The route comes
// last, `other` when it is not in routeOf's shape.
function readingLine(status, headers, route = "other") {
  const values = Object.entries(VALUE).map(([key, re]) => {
    const value = String(headers?.[`x-ratelimit-${key}`] ?? "");
    return re.test(value) ? value : "na";
  });
  return `${status} ${values.join(" ")} ${routeOk(route) ? route : "other"}\n`;
}

function recordReading({
  token,
  dir = process.env.RUNNER_TEMP,
  status,
  headers,
  route,
}) {
  if (!dir || !/^[a-z][a-z0-9-]{0,39}$/u.test(token ?? "")) return;
  try {
    fs.mkdirSync(path.join(dir, "api-budget"), { recursive: true });
    fs.appendFileSync(
      path.join(dir, "api-budget", token),
      readingLine(status, headers, route),
    );
  } catch {
    // Nothing to do: the notice is only missing a reading.
  }
}

// Records every response and refusal of one Octokit client, each under the
// route of the URL it was sent to; a refusal is rethrown unchanged.
function watch(github, token) {
  github.hook.after("request", (response) =>
    recordReading({
      token,
      status: response.status,
      headers: response.headers,
      route: routeOf(response.url),
    }),
  );
  github.hook.error("request", (error) => {
    if (error?.response)
      recordReading({
        token,
        status: error.status ?? error.response.status,
        headers: error.response.headers,
        route: routeOf(error.response.url ?? error.request?.url),
      });
    throw error;
  });
}

module.exports = {
  PLACEHOLDERS,
  REST_PATH_WORDS,
  readingLine,
  recordReading,
  routeOf,
  routeOk,
  watch,
};
