// Run a chunked review's chunks first..last in order, each as one
// run-claude-cli leg (`lane.cjs run`) on its own prompt, in one step.
//
// Every leg runs with the step's own environment, so lane.cjs binds this
// step's file-command files and the CLI install under LANE_WORK_DIR
// read-only for the leg, as it does for its own step. The work directory is
// the same for every chunk (its `cli` tree is the one lane.cjs locks), so
// each leg's files move to RESULTS_DIR/chunk-<k>/ before the next leg runs,
// and the outputs lane.cjs appends to GITHUB_OUTPUT are read back and
// removed, leaving only this script's outputs for the step.
//
// A chunk runs only after the chunk before it succeeded and handed nothing
// on, as the hand-written chunk steps did: the first failure or handoff
// stops the loop, and every later chunk is `skipped`. The step fails when a
// chunk failed.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const COUNT = /^[1-9][0-9]{0,5}$/u;

// The `key=value` lines lane.cjs's writeOutputs appends.
function parseOutputs(text) {
  const outputs = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return outputs;
}

// Moves `from` to `to` when `from` is a regular file; returns `to`, else "".
function move(from, to) {
  if (!from) return "";
  try {
    if (!fs.lstatSync(from).isFile()) return "";
    fs.renameSync(from, to);
    return to;
  } catch {
    return "";
  }
}

// The messages of every chunk's execution file, in order, as one JSON
// array: the transcript upload-lane-transcript seals for the whole loop.
function transcript(files, target) {
  const messages = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) messages.push(...parsed);
    } catch {}
  }
  if (messages.length === 0) return "";
  fs.writeFileSync(target, JSON.stringify(messages));
  return target;
}

/**
 * Runs chunks env.CHUNK_FIRST..env.CHUNK_LAST. `runChunk(promptFile)` runs one
 * leg and returns its exit status; it appends its outputs to
 * env.GITHUB_OUTPUT as lane.cjs does. Returns the step's outputs and whether
 * the step succeeded.
 */
function runChunks(env, { runChunk, now = () => Date.now() }) {
  const first = Number(env.CHUNK_FIRST);
  const last = Number(env.CHUNK_LAST);
  if (!COUNT.test(env.CHUNK_FIRST ?? "") || !COUNT.test(env.CHUNK_LAST ?? "") || first > last) {
    throw new Error("CHUNK_FIRST and CHUNK_LAST must be whole numbers, first <= last");
  }
  const outputFile = env.GITHUB_OUTPUT;
  const results = env.RESULTS_DIR;
  const outcomes = [];
  const executions = [];
  let stop = {};
  let failed = false;
  for (let k = first; k <= last; k++) {
    if (failed || stop.handoff === "true") {
      outcomes.push("skipped");
      continue;
    }
    const dir = path.join(results, `chunk-${k}`);
    fs.mkdirSync(dir);
    const before = fs.statSync(outputFile).size;
    const startedAt = String(Math.floor(now() / 1000));
    const status = runChunk(path.join(env.PROMPT_DIR, `prompt-${k}.md`));
    const appended = fs.readFileSync(outputFile).subarray(before).toString("utf8");
    fs.truncateSync(outputFile, before);
    const leg = parseOutputs(appended);
    const execution = move(leg["execution-file"], path.join(dir, "execution.json"));
    if (execution) executions.push(execution);
    const log = move(leg["log-file"], path.join(dir, "log.jsonl"));
    move(leg["structured-output-file"], path.join(dir, "structured.json"));
    failed = status !== 0;
    outcomes.push(failed ? "failure" : "success");
    stop = {
      "lane-class": leg["lane-class"] ?? (failed ? "other" : ""),
      handoff: leg.handoff ?? "",
      "handoff-reason": leg["handoff-reason"] ?? "",
      credential: leg.credential ?? "",
      "execution-file": execution,
      "execution-file-clean": execution ? (leg["execution-file-clean"] ?? "") : "",
      "log-file": log,
      "started-at": startedAt,
      "last-chunk": String(k),
    };
    if (failed && stop["lane-class"] === "") stop["lane-class"] = "other";
  }
  return {
    ok: !failed,
    outputs: {
      ...stop,
      "chunk-outcomes": outcomes.join(","),
      "results-dir": results,
      "transcript-file": transcript(executions, path.join(results, "transcript.json")),
    },
  };
}

function writeOutputs(file, outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => {
    if (String(value).includes("\n")) throw new Error(`output ${key} holds a newline`);
    return `${key}=${value}`;
  });
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

if (require.main === module) {
  const env = process.env;
  const lane = path.join(__dirname, "..", "run-claude-cli", "lane.cjs");
  const { ok, outputs } = runChunks(env, {
    runChunk: (promptFile) =>
      spawnSync(process.execPath, [lane, "run"], {
        env: { ...env, LANE_PROMPT_FILE: promptFile },
        stdio: "inherit",
      }).status ?? 1,
  });
  writeOutputs(env.GITHUB_OUTPUT, outputs);
  if (!ok) process.exitCode = 1;
}

module.exports = { parseOutputs, runChunks };
