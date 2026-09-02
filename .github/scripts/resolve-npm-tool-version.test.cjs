"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ResolveError,
  resolveNpmToolVersion,
} = require("./resolve-npm-tool-version.cjs");

function writePackage(dir, manifest) {
  const file = path.join(dir, "package.json");
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return file;
}

test("explicit exact input wins over package.json and fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-npm-"));
  const packageJsonPath = writePackage(dir, {
    devDependencies: { "@biomejs/biome": "2.5.6" },
  });
  assert.deepEqual(
    resolveNpmToolVersion({
      versionInput: "2.4.0",
      fallbackVersion: "2.5.6",
      packageName: "@biomejs/biome",
      packageJsonPath,
    }),
    { version: "2.4.0", source: "input" },
  );
});

test("exact package.json pin wins over fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-npm-"));
  const packageJsonPath = writePackage(dir, {
    dependencies: { "@biomejs/biome": "2.5.6" },
  });
  assert.deepEqual(
    resolveNpmToolVersion({
      versionInput: "",
      fallbackVersion: "2.5.4",
      packageName: "@biomejs/biome",
      packageJsonPath,
    }),
    { version: "2.5.6", source: "package.json" },
  );
});

test("absent package.json uses fallback", () => {
  assert.deepEqual(
    resolveNpmToolVersion({
      versionInput: "  ",
      fallbackVersion: "2.5.6",
      packageName: "@biomejs/biome",
      packageJsonPath: path.join(
        os.tmpdir(),
        "resolve-npm-missing-package.json",
      ),
    }),
    { version: "2.5.6", source: "fallback" },
  );
});

test("absent package entry uses fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-npm-"));
  const packageJsonPath = writePackage(dir, {
    devDependencies: { typescript: "5.9.3" },
  });
  assert.deepEqual(
    resolveNpmToolVersion({
      versionInput: "",
      fallbackVersion: "2.5.6",
      packageName: "@biomejs/biome",
      packageJsonPath,
    }),
    { version: "2.5.6", source: "fallback" },
  );
});

test("ranged package.json pin fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-npm-"));
  const packageJsonPath = writePackage(dir, {
    devDependencies: { "@biomejs/biome": "^2.5.6" },
  });
  assert.throws(
    () =>
      resolveNpmToolVersion({
        versionInput: "",
        fallbackVersion: "2.5.6",
        packageName: "@biomejs/biome",
        packageJsonPath,
      }),
    (error) =>
      error instanceof ResolveError &&
      /not an exact major\.minor\.patch/u.test(error.message),
  );
});

test("conflicting dependency section pins fail closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-npm-"));
  const packageJsonPath = writePackage(dir, {
    dependencies: { "@biomejs/biome": "2.5.4" },
    devDependencies: { "@biomejs/biome": "2.5.6" },
  });
  assert.throws(
    () =>
      resolveNpmToolVersion({
        versionInput: "",
        fallbackVersion: "2.5.6",
        packageName: "@biomejs/biome",
        packageJsonPath,
      }),
    (error) =>
      error instanceof ResolveError && /conflicting/u.test(error.message),
  );
});

test("ranged version input fails closed", () => {
  assert.throws(
    () =>
      resolveNpmToolVersion({
        versionInput: "^2.5.6",
        fallbackVersion: "2.5.6",
        packageName: "@biomejs/biome",
      }),
    (error) =>
      error instanceof ResolveError &&
      /version input must be an exact/u.test(error.message),
  );
});

test("biome action wires resolve step before npx", () => {
  const action = fs.readFileSync(
    path.join(__dirname, "..", "actions", "biome", "action.yml"),
    "utf8",
  );
  assert.match(action, /^ {2}fallback-version:/mu);
  assert.match(action, /^ {4}default: 2\.5\.11$/mu);
  assert.match(action, /resolve-npm-tool-version\.cjs/u);
  assert.match(action, /PACKAGE_NAME: '@biomejs\/biome'/u);
  assert.match(
    action,
    /VERSION: \$\{\{ steps\.resolve\.outputs\.version \}\}/u,
  );
  assert.match(action, /npx --yes "@biomejs\/biome@\$VERSION"/u);
});
