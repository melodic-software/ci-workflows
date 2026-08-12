"use strict";

/**
 * Shared primitives for render-*.cjs codegen.
 *
 * Reusable workflows must ship standalone (no repo-relative `source`), so
 * canonical script bodies are inlined between BEGIN/END GENERATED markers at
 * render time. This module owns the common mechanics — newline normalize,
 * exactly-one ordered block replacement, indentation, and the --check/write
 * CLI loop — so per-target renderers only declare source/workflow/markers and
 * a bundle transform.
 *
 * Composition/include of *shared bash primitives into* those sources (issue
 * #200 items 1a/1b) is intentionally out of scope here.
 */

const fs = require("node:fs");

function normalizeNewlines(text) {
  return String(text).replaceAll("\r\n", "\n");
}

function readNormalized(filePath) {
  return normalizeNewlines(fs.readFileSync(filePath, "utf8"));
}

function indentLines(lines, indentation) {
  return lines.map((line) => (line.length === 0 ? "" : `${indentation}${line}`));
}

/**
 * Locate a single ordered begin/end marker pair. Rejects missing, reversed,
 * or duplicated markers (the stricter pulumi-era contract).
 */
function findExactlyOneOrderedBlock(text, beginMarker, endMarker) {
  const start = text.indexOf(beginMarker);
  const end = text.indexOf(endMarker);
  if (
    start < 0 ||
    end <= start ||
    text.indexOf(beginMarker, start + beginMarker.length) >= 0 ||
    text.indexOf(endMarker, end + endMarker.length) >= 0
  ) {
    throw new Error(
      "workflow must contain exactly one ordered generated block",
    );
  }
  return { start, end };
}

/**
 * Replace the region from beginMarker through endMarker (inclusive) with
 * `replacement`, which must itself include both markers.
 */
function replaceGeneratedBlock(text, beginMarker, endMarker, replacement) {
  const { start, end } = findExactlyOneOrderedBlock(
    text,
    beginMarker,
    endMarker,
  );
  return `${text.slice(0, start)}${replacement}${text.slice(end + endMarker.length)}`;
}

/**
 * Apply a target's bundle transform and splice it into a workflow document.
 *
 * @param {object} options
 * @param {string} options.workflow
 * @param {string} options.source
 * @param {string} options.beginMarker fully-indented begin marker as it
 *   appears in the workflow file
 * @param {string} options.endMarker fully-indented end marker
 * @param {(source: string) => string} options.bundle returns the full
 *   indented block including begin/end markers
 * @param {string} [options.name] used only in error messages
 */
function renderWorkflow({
  workflow,
  source,
  beginMarker,
  endMarker,
  bundle,
  name,
}) {
  try {
    return replaceGeneratedBlock(
      workflow,
      beginMarker,
      endMarker,
      bundle(source),
    );
  } catch (error) {
    if (name && error instanceof Error) {
      error.message = `${name}: ${error.message}`;
    }
    throw error;
  }
}

/**
 * Write expected content, or in --check mode report drift without writing.
 *
 * @returns {boolean} true when in sync / written; false when check saw drift
 */
function writeOrCheck({ filePath, current, expected, check, driftMessage }) {
  if (check) {
    if (current !== expected) {
      process.stderr.write(driftMessage);
      return false;
    }
    return true;
  }
  fs.writeFileSync(filePath, expected, "utf8");
  return true;
}

/**
 * Run a multi-file render/check pass.
 *
 * @param {object} options
 * @param {boolean} options.check
 * @param {Array<{
 *   filePath: string,
 *   current: string,
 *   expected: string,
 *   driftMessage: string,
 * }>} options.files
 * @returns {number} process exit code (0 ok, 1 drift under --check)
 */
function runRenderPass({ check, files }) {
  let drift = false;
  for (const file of files) {
    const ok = writeOrCheck({ ...file, check });
    if (!ok) {
      drift = true;
    }
  }
  return check && drift ? 1 : 0;
}

module.exports = Object.freeze({
  normalizeNewlines,
  readNormalized,
  indentLines,
  findExactlyOneOrderedBlock,
  replaceGeneratedBlock,
  renderWorkflow,
  writeOrCheck,
  runRenderPass,
});
