"use strict";

const fs = require("node:fs");
const path = require("node:path");

const scriptsDirectory = __dirname;
const sourcePath = path.join(scriptsDirectory, "select-runner.cjs");
const workflowPath = path.join(
  scriptsDirectory,
  "..",
  "workflows",
  "select-runner.yml",
);
const startMarker = "            // BEGIN GENERATED SELECTOR - DO NOT EDIT";
const endMarker = "            // END GENERATED SELECTOR";

function bundledScript(source) {
  const sourceLines = source.trimEnd().split(/\r?\n/u);
  if (sourceLines[0] === '"use strict";') {
    sourceLines.shift();
  }
  return [
    "// BEGIN GENERATED SELECTOR - DO NOT EDIT",
    "// Source: .github/scripts/select-runner.cjs",
    "const selectorModule = (() => {",
    '  "use strict";',
    "  const module = {exports: {}};",
    ...sourceLines.map((line) => (line === "" ? "" : `  ${line}`)),
    "  return module.exports;",
    "})();",
    "await selectorModule.runGitHubScript({github, core, env: process.env});",
    "// END GENERATED SELECTOR",
  ]
    .map((line) => (line === "" ? "" : `            ${line}`))
    .join("\n");
}

function render(workflow, source) {
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker);
  if (start < 0 || end < start) {
    throw new Error(
      "select-runner.yml does not contain the generated-selector markers",
    );
  }
  const afterEnd = end + endMarker.length;
  return `${workflow.slice(0, start)}${bundledScript(source)}${workflow.slice(afterEnd)}`;
}

const current = fs.readFileSync(workflowPath, "utf8");
const source = fs.readFileSync(sourcePath, "utf8");
const expected = render(current, source);

if (process.argv.includes("--check")) {
  if (current !== expected) {
    process.stderr.write(
      "select-runner.yml is out of sync; run node .github/scripts/render-select-runner-workflow.cjs\n",
    );
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(workflowPath, expected, "utf8");
}

module.exports = Object.freeze({ bundledScript, render });
