"use strict";

const fs = require("node:fs");
const path = require("node:path");

const scriptsDirectory = __dirname;
const sourcePath = path.join(scriptsDirectory, "osv-scan-guard.sh");
const workflowPath = path.join(
  scriptsDirectory,
  "..",
  "workflows",
  "osv-scanner.yml",
);
const generatedBlocks = ["SCAN", "SARIF"];

function markers(block) {
  return {
    start: `          # BEGIN GENERATED OSV ${block} GUARD - DO NOT EDIT`,
    end: `          # END GENERATED OSV ${block} GUARD`,
  };
}

function bundledScript(source, block) {
  return [
    `# BEGIN GENERATED OSV ${block} GUARD - DO NOT EDIT`,
    "# Source: .github/scripts/osv-scan-guard.sh",
    ...source.trimEnd().split(/\r?\n/u),
    `# END GENERATED OSV ${block} GUARD`,
  ]
    .map((line) => (line.length === 0 ? "" : `          ${line}`))
    .join("\n");
}

function render(workflow, source) {
  return generatedBlocks.reduce((rendered, block) => {
    const { start: startMarker, end: endMarker } = markers(block);
    const start = rendered.indexOf(startMarker);
    const end = rendered.indexOf(endMarker);
    if (start < 0 || end < start) {
      throw new Error(
        `osv-scanner.yml does not contain the generated ${block} guard markers`,
      );
    }
    const afterEnd = end + endMarker.length;
    return `${rendered.slice(0, start)}${bundledScript(source, block)}${rendered.slice(afterEnd)}`;
  }, workflow);
}

const current = fs.readFileSync(workflowPath, "utf8");
const source = fs.readFileSync(sourcePath, "utf8");
const expected = render(current, source);

if (process.argv.includes("--check")) {
  if (current !== expected) {
    process.stderr.write(
      "osv-scanner.yml is out of sync; run node .github/scripts/render-osv-scan-guard.cjs\n",
    );
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(workflowPath, expected, "utf8");
}

module.exports = Object.freeze({ bundledScript, render });
