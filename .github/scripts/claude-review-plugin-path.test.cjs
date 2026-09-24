"use strict";

// Both review lanes expose plugins / plugin-marketplaces / plugin-command,
// pass the plugins through to the one claude-code-action invocation, and
// prompt it to run the plugin command.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const repositoryRoot = path.join(__dirname, "..", "..");

for (const { file, defaultCommand } of [
  { file: "claude-review.yml", defaultCommand: "/review:code-review" },
  {
    file: "claude-security-review.yml",
    defaultCommand: "/review:security-review",
  },
]) {
  const workflow = parseWorkflow(
    fs.readFileSync(
      path.join(repositoryRoot, ".github", "workflows", file),
      "utf8",
    ),
  );
  const inputs = workflow.on.workflow_call.inputs;
  const invocation = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((step) =>
      String(step?.uses ?? "").startsWith("anthropics/claude-code-action@"),
    );

  test(`${file} declares the plugin inputs and no prompt input`, () => {
    assert.match(inputs.plugins.default, /review@melodic-software/u);
    assert.match(
      inputs["plugin-marketplaces"].default,
      /https:\/\/github\.com\/melodic-software\/claude-code-plugins\.git/u,
    );
    assert.equal(inputs["plugin-command"].default, defaultCommand);
    assert.equal(inputs.prompt, undefined);
  });

  test(`${file} passes the plugins through and prompts the plugin command`, () => {
    assert.equal(invocation.with.plugins, `\${{ inputs.plugins }}`);
    assert.equal(
      invocation.with.plugin_marketplaces,
      `\${{ inputs.plugin-marketplaces }}`,
    );
    assert.match(
      invocation.with.prompt,
      /Invoke \$\{\{ inputs\.plugin-command \}\} now/u,
    );
  });
}

test("V2 architecture doc exists and names both skills", () => {
  const doc = fs.readFileSync(
    path.join(
      repositoryRoot,
      "docs",
      "topics",
      "claude-review-lanes",
      "V2-PLUGIN-ARCHITECTURE.md",
    ),
    "utf8",
  );
  assert.match(doc, /\/review:code-review/);
  assert.match(doc, /\/review:security-review/);
  assert.match(doc, /Dual-path|dual-path/);
  assert.match(doc, /Migration/);
});
