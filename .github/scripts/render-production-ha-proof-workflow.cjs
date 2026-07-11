"use strict";

const fs = require("node:fs");
const path = require("node:path");

const scriptsDirectory = __dirname;
const sourcePath = path.join(scriptsDirectory, "production-ha-proof.cjs");
const workflowPath = path.join(
  scriptsDirectory,
  "..",
  "workflows",
  "production-ha-proof.yml",
);
const generatedBlocks = Object.freeze([
  Object.freeze({
    start:
      "            // BEGIN GENERATED PRODUCTION HA INVENTORY - DO NOT EDIT",
    end: "            // END GENERATED PRODUCTION HA INVENTORY",
  }),
  Object.freeze({
    start:
      "            // BEGIN GENERATED PRODUCTION HA DRAIN HOLD - DO NOT EDIT",
    end: "            // END GENERATED PRODUCTION HA DRAIN HOLD",
  }),
]);

function bundledScript(source, block) {
  const sourceLines = source.trimEnd().split(/\r?\n/u);
  if (sourceLines[0] === '"use strict";') {
    sourceLines.shift();
  }
  return [
    block.start.trim(),
    "// Source: .github/scripts/production-ha-proof.cjs",
    "const productionHaModule = (() => {",
    '  "use strict";',
    "  const module = {exports: {}};",
    ...sourceLines.map((line) => (line === "" ? "" : `  ${line}`)),
    "  return module.exports;",
    "})();",
    "await productionHaModule.runGitHubScript({github, core, env: process.env});",
    block.end.trim(),
  ]
    .map((line) => (line === "" ? "" : `            ${line}`))
    .join("\n");
}

function render(workflow, source) {
  let rendered = workflow;
  for (const block of generatedBlocks) {
    const start = rendered.indexOf(block.start);
    const end = rendered.indexOf(block.end);
    if (start < 0 || end < start) {
      throw new Error(
        "production-ha-proof.yml does not contain every generated block marker",
      );
    }
    const afterEnd = end + block.end.length;
    rendered = `${rendered.slice(0, start)}${bundledScript(source, block)}${rendered.slice(afterEnd)}`;
  }
  return rendered;
}

const current = fs.readFileSync(workflowPath, "utf8");
const source = fs.readFileSync(sourcePath, "utf8");
const expected = render(current, source);

if (process.argv.includes("--check")) {
  if (current !== expected) {
    process.stderr.write(
      "production-ha-proof.yml is out of sync; run node .github/scripts/render-production-ha-proof-workflow.cjs\n",
    );
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(workflowPath, expected, "utf8");
}

module.exports = Object.freeze({ bundledScript, render });
