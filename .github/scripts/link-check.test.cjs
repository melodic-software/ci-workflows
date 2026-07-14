"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const workflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "link-check.yml"),
  "utf8",
);

test("link-check keeps one rolling issue and closes it after recovery", () => {
  const findIndex = workflow.indexOf("- name: Find existing tracking issue");
  const updateIndex = workflow.indexOf("- name: Open or update tracking issue");
  const closeIndex = workflow.indexOf("- name: Close recovered tracking issue");

  assert.ok(findIndex >= 0, "tracking issue lookup is missing");
  assert.ok(updateIndex > findIndex, "failure update must follow issue lookup");
  assert.ok(closeIndex > updateIndex, "recovery close must follow failure update");

  const findStep = workflow.slice(findIndex, updateIndex);
  assert.doesNotMatch(
    findStep,
    /\n\s+if:/u,
    "issue lookup must run on healthy checks so recovery can close the issue",
  );

  const updateStep = workflow.slice(updateIndex, closeIndex);
  assert.match(updateStep, /if: steps\.lychee\.outputs\.exit_code != '0'/u);
  assert.match(
    updateStep,
    /issue-number: \$\{\{ steps\.tracking\.outputs\.number \}\}/u,
  );

  const closeStep = workflow.slice(closeIndex);
  assert.match(
    closeStep,
    /if: steps\.lychee\.outputs\.exit_code == '0' && steps\.tracking\.outputs\.number != ''/u,
  );
  assert.match(
    closeStep,
    /NUMBER: \$\{\{ steps\.tracking\.outputs\.number \}\}/u,
  );
  assert.match(closeStep, /gh issue close "\$NUMBER"/u);
  assert.match(closeStep, /--reason completed/u);
});
