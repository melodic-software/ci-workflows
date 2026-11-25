"use strict";

// The hosted code-review lane hands the review the criteria in effect the way
// pr-review-cli.yml does: build-review-criteria runs claude-code-plugins'
// org-standards.sh over one standards checkout, and both review attempts'
// prompts carry its REVIEW CRITERIA and ORG STANDARDS lines.
// pr-review-cli.test.cjs exercises compose.sh itself.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const root = path.join(__dirname, "..");
const workflow = parseWorkflow(
  fs.readFileSync(path.join(root, "workflows", "pr-review.yml"), "utf8"),
);
const steps = workflow.jobs.claude.steps;
const ids = steps.map((s) => s.id);
const step = (id) => {
  const found = steps.find((s) => s?.id === id);
  assert.ok(found, `${id} step not found`);
  return found;
};

test("the hosted lane clones claude-code-plugins' default-branch tip into the runner's temp directory, sparse to the criteria script", () => {
  const source = step("plugin-source");
  assert.equal(source.env.SOURCE, `\${{ runner.temp }}/claude-code-plugins`);
  assert.equal(source["continue-on-error"], true);
  const lines = source.run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bgit\b/u.test(line));
  assert.deepEqual(lines, [
    'git clone --quiet --depth=1 --filter=blob:none --sparse https://github.com/melodic-software/claude-code-plugins.git "$SOURCE"',
    'git -C "$SOURCE" sparse-checkout set plugins/review/scripts',
    'echo "Review criteria script from claude-code-plugins@$(git -C "$SOURCE" rev-parse HEAD)"',
  ]);
  assert.match(
    fs.readFileSync(
      path.join(root, "actions", "build-review-criteria", "compose.sh"),
      "utf8",
    ),
    /script="\$SOURCE\/plugins\/review\/scripts\/org-standards\.sh"/u,
    "compose.sh reads the script inside the sparse set",
  );
});

test("the hosted lane composes the criteria from one standards checkout before the review", () => {
  const standards = step("standards");
  assert.equal(standards.uses, "$/.github/actions/download-standards");
  assert.equal(standards["continue-on-error"], true);
  const criteria = step("criteria");
  assert.equal(criteria.uses, "$/.github/actions/build-review-criteria");
  assert.equal(criteria["continue-on-error"], true);
  assert.match(criteria.if, /steps\.plugin-source\.outcome == 'success'/u);
  assert.match(criteria.if, /steps\.standards\.outputs\.path != ''/u);
  assert.deepEqual(criteria.env, {
    SOURCE: `\${{ runner.temp }}/claude-code-plugins`,
    STANDARDS_DIR: `\${{ steps.standards.outputs.path }}`,
    STANDARDS_SHA: `\${{ steps.standards.outputs.sha }}`,
    CRITERIA_FILE: ".claude-lane/review-criteria.md",
    ORG_COPY: ".claude-lane/org",
  });
  assert.ok(
    ids.indexOf("plugin-source") < ids.indexOf("criteria") &&
      ids.indexOf("standards") < ids.indexOf("criteria") &&
      ids.indexOf("criteria") < ids.indexOf("claude-review"),
  );
});

test("both review attempts' prompts carry the REVIEW CRITERIA and ORG STANDARDS lines", () => {
  for (const id of ["claude-review", "claude-review-fallback"]) {
    const prompt = step(id).with.prompt;
    assert.match(
      prompt,
      /\$\{\{ steps\.pr-context\.outputs\.note \}\}\n\$\{\{ steps\.criteria\.outputs\.note \}\}\n\$\{\{ steps\.criteria\.outputs\.org-note \}\}\n/u,
      id,
    );
  }
});
