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

const skipScript = (() => {
  const step = action
    .split(/^ {4}- name: /mu)
    .find((s) => /^ {6}id: skip$/mu.test(s));
  assert.ok(step, "skip step not found");
  const body = step.split(/^ {6}run: \|\n/mu)[1];
  return body
    .split("\n")
    .filter((line) => line === "" || line.startsWith("        "))
    .map((line) => line.slice(8))
    .join("\n");
})();

function skips(actor, labels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-files-skip-"));
  const output = path.join(dir, "out");
  try {
    execFileSync("bash", ["-c", skipScript], {
      env: {
        ...process.env,
        PR_ACTOR: actor,
        PR_LABELS: labels,
        GITHUB_OUTPUT: output,
      },
      stdio: "pipe",
    });
    return fs.readFileSync(output, "utf8").trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("sync App PR carrying the standards-sync label is exempt", () => {
  assert.equal(
    skips("melodic-standards-sync[bot]", "chore,standards-sync"),
    "skip=true",
  );
});

test("standards-sync label on a PR by anyone else does not exempt it", () => {
  assert.equal(skips("some-contributor", "standards-sync"), "skip=false");
});

test("sync App PR without the label is not exempt", () => {
  assert.equal(skips("melodic-standards-sync[bot]", "chore"), "skip=false");
});

test("a user login matching the App name without [bot] is not exempt", () => {
  assert.equal(skips("melodic-standards-sync", "standards-sync"), "skip=false");
});

test("label matching is exact, not a substring", () => {
  assert.equal(
    skips("melodic-standards-sync[bot]", "standards-sync-extra"),
    "skip=false",
  );
});

test("dependabot PRs stay exempt without a label", () => {
  assert.equal(skips("dependabot[bot]", ""), "skip=true");
});
