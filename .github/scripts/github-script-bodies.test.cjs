"use strict";

// actions/github-script compiles `with.script` as the body of an AsyncFunction
// whose parameters are the names below, so a top-level `const context` in a body
// is a SyntaxError at run time ("Identifier 'context' has already been
// declared"). No other test compiles the bodies the way github-script does; this
// one compiles every body in every workflow and local action.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
// The callAsyncFunction arguments in src/main.ts of the pinned
// actions/github-script (3a2844b7e9c422d3c10d287c895573f7108da1b3, v9.0.0);
// re-check them when the pin moves.
const PARAMETERS = [
  "require",
  "__original_require__",
  "github",
  "octokit",
  "getOctokit",
  "context",
  "core",
  "exec",
  "glob",
  "io",
];
const GITHUB_SCRIPT = /^actions\/github-script@/u;
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/gu;

const githubDir = path.join(__dirname, "..");
const repoRoot = path.join(githubDir, "..");

function yamlFiles(dir, nameFilter) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? [] : nameFilter(entry.name) ? [full] : [];
    })
    .sort();
}

function sourceFiles() {
  const actionsDir = path.join(githubDir, "actions");
  const actionFiles = fs.existsSync(actionsDir)
    ? fs
        .readdirSync(actionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) =>
          yamlFiles(path.join(actionsDir, entry.name), (name) =>
            /^action\.ya?ml$/u.test(name),
          ),
        )
        .sort()
    : [];
  return [
    ...yamlFiles(path.join(githubDir, "workflows"), (name) =>
      /\.ya?ml$/u.test(name),
    ),
    ...actionFiles,
  ];
}

function stepsOf(document) {
  const lists = Object.entries(document?.jobs ?? {}).map(([id, job]) => [
    `${id}: `,
    job?.steps,
  ]);
  lists.push(["", document?.runs?.steps]);
  return lists.flatMap(([prefix, steps]) =>
    Array.isArray(steps) ? steps.map((step) => ({ prefix, step })) : [],
  );
}

const cases = [];
for (const file of sourceFiles()) {
  const relative = path.relative(repoRoot, file).split(path.sep).join("/");
  let document;
  try {
    document = parseWorkflow(fs.readFileSync(file, "utf8"));
  } catch (error) {
    cases.push({ name: `${relative}: parses`, error });
    continue;
  }
  let position = 0;
  for (const { prefix, step } of stepsOf(document)) {
    position += 1;
    if (!GITHUB_SCRIPT.test(String(step?.uses ?? ""))) continue;
    cases.push({
      name: `${relative}: ${prefix}${step.name ?? `step ${position}`}`,
      body: step.with?.script,
    });
  }
}

test("the scan finds github-script steps", () => {
  assert.ok(
    cases.some((entry) => entry.body !== undefined),
    "no actions/github-script step found",
  );
});

test("a body redeclaring any injected name fails to compile", () => {
  for (const name of PARAMETERS) {
    assert.throws(
      () => new AsyncFunction(...PARAMETERS, `const ${name} = 1;`),
      SyntaxError,
      name,
    );
  }
});

for (const entry of cases) {
  test(`${entry.name} compiles as a github-script body`, () => {
    if (entry.error) throw entry.error;
    assert.equal(
      typeof entry.body,
      "string",
      "a github-script step needs a string with.script",
    );
    // The runner substitutes ${{ }} before the body reaches github-script.
    const body = entry.body.replace(EXPRESSION, "");
    assert.doesNotThrow(() => new AsyncFunction(...PARAMETERS, body));
  });
}
