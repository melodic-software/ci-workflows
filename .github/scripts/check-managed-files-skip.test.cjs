"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const action = fs.readFileSync(
  path.join(__dirname, "..", "actions", "check-managed-files", "action.yml"),
  "utf8",
);

const modeScript = (() => {
  const step = action
    .split(/^ {4}- name: /mu)
    .find((s) => /^ {6}id: mode$/mu.test(s));
  assert.ok(step, "mode step not found");
  const body = step.split(/^ {6}run: \|\n/mu)[1];
  return body
    .split("\n")
    .filter((line) => line === "" || line.startsWith("        "))
    .map((line) => line.slice(8))
    .join("\n");
})();

const SYNC_PR = {
  PR_ACTOR: "melodic-standards-sync[bot]",
  PR_AUTHOR: "melodic-standards-sync[bot]",
  PR_HEAD_REF: "chore/standards-sync",
  PR_HEAD_REPO: "melodic-software/claude-code-plugins",
  PR_BASE_REPO: "melodic-software/claude-code-plugins",
};

function mode(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-files-mode-"));
  const output = path.join(dir, "out");
  try {
    execFileSync("bash", ["-c", modeScript], {
      env: { ...process.env, ...SYNC_PR, ...overrides, GITHUB_OUTPUT: output },
      stdio: "pipe",
    });
    return fs.readFileSync(output, "utf8").trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a PR meeting all three sync conditions is verified, not skipped", () => {
  assert.equal(mode({}), "mode=sync");
});

test("a sync-App PR from another branch gets the hand-edit check", () => {
  assert.equal(mode({ PR_HEAD_REF: "chore/other" }), "mode=hand-edit");
});

test("a sync-App PR from a fork gets the hand-edit check", () => {
  assert.equal(
    mode({ PR_HEAD_REPO: "someone/claude-code-plugins" }),
    "mode=hand-edit",
  );
});

test("a missing head repository never counts as same-repo", () => {
  assert.equal(mode({ PR_HEAD_REPO: "", PR_BASE_REPO: "" }), "mode=hand-edit");
});

test("the sync branch opened by anyone else gets the hand-edit check", () => {
  assert.equal(
    mode({ PR_ACTOR: "some-contributor", PR_AUTHOR: "some-contributor" }),
    "mode=hand-edit",
  );
});

test("a user login matching the App name without [bot] is not sync", () => {
  assert.equal(
    mode({
      PR_ACTOR: "melodic-standards-sync",
      PR_AUTHOR: "melodic-standards-sync",
    }),
    "mode=hand-edit",
  );
});

test("a non-PR run whose actor is the sync App is not sync", () => {
  assert.equal(
    mode({
      PR_AUTHOR: "",
      PR_HEAD_REF: "",
      PR_HEAD_REPO: "",
      PR_BASE_REPO: "",
    }),
    "mode=hand-edit",
  );
});

test("dependabot PRs stay exempt", () => {
  assert.equal(
    mode({ PR_ACTOR: "dependabot[bot]", PR_AUTHOR: "dependabot[bot]" }),
    "mode=skip",
  );
});

test("a user login named dependabot without [bot] is not exempt", () => {
  assert.equal(
    mode({ PR_ACTOR: "dependabot", PR_AUTHOR: "dependabot" }),
    "mode=hand-edit",
  );
});

test("verification steps run only in sync mode and no step skips it", () => {
  const steps = action.split(/^ {4}- name: /mu).slice(1);
  const gate = (name) =>
    steps.find((s) => s.startsWith(name))?.match(/^ {6}if: (.*)$/mu)?.[1];
  assert.equal(
    gate("Verify sync PR commits"),
    "steps.mode.outputs.mode == 'sync'",
  );
  assert.equal(
    gate("Verify sync PR content against standards"),
    "steps.mode.outputs.mode == 'sync'",
  );
  assert.equal(
    gate("Reject hand-edits of managed files"),
    "steps.mode.outputs.mode == 'hand-edit'",
  );
});
