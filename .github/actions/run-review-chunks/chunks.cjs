// Run a chunked review's chunks first..last, up to CHUNK_PARALLELISM at
// once, each as one run-claude-cli leg (`lane.cjs run`) on its own prompt, in
// one step.
//
// Legs run side by side, so each gets what lane.cjs would otherwise share:
// its own results directory (RESULTS_DIR/chunk-<k>/, LANE_RESULTS_DIR) for
// its execution, log and structured files, and its own empty file-command
// files, which lane.cjs snapshots, binds read-only and restores for that leg
// alone. The step's real file-command files are bound read-only in every leg
// too (LANE_READ_ONLY_PATHS) but left writable here, so this step writes its
// outputs after each leg as before. Before the first leg starts this step
// removes the write bits from the CLI install and the action checkouts, and
// puts them back after the last leg ends, so a leg's own lock and restore
// only ever see locked modes and no leg can unlock another's trees by ending
// first.
//
// A leg's console output (its live log and workflow commands, which lane.cjs
// wraps in its own ::stop-commands:: block) goes to a file and is replayed
// whole when the leg ends, so no leg's text lands inside another's block.
//
// No chunk starts after one failed or handed off; legs already running
// finish, and every chunk not started is `skipped`. The step fails when a
// chunk failed. Outputs name the first chunk that handed off, else the first
// that failed, else the last chunk.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const COUNT = /^[1-9][0-9]{0,5}$/u;
const FILE_COMMANDS = [
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_OUTPUT",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
];

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
    if (from !== to) fs.renameSync(from, to);
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

// Whether `file` holds one JSON object, the structured result lane.cjs writes.
function resultObject(file) {
  if (!file) return false;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function writeOutputs(file, outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => {
    if (String(value).includes("\n")) throw new Error(`output ${key} holds a newline`);
    return `${key}=${value}`;
  });
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Runs chunks env.CHUNK_FIRST..env.CHUNK_LAST, env.CHUNK_PARALLELISM at once
 * (1 when unset). `runChunk(promptFile, legEnv)` runs one leg on `legEnv`
 * (the step's environment with this leg's own file-command files and
 * LANE_RESULTS_DIR) and resolves to its exit status; the leg appends its
 * outputs to legEnv.GITHUB_OUTPUT as lane.cjs does. `lock()` runs before the
 * first leg and returns the function that undoes it, which runs after the
 * last. Resolves to the step's outputs and whether the step succeeded.
 */
async function runChunks(env, { runChunk, now = () => Date.now(), lock = () => () => {}, onStart = () => {} }) {
  const first = Number(env.CHUNK_FIRST);
  const last = Number(env.CHUNK_LAST);
  if (!COUNT.test(env.CHUNK_FIRST ?? "") || !COUNT.test(env.CHUNK_LAST ?? "") || first > last) {
    throw new Error("CHUNK_FIRST and CHUNK_LAST must be whole numbers, first <= last");
  }
  const parallelism = env.CHUNK_PARALLELISM ? Number(env.CHUNK_PARALLELISM) : 1;
  if (!COUNT.test(String(parallelism))) {
    throw new Error("CHUNK_PARALLELISM must be a whole number");
  }
  const outputFile = env.GITHUB_OUTPUT;
  const base = fs.statSync(outputFile).size;
  const summaryFile = env.GITHUB_STEP_SUMMARY;
  const results = env.RESULTS_DIR;
  const count = last - first + 1;
  const legs = Array.from({ length: count }, () => null);
  let stopped = false;
  let next = 0;
  // The step's outputs for `list`, one entry per chunk from first, null for
  // a chunk that did not run.
  const outputsOf = (list) => {
    const ran = list.filter(Boolean);
    const stopLeg =
      ran.find((l) => l.stop.handoff === "true") ?? ran.find((l) => l.failed) ?? ran.at(-1);
    return {
      ...(stopLeg?.stop ?? {}),
      "chunk-outcomes": list
        .map((l) => (l === null ? "skipped" : l.failed ? "failure" : "success"))
        .join(","),
      "results-dir": results,
      "transcript-file": transcript(
        ran.map((l) => l.execution).filter(Boolean),
        path.join(results, "transcript.json"),
      ),
    };
  };
  // After every leg the outputs of the chunks finished in a row from the
  // first replace the last ones written, so a step its timeout kills still
  // names the chunks it finished and keeps their transcript.
  const progress = () => {
    const done = legs.indexOf(null);
    fs.truncateSync(outputFile, base);
    writeOutputs(outputFile, outputsOf(done === -1 ? legs : legs.slice(0, done)));
  };

  const runOne = async (i) => {
    const k = first + i;
    const dir = path.join(results, `chunk-${k}`);
    const files = path.join(dir, "file-commands");
    fs.mkdirSync(files, { recursive: true });
    const legEnv = { ...env, LANE_RESULTS_DIR: dir };
    for (const name of FILE_COMMANDS) {
      legEnv[name] = path.join(files, name.toLowerCase());
      fs.writeFileSync(legEnv[name], "");
    }
    legEnv.LANE_READ_ONLY_PATHS = FILE_COMMANDS.map((name) => env[name] ?? "")
      .filter((file) => file !== "" && fs.existsSync(file))
      .join("\n");
    const startedAt = String(Math.floor(now() / 1000));
    const status = await runChunk(path.join(env.PROMPT_DIR, `prompt-${k}.md`), legEnv);
    const leg = parseOutputs(readText(legEnv.GITHUB_OUTPUT));
    const summary = readText(legEnv.GITHUB_STEP_SUMMARY);
    fs.rmSync(files, { recursive: true, force: true });
    const execution = move(leg["execution-file"], path.join(dir, "execution.json"));
    const log = move(leg["log-file"], path.join(dir, "log.jsonl"));
    const structured = move(leg["structured-output-file"], path.join(dir, "structured.json"));
    // A leg that exits 0 with no well-formed result fails here, so no later
    // chunk starts for a review that is already incomplete.
    const failed = status !== 0 || !resultObject(structured);
    if (failed || leg.handoff === "true") stopped = true;
    legs[i] = {
      k,
      failed,
      execution,
      summary,
      stop: {
        "lane-class": leg["lane-class"] || (failed ? "other" : ""),
        handoff: leg.handoff ?? "",
        "handoff-reason": leg["handoff-reason"] ?? "",
        credential: leg.credential ?? "",
        "execution-file": execution,
        "execution-file-clean": execution ? (leg["execution-file-clean"] ?? "") : "",
        "log-file": log,
        "started-at": startedAt,
        "last-chunk": String(k),
      },
    };
    progress();
  };

  // A leg that throws stops new chunks like a failed one; every running leg
  // still ends before the trees are unlocked, and the first error is thrown
  // after that.
  const errors = [];
  const worker = async () => {
    while (!stopped && next < count) {
      try {
        await runOne(next++);
      } catch (error) {
        stopped = true;
        errors.push(error);
      }
    }
  };

  // The step's other file-command files, put back exactly as they were
  // once the legs end, as lane.cjs does for its own step; this step
  // rewrites GITHUB_OUTPUT and appends to GITHUB_STEP_SUMMARY itself below.
  const snapshots = FILE_COMMANDS.filter((name) => name !== "GITHUB_OUTPUT")
    .map((name) => (env[name] ?? "").trim())
    .filter((file) => file !== "" && fs.existsSync(file))
    .map((file) => ({ file, content: fs.readFileSync(file) }));
  // Unlock, put the file-command files back, then add the summaries of the
  // legs that ended. Runs once: after the last leg, or from a signal handler
  // the caller registers through onStart.
  let unlock = () => {};
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    unlock();
    for (const { file, content } of snapshots) {
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(content)) fs.writeFileSync(file, content);
    }
    if (summaryFile) {
      for (const l of legs) if (l?.summary) fs.appendFileSync(summaryFile, l.summary);
    }
  };
  onStart(finish);
  try {
    unlock = lock();
    await Promise.all(Array.from({ length: Math.min(parallelism, count) }, worker));
  } finally {
    finish();
  }
  if (errors.length > 0) throw errors[0];

  const ran = legs.filter(Boolean);
  const outputs = outputsOf(legs);
  fs.truncateSync(outputFile, base);
  writeOutputs(outputFile, outputs);
  return { ok: !ran.some((l) => l.failed), outputs };
}

// The console files of the legs still running, so a signal can print them.
const running = new Set();

// Writes each running leg's console output so far, once; for a step that is
// being stopped.
function flushRunning(write = (data) => process.stdout.write(data)) {
  for (const file of running) {
    try {
      write(fs.readFileSync(file));
    } catch {}
  }
  running.clear();
}

// One leg as a child process: its stdout and stderr go to one file, which is
// written to this step's stdout whole once the leg ends.
function spawnLeg(lane, promptFile, legEnv, write = (data) => process.stdout.write(data)) {
  const consoleFile = path.join(legEnv.LANE_RESULTS_DIR, "console.txt");
  const out = fs.openSync(consoleFile, "w");
  running.add(consoleFile);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [lane, "run"], {
      env: { ...legEnv, LANE_PROMPT_FILE: promptFile },
      stdio: ["ignore", out, out],
    });
    let ended = false;
    const done = (status) => {
      if (ended) return;
      ended = true;
      running.delete(consoleFile);
      fs.closeSync(out);
      write(fs.readFileSync(consoleFile));
      fs.rmSync(consoleFile, { force: true });
      resolve(status ?? 1);
    };
    child.on("error", () => done(1));
    child.on("close", (status) => done(status));
  });
}

if (require.main === module) {
  const env = process.env;
  const lane = path.join(__dirname, "..", "run-claude-cli", "lane.cjs");
  const { lockTrees, readOnlyPaths, restoreModes } = require(lane);
  const lock = () => {
    const modes = [];
    const unlock = () => restoreModes(modes.splice(0));
    try {
      lockTrees(readOnlyPaths({ workDir: env.LANE_WORK_DIR }, env), modes);
    } catch (error) {
      unlock();
      throw error;
    }
    return unlock;
  };
  // A step stopped by its timeout or a cancel still prints what every running
  // leg wrote so far, unlocks, restores and adds the finished legs' summaries.
  const onStart = (finish) => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        flushRunning();
        finish();
        process.exit(1);
      });
    }
  };
  runChunks(env, { runChunk: (promptFile, legEnv) => spawnLeg(lane, promptFile, legEnv), lock, onStart })
    .then(({ ok }) => {
      if (!ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = { flushRunning, runChunks, spawnLeg };
