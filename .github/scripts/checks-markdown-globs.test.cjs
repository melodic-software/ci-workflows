"use strict";

// `checks.yml` forwards markdownlint globs. Passing `globs` replaces the
// composite default, so the workflow repeats that default and appends
// `markdown-extra-globs`. The expression is the GitHub `case`/`format` pair
// pinned below; the arguments markdownlint-cli2 actually receives are that
// string after the composite's `read -a` word-split, which this file executes.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const repoRoot = path.join(__dirname, "..", "..");

function readRepo(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const checks = parseWorkflow(readRepo(".github/workflows/checks.yml"));
const markdownAction = parseWorkflow(
  readRepo(".github/actions/markdown/action.yml"),
);
const markdownStep = checks.jobs.checks.steps.find(
  (step) => step?.id === "markdown",
);
const extraGlobs = checks.on.workflow_call.inputs["markdown-extra-globs"];
const lintStep = markdownAction.runs.steps.find((step) =>
  String(step?.run ?? "").includes("read -r -d '' -a globs"),
);

// Pinned in this file so neither side can change alone. The workflow literal
// and the composite `globs` default are the same string.
const BASE_GLOB = "**/*.md";
const DOTFILES_EXTRA = [
  "dot_claude/CLAUDE.md.tmpl",
  "dot_codex/AGENTS.md.tmpl",
  ".chezmoitemplates/agent-instructions-shared",
].join(" ");

assert.ok(markdownStep !== undefined, "checks.yml has no markdown step");
assert.ok(lintStep !== undefined, "markdown composite has no glob split");

function forwardedGlobs(extra) {
  // case(inputs.markdown-extra-globs == '', BASE, format('BASE {0}', extra))
  return extra === "" ? BASE_GLOB : `${BASE_GLOB} ${extra}`;
}

function wordSplit(value) {
  const readLine = /^read -r -d '' -a globs <<<"\$GLOBS" \|\| true$/mu.exec(
    lintStep.run,
  );
  assert.ok(readLine, "the composite no longer word-splits globs with read -a");
  const script = [
    "set -euo pipefail",
    "globs=()",
    readLine[0],
    "printf '%s\\n' \"" + "$" + '{globs[@]}"',
    "",
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, GLOBS: value },
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  if (result.stdout === "") return [];
  return result.stdout.replace(/\n$/u, "").split("\n");
}

test("markdown-extra-globs is an optional string and defaults empty", () => {
  assert.ok(extraGlobs, "checks.yml has no markdown-extra-globs input");
  assert.equal(extraGlobs.type, "string");
  assert.equal(extraGlobs.default, "");
  // Omitted `required` is optional. workflow_call inputs are required only
  // when `required: true` (GitHub's reusable-workflow inputs).
  assert.notEqual(extraGlobs.required, true);
  assert.match(extraGlobs.description, /Space-separated/u);
  assert.match(extraGlobs.description, /read -a/u);
});

test("the markdown step forwards globs and repeats the composite default", () => {
  assert.equal(markdownAction.inputs.globs.default, BASE_GLOB);
  assert.equal(
    markdownStep.with.globs,
    `\${{ case(inputs.markdown-extra-globs == '', '${BASE_GLOB}', format('${BASE_GLOB} {0}', inputs.markdown-extra-globs)) }}`,
  );
});

test("an empty extra value resolves to the composite default only", () => {
  const forwarded = forwardedGlobs("");
  assert.equal(forwarded, BASE_GLOB);
  assert.deepEqual(wordSplit(forwarded), [BASE_GLOB]);
});

test("dotfiles template paths are appended after the composite default", () => {
  const forwarded = forwardedGlobs(DOTFILES_EXTRA);
  assert.equal(forwarded, `${BASE_GLOB} ${DOTFILES_EXTRA}`);
  assert.deepEqual(wordSplit(forwarded), [
    BASE_GLOB,
    ...DOTFILES_EXTRA.split(" "),
  ]);
  const readme = readRepo("README.md");
  assert.match(
    readme,
    new RegExp(
      `markdown-extra-globs: ${DOTFILES_EXTRA.replaceAll(".", "\\.")}`,
      "u",
    ),
  );
});
