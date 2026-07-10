"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const githubRoot = path.join(__dirname, "..");

function yamlFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return yamlFiles(entryPath);
      }
      return /\.ya?ml$/u.test(entry.name) ? [entryPath] : [];
    })
    .sort();
}

test("hosted workflow contracts use explicit GA operating-system labels", () => {
  const movingLabels = /\b(?:ubuntu|windows)-latest\b/u;
  for (const file of yamlFiles(githubRoot)) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      movingLabels,
      `${path.relative(githubRoot, file)} uses a moving hosted image label`,
    );
  }
});
