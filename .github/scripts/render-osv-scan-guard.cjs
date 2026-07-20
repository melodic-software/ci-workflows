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
const startMarker = "          # BEGIN GENERATED OSV SCAN GUARD - DO NOT EDIT";
const endMarker = "          # END GENERATED OSV SCAN GUARD";

function bundledScript(source) {
  return [
    "# BEGIN GENERATED OSV SCAN GUARD - DO NOT EDIT",
    "# Source: .github/scripts/osv-scan-guard.sh",
    ...source.trimEnd().split(/\r?\n/u),
    "# END GENERATED OSV SCAN GUARD",
  ]
    .map((line) => (line.length === 0 ? "" : `          ${line}`))
    .join("\n");
}

function render(workflow, source) {
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker);
  if (start < 0 || end < start) {
    throw new Error("osv-scanner.yml is missing generated guard markers");
  }
  return `${workflow.slice(0, start)}${bundledScript(source)}${workflow.slice(end + endMarker.length)}`;
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
