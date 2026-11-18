"use strict";

// Derives each model leg's steps from its workflow's key leg. The key leg is
// the one hand-edited copy; a spec in model-legs/ lists, per derived leg, the
// counted text substitutions that make it differ, and the key leg's
// KEY-ONLY block is dropped. Run with --check to fail on a stale region.

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const specDir = path.join(__dirname, "model-legs");
const STEP_INDENT = "      ";
const KEY_ONLY = /^ {6}# BEGIN KEY-ONLY\n[\s\S]*?^ {6}# END KEY-ONLY\n/gmu;

const name = (spec) => path.basename(spec.workflow, ".yml");
const markers = (spec, job) => [
  `${STEP_INDENT}# BEGIN GENERATED: ${name(spec)} ${job}\n`,
  `${STEP_INDENT}# END GENERATED: ${name(spec)} ${job}\n`,
];

// [start, end) offsets of a job's steps: from the line after `    steps:`
// through the last line indented six or more, so the blank line and the
// next job's indent-2 comments stay outside.
function stepsRange(text, job) {
  const header = text.indexOf(`\n  ${job}:\n`);
  const steps = header < 0 ? -1 : text.indexOf("\n    steps:\n", header);
  if (steps < 0) throw new Error(`${job}: no steps for job ${job}`);
  const start = steps + "\n    steps:\n".length;
  let end = start;
  for (let at = start; at < text.length; ) {
    const next = text.indexOf("\n", at) + 1 || text.length;
    const line = text.slice(at, next);
    if (line.startsWith(STEP_INDENT)) end = next;
    else if (line.trim() !== "") break;
    at = next;
  }
  return [start, end];
}

function derive(keySteps, leg, keyJob) {
  const blocks = keySteps.match(KEY_ONLY) ?? [];
  const begins = keySteps.match(/^ {6}# BEGIN KEY-ONLY$/gmu) ?? [];
  if (blocks.length !== 1 || begins.length !== 1) {
    throw new Error(
      `${keyJob}: ${Math.max(blocks.length, begins.length)} KEY-ONLY blocks, expected 1`,
    );
  }
  const base = keySteps.replace(KEY_ONLY, "");
  const edits = leg.substitutions.flatMap(({ find, replace, count }) => {
    const at = [];
    for (let i = base.indexOf(find); i >= 0; i = base.indexOf(find, i + 1)) {
      at.push(i);
    }
    if (at.length !== count) {
      throw new Error(
        `${leg.job}: ${JSON.stringify(find)} matched ${at.length} times, expected ${count}`,
      );
    }
    return at.map((start) => ({ start, end: start + find.length, replace }));
  });
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const { start, end, replace } of edits) {
    if (start < cursor) throw new Error(`${leg.job}: substitutions overlap`);
    out += base.slice(cursor, start) + replace;
    cursor = end;
  }
  return out + base.slice(cursor);
}

// The derived job's current generated region, or its unmarked steps range
// before the first write.
function regionRange(text, spec, job) {
  const [begin, end] = markers(spec, job);
  const start = text.indexOf(begin);
  if (start >= 0) {
    const finish = text.indexOf(end, start);
    if (finish < 0) throw new Error(`${job}: unterminated generated region`);
    return { start, end: finish + end.length, marked: true };
  }
  const [s, e] = stepsRange(text, job);
  return { start: s, end: e, marked: false };
}

function render(workflowText, spec) {
  const keySteps = workflowText.slice(...stepsRange(workflowText, spec.keyJob));
  let text = workflowText;
  for (const leg of spec.legs) {
    const [begin, end] = markers(spec, leg.job);
    const region = `${begin}${derive(keySteps, leg, spec.keyJob)}${end}`;
    const { start, end: finish } = regionRange(text, spec, leg.job);
    text = text.slice(0, start) + region + text.slice(finish);
  }
  return text;
}

function check(workflowText, spec) {
  const rendered = render(workflowText, spec);
  return spec.legs
    .filter((leg) => {
      const current = regionRange(workflowText, spec, leg.job);
      const wanted = regionRange(rendered, spec, leg.job);
      return (
        !current.marked ||
        workflowText.slice(current.start, current.end) !==
          rendered.slice(wanted.start, wanted.end)
      );
    })
    .map((leg) => `${name(spec)} ${leg.job}`);
}

const specs = () =>
  fs
    .readdirSync(specDir)
    .filter((file) => file.endsWith(".cjs"))
    .sort()
    .map((file) => require(path.join(specDir, file)));

function main(argv, specList = specs(), rootDir = root) {
  const checkOnly = argv.includes("--check");
  const stale = [];
  for (const spec of specList) {
    const file = path.join(rootDir, spec.workflow);
    const text = fs.readFileSync(file, "utf8");
    if (checkOnly) stale.push(...check(text, spec));
    else fs.writeFileSync(file, render(text, spec));
  }
  if (stale.length === 0) return 0;
  for (const region of stale) console.error(`stale generated steps: ${region}`);
  console.error("Run: node .github/scripts/generate-model-legs.cjs");
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { render, check, main };
