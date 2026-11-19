// contract.cjs is what outside consumers load at a pin: its export names and
// the files contract-files.txt tells them to fetch.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../../..");
const FILES = fs.readFileSync(path.join(__dirname, "contract-files.txt"), "utf8").split("\n").filter(Boolean);

test("the contract exports exactly the names consumers read", () => {
  // Removing or renaming one, here or in the module it comes from, breaks a
  // consumer at its next re-pin.
  const contract = require("./contract.cjs");
  for (const [name, value] of Object.entries(contract)) assert.notEqual(value, undefined, name);
  assert.deepEqual(Object.keys(contract).sort(), [
    "HANDOFF_REASONS",
    "SANDBOX_SETTINGS",
    "cliArgs",
    "handoffReason",
    "isCreditStop",
    "judgeLeg",
    "leg",
    "legEnv",
    "linesToMessages",
    "next",
    "start",
  ]);
});

test("contract-files.txt lists only files that exist, the contract first", () => {
  assert.equal(FILES[0], ".github/actions/run-claude-cli/contract.cjs");
  assert.equal(new Set(FILES).size, FILES.length);
  for (const file of FILES) assert.ok(fs.statSync(path.join(ROOT, file)).isFile(), file);
});

test("the contract loads from contract-files.txt alone, and loads every file it lists", (t) => {
  // require.cache keys are real paths; a symlinked tmpdir would match none.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "contract-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"commonjs"}\n');
  for (const file of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
  const contract = createRequire(path.join(dir, "package.json"))(`./${FILES[0]}`);
  assert.equal(typeof contract.judgeLeg, "function");
  const loaded = Object.keys(require.cache)
    .filter((file) => file.startsWith(`${dir}${path.sep}`))
    .map((file) => path.relative(dir, file).split(path.sep).join("/"));
  assert.deepEqual(loaded.sort(), [...FILES].sort());
});
