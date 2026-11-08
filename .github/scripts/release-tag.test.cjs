"use strict";

// release-tag.yml's "Compute next version" step, run under bash with a fake
// gh that answers the Releases read and a no-op sleep.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(__dirname, "..", "workflows", "release-tag.yml"),
    "utf8",
  ),
);
const compute = workflow.jobs.tag.steps.find((s) => s.id === "ver");

// answers: one stdout per gh call, in order; the last repeats.
function run(answers, bump = "minor") {
  const dir = makeTemporaryDirectory("release-tag-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const [i, answer] of answers.entries()) {
    fs.writeFileSync(path.join(dir, `answer-${i}`), answer);
  }
  fs.writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      `n=$(cat "${dir}/calls" 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > "${dir}/calls"`,
      `f="${dir}/answer-$n"; [ -f "$f" ] || f="${dir}/answer-${answers.length - 1}"`,
      'cat "$f"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\n", {
    mode: 0o755,
  });
  const output = path.join(dir, "output");
  fs.writeFileSync(output, "");
  const result = spawnSync("bash", ["-c", compute.run], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      BUMP: bump,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_OUTPUT: output,
    },
  });
  const calls = Number(fs.readFileSync(path.join(dir, "calls"), "utf8"));
  return { ...result, calls, output: fs.readFileSync(output, "utf8") };
}

test("the next version is the newest published vX.Y.Z release plus the bump", () => {
  const result = run(["v0.9.0\nv0.61.0\nv0.10.3\nnot-semver\n"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "next=v0.62.0\n");
  assert.equal(run(["v1.2.3\n"], "patch").output, "next=v1.2.4\n");
  assert.equal(run(["v1.2.3\n"], "major").output, "next=v2.0.0\n");
});

test("an empty Releases answer is retried, then fails the step instead of computing v0.1.0", () => {
  const result = run([""]);
  assert.equal(result.status, 1);
  assert.equal(result.calls, 4, "four reads before failing");
  assert.equal(result.output, "", "no next version is written");
  assert.match(
    result.stdout,
    /::error::The Releases list came back with no published vX\.Y\.Z release after 4 reads; GitHub may be degraded\./u,
  );
});

test("a Releases answer that turns non-empty on a retry is used", () => {
  const result = run(["", "", "v0.61.0\n"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 3);
  assert.equal(result.output, "next=v0.62.0\n");
});
