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
