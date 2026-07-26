"use strict";

const fs = require("node:fs");
const path = require("node:path");

const scriptsDirectory = __dirname;
const sourcePath = path.join(scriptsDirectory, "classify-infra-failure.sh");
const workflowsDirectory = path.join(scriptsDirectory, "..", "workflows");
// Both review reusables share the infra-failure surfacing shape, and both run
// on a caller-selected runner over the CALLER's checkout — this repo's scripts
// directory is not on disk there, so the source is embedded rather than called.
const workflowFiles = ["claude-review.yml", "claude-security-review.yml"];
const startMarker =
  "          # BEGIN GENERATED CLASSIFY INFRA FAILURE - DO NOT EDIT";
const endMarker = "          # END GENERATED CLASSIFY INFRA FAILURE";

function bundledScript(source) {
  // The `shell=bash` directive is for standalone ShellCheck of the source file.
  // Inlined, it lands mid-run:-block, which ShellCheck rejects (a directive
  // must precede all commands); actionlint already supplies the bash shell for
  // embedded scripts, so drop it from the generated copy.
  const body = source
    .trimEnd()
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "# shellcheck shell=bash");
  while (body.length > 0 && body[0].trim() === "") {
    body.shift();
  }
  return [
    "# BEGIN GENERATED CLASSIFY INFRA FAILURE - DO NOT EDIT",
    "# Source: .github/scripts/classify-infra-failure.sh",
    ...body,
    "# END GENERATED CLASSIFY INFRA FAILURE",
  ]
    .map((line) => (line.length === 0 ? "" : `          ${line}`))
    .join("\n");
}

function render(workflow, source, name) {
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker);
  if (start < 0 || end < start) {
    throw new Error(
      `${name} is missing generated classify-infra-failure markers`,
    );
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
        `${name} is out of sync; run node .github/scripts/render-classify-infra-failure.cjs\n`,
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
