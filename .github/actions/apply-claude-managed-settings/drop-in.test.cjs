"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readDropIn } = require("./drop-in.cjs");

const { parseWorkflow } = require("../../scripts/workflow-yaml.cjs");

const action = parseWorkflow(fs.readFileSync(path.join(__dirname, "action.yml"), "utf8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "drop-in-"));
const OPTIONS = { pluginConfigs: { "source-control@melodic-software": { options: { a: ["b"] } } } };

function write(name, text) {
  const file = path.join(root, name);
  fs.writeFileSync(file, text);
  return file;
}

test("a pluginConfigs-only object passes and prints as JSON", () => {
  const verdict = readDropIn(write("ok.json", JSON.stringify(OPTIONS)), "50-source-control");
  assert.deepEqual(JSON.parse(verdict.json), OPTIONS);
});

test("a drop-in that sets anything but pluginConfigs is refused", () => {
  for (const extra of [
    { apiKeyHelper: "x" },
    { env: { ANTHROPIC_BASE_URL: "http://evil" } },
    { permissions: {} },
    { allowManagedHooksOnly: false },
    { hooks: {} },
  ]) {
    const file = write("extra.json", JSON.stringify({ ...OPTIONS, ...extra }));
    assert.match(readDropIn(file, "x").problem, /may set only pluginConfigs$/u, JSON.stringify(extra));
  }
});

test("a file that is not a pluginConfigs object is refused", () => {
  for (const text of ["{nope", "[]", "null", "{}", '{"pluginConfigs": []}']) {
    assert.ok(readDropIn(write("bad.json", text), "x").problem, text);
  }
  assert.ok(readDropIn(path.join(root, "absent.json"), "x").problem);
});

test("drop-in-name must be a bare lowercase file name", () => {
  const file = write("name.json", JSON.stringify(OPTIONS));
  for (const name of ["", "../x", "a/b", "X", "x.json", ".hidden", "a b"]) {
    assert.match(readDropIn(file, name).problem, /^drop-in-name /u, name);
  }
});

test("the drop-in step writes only managed-settings.d/<name>.json, root-owned 644", () => {
  const [settings, dropIn] = action.runs.steps;
  assert.equal(settings.if, "inputs.drop-in-file == '' && inputs.drop-in-name == ''");
  assert.equal(dropIn.if, "inputs.drop-in-file != '' || inputs.drop-in-name != ''");
  assert.equal(action.inputs["drop-in-file"].default, "");
  assert.equal(action.inputs["drop-in-name"].default, "");
  assert.doesNotMatch(dropIn.run, /managed-settings\.json/u);

  // Run the step's script with a sudo stand-in that logs each call and keeps
  // what tee writes.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(root, "sudo.log");
  const written = path.join(root, "tee.out");
  fs.writeFileSync(
    path.join(bin, "sudo"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"${log}"\n[ "$1" = tee ] && cat >"${written}"\nexit 0\n`,
    { mode: 0o755 },
  );
  const run = spawnSync("bash", ["-c", dropIn.run], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_ACTION_PATH: __dirname,
      DROP_IN_FILE: write("in.json", JSON.stringify(OPTIONS)),
      DROP_IN_NAME: "50-source-control",
    },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  const target = "/etc/claude-code/managed-settings.d/50-source-control.json";
  assert.deepEqual(calls, [
    "-n true",
    "install -d -o root -g root -m 755 /etc/claude-code /etc/claude-code/managed-settings.d",
    `tee ${target}`,
    `chown root:root ${target}`,
    `chmod 644 ${target}`,
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(written, "utf8")), OPTIONS);
});

test("a refused drop-in writes nothing", () => {
  const [, dropIn] = action.runs.steps;
  const log = path.join(root, "refused.log");
  const bin = path.join(root, "bin-refused");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "sudo"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"${log}"\n`, {
    mode: 0o755,
  });
  const run = spawnSync("bash", ["-c", dropIn.run], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_ACTION_PATH: __dirname,
      DROP_IN_FILE: write("refused.json", JSON.stringify({ ...OPTIONS, apiKeyHelper: "x" })),
      DROP_IN_NAME: "50-source-control",
    },
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^::error title=apply-claude-managed-settings::.*may set only pluginConfigs$/mu);
  assert.equal(fs.existsSync(log), false);
});

test("a drop-in name with an empty file is refused, never a managed-settings.json write", () => {
  assert.match(readDropIn("", "50-source-control").problem, /drop-in-file is empty$/u);
  const [settings] = action.runs.steps;
  assert.match(settings.if, /inputs\.drop-in-name == ''/u);
});
