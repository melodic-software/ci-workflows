"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const repoRoot = path.join(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("Node action defaults match the repository .node-version", () => {
  const nodeVersion = read(".node-version").trim();
  assert.match(nodeVersion, /^\d+\.\d+\.\d+$/u);

  for (const name of ["markdownlint", "biome"]) {
    const action = parseWorkflow(
      read(path.join(".github", "actions", name, "action.yml")),
    );
    assert.equal(
      String(action.inputs["node-version"].default),
      nodeVersion,
      `${name} node-version default must equal .node-version`,
    );
  }
});
