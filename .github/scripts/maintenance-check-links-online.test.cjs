"use strict";

// The online link check is opt-in per repository: a scheduled run does nothing
// unless the caller repository's custom property is "true", a dispatched run
// always checks, and a property read that errors fails red. The workflow also
// holds the issue #739 contract: workflow_call only, contents: read, the
// GITHUB_TOKEN only, and the report in the job summary.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const source = fs.readFileSync(
  path.join(__dirname, "..", "workflows", "maintenance-check-links-online.yml"),
  "utf8",
);
const workflow = parseWorkflow(source);
const job = workflow.jobs["check-links"];
const [gate, checkout, lychee] = job.steps;

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
    await new AsyncFunction("github", "context", "core", "process", gate.with.script)(
      github,
      context,
      core,
      process,
    );
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

test("lychee uses the GITHUB_TOKEN, fails red, and writes the job summary", () => {
  assert.match(lychee.uses, /^lycheeverse\/lychee-action@[0-9a-f]{40}$/u);
  assert.equal(lychee.with.token, "${{ github.token }}");
  assert.equal(lychee.with.fail, true);
  assert.equal(lychee.with.jobSummary, true);
  assert.equal(lychee.with.format, "markdown");
  assert.doesNotMatch(lychee.with.args, /--offline/u);
  assert.equal(checkout.with["persist-credentials"], false);
});

test("every step after the gate runs only when the gate says so", () => {
  for (const step of [checkout, lychee]) {
    assert.equal(step.if, "steps.gate.outputs.run == 'true'");
  }
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
  assert.equal(requests[0].route, "GET /repos/{owner}/{repo}/properties/values");
  assert.deepEqual(requests[0].params, { owner: "o", repo: "r" });
});

test("a scheduled run skips when the property is unset or false", async () => {
  for (const properties of [
    [],
    [{ property_name: "link-check-online", value: "false" }],
    [{ property_name: "link-check-online", value: null }],
    [{ property_name: "other", value: "true" }],
  ]) {
    const { outputs, failed } = await runGate({ eventName: "schedule", properties });
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
