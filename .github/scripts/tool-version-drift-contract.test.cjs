"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function inputDefault(actionName, inputName) {
  const source = read(
    path.join(".github", "actions", actionName, "action.yml"),
  );
  const lines = source.split(/\r?\n/u);
  const inputStart = lines.indexOf(`  ${inputName}:`);
  assert.notEqual(inputStart, -1, `missing ${actionName} input ${inputName}`);

  for (let index = inputStart + 1; index < lines.length; index += 1) {
    if (/^ {2}\S/u.test(lines[index])) {
      break;
    }
    const match = lines[index].match(/^ {4}default: ['"]?([^'"]+)['"]?$/u);
    if (match) {
      return match[1].trim();
    }
  }

  assert.fail(`missing ${actionName} inputs.${inputName}.default`);
}

test("Python action defaults are the same exact patch release", () => {
  const actionNames = ["ruff", "pyright", "check-jsonschema"];
  const versions = actionNames.map((name) =>
    inputDefault(name, "python-version"),
  );

  for (const [index, version] of versions.entries()) {
    assert.match(
      version,
      /^\d+\.\d+\.\d+$/u,
      `${actionNames[index]} must pin an exact Python patch release`,
    );
  }
  assert.equal(new Set(versions).size, 1, "Python action defaults must agree");

  const pyrightConfig = JSON.parse(
    read(path.join("fixtures", "python", "good", "pyrightconfig.json")),
  );
  assert.equal(
    pyrightConfig.pythonVersion,
    versions[0].split(".").slice(0, 2).join("."),
    "Pyright's language target must match the runtime major/minor",
  );
});

test("markdownlint action and schema pins agree", () => {
  const actionVersion = inputDefault("markdown", "version");
  const config = read(".markdownlint-cli2.jsonc");
  const schemaVersion = config.match(
    /"\$schema":\s*"https:\/\/raw\.githubusercontent\.com\/DavidAnson\/markdownlint-cli2\/v([^/]+)\/schema\/markdownlint-cli2-config-schema\.json"/u,
  );
  const commentVersion = config.match(
    /Schema pinned to markdownlint-cli2 v([^ ]+) — bump together on upgrade\./u,
  );

  assert.ok(schemaVersion, "missing pinned markdownlint-cli2 schema URL");
  assert.ok(commentVersion, "missing markdownlint-cli2 schema pin comment");
  assert.equal(schemaVersion[1], actionVersion);
  assert.equal(commentVersion[1], actionVersion);
});

test("drift workflow protects runtime and schema agreement", () => {
  const workflow = read(
    path.join(".github", "workflows", "tool-version-drift-check.yml"),
  );

  for (const relativePath of [
    ".github/actions/ruff/action.yml",
    ".github/actions/pyright/action.yml",
    ".github/actions/check-jsonschema/action.yml",
    ".github/actions/markdown/action.yml",
    ".markdownlint-cli2.jsonc",
  ]) {
    assert.match(
      workflow,
      new RegExp(`- '${relativePath.replaceAll(".", "\\.")}'`, "u"),
      `${relativePath} must trigger the drift workflow`,
    );
  }

  assert.match(workflow, /"ruff:version:github:astral-sh\/ruff"/u);
  assert.match(workflow, /"markdown:version:npm:markdownlint-cli2"/u);
  assert.match(workflow, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/u);
  assert.match(
    workflow,
    /\.github\/actions\/pyright\/action\.yml \.github\/actions\/check-jsonschema\/action\.yml/u,
  );
  assert.match(workflow, /markdown_schema_version/u);
  assert.match(workflow, /markdown_schema_version" != "\$markdown_current"/u);
  assert.match(workflow, /local prefix="\$\{1%\.\*\}\."/u);
});
