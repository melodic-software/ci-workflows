"use strict";

// Runs check-workflow-call-surface.cjs end to end in a scratch repository: a
// base commit holds a contracted reusable and the synced policy, a head commit
// changes the reusable, and the script compares the two against the contract.

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { POLICY_PATH } = require("./check-workflow-call-surface.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");

const SCRIPT = path.join(__dirname, "check-workflow-call-surface.cjs");
const REPOSITORY = "melodic-software/ci-workflows";
const REUSABLE = ".github/workflows/pr-example.yml";
const KEY = `${REPOSITORY}/${REUSABLE}`;

const BASE_REUSABLE = `name: pr-example

on:
  workflow_call:
    inputs:
      runner:
        type: string
        required: true
      label:
        type: string
        required: false
    secrets:
      APP_TOKEN:
        required: true

jobs:
  run:
    runs-on: \${{ inputs.runner }}
    steps:
      - run: echo ok
`;

function policy(contract) {
  return JSON.stringify({
    schemaVersion: 5,
    approvedReusableWorkflowContracts: {
      [KEY]: {
        routing: "runner-input",
        runnerInput: "runner",
        allowedInputs: ["runner", "label"],
        allowedSecrets: { APP_TOKEN: "secrets.APP_TOKEN" },
        approvedShas: [],
        ...contract,
      },
    },
  });
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

/** Commit `base`, then `head` on top, and run the check from the head. */
function check({ base, head, policyText = policy() }) {
  const root = makeTemporaryDirectory("surface-");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  const commit = (files, message) => {
    for (const [file, content] of Object.entries(files)) {
      if (content === null) fs.rmSync(path.join(root, file), { force: true });
      else write(root, file, content);
    }
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "--allow-empty", "-m", message]);
  };
  commit({ [POLICY_PATH]: policyText, ...base }, "base");
  git(root, ["branch", "base"]);
  commit(head, "head");
  const result = spawnSync(process.execPath, [SCRIPT, "base", REPOSITORY], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

const errors = (output) =>
  output.split("\n").filter((line) => line.startsWith("::error::"));

test("removing an input the contract still lists fails, naming it and the order", () => {
  const { status, output } = check({
    base: { [REUSABLE]: BASE_REUSABLE },
    head: {
      [REUSABLE]: BASE_REUSABLE.replace(
        "      label:\n        type: string\n        required: false\n",
        "",
      ),
    },
  });
  assert.equal(status, 1);
  const [error, ...rest] = errors(output);
  assert.deepEqual(rest, []);
  assert.match(error, /input 'label' was removed or renamed/u);
  assert.match(error, new RegExp(KEY.replaceAll(".", "\\."), "u"));
  assert.match(
    error,
    /remove 'label' from every caller, then from this path's contract/u,
  );
  assert.match(error, /Contract revision lockstep/u);
});

test("renaming an input the contract still lists fails on the old name", () => {
  const { status, output } = check({
    base: { [REUSABLE]: BASE_REUSABLE },
    head: { [REUSABLE]: BASE_REUSABLE.replace("      label:", "      tag:") },
  });
  assert.equal(status, 1);
  const found = errors(output);
  assert.equal(found.length, 1, output);
  assert.match(found[0], /input 'label' was removed or renamed/u);
});

test("renaming a contracted secret fails on the old name", () => {
  const { status, output } = check({
    base: { [REUSABLE]: BASE_REUSABLE },
    head: {
      [REUSABLE]: BASE_REUSABLE.replace(
        "      APP_TOKEN:\n        required: true",
        "      APP_KEY:\n        required: false",
      ),
    },
  });
  assert.equal(status, 1);
  const found = errors(output);
  assert.equal(found.length, 1, output);
  assert.match(found[0], /secret 'APP_TOKEN' was removed or renamed/u);
});

test("adding a required input the contract does not list fails, naming it and the order", () => {
  const { status, output } = check({
    base: { [REUSABLE]: BASE_REUSABLE },
    head: {
      [REUSABLE]: BASE_REUSABLE.replace(
        "    secrets:",
        "      mode:\n        type: string\n        required: true\n    secrets:",
      ),
    },
  });
  assert.equal(status, 1);
  const found = errors(output);
  assert.equal(found.length, 1, output);
  assert.match(found[0], /required input 'mode' was added/u);
  assert.match(found[0], /Expand first: add 'mode' to this path's contract/u);
});

test("adding a required input the contract already lists passes", () => {
  const { status, output } = check({
    policyText: policy({ allowedInputs: ["runner", "label", "mode"] }),
    base: { [REUSABLE]: BASE_REUSABLE },
    head: {
      [REUSABLE]: BASE_REUSABLE.replace(
        "    secrets:",
        "      mode:\n        type: string\n        required: true\n    secrets:",
      ),
    },
  });
  assert.equal(status, 0, output);
  assert.deepEqual(errors(output), []);
});

test("making a listed-nowhere optional input required fails", () => {
  const { status, output } = check({
    base: {
      [REUSABLE]: BASE_REUSABLE.replace(
        "    secrets:",
        "      mode:\n        type: string\n        required: false\n    secrets:",
      ),
    },
    head: {
      [REUSABLE]: BASE_REUSABLE.replace(
        "    secrets:",
        "      mode:\n        type: string\n        required: true\n    secrets:",
      ),
    },
  });
  assert.equal(status, 1);
  assert.match(errors(output)[0], /required input 'mode' was added/u);
});

test("adding optional inputs and secrets the contract does not list passes", () => {
  const { status, output } = check({
    base: { [REUSABLE]: BASE_REUSABLE },
    head: {
      [REUSABLE]: BASE_REUSABLE.replace(
        "    secrets:",
        "      mode:\n        type: string\n        required: false\n      depth:\n        type: number\n    secrets:",
      ).replace(
        "        required: true\n\njobs:",
        "        required: true\n      EXTRA_TOKEN:\n        required: false\n\njobs:",
      ),
    },
  });
  assert.equal(status, 0, output);
  assert.deepEqual(errors(output), []);
  assert.match(output, /Checked 1 changed workflow file\(s\)/u);
});

test("an unchanged reusable is skipped", () => {
  const { status, output } = check({
    base: { [REUSABLE]: BASE_REUSABLE, "README.md": "one\n" },
    head: { "README.md": "two\n" },
  });
  assert.equal(status, 0, output);
  assert.match(output, /Checked 0 changed workflow file\(s\)/u);
});

test("removing an input the contract does not list passes", () => {
  const { status, output } = check({
    policyText: policy({ allowedInputs: ["runner"] }),
    base: { [REUSABLE]: BASE_REUSABLE },
    head: {
      [REUSABLE]: BASE_REUSABLE.replace(
        "      label:\n        type: string\n        required: false\n",
        "",
      ),
    },
  });
  assert.equal(status, 0, output);
  assert.deepEqual(errors(output), []);
});

test("deleting a contracted reusable fails for each contracted entry", () => {
  const { status, output } = check({
    base: { [REUSABLE]: BASE_REUSABLE },
    head: { [REUSABLE]: null },
  });
  assert.equal(status, 1);
  assert.deepEqual(
    errors(output).map((line) => line.match(/(input|secret) '([^']+)'/u)[0]),
    ["input 'runner'", "input 'label'", "secret 'APP_TOKEN'"],
  );
});

test("a secret listed in any one of several secret maps still blocks its removal", () => {
  const { status, output } = check({
    policyText: policy({
      allowedSecrets: [{ APP_TOKEN: "secrets.APP_TOKEN" }, {}],
    }),
    base: { [REUSABLE]: BASE_REUSABLE },
    head: {
      [REUSABLE]: BASE_REUSABLE.replace(
        "    secrets:\n      APP_TOKEN:\n        required: true\n",
        "",
      ),
    },
  });
  assert.equal(status, 1);
  assert.match(errors(output)[0], /secret 'APP_TOKEN' was removed or renamed/u);
});

test("a new required secret must be in every secret map", () => {
  const head = BASE_REUSABLE.replace(
    "        required: true\n\njobs:",
    "        required: true\n      NEW_TOKEN:\n        required: true\n\njobs:",
  );
  const partial = check({
    policyText: policy({
      allowedSecrets: [
        { APP_TOKEN: "secrets.APP_TOKEN" },
        {
          APP_TOKEN: "secrets.APP_TOKEN",
          NEW_TOKEN: "secrets.NEW_TOKEN",
        },
      ],
    }),
    base: { [REUSABLE]: BASE_REUSABLE },
    head: { [REUSABLE]: head },
  });
  assert.equal(partial.status, 1);
  assert.match(
    errors(partial.output)[0],
    /required secret 'NEW_TOKEN' was added, but the synced runner-policy contract does not list it in every secret map/u,
  );
  const full = check({
    policyText: policy({
      allowedSecrets: {
        APP_TOKEN: "secrets.APP_TOKEN",
        NEW_TOKEN: "secrets.NEW_TOKEN",
      },
    }),
    base: { [REUSABLE]: BASE_REUSABLE },
    head: { [REUSABLE]: head },
  });
  assert.equal(full.status, 0, full.output);
});

test("unknown sibling fields in a contract entry are ignored", () => {
  const removed = BASE_REUSABLE.replace(
    "      label:\n        type: string\n        required: false\n",
    "",
  );
  const contract = {
    allowedSecretsUntil: "2026-12-31",
    allowedCallerPermissionsUntil: "2026-12-31",
    futureField: { anything: [1, 2] },
  };
  const blocked = check({
    policyText: policy(contract),
    base: { [REUSABLE]: BASE_REUSABLE },
    head: { [REUSABLE]: removed },
  });
  assert.equal(blocked.status, 1, blocked.output);
  assert.match(
    errors(blocked.output)[0],
    /input 'label' was removed or renamed/u,
  );
  const allowed = check({
    policyText: policy({ ...contract, allowedInputs: ["runner"] }),
    base: { [REUSABLE]: BASE_REUSABLE },
    head: { [REUSABLE]: removed },
  });
  assert.equal(allowed.status, 0, allowed.output);
});

test("a reusable with no contract entry is reported and passes", () => {
  const other = ".github/workflows/pr-uncontracted.yml";
  const { status, output } = check({
    base: { [other]: BASE_REUSABLE },
    head: { [other]: BASE_REUSABLE.replace("      label:", "      tag:") },
  });
  assert.equal(status, 0, output);
  assert.match(
    output,
    /::notice::.*pr-uncontracted\.yml: no runner-policy contract entry/u,
  );
});

test("a missing policy file fails with a named error", () => {
  const { status, output } = check({
    base: { [REUSABLE]: BASE_REUSABLE },
    head: { [POLICY_PATH]: null },
  });
  assert.equal(status, 1);
  assert.deepEqual(errors(output), [
    `::error::runner-policy contract missing: ${POLICY_PATH} does not exist. Restore ${POLICY_PATH} by reverting the change that removed or broke it, or let the standards component sync (runner-policy-contract) deliver it.`,
  ]);
});

test("an unparseable policy file fails with a named error", () => {
  const { status, output } = check({
    base: { [REUSABLE]: BASE_REUSABLE },
    head: { [POLICY_PATH]: "{ not json" },
  });
  assert.equal(status, 1);
  const found = errors(output);
  assert.equal(found.length, 1, output);
  assert.match(found[0], /^::error::runner-policy contract unparseable: /u);
});

test("a policy without approvedReusableWorkflowContracts fails with a named error", () => {
  const { status, output } = check({
    base: { [REUSABLE]: BASE_REUSABLE },
    head: { [POLICY_PATH]: JSON.stringify({ schemaVersion: 5 }) },
  });
  assert.equal(status, 1);
  assert.match(
    errors(output)[0],
    /has no approvedReusableWorkflowContracts object/u,
  );
});
