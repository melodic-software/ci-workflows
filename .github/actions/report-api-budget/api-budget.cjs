"use strict";

// Appends one rate-limit reading per GitHub API response, from its
// x-ratelimit-* headers, to $RUNNER_TEMP/api-budget/<token> in
// api-budget.bash's line shape, for the job-end notice this action writes.
// `token` names the bucket (`github-token` for the job token). Never throws:
// a reading is never worth failing the job.

const fs = require("node:fs");
const path = require("node:path");

const VALUE = {
  limit: /^\d+$/u,
  remaining: /^\d+$/u,
  used: /^\d+$/u,
  reset: /^\d+$/u,
  resource: /^[a-z_]+$/u,
};

// Octokit's headers: a plain object with lower-case keys.
function readingLine(status, headers) {
  const values = Object.entries(VALUE).map(([key, re]) => {
    const value = String(headers?.[`x-ratelimit-${key}`] ?? "");
    return re.test(value) ? value : "na";
  });
  return `${status} ${values.join(" ")}\n`;
}

function recordReading({ token, dir = process.env.RUNNER_TEMP, status, headers }) {
  if (!dir || !/^[a-z][a-z0-9-]{0,39}$/u.test(token ?? "")) return;
  try {
    fs.mkdirSync(path.join(dir, "api-budget"), { recursive: true });
    fs.appendFileSync(path.join(dir, "api-budget", token), readingLine(status, headers));
  } catch {
    // Nothing to do: the notice is only missing a reading.
  }
}

// Records every response and refusal of one Octokit client; a refusal is
// rethrown unchanged.
function watch(github, token) {
  github.hook.after("request", (response) => recordReading({ token, status: response.status, headers: response.headers }));
  github.hook.error("request", (error) => {
    if (error?.response) recordReading({ token, status: error.status ?? error.response.status, headers: error.response.headers });
    throw error;
  });
}

module.exports = { readingLine, recordReading, watch };
