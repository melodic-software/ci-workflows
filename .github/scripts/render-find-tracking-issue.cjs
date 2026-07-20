"use strict";

const fs = require("node:fs");
const path = require("node:path");

const scriptsDirectory = __dirname;
const sourcePath = path.join(scriptsDirectory, "find-tracking-issue.sh");
const workflowsDirectory = path.join(scriptsDirectory, "..", "workflows");
const workflowFiles = [
  "queue-monitor-liveness.yml",
  "tool-version-drift-check.yml",
  "link-check.yml",
];
const startMarker =
  "          # BEGIN GENERATED FIND TRACKING ISSUE - DO NOT EDIT";
const endMarker = "          # END GENERATED FIND TRACKING ISSUE";

function bundledScript(source) {
  // The `shell=bash` directive is for standalone ShellCheck of the source file.
  // Inlined, it lands mid-run:-block after the per-site fetch, which ShellCheck
  // rejects (a directive must precede all commands); actionlint already supplies
  // the bash shell for embedded scripts, so drop it from the generated copy.
  const body = source
    .trimEnd()
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "# shellcheck shell=bash");
  while (body.length > 0 && body[0].trim() === "") {
    body.shift();
  }
  return [
    "# BEGIN GENERATED FIND TRACKING ISSUE - DO NOT EDIT",
    "# Source: .github/scripts/find-tracking-issue.sh",
    ...body,
    "# END GENERATED FIND TRACKING ISSUE",
  ]
    .map((line) => (line.length === 0 ? "" : `          ${line}`))
    .join("\n");
}

function render(workflow, source, name) {
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker);
  if (start < 0 || end < start) {
    throw new Error(`${name} is missing generated find-tracking-issue markers`);
  }
  return `${workflow.slice(0, start)}${bundledScript(source)}${workflow.slice(end + endMarker.length)}`;
}

const source = fs.readFileSync(sourcePath, "utf8");
const check = process.argv.includes("--check");
let drift = false;

for (const name of workflowFiles) {
  const workflowPath = path.join(workflowsDirectory, name);
  const current = fs.readFileSync(workflowPath, "utf8");
  const expected = render(current, source, name);
  if (check) {
    if (current !== expected) {
      process.stderr.write(
        `${name} is out of sync; run node .github/scripts/render-find-tracking-issue.cjs\n`,
      );
      drift = true;
    }
  } else {
    fs.writeFileSync(workflowPath, expected, "utf8");
  }
}

if (check && drift) {
  process.exitCode = 1;
}

module.exports = Object.freeze({ bundledScript, render });
