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

function lookupStepSlice() {
  const findIndex = workflow.indexOf("- name: Find existing tracking issue");
  const embedIndex = workflow.indexOf(
    "- name: Embed the marker in the lychee report",
  );
  assert.ok(findIndex >= 0 && embedIndex > findIndex);
  return workflow.slice(findIndex, embedIndex);
}

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
    /if: steps\.lychee\.outputs\.exit_code == '0' && steps\.tracking\.outputs\.issue-number != '' && inputs\.auto-close/u,
    "recovery close must be gated on the auto-close toggle",
  );
  assert.match(
    closeStep,
    /ISSUE_NUMBER: \$\{\{ steps\.tracking\.outputs\.issue-number \}\}/u,
  );
  assert.match(closeStep, /github\.rest\.issues\.createComment\(/u);
  assert.match(closeStep, /state: "closed"/u);
  assert.match(closeStep, /state_reason: "completed"/u);
});

test("the tracking marker is scoped per configured report", () => {
  const embedIndex = workflow.indexOf(
    "- name: Embed the marker in the lychee report",
  );
  const lookupStep = lookupStepSlice();
  assert.match(
    lookupStep,
    /ISSUE_TITLE: \$\{\{ inputs\.issue-title \}\}/u,
    "the marker must be derived from the caller-configured report title so " +
      "a caller invoking this reusable workflow more than once gets a " +
      "distinct marker per report",
  );
  assert.match(
    lookupStep,
    /createHash\("sha256"\)\.update\(issueTitle, "utf8"\)\.digest\("hex"\)\.slice\(0, 12\)/u,
  );
  assert.match(
    lookupStep,
    /`<!-- ci-workflows:link-check:v1:active:\$\{reportKey\} -->`/u,
  );
  assert.match(lookupStep, /core\.setOutput\("marker", marker\)/u);

  const embedStep = workflow.slice(embedIndex);
  assert.match(
    embedStep,
    /MARKER: \$\{\{ steps\.tracking\.outputs\.marker \}\}/u,
    "the report must be stamped with the same scoped marker the lookup " +
      "step computed, not a hardcoded constant",
  );
});

test("behavior-shaping inputs default to the established rolling-issue behavior", () => {
  const inputBlock = (name) => {
    const match = workflow.match(
      new RegExp(`\\n {6}${name}:\\n(?: {8}.*\\n)+`, "u"),
    );
    assert.ok(match, `workflow_call input '${name}' is missing`);
    return match[0];
  };

  assert.match(inputBlock("issue-title"), /default: 'Link checker report'/u);
  assert.match(
    inputBlock("issue-labels"),
    /default: 'automated, link-check'/u,
    "existing callers must keep the historical label set",
  );
  assert.match(
    inputBlock("issue-type"),
    /default: ''/u,
    "existing callers must keep their rolling issue untyped",
  );
  const autoClose = inputBlock("auto-close");
  assert.match(autoClose, /type: boolean/u);
  assert.match(
    autoClose,
    /default: true/u,
    "existing callers must keep close-on-recovery",
  );
});

test("the tracking lookup filters on the same labels the update step applies", () => {
  const lookupStep = lookupStepSlice();

  assert.match(
    lookupStep,
    /ISSUE_LABELS: \$\{\{ inputs\.issue-labels \}\}/u,
    "the lookup must derive its label filter from the caller-configured set",
  );
  assert.match(
    lookupStep,
    /\.split\(\/\[,\\n\]\/\)/u,
    "labels must split on the same comma/newline separators the bash " +
      "resolver used",
  );
  assert.match(
    lookupStep,
    /if \(labels\.length === 0\) \{[\s\S]*?core\.setFailed\(/u,
    "an empty label set must fail closed, not silently drop the " +
      "owned-report constraint",
  );
  assert.match(
    lookupStep,
    /labels: labels\.join\(","\)/u,
    "the issues query must filter on the caller-configured labels",
  );

  const updateIndex = workflow.indexOf("- name: Open or update tracking issue");
  const typeIndex = workflow.indexOf("- name: Assert native issue type");
  assert.ok(updateIndex >= 0 && typeIndex > updateIndex);
  const updateStep = workflow.slice(updateIndex, typeIndex);
  assert.match(
    updateStep,
    /labels: \$\{\{ inputs\.issue-labels \}\}/u,
    "the update step must apply exactly the configured label set",
  );
});

test("the native issue type is asserted from input, after create or update", () => {
  const updateIndex = workflow.indexOf("- name: Open or update tracking issue");
  const typeIndex = workflow.indexOf("- name: Assert native issue type");
  const closeIndex = workflow.indexOf("- name: Close recovered tracking issue");
  assert.ok(
    typeIndex > updateIndex,
    "type assertion must follow the create/update step whose issue number " +
      "it targets",
  );
  assert.ok(closeIndex > typeIndex);

  const typeStep = workflow.slice(typeIndex, closeIndex);
  assert.match(
    typeStep,
    /if: steps\.lychee\.outputs\.exit_code != '0' && inputs\.issue-type != ''/u,
    "an empty issue-type must skip type assignment (the pre-input behavior)",
  );
  assert.match(
    typeStep,
    /ISSUE_NUMBER: \$\{\{ steps\.issue\.outputs\.issue-number \}\}/u,
  );
  assert.match(
    typeStep,
    /github\.request\("PATCH \/repos\/\{owner\}\/\{repo\}\/issues\/\{issue_number\}", \{/u,
  );
  assert.match(typeStep, /type: process\.env\.ISSUE_TYPE/u);
});

test("the tracking lookup and its two consumers run on github-script, not the gh CLI", () => {
  for (const name of [
    "Find existing tracking issue",
    "Assert native issue type",
    "Close recovered tracking issue",
  ]) {
    const stepIndex = workflow.indexOf(`- name: ${name}`);
    assert.ok(stepIndex >= 0, `step '${name}' is missing`);
    const nextStepOffset = workflow
      .slice(stepIndex + 1)
      .search(/\n\s*(?:#[^\n]*\n\s*)*- name:/u);
    const step =
      nextStepOffset >= 0
        ? workflow.slice(stepIndex, stepIndex + 1 + nextStepOffset)
        : workflow.slice(stepIndex);
    assert.match(
      step,
      /uses: actions\/github-script@/u,
      `'${name}' must run on github-script, not shell out to the gh CLI`,
    );
    // Scoped to the executable script, not the whole step: surrounding
    // explanatory comments may name the gh CLI in prose without invoking it.
    const scriptBody = step.slice(step.indexOf("script: |"));
    assert.doesNotMatch(
      scriptBody,
      /\bgh (api|issue|pr)\b/u,
      `'${name}' must not shell out to the gh CLI`,
    );
  }
});
