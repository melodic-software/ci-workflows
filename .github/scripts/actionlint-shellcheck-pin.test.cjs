"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const actionsRoot = path.join(__dirname, "..", "actions");
const workflowsRoot = path.join(__dirname, "..", "workflows");

function inputDefault(source, inputName) {
  const lines = source.split(/\r?\n/u);
  const inputStart = lines.indexOf(`  ${inputName}:`);
  assert.notEqual(inputStart, -1, `missing input ${inputName}`);

  for (let index = inputStart + 1; index < lines.length; index += 1) {
    if (/^ {2}\S/u.test(lines[index])) {
      break;
    }
    const match = lines[index].match(/^ {4}default: (.+)$/u);
    if (match) {
      return match[1].trim();
    }
  }

  assert.fail(`missing inputs.${inputName}.default`);
}

test("actionlint installs the canonical checksum-pinned ShellCheck release", () => {
  const actionlint = fs.readFileSync(
    path.join(actionsRoot, "actionlint", "action.yml"),
    "utf8",
  );
  const shellcheck = fs.readFileSync(
    path.join(actionsRoot, "shellcheck", "action.yml"),
    "utf8",
  );

  assert.equal(
    inputDefault(actionlint, "shellcheck-version"),
    inputDefault(shellcheck, "version"),
  );
  assert.equal(
    inputDefault(actionlint, "shellcheck-sha256"),
    inputDefault(shellcheck, "sha256"),
  );

  const stepStart = actionlint.indexOf(
    "    - name: Install ShellCheck for embedded scripts",
  );
  assert.notEqual(stepStart, -1, "missing dedicated ShellCheck install step");
  const nextStep = actionlint.indexOf("\n    - name:", stepStart + 1);
  assert.notEqual(nextStep, -1, "ShellCheck install step is not bounded");
  const installStep = actionlint.slice(stepStart, nextStep);
  assert.match(
    installStep,
    /URL: https:\/\/github\.com\/koalaman\/shellcheck\/releases\/download\/v\$\{\{ inputs\.shellcheck-version \}\}\/shellcheck-v\$\{\{ inputs\.shellcheck-version \}\}\.linux\.x86_64\.tar\.gz/u,
  );
  assert.match(installStep, /SHA256: \$\{\{ inputs\.shellcheck-sha256 \}\}/u);
  assert.match(installStep, /^ {8}BIN: shellcheck$/mu);
  assert.match(
    installStep,
    /ARCHIVE_MEMBER: shellcheck-v\$\{\{ inputs\.shellcheck-version \}\}\/shellcheck/u,
  );
  assert.match(
    installStep,
    /run: bash "\$GITHUB_ACTION_PATH\/\.\.\/_shared\/install-release\.sh"/u,
  );

  const ciWorkflow = fs.readFileSync(
    path.join(workflowsRoot, "ci.yml"),
    "utf8",
  );
  assert.match(ciWorkflow, /actionlint-shellcheck\.txt/u);
  assert.match(ciWorkflow, /actual_version.*shellcheck --version/su);
  assert.match(ciWorkflow, /expected_version.*shellcheck-version/su);
  assert.match(
    ciWorkflow,
    /if \[\[ -z "\$expected_version" \|\| "\$actual_version" != "\$expected_version" \]\]/u,
  );
  assert.match(ciWorkflow, /grep -F '\[shellcheck\]'/u);
  assert.match(ciWorkflow, /grep -F 'SC2086'/u);
});
