"use strict";

// pr-review-cli's prior-findings step: the round cap is read from the default
// branch only, an unread cap leaves CAP_CONFIG unset, and a failed script
// leaves no file. The composite's own run script is exercised with a stub gh
// and a stub prior-findings.mjs; every model leg runs it before compose.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const action = parseWorkflow(
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "actions",
      "collect-prior-findings",
      "action.yml",
    ),
    "utf8",
  ),
);
const step = action.runs.steps.find((s) => s.id === "prior");

// Runs the step's script in a fresh directory. `gh` records its arguments and
// prints the cap file or fails; the stub script records CAP_CONFIG and its
// content, then writes the output file and note or fails after writing it.
function runStep({
  ghFails = false,
  scriptFails = false,
  defaultBranch = "main",
} = {}) {
  const dir = makeTemporaryDirectory("prior-findings-");
  const bin = path.join(dir, "bin");
  const source = path.join(dir, "source");
  const work = path.join(dir, "work");
  const temp = path.join(dir, "temp");
  for (const d of [
    bin,
    path.join(source, "plugins/review/lib"),
    path.join(work, ".claude-lane"),
    temp,
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/gh-args"\n${ghFails ? "exit 1" : "printf 'loop:\\n  review-rounds: 3\\n'"}\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(source, "plugins/review/lib/prior-findings.mjs"),
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(`${dir}/seen.json`)}, JSON.stringify({
  cap: process.env.CAP_CONFIG ?? null,
  text: process.env.CAP_CONFIG ? fs.readFileSync(process.env.CAP_CONFIG, "utf8") : null,
  lane: process.env.LANE, token: process.env.GITHUB_TOKEN,
}));
fs.writeFileSync(process.env.OUTPUT_PATH, "findings\\n");
${scriptFails ? "process.exit(1);" : 'fs.appendFileSync(process.env.GITHUB_OUTPUT, "note=PRIOR FINDINGS: x\\n");'}
`,
  );
  const output = path.join(work, ".claude-lane", "prior-findings.md");
  fs.writeFileSync(output, "planted by the head\n");
  const githubOutput = path.join(dir, "github-output");
  fs.writeFileSync(githubOutput, "");
  const result = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
    cwd: work,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: githubOutput,
      SOURCE: source,
      OUTPUT_PATH: ".claude-lane/prior-findings.md",
      LANE: "claude-review",
      REPOSITORY: "o/r",
      PR_NUMBER: "7",
      HEAD_SHA: "a".repeat(40),
      DEFAULT_BRANCH: defaultBranch,
      GH_TOKEN: "t",
      GITHUB_TOKEN: "t",
    },
  });
  const read = (file) =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  return {
    status: result.status,
    ghArgs: read(path.join(dir, "gh-args"))?.trim().split("\n") ?? null,
    seen: JSON.parse(read(path.join(dir, "seen.json")) ?? "null"),
    output: read(output),
    githubOutput: read(githubOutput),
  };
}

test("collect-prior-findings: the cap is read from the default branch and handed to the script", () => {
  const r = runStep();
  assert.equal(r.status, 0);
  assert.deepEqual(r.ghArgs, [
    "api",
    "-X",
    "GET",
    "-H",
    "Accept: application/vnd.github.raw",
    "repos/o/r/contents/docs/conventions/pr-pipeline.yaml",
    "-f",
    "ref=main",
  ]);
  assert.equal(r.seen.text, "loop:\n  review-rounds: 3\n");
  assert.equal(r.seen.lane, "claude-review");
  assert.equal(r.output, "findings\n");
  assert.equal(r.githubOutput, "note=PRIOR FINDINGS: x\n");
});

test("collect-prior-findings: an unread cap leaves CAP_CONFIG unset and the review still gets its file", () => {
  for (const r of [
    runStep({ ghFails: true }),
    runStep({ defaultBranch: "" }),
  ]) {
    assert.equal(r.status, 0);
    assert.equal(r.seen.cap, null);
    assert.equal(r.output, "findings\n");
  }
});

test("collect-prior-findings: a failed script leaves no file and no note, even one the head planted", () => {
  const r = runStep({ scriptFails: true });
  assert.notEqual(r.status, 0);
  assert.equal(r.output, null);
  assert.equal(r.githubOutput, "");
});

test("pr-review-cli.yml: every model leg writes the prior findings after the plugin clone, into the prompt", () => {
  const workflow = parseWorkflow(
    fs.readFileSync(
      path.join(__dirname, "..", "workflows", "pr-review-cli.yml"),
      "utf8",
    ),
  );
  for (const name of ["review-key", "review-subscription", "review-fallback"]) {
    const job = workflow.jobs[name];
    assert.deepEqual(
      job.permissions,
      { contents: "read", "pull-requests": "read" },
      name,
    );
    const ids = job.steps.map((s) => s.id);
    const prior = job.steps.find((s) => s.id === "prior");
    assert.equal(prior.uses, "$/.github/actions/collect-prior-findings", name);
    assert.equal(prior["continue-on-error"], true, name);
    assert.equal(
      prior.with["output-file"],
      ".claude-lane/prior-findings.md",
      name,
    );
    assert.equal(
      prior.with.lane,
      `\${{ inputs.lane == 'security' && 'claude-security-review' || 'claude-review' }}`,
      name,
    );
    assert.ok(
      ids.indexOf("plugin") < ids.indexOf("prior") &&
        ids.indexOf("prior") < ids.indexOf("compose"),
      name,
    );
    const compose = job.steps.find((s) => s.id === "compose");
    assert.equal(
      compose.env.PRIOR_NOTE,
      `\${{ steps.prior.outputs.note }}`,
      name,
    );
    assert.match(
      compose.with.script,
      /env\.SETTLED_NOTE,\n\s*env\.PRIOR_NOTE,/u,
      name,
    );
  }
});
