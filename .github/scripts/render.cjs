"use strict";

/**
 * Data-driven render entrypoint for workflow codegen (#200 / 1c).
 *
 * Manifest entries declare {source, workflows, markers} plus a small bundle
 * strategy for target-specific transforms (shell source header, shellcheck
 * directive strip, github-script IIFE wrap). Shared splice/check mechanics
 * live in render-compose.cjs.
 *
 * Usage:
 *   node .github/scripts/render.cjs [--check]                 # all targets
 *   node .github/scripts/render.cjs <target-id> [--check]     # one target
 *   node .github/scripts/render-<target>.cjs [--check]        # thin wrappers
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  indentLines,
  normalizeNewlines,
  renderWorkflow,
  runRenderPass,
} = require("./render-compose.cjs");

const scriptsDirectory = __dirname;
const workflowsDirectory = path.join(scriptsDirectory, "..", "workflows");

function shellLines(source) {
  return normalizeNewlines(source).trimEnd().split("\n");
}

function bundleShellWithSourceHeader({
  beginBare,
  endBare,
  sourceComment,
  indentation,
  prepareLines = shellLines,
}) {
  return (source) =>
    indentLines(
      [beginBare, sourceComment, ...prepareLines(source), endBare],
      indentation,
    ).join("\n");
}

function prepareFindTrackingLines(source) {
  // The `shell=bash` directive is for standalone ShellCheck of the source
  // file. Inlined, it lands mid-run:-block after the per-site fetch, which
  // ShellCheck rejects (a directive must precede all commands); actionlint
  // already supplies the bash shell for embedded scripts, so drop it from
  // the generated copy.
  const body = shellLines(source).filter(
    (line) => line.trim() !== "# shellcheck shell=bash",
  );
  while (body.length > 0 && body[0].trim() === "") {
    body.shift();
  }
  return body;
}

function bundleSelectRunner(source) {
  const indentation = "            ";
  const sourceLines = shellLines(source);
  if (sourceLines[0] === '"use strict";') {
    sourceLines.shift();
  }
  return indentLines(
    [
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
    ],
    indentation,
  ).join("\n");
}

/**
 * @typedef {object} RenderTarget
 * @property {string} id
 * @property {string} source relative to .github/scripts
 * @property {string[]} workflows basename list under .github/workflows
 * @property {string} beginMarker fully-indented begin marker in the workflow
 * @property {string} endMarker fully-indented end marker in the workflow
 * @property {(source: string) => string} bundle
 * @property {(workflowName: string) => string} driftMessage
 */

/** @type {Record<string, RenderTarget>} */
const TARGETS = Object.freeze({
  "osv-scan-guard": Object.freeze({
    id: "osv-scan-guard",
    source: "osv-scan-guard.sh",
    workflows: Object.freeze(["osv-scanner.yml"]),
    beginMarker: "          # BEGIN GENERATED OSV SCAN GUARD - DO NOT EDIT",
    endMarker: "          # END GENERATED OSV SCAN GUARD",
    bundle: bundleShellWithSourceHeader({
      beginBare: "# BEGIN GENERATED OSV SCAN GUARD - DO NOT EDIT",
      endBare: "# END GENERATED OSV SCAN GUARD",
      sourceComment: "# Source: .github/scripts/osv-scan-guard.sh",
      indentation: "          ",
    }),
    driftMessage: () =>
      "osv-scanner.yml is out of sync; run node .github/scripts/render-osv-scan-guard.cjs\n",
  }),
  "find-tracking-issue": Object.freeze({
    id: "find-tracking-issue",
    source: "find-tracking-issue.sh",
    // link-check.yml is not a consumer: it runs on a caller-selected runner
    // and was ported to actions/github-script instead of embedding this
    // gh/jq-driven source. Only fixed-hosted-runner consumers stay here.
    workflows: Object.freeze([
      "queue-monitor-liveness.yml",
      "release-gap-check.yml",
      "release-tag-drift-check.yml",
      "tool-version-drift-check.yml",
    ]),
    beginMarker:
      "          # BEGIN GENERATED FIND TRACKING ISSUE - DO NOT EDIT",
    endMarker: "          # END GENERATED FIND TRACKING ISSUE",
    bundle: bundleShellWithSourceHeader({
      beginBare: "# BEGIN GENERATED FIND TRACKING ISSUE - DO NOT EDIT",
      endBare: "# END GENERATED FIND TRACKING ISSUE",
      sourceComment: "# Source: .github/scripts/find-tracking-issue.sh",
      indentation: "          ",
      prepareLines: prepareFindTrackingLines,
    }),
    driftMessage: (workflowName) =>
      `${workflowName} is out of sync; run node .github/scripts/render-find-tracking-issue.cjs\n`,
  }),
  "select-runner-workflow": Object.freeze({
    id: "select-runner-workflow",
    source: "select-runner.cjs",
    workflows: Object.freeze(["select-runner.yml"]),
    beginMarker: "            // BEGIN GENERATED SELECTOR - DO NOT EDIT",
    endMarker: "            // END GENERATED SELECTOR",
    bundle: bundleSelectRunner,
    driftMessage: () =>
      "select-runner.yml is out of sync; run node .github/scripts/render-select-runner-workflow.cjs\n",
  }),
});

function requireTarget(id) {
  const target = TARGETS[id];
  if (!target) {
    const known = Object.keys(TARGETS).sort().join(", ");
    throw new Error(`unknown render target '${id}' (known: ${known})`);
  }
  return target;
}

function bundledScript(id, source) {
  return requireTarget(id).bundle(source);
}

function render(id, workflow, source, name) {
  const target = requireTarget(id);
  return renderWorkflow({
    workflow,
    source,
    beginMarker: target.beginMarker,
    endMarker: target.endMarker,
    bundle: target.bundle,
    name: name ?? target.workflows[0],
  });
}

function filesForTarget(id) {
  const target = requireTarget(id);
  const sourcePath = path.join(scriptsDirectory, target.source);
  // Source is normalized inside each bundle strategy when splitting lines.
  // Workflows are read/written as raw bytes so --check stays byte-identical
  // to the historical render-*.cjs behavior (no whole-file CRLF rewrite).
  const source = fs.readFileSync(sourcePath, "utf8");
  return target.workflows.map((workflowName) => {
    const filePath = path.join(workflowsDirectory, workflowName);
    const current = fs.readFileSync(filePath, "utf8");
    const expected = render(id, current, source, workflowName);
    return {
      filePath,
      current,
      expected,
      driftMessage: target.driftMessage(workflowName),
    };
  });
}

function runTarget(id, argv = process.argv) {
  const check = argv.includes("--check");
  const code = runRenderPass({ check, files: filesForTarget(id) });
  if (code !== 0) {
    process.exitCode = code;
  }
  return code;
}

function runAll(argv = process.argv) {
  const check = argv.includes("--check");
  const files = Object.keys(TARGETS).flatMap((id) => filesForTarget(id));
  const code = runRenderPass({ check, files });
  if (code !== 0) {
    process.exitCode = code;
  }
  return code;
}

/**
 * Thin-wrapper entry: run one target's CLI (always, matching historical
 * render-*.cjs top-level behavior).
 */
function cli(id, argv = process.argv) {
  return runTarget(id, argv);
}

function parseArgs(argv) {
  const positional = argv
    .slice(2)
    .filter((arg) => arg !== "--check" && !arg.startsWith("-"));
  return { targetId: positional[0] ?? null };
}

function main(argv = process.argv) {
  const { targetId } = parseArgs(argv);
  if (targetId) {
    return runTarget(targetId, argv);
  }
  return runAll(argv);
}

module.exports = Object.freeze({
  TARGETS,
  bundledScript,
  render,
  filesForTarget,
  runTarget,
  runAll,
  cli,
  main,
});

if (require.main === module) {
  main();
}
