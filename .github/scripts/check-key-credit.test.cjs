"use strict";

// check-key-credit reads the key job's credit-stop marker and skips the key
// job on a marker uploaded inside the window. Past the window, with that
// marker still kept, it reads the probing marker too and skips while another
// gate's probe is fresh. Every other answer, and every failure, runs the key.
// Its calls: one, or two after a credit stop past the window.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  backoff,
  decide,
  judgeMarkers,
  main,
  markerName,
  parseReset,
  probeName,
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
    PROBE_MINUTES: "15",
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
    `skip-key=true\norigin-run=98\nmarker=${NAME}\nprobing-marker=\n`,
  );
  // The response's rate-limit reading, for report-api-budget.
  assert.equal(
    fs.readFileSync(path.join(dir, "api-budget", "github-token"), "utf8"),
    "200 1000 999 1 1 core repos/{repo}/actions/artifacts\n",
  );
});

// A credit stop past the window takes a second call, the probing markers:
// see the probe tests below.
test("main runs the key with one call when no credit-stop marker counts", async () => {
  const fork = marker(98, 1, {
    workflow_run: { id: 98, repository_id: 1, head_repository_id: 2 },
  });
  for (const artifacts of [[], [fork]]) {
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
      `skip-key=false\norigin-run=\nmarker=${NAME}\nprobing-marker=\n`,
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
      `skip-key=false\norigin-run=\nmarker=${name}\nprobing-marker=\n`,
    );
  }
});

// The probing marker: the gate that passes the key after a credit stop's
// window ends uploads it, and gates that read it while it is fresh skip.
const PROBE = "key-credit-probing-pr-review-hosted.yml-claude-review-key";
const PROBES =
  /^https:\/\/api\.example\/repos\/o\/r\/actions\/artifacts\?name=key-credit-probing-pr-review-hosted\.yml-claude-review-key&per_page=100$/u;
const minutesAgo = (minutes) =>
  new Date(NOW - minutes * 60 * 1000).toISOString();
const probe = (run, minutes, extra = {}) =>
  marker(run, 0, { name: PROBE, created_at: minutesAgo(minutes), ...extra });
const output = (dir) => fs.readFileSync(path.join(dir, "output"), "utf8");

test("the probing marker is named apart from the credit-stop marker", () => {
  assert.equal(probeName("pr-review-hosted.yml", KEY), PROBE);
  assert.notEqual(probeName("other.yml", KEY), PROBE);
  assert.notEqual(PROBE, NAME);
});

test("a fresh probing marker after the credit stop skips the key, citing the probing run", async () => {
  const dir = makeTemporaryDirectory("check-key-credit-");
  const { urls, fetchImpl } = fakeFetch([
    [ARTIFACTS, { artifacts: [marker(90, 7)] }],
    [PROBES, { artifacts: [probe(95, 5)] }],
  ]);
  const { verdict, lines } = await main(env(dir), fetchImpl, now);
  assert.equal(verdict.skip, true);
  assert.equal(verdict.origin, "95");
  assert.deepEqual(
    urls.map((u) => [ARTIFACTS, PROBES].findIndex((r) => r.test(u))),
    [0, 1],
  );
  assert.match(
    lines[0],
    /^::notice title=check-key-credit::claude-review-key skips the key: run 95 \(https:\/\/example\/o\/r\/actions\/runs\/95\) is probing the key, 5 minutes ago, inside the 15-minute probe window/u,
  );
  assert.equal(
    output(dir),
    `skip-key=true\norigin-run=95\nmarker=${NAME}\nprobing-marker=\n`,
  );
});

test("the first gate after the window ends passes the key and names the probing marker to upload", async () => {
  // A probe from before the credit stop does not count: the stop is newer.
  for (const probes of [[], [probe(80, 7.5 * 60)]]) {
    const dir = makeTemporaryDirectory("check-key-credit-");
    const { urls, fetchImpl } = fakeFetch([
      [ARTIFACTS, { artifacts: [marker(90, 7)] }],
      [PROBES, { artifacts: probes }],
    ]);
    const { verdict } = await main(env(dir), fetchImpl, now);
    assert.equal(verdict.skip, false, JSON.stringify(probes));
    assert.equal(urls.length, 2);
    assert.equal(
      output(dir),
      `skip-key=false\norigin-run=\nmarker=${NAME}\nprobing-marker=${PROBE}\n`,
    );
  }
});

test("an expired probing marker after the credit stop runs the key and writes no new probe", async () => {
  // 20 minutes ago, past the 15-minute probe window: that probe hit no credit
  // stop, so the key works again.
  const dir = makeTemporaryDirectory("check-key-credit-");
  const { urls, fetchImpl } = fakeFetch([
    [ARTIFACTS, { artifacts: [marker(90, 7)] }],
    [PROBES, { artifacts: [probe(95, 20)] }],
  ]);
  const { verdict, lines } = await main(env(dir), fetchImpl, now);
  assert.equal(verdict.skip, false);
  assert.equal(urls.length, 2);
  assert.match(
    lines[0],
    /^check-key-credit: claude-review-key runs the key: run 95 probed the key after its credit stop with no new credit stop$/u,
  );
  assert.equal(
    output(dir),
    `skip-key=false\norigin-run=\nmarker=${NAME}\nprobing-marker=\n`,
  );
});

test("a credit-stop marker in the window still skips, with one call and no probe", async () => {
  const dir = makeTemporaryDirectory("check-key-credit-");
  const { urls, fetchImpl } = fakeFetch([
    [ARTIFACTS, { artifacts: [marker(98, 1)] }],
    [PROBES, { artifacts: [probe(95, 5)] }],
  ]);
  const { verdict } = await main(env(dir), fetchImpl, now);
  assert.deepEqual(verdict, { skip: true, origin: "98" });
  assert.equal(urls.length, 1);
  assert.equal(
    output(dir),
    `skip-key=true\norigin-run=98\nmarker=${NAME}\nprobing-marker=\n`,
  );
});

test("a healthy key, with no credit-stop marker in retention, reads once and writes no probe", async () => {
  const dir = makeTemporaryDirectory("check-key-credit-");
  const { urls, fetchImpl } = fakeFetch([
    [ARTIFACTS, { artifacts: [] }],
    [PROBES, { artifacts: [probe(95, 5)] }],
  ]);
  const { verdict } = await main(env(dir), fetchImpl, now);
  assert.equal(verdict.skip, false);
  assert.equal(urls.length, 1);
  assert.equal(
    output(dir),
    `skip-key=false\norigin-run=\nmarker=${NAME}\nprobing-marker=\n`,
  );
});

test("a failed probing-marker read runs the key and writes no probe", async () => {
  for (const probes of [undefined, {}]) {
    const dir = makeTemporaryDirectory("check-key-credit-");
    const routes = [[ARTIFACTS, { artifacts: [marker(90, 7)] }]];
    if (probes) routes.push([PROBES, probes]);
    const { urls, fetchImpl } = fakeFetch(routes);
    const { verdict, lines } = await main(env(dir), fetchImpl, now);
    assert.equal(verdict.skip, false, JSON.stringify(probes));
    assert.equal(urls.length, 2);
    assert.match(
      lines[0],
      /^check-key-credit: claude-review-key runs the key: the probing marker(s were not read \(HTTP 404\)| list was not a list)$/u,
    );
    assert.equal(
      output(dir),
      `skip-key=false\norigin-run=\nmarker=${NAME}\nprobing-marker=\n`,
    );
  }
});

test("a fork's probing marker, or a probe window of 0 or out of range, never skips", async () => {
  const fork = probe(95, 5, {
    workflow_run: { id: 95, repository_id: 1, head_repository_id: 2 },
  });
  for (const [extra, probes, calls, written] of [
    [{}, [fork], 2, PROBE],
    [{ PROBE_MINUTES: "0" }, [probe(95, 5)], 1, ""],
    [{ PROBE_MINUTES: "1441" }, [probe(95, 5)], 1, ""],
    [{ PROBE_MINUTES: "abc" }, [probe(95, 5)], 1, ""],
  ]) {
    const dir = makeTemporaryDirectory("check-key-credit-");
    const { urls, fetchImpl } = fakeFetch([
      [ARTIFACTS, { artifacts: [marker(90, 7)] }],
      [PROBES, { artifacts: probes }],
    ]);
    const { verdict } = await main(env(dir, extra), fetchImpl, now);
    assert.equal(verdict.skip, false, JSON.stringify(extra));
    assert.equal(urls.length, calls, JSON.stringify(extra));
    assert.equal(
      output(dir),
      `skip-key=false\norigin-run=\nmarker=${NAME}\nprobing-marker=${written}\n`,
    );
  }
});

test("the action passes the probe window to the gate and the probing marker out", () => {
  const { parseWorkflow } = require("./workflow-yaml.cjs");
  const action = parseWorkflow(
    fs.readFileSync(
      path.join(__dirname, "..", "actions", "check-key-credit", "action.yml"),
      "utf8",
    ),
  );
  assert.equal(
    action.runs.steps[0].env.PROBE_MINUTES,
    `\${{ inputs.probe-minutes }}`,
  );
  // Empty is gate.cjs's default, so the default lives in one place.
  assert.equal(action.inputs["probe-minutes"].default, "");
  assert.equal(
    action.outputs["probing-marker"].value,
    `\${{ steps.gate.outputs.probing-marker }}`,
  );
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
  assert.equal(action.inputs["window-hours"].default, "");
  assert.equal(
    action.outputs.marker.value,
    `\${{ steps.gate.outputs.marker }}`,
  );
  assert.match(run.run, /\|\| true$/u);
});

// A caller passes an unset vars.KEY_CREDIT_WINDOW_HOURS as it is, an empty
// string the action's default never replaces: empty must mean 1 hour and
// 15 probe minutes, never 0 (the gate off).
test("an empty window or probe window is the 1-hour and 15-minute default; 0 stays off", async () => {
  const {
    DEFAULT_WINDOW_HOURS,
  } = require("../actions/check-key-credit/gate.cjs");
  assert.equal(DEFAULT_WINDOW_HOURS, 1);
  for (const [window, skip] of [
    ["", true],
    [" ", true],
    ["0", false],
  ]) {
    const dir = makeTemporaryDirectory("check-key-credit-");
    const { urls, fetchImpl } = fakeFetch([
      [ARTIFACTS, { artifacts: [marker(98, 0.5)] }],
    ]);
    const { verdict } = await main(
      env(dir, { WINDOW_HOURS: window }),
      fetchImpl,
      now,
    );
    assert.equal(verdict.skip, skip, JSON.stringify(window));
    assert.equal(urls.length, skip ? 1 : 0, JSON.stringify(window));
  }
  // Half an hour past a 1-hour window, a probe 10 minutes ago skips only
  // with probing on: empty is 15 minutes, 0 is off.
  const PROBE = /actions\/artifacts\?name=key-credit-probing-/u;
  for (const [probe, skip] of [
    ["", true],
    ["0", false],
  ]) {
    const dir = makeTemporaryDirectory("check-key-credit-");
    const { fetchImpl } = fakeFetch([
      [ARTIFACTS, { artifacts: [marker(98, 1.5)] }],
      [
        PROBE,
        {
          artifacts: [
            {
              ...marker(99, 10 / 60),
              name: probeName("pr-review-hosted.yml", KEY),
            },
          ],
        },
      ],
    ]);
    const { verdict } = await main(
      env(dir, { WINDOW_HOURS: "", PROBE_MINUTES: probe }),
      fetchImpl,
      now,
    );
    assert.equal(verdict.skip, skip, JSON.stringify(probe));
  }
});

// The backoff: window-hours is the base step, each consecutive credit stop
// doubles it up to 24 hours, and reset-at starts it over.
const HOUR = 3600 * 1000;
const PROBE_MS = 15 * 60 * 1000;
const stopsAt = (...hours) =>
  hours.map((h, i) => ({ created: h * HOUR, run: i + 1 }));

test("each consecutive credit stop doubles a 1-hour base: 1, 2, 4, 8, 16, then 24 hours and no more", () => {
  for (const lagMs of [0, 30 * 60 * 1000]) {
    const stops = [];
    let created = 0;
    const seen = [];
    for (let run = 1; run <= 8; run++) {
      stops.push({ created, run });
      const { steps, windowMs } = backoff(stops, [], HOUR, PROBE_MS);
      seen.push([steps, windowMs / HOUR]);
      // The next credit stop comes from the first run let through after the
      // window, at once or after a quiet spell.
      created += windowMs + lagMs;
    }
    assert.deepEqual(
      seen,
      [
        [1, 1],
        [2, 2],
        [3, 4],
        [4, 8],
        [5, 16],
        [6, 24],
        [7, 24],
        [8, 24],
      ],
      String(lagMs),
    );
  }
});

test("credit stops from runs already in flight add no step", () => {
  // Three runs hit the empty key within minutes: still the first step.
  assert.deepEqual(backoff(stopsAt(0, 0.03, 0.06), [], HOUR, PROBE_MS), {
    steps: 1,
    windowMs: HOUR,
  });
  // The same after the first re-try: the second step, not the fourth.
  assert.equal(backoff(stopsAt(0, 1, 1.03, 1.06), [], HOUR, PROBE_MS).steps, 2);
});

test("a probe with no credit stop after it is a key run that worked, so the next stop starts at the base", () => {
  const probe = (hours) => ({ created: hours * HOUR, run: 50 });
  // Stops at 0 and 1 h; the probe at 3 h worked; the key stops again at 10 h.
  assert.deepEqual(backoff(stopsAt(0, 1, 10), [probe(3)], HOUR, PROBE_MS), {
    steps: 1,
    windowMs: HOUR,
  });
  // A probe its own credit stop followed inside the probe window did not work.
  assert.equal(
    backoff(stopsAt(0, 1, 3.05), [probe(3)], HOUR, PROBE_MS).steps,
    3,
  );
  // A probe from before the stops does not reset them.
  assert.equal(backoff(stopsAt(5, 6), [probe(1)], HOUR, PROBE_MS).steps, 2);
});

test("a base above 24 hours never backs off; a base of 6 caps at 24", () => {
  assert.equal(
    backoff(stopsAt(0, 48, 144), [], 48 * HOUR, PROBE_MS).windowMs,
    48 * HOUR,
  );
  assert.deepEqual(
    [stopsAt(0), stopsAt(0, 6), stopsAt(0, 6, 18), stopsAt(0, 6, 18, 42)].map(
      (stops) => backoff(stops, [], 6 * HOUR, PROBE_MS).windowMs / HOUR,
    ),
    [6, 12, 24, 24],
  );
});

test("reset-at takes the rotation tool's ISO-8601 UTC time and nothing looser", () => {
  assert.equal(
    parseReset("2026-11-06T12:00:00Z"),
    Date.parse("2026-11-06T12:00:00Z"),
  );
  assert.equal(
    parseReset("2026-11-06T12:00:00.123Z"),
    Date.parse("2026-11-06T12:00:00.123Z"),
  );
  for (const text of [
    "",
    undefined,
    "2026",
    "not a time",
    "2026-11-06",
    "2026-11-06T12:00:00",
    "2026-11-06T12:00:00+01:00",
    "2026-11-06 12:00:00Z",
    "2026-13-45T99:99:99Z",
  ]) {
    assert.equal(parseReset(text), -Infinity, String(text));
  }
});

const seconds = (hoursAgo) => at(hoursAgo).replace(/\.\d{3}Z$/u, "Z");
// Credit stops 6, 5 and 3 hours ago from a 1-hour base: the third step, a
// 4-hour window, so the newest still skips.
const CHAIN = [marker(91, 6), marker(92, 5), marker(93, 3)];

test("main skips inside the backed-off window, naming the step, with the two calls it already made", async () => {
  const dir = makeTemporaryDirectory("check-key-credit-");
  const { urls, fetchImpl } = fakeFetch([
    [ARTIFACTS, { artifacts: CHAIN }],
    [PROBES, { artifacts: [] }],
  ]);
  const { verdict, lines } = await main(
    env(dir, { WINDOW_HOURS: "1" }),
    fetchImpl,
    now,
  );
  assert.deepEqual(verdict, { skip: true, origin: "93", steps: 3, hours: 4 });
  assert.equal(urls.length, 2);
  assert.match(
    lines[0],
    /^::notice title=check-key-credit::claude-review-key skips the key: the key's credit stop in run 93 \(https:\/\/example\/o\/r\/actions\/runs\/93\) is inside the 4-hour window \(credit stop 3 in a row\); the subscription job reviews$/u,
  );
  assert.equal(
    output(dir),
    `skip-key=true\norigin-run=93\nmarker=${NAME}\nprobing-marker=\n`,
  );
});

test("main probes the key once the backed-off window ends", async () => {
  const dir = makeTemporaryDirectory("check-key-credit-");
  const { fetchImpl } = fakeFetch([
    [
      ARTIFACTS,
      { artifacts: [marker(91, 7.5), marker(92, 6.5), marker(93, 4.5)] },
    ],
    [PROBES, { artifacts: [] }],
  ]);
  const { verdict } = await main(
    env(dir, { WINDOW_HOURS: "1" }),
    fetchImpl,
    now,
  );
  assert.equal(verdict.skip, false);
  assert.equal(verdict.probe, true);
  assert.equal(
    output(dir),
    `skip-key=false\norigin-run=\nmarker=${NAME}\nprobing-marker=${PROBE}\n`,
  );
});

test("reset-at counts only the credit stops after it", async () => {
  for (const [resetAt, expected, calls] of [
    // After the first stop: two steps left, a 2-hour window, past already.
    [seconds(5.5), { skip: false, probe: true }, 2],
    // After every stop: a new key, tried at once with one call.
    [
      seconds(1),
      { skip: false, reason: "no credit-stop marker in the window" },
      1,
    ],
    // No reset, or text that is not one: the full chain.
    ["", { skip: true, origin: "93", steps: 3, hours: 4 }, 2],
    ["2026", { skip: true, origin: "93", steps: 3, hours: 4 }, 2],
  ]) {
    const dir = makeTemporaryDirectory("check-key-credit-");
    const { urls, fetchImpl } = fakeFetch([
      [ARTIFACTS, { artifacts: CHAIN }],
      [PROBES, { artifacts: [] }],
    ]);
    const { verdict } = await main(
      env(dir, { WINDOW_HOURS: "1", RESET_AT: resetAt }),
      fetchImpl,
      now,
    );
    assert.equal(verdict.skip, expected.skip, resetAt);
    for (const [key, value] of Object.entries(expected)) {
      if (key !== "reason")
        assert.equal(verdict[key], value, `${resetAt} ${key}`);
    }
    if (expected.reason) assert.equal(verdict.reason, expected.reason);
    assert.equal(urls.length, calls, resetAt);
  }
  // A stop inside the base window but before the reset no longer skips.
  const dir = makeTemporaryDirectory("check-key-credit-");
  const { urls, fetchImpl } = fakeFetch([
    [ARTIFACTS, { artifacts: [marker(98, 0.5)] }],
  ]);
  const { verdict } = await main(
    env(dir, { WINDOW_HOURS: "1", RESET_AT: seconds(0.25) }),
    fetchImpl,
    now,
  );
  assert.equal(verdict.skip, false);
  assert.equal(urls.length, 1);
});

test("a failed read inside the backed-off window tries the key, never a longer skip", async () => {
  for (const routes of [
    [[ARTIFACTS, { artifacts: CHAIN }]],
    [
      [ARTIFACTS, { artifacts: CHAIN }],
      [PROBES, {}],
    ],
    [[ARTIFACTS, {}]],
    [],
  ]) {
    const dir = makeTemporaryDirectory("check-key-credit-");
    const { fetchImpl } = fakeFetch(routes);
    const { verdict, lines } = await main(
      env(dir, { WINDOW_HOURS: "1" }),
      fetchImpl,
      now,
    );
    assert.equal(verdict.skip, false, JSON.stringify(routes.length));
    assert.match(
      lines[0],
      /^check-key-credit: claude-review-key runs the key: the (probing )?marker/u,
    );
    assert.equal(
      output(dir),
      `skip-key=false\norigin-run=\nmarker=${NAME}\nprobing-marker=\n`,
    );
  }
});

test("the action passes reset-at to the gate and says a hand-set key waits out the step", () => {
  const { parseWorkflow } = require("./workflow-yaml.cjs");
  const action = parseWorkflow(
    fs.readFileSync(
      path.join(__dirname, "..", "actions", "check-key-credit", "action.yml"),
      "utf8",
    ),
  );
  assert.equal(action.runs.steps[0].env.RESET_AT, `\${{ inputs.reset-at }}`);
  assert.equal(action.inputs["reset-at"].default, "");
  assert.match(action.description, /gh secret set/u);
  assert.match(action.description, /at most 24\s+hours/u);
});
