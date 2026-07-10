"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const sourcePath = path.join(
  root,
  ".github",
  "scripts",
  "pulumi-version-drift.sh",
);
const workflowPath = path.join(
  root,
  ".github",
  "workflows",
  "pulumi-version-drift-check.yml",
);
const indentation = "          ";
const beginMarker = `${indentation}# BEGIN GENERATED: pulumi-version-drift.sh`;
const endMarker = `${indentation}# END GENERATED: pulumi-version-drift.sh`;

function normalizedFile(file) {
  return fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
}

function render(workflow, source) {
  const start = workflow.indexOf(beginMarker);
  const end = workflow.indexOf(endMarker);
  if (
    start < 0 ||
    end <= start ||
    workflow.indexOf(beginMarker, start + beginMarker.length) >= 0 ||
    workflow.indexOf(endMarker, end + endMarker.length) >= 0
  ) {
    throw new Error(
      "workflow must contain exactly one ordered generated block",
    );
  }

  const embedded = source
    .trimEnd()
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${indentation}${line}`))
    .join("\n");
  return `${workflow.slice(0, start)}${beginMarker}\n${embedded}\n${endMarker}${workflow.slice(end + endMarker.length)}`;
}

const workflow = normalizedFile(workflowPath);
const expected = render(workflow, normalizedFile(sourcePath));
if (process.argv.includes("--check")) {
  if (workflow !== expected) {
    throw new Error(
      "pulumi-version-drift-check.yml is stale; run render-pulumi-version-drift.cjs",
    );
  }
} else {
  fs.writeFileSync(workflowPath, expected, "utf8");
}
