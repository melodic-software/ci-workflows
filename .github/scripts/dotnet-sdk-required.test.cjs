"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const repoRoot = path.join(__dirname, "..", "..");

for (const name of ["dotnet-build", "dotnet-format"]) {
  test(`${name} fails instead of using ci-workflows' own global.json`, () => {
    const actionPath = path.join(".github", "actions", name, "action.yml");
    const source = fs.readFileSync(path.join(repoRoot, actionPath), "utf8");
    const steps = parseWorkflow(source).runs.steps;

    assert.doesNotMatch(source, /global-json-file/u);
    assert.doesNotMatch(source, /action_path[^\n]*global\.json/u);

    const setup = steps.findIndex((step) => step.id === "setup-dotnet");
    assert.notEqual(setup, -1, "missing setup-dotnet step");
    const guard = steps[setup + 1];
    assert.equal(guard.if, "steps.setup-dotnet.outputs.dotnet-version == ''");
    assert.equal(guard.uses ?? null, null);
    assert.match(guard.run, new RegExp(`::error::${name}: `, "u"));
    assert.match(guard.run, /exit 1/u);
  });
}
