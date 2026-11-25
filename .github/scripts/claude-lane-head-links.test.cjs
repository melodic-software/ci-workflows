"use strict";

// The review lanes write their files under .claude-lane in the head checkout,
// from outside any sandbox. A head may commit .claude-lane, symlinks
// included, so each lane removes the head's .claude-lane right after the
// checkout, before any step writes there: a planted link is never written
// through.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const root = path.join(__dirname, "..");
const read = (name) =>
  parseWorkflow(fs.readFileSync(path.join(root, "workflows", name), "utf8"));
const cli = read("pr-review-cli.yml");
const hosted = read("pr-review.yml");
const security = read("pr-review-security.yml");
const JOBS = [
  ["pr-review-cli review-key", cli.jobs["review-key"]],
  ["pr-review-cli review-subscription", cli.jobs["review-subscription"]],
  ["pr-review-cli review-fallback", cli.jobs["review-fallback"]],
  ["pr-review claude", hosted.jobs.claude],
  ["pr-review-security claude", security.jobs.claude],
];

// Every path a step of the two lanes writes under .claude-lane.
const WRITTEN = [
  "pr.diff",
  "files.txt",
  "incremental.diff",
  "incremental-files.txt",
  "incremental-data-files.txt",
  "data-files.txt",
  "media-files.txt",
  "binary-files.txt",
  "identical.txt",
  "renames.txt",
  "to-read.txt",
  "pr-context.md",
  "pr-context.md.tmp",
  "settled-threads.md",
  "settled-threads.md.tmp",
  "prior-findings.md",
];

test("every review job removes the head's .claude-lane right after the checkout, before any step that names it", () => {
  for (const [name, job] of JOBS) {
    const steps = job.steps;
    const clear = steps.findIndex((s) => s.id === "clear-lane");
    assert.ok(clear > 0, `${name}: no clear-lane step`);
    assert.equal(steps[clear - 1].name, "Check out", name);
    assert.match(
      steps[clear].run,
      /^rm -rf -- "\$\{GITHUB_WORKSPACE:\?\}\/\.claude-lane"$/u,
      name,
    );
    steps.forEach((s, i) => {
      if (i === clear) return;
      if (JSON.stringify(s).includes(".claude-lane/")) {
        assert.ok(
          i > clear,
          `${name}: "${s.name}" names .claude-lane before it is cleared`,
        );
      }
    });
  }
});

// GitHub runs a `run:` step as `bash --noprofile --norc -eo pipefail`.
function run(script, cwd, env) {
  const output = path.join(cwd, "..", "output");
  fs.writeFileSync(output, "");
  return spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
    {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_WORKSPACE: cwd,
        GITHUB_OUTPUT: output,
        ...env,
      },
    },
  );
}

test("links the head commits under .claude-lane are removed, never written through", () => {
  const dir = makeTemporaryDirectory("claude-lane-head-links-");
  const workspace = path.join(dir, "workspace");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(path.join(outside, "chunks"), { recursive: true });
  fs.writeFileSync(path.join(outside, "file"), "untouched\n");
  const lane = path.join(workspace, ".claude-lane");
  fs.mkdirSync(lane, { recursive: true });
  for (const name of WRITTEN) {
    fs.symlinkSync(path.join(outside, "file"), path.join(lane, name));
  }
  fs.symlinkSync(path.join(outside, "chunks"), path.join(lane, "chunks"));
  fs.writeFileSync(
    path.join(dir, "pr-context.json"),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 5,
            title: "T",
            body: "B",
            closingIssuesReferences: { nodes: [] },
          },
        },
      },
    }),
  );
  for (const [name, job] of JOBS) {
    // The job's steps in order up to its first write: the run steps among
    // them (clear-lane on the fixed code), then the write. That is the
    // PR-context step where the job has one; pr-review-security's first
    // write, the full diff, is a script, so the test writes
    // .claude-lane/pr.diff the way build-review-diff/diff.sh does.
    const steps = job.steps;
    const context = steps.findIndex((s) => s.id === "pr-context");
    const upTo =
      context >= 0 ? context : steps.findIndex((s) => s.id === "full-diff");
    for (const s of steps.slice(0, upTo)) {
      if (s.id === "clear-lane") run(s.run, workspace);
    }
    const written = context >= 0 ? "pr-context.md" : "pr.diff";
    const result =
      context >= 0
        ? run(steps[upTo].run, workspace, {
            RUNNER_TEMP: dir,
            REPOSITORY: "o/r",
            TRUSTED: "[]",
            CONTEXT_FILE: ".claude-lane/pr-context.md",
          })
        : run(
            'mkdir -p "$(dirname "$DIFF_FILE")"; printf "diff\\n" >"$DIFF_FILE"',
            workspace,
            {
              DIFF_FILE: ".claude-lane/pr.diff",
            },
          );
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.equal(
      fs.readFileSync(path.join(outside, "file"), "utf8"),
      "untouched\n",
      `${name}: nothing is written through a planted link`,
    );
    assert.deepEqual(fs.readdirSync(path.join(outside, "chunks")), [], name);
    assert.ok(fs.lstatSync(lane).isDirectory(), name);
    assert.ok(fs.lstatSync(path.join(lane, written)).isFile(), name);
    for (const file of WRITTEN.filter((f) => f !== written)) {
      assert.equal(
        fs.existsSync(path.join(lane, file)),
        false,
        `${name}: ${file}`,
      );
    }
    // Plant again for the next job.
    fs.rmSync(lane, { recursive: true });
    fs.mkdirSync(lane);
    for (const file of WRITTEN) {
      fs.symlinkSync(path.join(outside, "file"), path.join(lane, file));
    }
    fs.symlinkSync(path.join(outside, "chunks"), path.join(lane, "chunks"));
  }
});

test("a head whose .claude-lane is itself a link loses the link, not its target", () => {
  const dir = makeTemporaryDirectory("claude-lane-head-link-dir-");
  const workspace = path.join(dir, "workspace");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "kept\n");
  fs.symlinkSync(outside, path.join(workspace, ".claude-lane"));
  const clear = JOBS[0][1].steps.find((s) => s.id === "clear-lane");
  assert.equal(run(clear.run, workspace).status, 0);
  assert.equal(fs.existsSync(path.join(workspace, ".claude-lane")), false);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "kept\n");
});
