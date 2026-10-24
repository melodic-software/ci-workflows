"use strict";

// key-credit-gate reads a keyed lane's own recent runs and skips the key job
// only on a credit-stop record inside the window; every other answer, and
// every failure, runs the key. Its calls: one run list, then at most
// MAX_JOB_READS job lists.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_JOB_READS,
  decide,
  judgeRun,
  main,
} = require("../actions/key-credit-gate/gate.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");

const KEY = "claude-review-key";
const step = (name, conclusion = "success") => ({ name, conclusion });
const keyJob = (steps, name = `pr-review / ${KEY}`) => ({
  name,
  status: "completed",
  steps,
});
const RAN = step("Claude review", "failure");
const credit = (id) => step(`Record the key's credit stop in run ${id}`);

test("a run settles on a record in the window, a record outside it, or a key that ran", () => {
  const ids = new Set(["10", "11"]);
  assert.deepEqual(judgeRun([keyJob([RAN, credit(10)])], KEY, ids), {
    skip: true,
    origin: "10",
  });
  // The gate job's carried record counts the same.
  assert.deepEqual(
    judgeRun(
      [keyJob([credit(11)], `pr-review / ${KEY}-credit`), keyJob([], "x")],
      KEY,
      ids,
    ),
    { skip: true, origin: "11" },
  );
  assert.equal(judgeRun([keyJob([credit(9)])], KEY, ids).skip, false);
  assert.equal(judgeRun([keyJob([RAN])], KEY, ids).skip, false);
  assert.equal(
    judgeRun([keyJob([step("Claude review", "success")])], KEY, ids).skip,
    false,
  );
});

test("a run settles nothing without a finished key job whose model or record ran", () => {
  const ids = new Set(["10"]);
  for (const jobs of [
    [],
    null,
    [keyJob([step("Claude review", "skipped")])],
    [{ ...keyJob([RAN]), status: "in_progress" }],
    // A record that did not succeed, and another lane's job.
    [keyJob([credit(10).name].map((name) => step(name, "skipped")))],
    [keyJob([RAN], "pr-review / security-review-key")],
    [keyJob([RAN], `pr-review / not-${KEY}`)],
    // The jobs API sometimes returns every job of a run with no steps.
    [keyJob([]), keyJob([], `pr-review / ${KEY}-credit`)],
    [{ name: `pr-review / ${KEY}`, status: "completed" }],
  ]) {
    assert.equal(judgeRun(jobs, KEY, ids), null, JSON.stringify(jobs));
  }
});

test("an auth stop or any other class never reads as a credit stop", () => {
  // Only the record step's exact name counts, and the workflow runs it only
  // after lane-class credit-stop (pr-review-cli.test.cjs holds that).
  const ids = new Set(["10"]);
  for (const name of [
    "Record the key's credit stop in run ",
    "Record the key's credit stop in run 10 ",
    "Record the key's auth stop in run 10",
    `Record the key's credit stop in run \${{ github.run_id }}`,
  ]) {
    assert.equal(
      judgeRun([keyJob([RAN, step(name)])], KEY, ids).skip,
      false,
      name,
    );
  }
});

test("decide reads newest first, skips the current run and caps its job reads", async () => {
  const runs = [
    { id: 7 },
    { id: 6 },
    { id: 5 },
    { id: 4 },
    { id: 3 },
    { id: 2 },
  ];
  const read = [];
  const verdict = await decide({
    currentRunId: "7",
    keyJob: KEY,
    listRuns: async () => runs,
    listJobs: async (id) => {
      read.push(id);
      return id === 2 ? [keyJob([credit(2)])] : [];
    },
  });
  assert.deepEqual(read, [6, 5, 4]);
  assert.equal(read.length, MAX_JOB_READS);
  assert.equal(verdict.skip, false);

  const read2 = [];
  const skip = await decide({
    currentRunId: "9",
    keyJob: KEY,
    listRuns: async () => runs,
    listJobs: async (id) => {
      read2.push(id);
      return id === 6 ? [keyJob([credit(3)], `r / ${KEY}-credit`)] : [];
    },
  });
  assert.deepEqual(skip, { skip: true, origin: "3", run: "6" });
  assert.deepEqual(read2, [7, 6]);
});

test("runs whose jobs all come back with empty steps run the key after the cap", async () => {
  const read = [];
  const verdict = await decide({
    currentRunId: "9",
    keyJob: KEY,
    listRuns: async () => [{ id: 8 }, { id: 7 }, { id: 6 }, { id: 5 }],
    listJobs: async (id) => {
      read.push(id);
      return [keyJob([]), keyJob([], `r / ${KEY}-credit`)];
    },
  });
  assert.equal(verdict.skip, false);
  assert.deepEqual(read, [8, 7, 6]);
});

test("decide fails open on every read failure", async () => {
  const boom = async () => {
    throw new Error("HTTP 403");
  };
  for (const args of [
    { listRuns: boom, listJobs: async () => [] },
    { listRuns: async () => ({}), listJobs: async () => [] },
    { listRuns: async () => [{ id: 1 }], listJobs: boom },
    { listRuns: async () => [], listJobs: async () => [] },
  ]) {
    const verdict = await decide({ currentRunId: "9", keyJob: KEY, ...args });
    assert.equal(verdict.skip, false);
  }
});

function env(dir, extra = {}) {
  return {
    KEY_JOB: KEY,
    WINDOW_HOURS: "6",
    WORKFLOW_REF:
      "o/r/.github/workflows/pr-review-hosted.yml@refs/pull/1/merge",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_RUN_ID: "100",
    GITHUB_TOKEN: "t",
    GITHUB_API_URL: "https://api.example",
    GITHUB_SERVER_URL: "https://example",
    GITHUB_OUTPUT: path.join(dir, "output"),
    RUNNER_TEMP: dir,
    ...extra,
  };
}

function fakeFetch(routes) {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers.Authorization, "Bearer t");
    const [, body] = routes.find(([pattern]) => pattern.test(url)) ?? [];
    const headers = new Map([
      ["x-ratelimit-limit", "1000"],
      ["x-ratelimit-remaining", String(1000 - urls.length)],
      ["x-ratelimit-used", String(urls.length)],
      ["x-ratelimit-reset", "1"],
      ["x-ratelimit-resource", "core"],
    ]);
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      headers,
      json: async () => body,
    };
  };
  return { urls, fetchImpl };
}

test("main skips on a credit stop in the window with one list call and one jobs call, and says which run", async () => {
  const dir = makeTemporaryDirectory("key-credit-gate-");
  const { urls, fetchImpl } = fakeFetch([
    [
      /\/workflows\/pr-review-hosted\.yml\/runs\?/u,
      { workflow_runs: [{ id: 99 }, { id: 98 }] },
    ],
    [/\/runs\/99\/jobs\?/u, { jobs: [keyJob([RAN, credit(98)])] }],
  ]);
  const now = () => new Date("2026-10-24T12:00:00Z");
  const { verdict, lines } = await main(env(dir), fetchImpl, now);
  assert.deepEqual(verdict, { skip: true, origin: "98", run: "99" });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /status=completed/u);
  assert.match(urls[0], /created=%3E%3D2026-10-24T06%3A00%3A00Z/u);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^::notice title=key-credit-gate::claude-review-key skips the key: the key's credit stop in run 98 \(https:\/\/example\/o\/r\/actions\/runs\/98\)/u,
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "output"), "utf8"),
    "skip-key=true\norigin-run=98\n",
  );
  // Each response's rate-limit reading, for report-api-budget.
  assert.equal(
    fs.readFileSync(path.join(dir, "api-budget", "github-token"), "utf8"),
    "200 1000 999 1 1 core\n200 1000 998 2 1 core\n",
  );
});

test("main runs the key on a refused read, an unreadable ref or a window of 0, spending nothing on the last two", async () => {
  for (const [extra, calls] of [
    [{}, 1],
    [{ WINDOW_HOURS: "0" }, 0],
    [{ WINDOW_HOURS: "abc" }, 0],
    [{ WORKFLOW_REF: "nonsense" }, 0],
    [{ GITHUB_TOKEN: "" }, 0],
  ]) {
    const dir = makeTemporaryDirectory("key-credit-gate-");
    const { urls, fetchImpl } = fakeFetch([]);
    const { verdict, lines } = await main(env(dir, extra), fetchImpl);
    assert.equal(verdict.skip, false, JSON.stringify(extra));
    assert.equal(urls.length, calls, JSON.stringify(extra));
    assert.match(lines[0], /^key-credit-gate: .* runs the key: /u);
    assert.equal(
      fs.readFileSync(path.join(dir, "output"), "utf8"),
      "skip-key=false\norigin-run=\n",
    );
  }
});

test("the action passes the caller's workflow ref and the window to the gate", () => {
  const { parseWorkflow } = require("./workflow-yaml.cjs");
  const action = parseWorkflow(
    fs.readFileSync(
      path.join(__dirname, "..", "actions", "key-credit-gate", "action.yml"),
      "utf8",
    ),
  );
  const run = action.runs.steps[0];
  assert.equal(run.env.WORKFLOW_REF, `\${{ github.workflow_ref }}`);
  assert.equal(run.env.WINDOW_HOURS, `\${{ inputs.window-hours }}`);
  assert.equal(action.inputs["window-hours"].default, "6");
  assert.match(run.run, /\|\| true$/u);
});
