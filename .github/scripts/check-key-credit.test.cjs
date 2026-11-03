"use strict";

// check-key-credit reads one artifact name, the key job's credit-stop marker,
// and skips the key job only on a marker uploaded inside the window; every
// other answer, and every failure, runs the key. Its calls: one, on every
// path that reads.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  decide,
  judgeMarkers,
  main,
  markerName,
} = require("../actions/check-key-credit/gate.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");

const KEY = "claude-review-key";
const NAME = markerName("pr-review-hosted.yml", KEY);
const NOW = Date.parse("2026-10-24T12:00:00Z");
const SINCE = NOW - 6 * 3600 * 1000;
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600 * 1000).toISOString();
const marker = (run, hoursAgo, extra = {}) => ({
  name: NAME,
  expired: false,
  created_at: at(hoursAgo),
  workflow_run: { id: run, repository_id: 1, head_repository_id: 1 },
  ...extra,
});

test("the marker is named for the caller workflow and the key job", () => {
  assert.equal(NAME, "key-credit-stop-pr-review-hosted.yml-claude-review-key");
  assert.notEqual(markerName("other.yml", KEY), NAME);
  assert.notEqual(
    markerName("pr-review-hosted.yml", "security-review-key"),
    NAME,
  );
});

test("a marker inside the window skips, citing its run; the newest wins in any order", () => {
  assert.deepEqual(judgeMarkers([marker(10, 1)], NAME, SINCE), {
    skip: true,
    origin: "10",
  });
  assert.deepEqual(
    judgeMarkers([marker(10, 5), marker(12, 0.5), marker(11, 3)], NAME, SINCE),
    { skip: true, origin: "12" },
  );
  assert.deepEqual(
    judgeMarkers([marker(12, 0.5), marker(10, 5)], NAME, SINCE),
    { skip: true, origin: "12" },
  );
});

test("a marker older than the window runs the key, so a topped-up key is tried on the first run after it", () => {
  // The credit stop at 6h01m: the window has just ended.
  assert.equal(judgeMarkers([marker(10, 6.02)], NAME, SINCE).skip, false);
  // At exactly the window's edge it still counts.
  assert.equal(judgeMarkers([marker(10, 6)], NAME, SINCE).skip, true);
});

test("no marker, an expired one, another name or a malformed one runs the key", () => {
  for (const artifacts of [
    [],
    null,
    [marker(10, 1, { expired: true })],
    [marker(10, 1, { name: markerName("other.yml", KEY) })],
    [marker(10, 1, { created_at: "not a date" })],
    [marker(10, 1, { created_at: null })],
    [marker(10, 1, { workflow_run: null })],
    [marker(10, 1, { workflow_run: { id: "10" } })],
    [null, 3],
  ]) {
    assert.equal(
      judgeMarkers(artifacts, NAME, SINCE).skip,
      false,
      JSON.stringify(artifacts),
    );
  }
});

test("only a marker from a run whose head is this repository counts, so a fork cannot forge one", () => {
  const run = (ids) => ({ workflow_run: { id: 10, ...ids } });
  // A fork's pull_request run: its head repository is the fork.
  assert.equal(
    judgeMarkers(
      [marker(10, 1, run({ repository_id: 1, head_repository_id: 2 }))],
      NAME,
      SINCE,
    ).skip,
    false,
  );
  // A same-repository run still skips.
  assert.deepEqual(
    judgeMarkers(
      [marker(10, 1, run({ repository_id: 1, head_repository_id: 1 }))],
      NAME,
      SINCE,
    ),
    { skip: true, origin: "10" },
  );
  // Either id missing or malformed: ignored.
  for (const ids of [
    { repository_id: 1 },
    { head_repository_id: 1 },
    {},
    { repository_id: null, head_repository_id: null },
    { repository_id: "1", head_repository_id: "1" },
  ]) {
    assert.equal(
      judgeMarkers([marker(10, 1, run(ids))], NAME, SINCE).skip,
      false,
      JSON.stringify(ids),
    );
  }
  // A fork marker newer than a same-repository one does not hide it.
  assert.deepEqual(
    judgeMarkers(
      [
        marker(11, 0.5, {
          workflow_run: { id: 11, repository_id: 1, head_repository_id: 2 },
        }),
        marker(10, 2),
      ],
      NAME,
      SINCE,
    ),
    { skip: true, origin: "10" },
  );
});

test("the decision reads no run history, so runs that carry no record cannot starve it", async () => {
  // Before the marker, the gate scanned the newest three runs' jobs and ran
  // the key when none of them carried a record. The marker is read alone.
  let reads = 0;
  const verdict = await decide({
    name: NAME,
    sinceMs: SINCE,
    listArtifacts: async () => {
      reads++;
      return [marker(104, 2)];
    },
  });
  assert.deepEqual(verdict, { skip: true, origin: "104" });
  assert.equal(reads, 1);
});

test("decide fails open on every read failure", async () => {
  for (const listArtifacts of [
    async () => {
      throw new Error("HTTP 403");
    },
    async () => ({}),
    async () => undefined,
  ]) {
    const verdict = await decide({ name: NAME, sinceMs: SINCE, listArtifacts });
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

const ARTIFACTS =
  /^https:\/\/api\.example\/repos\/o\/r\/actions\/artifacts\?name=key-credit-stop-pr-review-hosted\.yml-claude-review-key&per_page=100$/u;
const now = () => new Date(NOW);

test("main skips on a marker in the window with one call, reads no run or job list, and says which run", async () => {
  const dir = makeTemporaryDirectory("check-key-credit-");
  const { urls, fetchImpl } = fakeFetch([
    [ARTIFACTS, { artifacts: [marker(98, 1), marker(97, 7)] }],
  ]);
  const { verdict, lines } = await main(env(dir), fetchImpl, now);
  assert.deepEqual(verdict, { skip: true, origin: "98" });
  assert.equal(urls.length, 1);
  assert.match(urls[0], ARTIFACTS);
  assert.doesNotMatch(urls.join("\n"), /\/runs|\/jobs/u);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^::notice title=check-key-credit::claude-review-key skips the key: the key's credit stop in run 98 \(https:\/\/example\/o\/r\/actions\/runs\/98\) is inside the 6-hour window/u,
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "output"), "utf8"),
    `skip-key=true\norigin-run=98\nmarker=${NAME}\n`,
  );
  // The response's rate-limit reading, for report-api-budget.
  assert.equal(
    fs.readFileSync(path.join(dir, "api-budget", "github-token"), "utf8"),
    "200 1000 999 1 1 core\n",
  );
});

test("main runs the key with one call when no marker is in the window, a topped-up key included", async () => {
  const fork = marker(98, 1, {
    workflow_run: { id: 98, repository_id: 1, head_repository_id: 2 },
  });
  for (const artifacts of [[], [marker(98, 6.5)], [fork]]) {
    const dir = makeTemporaryDirectory("check-key-credit-");
    const { urls, fetchImpl } = fakeFetch([[ARTIFACTS, { artifacts }]]);
    const { verdict, lines } = await main(env(dir), fetchImpl, now);
    assert.equal(verdict.skip, false, JSON.stringify(artifacts));
    assert.equal(urls.length, 1);
    assert.match(
      lines[0],
      /^check-key-credit: claude-review-key runs the key: no credit-stop marker in the window$/u,
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "output"), "utf8"),
      `skip-key=false\norigin-run=\nmarker=${NAME}\n`,
    );
  }
});

test("main runs the key on a refused read, an unreadable ref or a window of 0, spending nothing on the last two", async () => {
  for (const [extra, calls, name] of [
    [{}, 1, NAME],
    [{ WINDOW_HOURS: "0" }, 0, NAME],
    [{ WINDOW_HOURS: "abc" }, 0, NAME],
    [{ WORKFLOW_REF: "nonsense" }, 0, ""],
    [{ GITHUB_TOKEN: "" }, 0, NAME],
  ]) {
    const dir = makeTemporaryDirectory("check-key-credit-");
    const { urls, fetchImpl } = fakeFetch([]);
    const { verdict, lines } = await main(env(dir, extra), fetchImpl, now);
    assert.equal(verdict.skip, false, JSON.stringify(extra));
    assert.equal(urls.length, calls, JSON.stringify(extra));
    assert.match(lines[0], /^check-key-credit: .* runs the key: /u);
    // The marker name still goes out, so a key job can record a credit stop
    // while the gate is off; an unreadable ref leaves it empty.
    assert.equal(
      fs.readFileSync(path.join(dir, "output"), "utf8"),
      `skip-key=false\norigin-run=\nmarker=${name}\n`,
    );
  }
});

test("the action passes the caller's workflow ref and the window to the gate, and the marker out", () => {
  const { parseWorkflow } = require("./workflow-yaml.cjs");
  const action = parseWorkflow(
    fs.readFileSync(
      path.join(__dirname, "..", "actions", "check-key-credit", "action.yml"),
      "utf8",
    ),
  );
  const run = action.runs.steps[0];
  assert.equal(run.env.WORKFLOW_REF, `\${{ github.workflow_ref }}`);
  assert.equal(run.env.WINDOW_HOURS, `\${{ inputs.window-hours }}`);
  assert.equal(action.inputs["window-hours"].default, "6");
  assert.equal(
    action.outputs.marker.value,
    `\${{ steps.gate.outputs.marker }}`,
  );
  assert.match(run.run, /\|\| true$/u);
});
