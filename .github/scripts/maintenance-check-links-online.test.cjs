"use strict";

// The online link check is opt-in per repository: a scheduled run does nothing
// unless the caller repository's custom property is "true", a dispatched run
// always checks, and a property read that errors fails red. The workflow also
// holds its contract: workflow_call only, contents: read, the
// GITHUB_TOKEN only, and the report in the job summary: broken links fail the
// job, while timeouts and accepted 429 and 5xx responses are listed without
// failing it.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const source = fs.readFileSync(
  path.join(__dirname, "..", "workflows", "maintenance-check-links-online.yml"),
  "utf8",
);
const workflow = parseWorkflow(source);
const job = workflow.jobs["check-links"];
const [gate, checkout, lychee, report] = job.steps;

async function runGate({ eventName, properties }) {
  const original = process.env.OPT_IN_PROPERTY;
  process.env.OPT_IN_PROPERTY = "link-check-online";
  const outputs = {};
  const failed = [];
  const requests = [];
  try {
    const github = {
      request: async (route, params) => {
        requests.push({ route, params });
        if (properties instanceof Error) throw properties;
        return { data: properties };
      },
    };
    const core = {
      info: () => {},
      notice: () => {},
      setOutput: (name, value) => {
        outputs[name] = value;
      },
      setFailed: (message) => failed.push(message),
    };
    const context = { eventName, repo: { owner: "o", repo: "r" } };
    await new AsyncFunction(
      "github",
      "context",
      "core",
      "process",
      gate.with.script,
    )(github, context, core, process);
    return { outputs, failed, requests };
  } finally {
    if (original === undefined) delete process.env.OPT_IN_PROPERTY;
    else process.env.OPT_IN_PROPERTY = original;
  }
}

test("the workflow is reusable only, read-only, and declares no secrets", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
  assert.equal(workflow.on.workflow_call.secrets, undefined);
  assert.equal(workflow.on.workflow_call.inputs.runner.required, true);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./u);
});

test("lychee uses the GITHUB_TOKEN and hands a verbose JSON report to the report step", () => {
  assert.match(lychee.uses, /^lycheeverse\/lychee-action@[0-9a-f]{40}$/u);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
  assert.equal(lychee.with.token, "${{ github.token }}");
  // lychee-action writes the job summary only for markdown and fails on
  // lychee's exit code itself; the report step owns both instead.
  assert.equal(lychee.with.format, "json");
  assert.equal(lychee.with.jobSummary, false);
  assert.equal(lychee.with.fail, false);
  assert.equal(lychee.with.failIfEmpty, false);
  // Only -v and above fills success_map, where accepted responses appear.
  assert.match(lychee.with.args, /(^|\s)--verbose(\s|$)/u);
  assert.doesNotMatch(lychee.with.args, /--offline|--format|--output/u);
  assert.equal(report.env.REPORT, lychee.with.output);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
  assert.equal(report.env.LYCHEE_EXIT, "${{ steps.lychee.outputs.exit_code }}");
  assert.equal(checkout.with["persist-credentials"], false);
});

test("every step after the gate runs only when the gate says so", () => {
  for (const step of [checkout, lychee]) {
    assert.equal(step.if, "steps.gate.outputs.run == 'true'");
  }
  assert.equal(report.if, "steps.gate.outputs.run == 'true' && !cancelled()");
});

// Recorded from lychee 0.24.2 `--format json --verbose` against a local status
// server, with accept = 100..=103, 200..=299, 429, 500..=599 and
// accept_timeouts; only the input path is renamed and durations dropped.
const recorded = {
  total: 7,
  unique: 7,
  successful: 3,
  unknown: 0,
  unsupported: 0,
  timeouts: 1,
  redirects: 0,
  remaps: 0,
  excludes: 0,
  errors: 3,
  cached: 0,
  success_map: {
    "docs/links.md": [
      {
        url: "http://127.0.0.1:18766/429/y",
        status: { text: "429 Too Many Requests", code: 429 },
        span: { line: 1, column: 2 },
      },
      {
        url: "http://127.0.0.1:18766/503/y",
        status: { text: "503 Service Unavailable", code: 503 },
        span: { line: 2, column: 2 },
      },
      {
        url: "http://127.0.0.1:18766/200/y",
        status: { text: "200 OK", code: 200 },
        span: { line: 4, column: 2 },
      },
    ],
  },
  error_map: {
    "docs/links.md": [
      {
        url: "http://127.0.0.1:18766/404/y",
        status: { text: "Rejected status code: 404 Not Found", code: 404 },
        span: { line: 5, column: 2 },
      },
      {
        url: "http://127.0.0.1:18766/410/y",
        status: { text: "Rejected status code: 410 Gone", code: 410 },
        span: { line: 6, column: 2 },
      },
      {
        url: "http://127.0.0.1:18766/403/y",
        status: { text: "Rejected status code: 403 Forbidden", code: 403 },
        span: { line: 7, column: 2 },
      },
    ],
  },
  timeout_map: {
    "docs/links.md": [
      {
        url: "http://127.0.0.1:18766/hang/y",
        status: { text: "Timeout", details: "Request timed out" },
        span: { line: 3, column: 2 },
      },
    ],
  },
  suggestion_map: {},
  redirect_map: {},
  excluded_map: {},
  detailed_stats: true,
};

function runReport(reportBody, lycheeExit) {
  const directory = makeTemporaryDirectory("check-links-online-");
  const reportPath = path.join(directory, "report.json");
  const summaryPath = path.join(directory, "summary.md");
  fs.writeFileSync(reportPath, reportBody);
  fs.writeFileSync(summaryPath, "");
  const result = spawnSync("bash", ["-c", report.run], {
    encoding: "utf8",
    env: {
      ...process.env,
      REPORT: reportPath,
      LYCHEE_EXIT: lycheeExit,
      GITHUB_STEP_SUMMARY: summaryPath,
    },
  });
  return {
    status: result.status,
    log: `${result.stdout}${result.stderr}`,
    summary: fs.readFileSync(summaryPath, "utf8"),
  };
}

function section(summary, title) {
  const start = summary.indexOf(`## ${title}`);
  if (start === -1) return "";
  const next = summary.indexOf("\n## ", start + 1);
  return summary.slice(start, next === -1 ? undefined : next);
}

test("broken links fail the job and every list reaches the summary", () => {
  const { status, summary } = runReport(JSON.stringify(recorded), "2");
  assert.equal(status, 1);
  const broken = section(summary, "Broken links");
  assert.match(
    broken,
    /<http:\/\/127\.0\.0\.1:18766\/404\/y> in `docs\/links\.md` at 5:2/u,
  );
  assert.match(broken, /\/410\/y>/u);
  assert.match(broken, /\/403\/y>/u);
  assert.match(section(summary, "Timeouts"), /\/hang\/y>/u);
  const accepted = section(summary, "Accepted 429 and 5xx");
  assert.match(accepted, /^\* \[429\] <http:\/\/127\.0\.0\.1:18766\/429\/y>/mu);
  assert.match(accepted, /^\* \[503\] <http:\/\/127\.0\.0\.1:18766\/503\/y>/mu);
  assert.doesNotMatch(accepted, /\/200\/y>/u);
});

test("timeouts and accepted 429 and 5xx responses are listed without failing the job", () => {
  const { error_map: _broken, ...rest } = recorded;
  const passing = { ...rest, errors: 0, error_map: {} };
  const { status, summary } = runReport(JSON.stringify(passing), "0");
  assert.equal(status, 0);
  assert.equal(section(summary, "Broken links"), "");
  assert.match(section(summary, "Timeouts"), /\/hang\/y>/u);
  assert.match(
    section(summary, "Accepted 429 and 5xx"),
    /\/429\/y>[\s\S]*\/503\/y>/u,
  );
});

test("a run that found no links or left no JSON report fails the job", () => {
  const empty = {
    ...recorded,
    total: 0,
    successful: 0,
    errors: 0,
    timeouts: 0,
    success_map: {},
    error_map: {},
    timeout_map: {},
  };
  assert.equal(runReport(JSON.stringify(empty), "0").status, 1);
  assert.equal(runReport("", "101").status, 1);
  assert.notEqual(runReport("thread 'main' panicked", "101").status, 0);
});

test("a dispatched run checks links without reading the property", async () => {
  const { outputs, failed, requests } = await runGate({
    eventName: "workflow_dispatch",
    properties: [],
  });
  assert.deepEqual(outputs, { run: "true" });
  assert.deepEqual(failed, []);
  assert.deepEqual(requests, []);
});

test("a scheduled run checks links when the property is true", async () => {
  const { outputs, requests } = await runGate({
    eventName: "schedule",
    properties: [{ property_name: "link-check-online", value: "true" }],
  });
  assert.deepEqual(outputs, { run: "true" });
  assert.equal(
    requests[0].route,
    "GET /repos/{owner}/{repo}/properties/values",
  );
  assert.deepEqual(requests[0].params, { owner: "o", repo: "r" });
});

test("a scheduled run skips when the property is unset or false", async () => {
  for (const properties of [
    [],
    [{ property_name: "link-check-online", value: "false" }],
    [{ property_name: "link-check-online", value: null }],
    [{ property_name: "other", value: "true" }],
  ]) {
    const { outputs, failed } = await runGate({
      eventName: "schedule",
      properties,
    });
    assert.deepEqual(outputs, { run: "false" });
    assert.deepEqual(failed, []);
  }
});

test("a scheduled run whose property read errors fails instead of skipping", async () => {
  await assert.rejects(
    runGate({ eventName: "schedule", properties: new Error("403") }),
    /403/u,
  );
});
