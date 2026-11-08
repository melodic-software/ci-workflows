"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

// GitHub evaluates `${{ }}` in action metadata and refuses to load the action
// when an expression names a context unavailable there. The metadata reference
// lists the keys that take an expression (`outputs.<output_id>.value`,
// `runs.steps[*].if`, `.run`, `.with`, ...) and documents none for `name`,
// `description`, or an input or output `description`, so those are literal
// text: an expression there either fails the action's load (a `secrets` or
// `steps` reference, as in #1003) or is not evaluated and misleads the reader.
// https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax
//
// The contexts reference's availability table covers workflow keys only, not
// action metadata keys, so this suite does not assert which contexts each
// metadata key allows (for example `secrets` inside `runs.steps`).
// https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability
const actionsRoot = path.join(__dirname, "..", "actions");

/** Locations of `${{` in the action's name and every description. */
function expressionsInMetadataText(source) {
  const action = parseWorkflow(source);
  const found = [];
  const check = (location, value) => {
    if (typeof value === "string" && value.includes("${{")) {
      found.push(`${location}: ${value.trim()}`);
    }
  };
  check("name", action.name);
  check("description", action.description);
  for (const [id, input] of Object.entries(action.inputs ?? {})) {
    check(`inputs.${id}.description`, input?.description);
  }
  for (const [id, output] of Object.entries(action.outputs ?? {})) {
    check(`outputs.${id}.description`, output?.description);
  }
  return found;
}

test("no action's name or description holds an expression", () => {
  const checked = [];
  for (const dir of fs.readdirSync(actionsRoot)) {
    const file = path.join(actionsRoot, dir, "action.yml");
    if (!fs.existsSync(file)) continue;
    checked.push(dir);
    assert.deepEqual(
      expressionsInMetadataText(fs.readFileSync(file, "utf8")),
      [],
      `${dir}/action.yml: metadata text is not evaluated as an expression`,
    );
  }
  assert.ok(checked.length > 0, "no action.yml files were found");
});

// Built by concatenation so no source line holds a literal placeholder.
const expr = (inner) => `$${"{{"} ${inner} }}`;

test("the guard catches the #1003 input description", () => {
  const bad = `such as \`${expr("secrets.X != ''")}\`.`;
  const action = [
    "name: Select model credential",
    "description: Pick a credential.",
    "inputs:",
    "  credential-set:",
    `    description: "True when the credential is set, ${bad}"`,
    "    required: false",
    "outputs:",
    "  credential:",
    "    description: The chosen credential.",
    `    value: ${expr("steps.pick.outputs.credential")}`,
    "runs:",
    "  using: composite",
    "  steps:",
    "    - run: echo ok",
    "      shell: bash",
    "",
  ].join("\n");
  assert.deepEqual(expressionsInMetadataText(action), [
    `inputs.credential-set.description: True when the credential is set, ${bad}`,
  ]);
});

test("the guard flags an expression in every metadata text position", () => {
  const action = [
    `name: ${expr("github.workflow")}`,
    `description: ${expr("github.workflow")}`,
    "inputs:",
    "  a:",
    `    description: ${expr("github.workflow")}`,
    "outputs:",
    "  b:",
    `    description: ${expr("github.workflow")}`,
    `    value: ${expr("github.workflow")}`,
    "runs:",
    "  using: node24",
    "  main: index.js",
    "",
  ].join("\n");
  assert.deepEqual(
    expressionsInMetadataText(action).map((entry) => entry.split(":")[0]),
    ["name", "description", "inputs.a.description", "outputs.b.description"],
  );
});
