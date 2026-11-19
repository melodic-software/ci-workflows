"use strict";

// A calling job cannot set `environment`, so each reusable names the caller's
// environment on its own jobs that read a Claude secret:
// https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsDir = path.join(__dirname, "..", "workflows");
const REUSABLES = ["pr-review-cli.yml", "intake-triage.yml"];
const CLAUDE_SECRET = /secrets\.[A-Za-z_][\w-]*(?:CLAUDE|OAUTH)/i;
const CALLER_ENVIRONMENT = ["$", "{{ inputs.environment }}"].join("");

const load = (file) =>
  parseWorkflow(fs.readFileSync(path.join(workflowsDir, file), "utf8"));

for (const file of REUSABLES) {
  test(`${file}: an optional environment input defaults to empty`, () => {
    const input = load(file).on.workflow_call.inputs.environment;
    assert.deepEqual(
      { type: input?.type, default: input?.default, required: input?.required },
      { type: "string", default: "", required: undefined },
    );
  });

  test(`${file}: every job that reads a Claude secret runs in the caller's environment with no deployment record`, () => {
    const readers = Object.entries(load(file).jobs).filter(([, job]) =>
      CLAUDE_SECRET.test(JSON.stringify(job)),
    );
    assert.equal(
      readers.length,
      3,
      `${file}: one key, one subscription and one fallback job`,
    );
    for (const [id, job] of readers) {
      assert.deepEqual(
        job.environment,
        { name: CALLER_ENVIRONMENT, deployment: false },
        `${file} ${id}`,
      );
    }
  });
}
