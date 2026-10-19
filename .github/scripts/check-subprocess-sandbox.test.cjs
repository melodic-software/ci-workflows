"use strict";

// The review lanes run check-subprocess-sandbox before the model. These tests
// run the composite's own script against a stand-in bwrap on PATH: one that
// creates the namespace, and one that fails the way a runner with
// unprivileged user namespaces off does (ci-workflows#795).

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const action = parseWorkflow(
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "actions",
      "check-subprocess-sandbox",
      "action.yml",
    ),
    "utf8",
  ),
);
const step = action.runs.steps.find((candidate) => candidate.id === "probe");

function probe({ status, stderr }) {
  const directory = makeTemporaryDirectory("probe-");
  const argsFile = path.join(directory, "args");
  const outputFile = path.join(directory, "output");
  fs.writeFileSync(outputFile, "");
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "bwrap"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s' '${stderr}' >&2\nexit ${status}\n`,
    { mode: 0o755 },
  );
  const result = spawnSync(step.shell, ["-e", "-c", step.run], {
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: outputFile,
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    args: fs.readFileSync(argsFile, "utf8").trim().split("\n"),
    output: fs.readFileSync(outputFile, "utf8"),
  };
}

test("the action exposes the probe's class", () => {
  assert.equal(
    action.outputs["failure-class"].value,
    `\${{ steps.probe.outputs.failure-class }}`,
  );
});

test("the probe asks bwrap for a PID namespace over the whole filesystem", () => {
  const result = probe({ status: 0, stderr: "" });
  assert.deepEqual(result.args, [
    "--unshare-pid",
    "--dev-bind",
    "/",
    "/",
    "true",
  ]);
});

test("a sandbox that starts passes and sets no class", () => {
  const result = probe({ status: 0, stderr: "" });
  assert.equal(result.status, 0);
  assert.equal(result.output, "");
  assert.doesNotMatch(result.stdout, /::error/u);
});

test("a sandbox that cannot create a namespace fails as sandbox-unavailable with bwrap's stderr", () => {
  const result = probe({
    status: 1,
    stderr:
      "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.\n100% denied",
  });
  assert.equal(result.status, 1);
  assert.equal(result.output, "failure-class=sandbox-unavailable\n");
  // One annotation line: stderr's newline and percent sign are encoded.
  const errors = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("::error"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /failure-class=sandbox-unavailable/u);
  assert.match(
    errors[0],
    /bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces\.%0A100%25 denied$/u,
  );
});
