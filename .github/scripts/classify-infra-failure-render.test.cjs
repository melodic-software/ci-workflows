"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const consumers = ["claude-review.yml", "claude-security-review.yml"];

function workflowSource(name) {
  return fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", name),
    "utf8",
  );
}

test("both review reusables embed the classifier generated from one source", () => {
  const renderer = path.join(__dirname, "render-classify-infra-failure.cjs");
  const result = spawnSync(process.execPath, [renderer, "--check"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  for (const name of consumers) {
    assert.equal(
      workflowSource(name).match(
        /Source: \.github\/scripts\/classify-infra-failure\.sh/gu,
      )?.length,
      1,
      `${name} must embed the generated block exactly once`,
    );
  }
});

// The annotation is the surface a receiver polls through the check-run API, so
// the class term's shape is a contract, not a formatting choice.
test("each review job emits the class as a bare term in its infra-failure annotation", () => {
  for (const name of consumers) {
    assert.match(
      workflowSource(name),
      /^ {10}echo "::error::Claude (security )?review exited with: \$REVIEW_OUTCOME class=\$failure_class" \\$/mu,
      `${name} must carry the class as a bare class=<token> term`,
    );
  }
});

test("each marker-managed infra-status comment carries the class", () => {
  for (const name of consumers) {
    const source = workflowSource(name);
    assert.match(
      source,
      /^ {10}REVIEW_CLASS: \$\{\{ steps\.review-outcome\.outputs\.failure_class \}\}$/mu,
      `${name} must pass the class into the comment step`,
    );
    assert.match(
      source,
      /^ {14}`> - Failure class: \\`\$\{process\.env\.REVIEW_CLASS\}\\``,$/mu,
      `${name} must render the class as a comment field`,
    );
  }
});

// The whole point of the projection is that the two free-text fields are read
// inside the generated block and never emitted. A future edit that echoes
// either one, or projects it into the detail JSON, must fail here.
test("neither reusable emits the model-authored result or the raw error stacks", () => {
  for (const name of consumers) {
    const source = workflowSource(name);
    const emissions = [
      ...source.matchAll(/^ {10,}(echo .*|.*\$\{process\.env\..*)$/gmu),
    ].map((match) => match[0]);
    for (const line of emissions) {
      assert.doesNotMatch(
        line,
        /\$\{?(last\.)?(result|errors)\b/u,
        `${name} emits a free-text SDK field: ${line.trim()}`,
      );
    }
    assert.doesNotMatch(
      source,
      /^ {12,}result: \$last\.result,?$/mu,
      `${name} must not project the model-authored result field`,
    );
    assert.doesNotMatch(
      source,
      /^ {12,}errors: \$last\.errors,?$/mu,
      `${name} must not project the raw error stacks`,
    );
  }
});
