"use strict";

// check-kill-switch lets a lane proceed only when the org and the repository
// switch both read exactly `false`, and always exits 0 so the gated job's
// `if:` decides.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  checkKillSwitch,
  writeOutputs,
} = require("../actions/check-kill-switch/check.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");

const SCRIPT = path.join(
  __dirname,
  "..",
  "actions",
  "check-kill-switch",
  "check.cjs",
);
const PROCEED = { proceed: "true", reason: "ok", cause: "ok" };
const STOP = { proceed: "false", reason: "kill-switch", cause: "switch" };

// Parses a $GITHUB_OUTPUT file in the two forms the runner documents:
// `name=value` and the multiline `name<<DELIMITER` ... `DELIMITER` block.
function readOutputs(text) {
  const outputs = {};
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "") continue;
    const heredoc = line.match(/^([^=<]+)<<(.+)$/u);
    if (heredoc) {
      const [, name, delimiter] = heredoc;
      const body = [];
      index += 1;
      while (index < lines.length && lines[index] !== delimiter) {
        body.push(lines[index]);
        index += 1;
      }
      if (index >= lines.length) throw new Error(`unterminated output ${name}`);
      outputs[name] = body.join("\n");
      continue;
    }
    const separator = line.indexOf("=");
    outputs[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return outputs;
}

function runCli(env) {
  const outputPath = path.join(
    makeTemporaryDirectory("kill-switch-"),
    "output",
  );
  fs.writeFileSync(outputPath, "");
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputPath, ...env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    outputs: readOutputs(fs.readFileSync(outputPath, "utf8")),
  };
}

test("proceeds only when the org and the repository switch both read exactly false", () => {
  assert.deepEqual(checkKillSwitch("false", "false"), PROCEED);
});

const NOT_FALSE = [
  ["unset", undefined],
  ["empty", ""],
  ["true", "true"],
  ["FALSE in capitals", "FALSE"],
  ["false with whitespace", " false"],
  ["a timed value", "true@2026-11-11T11:00:00Z"],
];

for (const [label, value] of NOT_FALSE) {
  test(`stops when the org switch is ${label}, whatever the repository switch`, () => {
    for (const repo of ["false", "true", undefined]) {
      assert.deepEqual(checkKillSwitch(value, repo), STOP);
    }
  });

  test(`stops when the repository switch is ${label} and the org switch is false`, () => {
    assert.deepEqual(checkKillSwitch("false", value), STOP);
  });
}

test("CLI writes proceed=true when both switches are exactly false and exits 0", () => {
  const { status, stdout, outputs } = runCli({
    KILL_SWITCH_VALUE: "false",
    REPO_KILL_SWITCH_VALUE: "false",
  });
  assert.equal(status, 0);
  assert.deepEqual(outputs, PROCEED);
  assert.match(stdout, /check-kill-switch: proceed=true reason=ok cause=ok/u);
});

test("CLI writes proceed=false when the repository switch is unset and exits 0", () => {
  const { status, outputs } = runCli({ KILL_SWITCH_VALUE: "false" });
  assert.equal(status, 0);
  assert.deepEqual(outputs, STOP);
});

test("CLI writes proceed=false when both variables are unset and exits 0", () => {
  const { status, outputs } = runCli({});
  assert.equal(status, 0);
  assert.deepEqual(outputs, STOP);
});

test("output values cannot inject a second output line", () => {
  const outputPath = path.join(
    makeTemporaryDirectory("kill-switch-"),
    "output",
  );
  fs.writeFileSync(outputPath, "");
  writeOutputs({ "head-ref": "a\nproceed=true" }, outputPath);
  assert.deepEqual(readOutputs(fs.readFileSync(outputPath, "utf8")), {
    "head-ref": "a\nproceed=true",
  });
});

test("the action passes the two switches to the script and reads its outputs", () => {
  const { parseWorkflow } = require("./workflow-yaml.cjs");
  const action = parseWorkflow(
    fs.readFileSync(path.join(path.dirname(SCRIPT), "action.yml"), "utf8"),
  );
  const [stepDef] = action.runs.steps;
  assert.equal(stepDef.env.KILL_SWITCH_VALUE, `\${{ inputs.value }}`);
  assert.equal(stepDef.env.REPO_KILL_SWITCH_VALUE, `\${{ inputs.repo-value }}`);
  assert.equal(stepDef.run, 'node "$GITHUB_ACTION_PATH/check.cjs"');
  for (const name of ["proceed", "reason", "cause"]) {
    assert.equal(
      action.outputs[name].value,
      `\${{ steps.check.outputs.${name} }}`,
    );
  }
});
