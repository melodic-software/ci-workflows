"use strict";

// The hosted review's outage posture (#1007): its reads are sent at most 3
// times, a resend only on a 5xx, no answer or a rate limit, and a read of the
// pull request's base that still fails holds the run green with a `held: `
// notice instead of publishing a red. Each leg's copy is run as shipped.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { evaluate } = require("./actions-expression.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const ROOT = path.join(__dirname, "..", "..");
const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "pr-review-cli.yml"),
    "utf8",
  ),
);
const LEGS = ["review-key", "review-subscription", "review-fallback"];
const step = (job, id) => workflow.jobs[job].steps.find((s) => s.id === id);

// The scope step's `resend` wrapper, cut out of the shipped script and run
// with a recorded clock in place of setTimeout.
function resendOf(job) {
  const script = step(job, "scope").with.script;
  const start = script.indexOf("const resend = ");
  const end = script.indexOf('github.hook.wrap("request", resend);');
  assert.ok(start >= 0 && end > start, `${job}: no resend wrapper`);
  return script.slice(start, end);
}
function makeResend(job) {
  const waits = [];
  const fakeTimeout = (resolve, ms) => {
    waits.push(ms / 1000);
    resolve();
  };
  const resend = new Function(
    "core",
    "setTimeout",
    `${resendOf(job)}; return resend;`,
  )({ info: () => {} }, fakeTimeout);
  return { resend, waits };
}
const failure = (status, headers = {}, message = "failed") =>
  Object.assign(new Error(message), { status, response: { headers } });
// A request that answers each send from `answers` in turn: an Error throws.
function requestFrom(answers) {
  const sent = [];
  const request = async (options) => {
    sent.push(options);
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { request, sent };
}
const GET = { method: "GET", url: "/repos/{owner}/{repo}/pulls/{pull_number}" };

test("every leg ships the same resend wrapper", () => {
  const [first, ...rest] = LEGS.map(resendOf);
  for (const other of rest) assert.equal(other, first);
});

for (const leg of LEGS) {
  test(`${leg}: a read that answers 5xx is sent again after a full-jitter wait`, async () => {
    const { resend, waits } = makeResend(leg);
    const { request, sent } = requestFrom([
      failure(502),
      { status: 200, data: "ok" },
    ]);
    assert.deepEqual(await resend(request, GET), { status: 200, data: "ok" });
    assert.equal(sent.length, 2);
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 0 && waits[0] <= 2, `first wait ${waits[0]}`);
  });

  test(`${leg}: a read is sent at most 3 times, the second wait at most 4 s`, async () => {
    const { resend, waits } = makeResend(leg);
    const error = failure(500);
    const { request, sent } = requestFrom([error]);
    await assert.rejects(resend(request, GET), (thrown) => thrown === error);
    assert.equal(sent.length, 3);
    assert.equal(waits.length, 2);
    assert.ok(waits[1] >= 0 && waits[1] <= 4, `second wait ${waits[1]}`);
  });

  test(`${leg}: no answer (no status) is sent again`, async () => {
    const { resend } = makeResend(leg);
    const { request, sent } = requestFrom([
      failure(undefined),
      { status: 200 },
    ]);
    await resend(request, GET);
    assert.equal(sent.length, 2);
  });

  test(`${leg}: a 404 or a permission 403 is final`, async () => {
    for (const error of [
      failure(404),
      failure(
        403,
        { "x-ratelimit-remaining": "4999" },
        "Resource not accessible by integration",
      ),
    ]) {
      const { resend, waits } = makeResend(leg);
      const { request, sent } = requestFrom([error, { status: 200 }]);
      await assert.rejects(resend(request, GET), (thrown) => thrown === error);
      assert.equal(sent.length, 1);
      assert.deepEqual(waits, []);
    }
  });

  test(`${leg}: a rate limit waits its retry-after, else 60 s for a secondary limit`, async () => {
    for (const [error, wait] of [
      [failure(429, { "retry-after": "7" }), 7],
      [failure(403, {}, "You have exceeded a secondary rate limit."), 60],
    ]) {
      const { resend, waits } = makeResend(leg);
      const { request, sent } = requestFrom([error, { status: 200 }]);
      await resend(request, GET);
      assert.equal(sent.length, 2);
      assert.deepEqual(waits, [wait]);
    }
  });

  test(`${leg}: a rate limit whose wait would pass 60 s is final`, async () => {
    const { resend, waits } = makeResend(leg);
    const error = failure(429, { "retry-after": "61" });
    const { request, sent } = requestFrom([error, { status: 200 }]);
    await assert.rejects(resend(request, GET), (thrown) => thrown === error);
    assert.equal(sent.length, 1);
    assert.deepEqual(waits, []);
  });
}

// The full-diff step under a `gh` that answers from a list of HTTP statuses,
// one per call, and a `git` that succeeds.
function runFullDiff(leg, statuses) {
  const dir = makeTemporaryDirectory("pr-review-cli-outage-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const count = path.join(dir, "count");
  fs.writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      `n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${count}"`,
      `statuses=(${statuses.join(" ")})`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a bash expansion
      'code="${statuses[$(( n - 1 ))]:-${statuses[-1]}}"',
      'if [[ "$code" == 200 ]]; then printf "HTTP/2.0 200 OK\\r\\n\\r\\n%s\\n" "' +
        "c".repeat(40) +
        '"; exit 0; fi',
      'printf "HTTP/2.0 %s Error\\r\\n\\r\\n{}\\n" "$code"',
      'echo "gh: failed (HTTP $code)" >&2',
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "git"),
    '#!/usr/bin/env bash\n[ "$1" = diff ] && [ "$2" = --name-only ] && echo a.js\nexit 0\n',
    {
      mode: 0o755,
    },
  );
  fs.writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  const output = path.join(dir, "output");
  fs.writeFileSync(output, "");
  const result = spawnSync("bash", ["-e", "-c", step(leg, "full-diff").run], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: output,
      GITHUB_SERVER_URL: "https://github.com",
      GH_TOKEN: "t",
      REPO: "o/r",
      BASE_SHA: "a".repeat(40),
      HEAD_SHA: "b".repeat(40),
      MERGE_BASE: "",
      DIFF_FILE: ".claude-lane/pr.diff",
      FILE_LIST: ".claude-lane/files.txt",
      SCOPE: "whole",
    },
  });
  return {
    status: result.status,
    calls: Number(fs.readFileSync(count, "utf8")),
    output: fs.readFileSync(output, "utf8"),
    stdout: result.stdout,
  };
}

for (const leg of LEGS) {
  test(`${leg}: the full diff's compare read is sent again after a 502`, () => {
    const run = runFullDiff(leg, [502, 200]);
    assert.equal(run.calls, 2);
    assert.doesNotMatch(run.output, /^held=/mu);
    assert.match(run.stdout, /sending it again in [0-2]s \(attempt 2 of 3\)/u);
  });

  test(`${leg}: a compare read that fails 3 times holds the leg`, () => {
    const run = runFullDiff(leg, [503]);
    assert.equal(run.status, 1);
    assert.equal(run.calls, 3);
    assert.match(
      run.output,
      /^held=the compare read of the merge base failed$/mu,
    );
  });

  test(`${leg}: a compare 404 is final and still holds the leg`, () => {
    const run = runFullDiff(leg, [404, 200]);
    assert.equal(run.status, 1);
    assert.equal(run.calls, 1);
    assert.match(run.output, /^held=/mu);
  });

  test(`${leg}: a held leg checks no credential, so its model never runs`, () => {
    const gate = step(leg, "credential").if;
    const at = (held) =>
      evaluate(gate, {
        steps: {
          scope: { outputs: { review: "true" } },
          "full-diff": { outputs: { held } },
        },
      });
    assert.equal(at(""), true);
    assert.equal(at("the compare read of the merge base failed"), false);
  });
}

// The status job, from the legs' `held` outputs.
const status = workflow.jobs.status;
const statusStep = (name) => status.steps.find((s) => s.name === name);
const legsHeld = (held) => ({
  "review-key": { outputs: { held: held.key ?? "" } },
  "review-subscription": { outputs: { held: held.sub ?? "" } },
  "review-fallback": { outputs: { held: held.fb ?? "" } },
});

test("each leg passes its full-diff step's hold out as the job's held output", () => {
  for (const leg of LEGS)
    assert.equal(
      workflow.jobs[leg].outputs.held,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
      "${{ steps.full-diff.outputs.held }}",
    );
});

test("a held leg notes the hold, the status job publishes nothing, and the hold step still runs for a standing hold", () => {
  const note = statusStep("Note the hold");
  for (const held of [{ key: "x" }, { sub: "x" }, { fb: "x" }]) {
    assert.equal(
      evaluate(note.if, { needs: legsHeld(held), inputs: {} }),
      true,
      JSON.stringify(held),
    );
  }
  assert.equal(evaluate(note.if, { needs: legsHeld({}), inputs: {} }), false);
  const after = {
    steps: { held: { outcome: "success" } },
    inputs: { "hold-label": "needs-human", publish: "comments" },
  };
  assert.equal(evaluate(statusStep("Publish the review").if, after), false);
  // The hold step still runs: it labels only for an earlier head's standing
  // critical-security hold, since a held leg returns no review.
  assert.equal(evaluate(statusStep("Apply the hold").if, after), true);
  const unheld = { ...after, steps: { held: { outcome: "skipped" } } };
  assert.equal(evaluate(statusStep("Publish the review").if, unheld), true);
  assert.equal(evaluate(statusStep("Apply the hold").if, unheld), true);
});

test("the hold notice opens with `held: `, the prefix the reconciler reads", () => {
  const note = statusStep("Note the hold");
  const result = spawnSync("bash", ["-e", "-c", note.run], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      LANE_ID: "claude-review",
      HEAD_SHA: "b".repeat(40),
      HELD: "the compare read of the merge base failed",
    },
  });
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout.trim(),
    `::notice::held: claude-review did not review ${"b".repeat(40)}: the compare read of the merge base failed. A later run of this workflow reviews it.`,
  );
});
