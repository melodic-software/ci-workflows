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
  assert.ok(
    closeIndex > updateIndex,
    "recovery close must follow failure update",
  );

  const lookupStep = workflow.slice(
    findIndex,
    findIndex + workflow.slice(findIndex).indexOf("\n      - name:"),
  );
  assert.doesNotMatch(
    lookupStep,
    /\n\s+if:/u,
    "issue lookup must run on healthy checks so recovery can close the issue",
  );

  const updateStep = workflow.slice(updateIndex, closeIndex);
  assert.match(updateStep, /if: steps\.lychee\.outputs\.exit_code != '0'/u);
  assert.match(
    updateStep,
    /issue-number: \$\{\{ steps\.tracking\.outputs\.issue-number \}\}/u,
  );

  const closeStep = workflow.slice(closeIndex);
  assert.match(
    closeStep,
    /if: steps\.lychee\.outputs\.exit_code == '0' && steps\.tracking\.outputs\.issue-number != ''/u,
  );
  assert.match(
    closeStep,
    /NUMBER: \$\{\{ steps\.tracking\.outputs\.issue-number \}\}/u,
  );
  assert.match(closeStep, /gh issue close "\$NUMBER"/u);
  assert.match(closeStep, /--reason completed/u);
});

test("the tracking marker is scoped per configured report", () => {
  const findIndex = workflow.indexOf("- name: Find existing tracking issue");
  const embedIndex = workflow.indexOf(
    "- name: Embed the marker in the lychee report",
  );
  assert.ok(findIndex >= 0 && embedIndex > findIndex);

  const lookupStep = workflow.slice(findIndex, embedIndex);
  assert.match(
    lookupStep,
    /ISSUE_TITLE: \$\{\{ inputs\.issue-title \}\}/u,
    "the marker must be derived from the caller-configured report title so " +
      "a caller invoking this reusable workflow more than once gets a " +
      "distinct marker per report",
  );
  assert.match(
    lookupStep,
    /report_key="\$\(printf '%s' "\$ISSUE_TITLE" \| sha256sum \| cut -c1-12\)"/u,
  );
  assert.match(
    lookupStep,
    /marker="<!-- ci-workflows:link-check:v1:active:\$\{report_key\} -->"/u,
  );
  assert.match(lookupStep, /echo "marker=\$\{marker\}" >> "\$GITHUB_OUTPUT"/u);

  const embedStep = workflow.slice(embedIndex);
  assert.match(
    embedStep,
    /MARKER: \$\{\{ steps\.tracking\.outputs\.marker \}\}/u,
    "the report must be stamped with the same scoped marker the lookup " +
      "step computed, not a hardcoded constant",
  );
});
