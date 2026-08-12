"use strict";

// Dual-path wiring for ci-workflows#258: both review lanes expose
// plugins / plugin-marketplaces / plugin-command, compose REVIEW_BODY,
// and pass plugins through to both claude-code-action attempts.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");

const LANES = [
  {
    file: "claude-review.yml",
    defaultCommand: "/review:code-review",
    attemptNames: ["Claude review", "Claude review (retry)"],
  },
  {
    file: "claude-security-review.yml",
    defaultCommand: "/review:security-review",
    attemptNames: ["Claude security review", "Claude security review (retry)"],
  },
];

const laneSource = (file) =>
  fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", file),
    "utf8",
  );

function stepSource(workflow, stepName) {
  const start = workflow.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(start, -1, `step not found: ${stepName}`);
  const rest = workflow.slice(start + 1);
  const next = rest.indexOf("\n      - name: ");
  return next === -1 ? rest : rest.slice(0, next);
}

function inputBlock(workflow, name) {
  const start = workflow.indexOf(`      ${name}:\n`);
  assert.notEqual(start, -1, `input not found: ${name}`);
  const rest = workflow.slice(start);
  const end = rest.search(/\n {6}[a-z]/);
  return end === -1 ? rest : rest.slice(0, end);
}

for (const lane of LANES) {
  test(`${lane.file} declares plugins / plugin-marketplaces / plugin-command`, () => {
    const src = laneSource(lane.file);
    for (const name of ["plugins", "plugin-marketplaces", "plugin-command"]) {
      assert.match(src, new RegExp(`^ {6}${name}:`, "m"), name);
    }
    const plugins = inputBlock(src, "plugins");
    assert.match(plugins, /review@melodic-software/);
    const marketplaces = inputBlock(src, "plugin-marketplaces");
    assert.match(
      marketplaces,
      /https:\/\/github\.com\/melodic-software\/claude-code-plugins\.git/,
    );
    const command = inputBlock(src, "plugin-command");
    assert.match(
      command,
      new RegExp(`default:\\s*${lane.defaultCommand.replace("/", "\\/")}`),
    );
  });

  test(`${lane.file} composes REVIEW_BODY with dual-path preference`, () => {
    const compose = stepSource(
      laneSource(lane.file),
      "Compose the review body",
    );
    assert.match(compose, /plugins_trim=/);
    assert.match(compose, /cmd_trim=/);
    assert.match(compose, /Invoke \$\{PLUGIN_COMMAND\}/);
    assert.match(compose, /printf '%s\\n' "\$PROMPT"/);
    assert.match(compose, /REVIEW_BODY<<REVIEW_BODY_EOF/);
  });

  test(`${lane.file} both attempts pass plugins and use REVIEW_BODY`, () => {
    const src = laneSource(lane.file);
    for (const name of lane.attemptNames) {
      const step = stepSource(src, name);
      assert.match(step, /plugins: \$\{\{ inputs\.plugins \}\}/);
      assert.match(
        step,
        /plugin_marketplaces: \$\{\{ inputs\.plugin-marketplaces \}\}/,
      );
      assert.match(step, /\$\{\{ env\.REVIEW_BODY \}\}/);
      assert.doesNotMatch(
        step,
        /\$\{\{ inputs\.prompt \}\}/,
        `${name} must not embed inputs.prompt directly`,
      );
    }
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
