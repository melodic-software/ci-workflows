"use strict";

// pr-review-cli.yml's chunked review: the three limits that size it (files
// per chunk, bytes per chunk, the chunk ceiling) are defined once, in the
// workflow env, and every leg reads them from there.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { evaluate } = require("./actions-expression.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");
const { atChunkMachineryLimits } = require("./chunk-machinery-limits.cjs");

const WORKFLOW_FILE = path.join(
  __dirname,
  "..",
  "workflows",
  "pr-review-cli.yml",
);
const text = fs.readFileSync(WORKFLOW_FILE, "utf8");
const workflow = parseWorkflow(text);
const SHIPPED_LIMITS = atChunkMachineryLimits(workflow.env);
const LEGS = ["review-key", "review-subscription", "review-fallback"].map(
  (name) => workflow.jobs[name],
);
const LIMITS = ["MAX_CHUNK_FILES", "READ_BUDGET", "MAX_CHUNKS"];

test("each chunk limit is defined once, in the workflow env, and read from there", () => {
  for (const name of LIMITS) {
    assert.match(SHIPPED_LIMITS[name] ?? "", /^[1-9][0-9]*$/u, name);
    const definitions = text.match(new RegExp(`^\\s*${name}:`, "gmu")) ?? [];
    assert.equal(definitions.length, 1, `${name} is defined more than once`);
    assert.doesNotMatch(
      text,
      new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*[0-9]`, "u"),
      `${name} is hard-coded in a script`,
    );
  }
  for (const job of LEGS) {
    for (const name of LIMITS) assert.equal(job.env?.[name], undefined);
    for (const s of job.steps) {
      for (const name of LIMITS)
        assert.equal(s.env?.[name], undefined, `${job.name} / ${s.name}`);
      const body = `${s.run ?? ""}\n${s.with?.script ?? ""}`;
      assert.doesNotMatch(body, /\b1000000\b/u, `${job.name} / ${s.name}`);
    }
  }
  // The data floor stays 7500 bytes whatever the read budget.
  assert.equal(workflow.env.DATA_FLOOR_BYTES, "7500");
});

// A stand-in for claude-code-plugins' split-diff.py with its documented
// contract (usage line and module docstring): greedy chunks of whole files,
// at most max-bytes and max-files each, and exit 3 with
// `split-diff: the diff needs <n> chunks, more than <max>` past max-chunks.
const SPLITTER = [
  "import sys",
  "from pathlib import Path",
  "patch, out, max_bytes, max_chunks, manifest, _ = sys.argv[1:7]",
  "max_files = int(sys.argv[7]) if len(sys.argv) > 7 else 0",
  "files = []",
  "for line in Path(patch).read_bytes().splitlines(keepends=True):",
  "    if not files or line.startswith(b'diff --git '):",
  "        files.append(b'')",
  "    files[-1] += line",
  "chunks, count = [], 0",
  "for unit in files:",
  "    if not chunks or len(chunks[-1]) + len(unit) > int(max_bytes) or (max_files and count >= max_files):",
  "        chunks.append(b'')",
  "        count = 0",
  "    chunks[-1] += unit",
  "    count += 1",
  "if len(chunks) > int(max_chunks):",
  "    print(f'split-diff: the diff needs {len(chunks)} chunks, more than {max_chunks}', file=sys.stderr)",
  "    sys.exit(3)",
  "for k, chunk in enumerate(chunks, 1):",
  "    (Path(out) / f'chunk-{k}.patch').write_bytes(chunk)",
  "if len(chunks) > 1:",
  "    Path(manifest).write_text('manifest\\n')",
  "",
].join("\n");

// The split step as shipped, over a diff of `files` added one-line files
// and `renames` pure renames the full-diff step listed as verified.
function split(job, files, env = {}, { renames = 0 } = {}) {
  const dir = makeTemporaryDirectory("pr-review-cli-chunks-split-");
  const source = path.join(dir, "source");
  const scripts = path.join(source, ".github", "scripts", "pr-review-main");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "split-diff.py"), SPLITTER);
  const work = path.join(dir, "work");
  fs.mkdirSync(path.join(work, ".claude-lane"), { recursive: true });
  const moved = Array.from({ length: renames }, (_, i) => [
    `old${i}`,
    `new${i}`,
  ]);
  const diff =
    moved
      .map(
        ([from, to]) =>
          `diff --git a/${from} b/${to}\nsimilarity index 100%\nrename from ${from}\nrename to ${to}\n`,
      )
      .join("") +
    Array.from(
      { length: files },
      (_, i) => `diff --git a/f${i} b/f${i}\n+line ${i}\n`,
    ).join("");
  fs.writeFileSync(path.join(work, ".claude-lane", "pr.diff"), diff);
  if (renames > 0) {
    fs.writeFileSync(
      path.join(work, ".claude-lane", "renames.txt"),
      moved.map((pair) => `${pair.join("\t")}\n`).join(""),
    );
    env = { RENAMES: String(renames), ...env };
  }
  const output = path.join(dir, "out");
  fs.writeFileSync(output, "");
  const s = job.steps.find((candidate) => candidate.id === "split");
  const result = spawnSync("bash", ["-e", "-c", s.run], {
    cwd: work,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SOURCE: source,
      SCOPE_DIFF: ".claude-lane/pr.diff",
      SCOPE_BYTES: String(Buffer.byteLength(diff)),
      CHUNK_DIR: s.env.CHUNK_DIR,
      SCOPE: "whole",
      COPIES: "0",
      GITHUB_OUTPUT: output,
      ...Object.fromEntries(LIMITS.map((name) => [name, workflow.env[name]])),
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    outputs: Object.fromEntries(
      fs
        .readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("=")),
    ),
    stdout: result.stdout,
  };
}

test("a diff over the chunk ceiling is reviewed unsplit, with the count and the ceiling named", () => {
  const ceiling = Number(workflow.env.MAX_CHUNKS);
  const perChunk = Number(workflow.env.MAX_CHUNK_FILES);
  for (const job of LEGS) {
    const over = split(job, (ceiling + 1) * perChunk);
    assert.equal(over.outputs.chunks, "1", job.name);
    assert.equal(over.outputs["over-chunks"], String(ceiling + 1), job.name);
    assert.match(
      over.stdout,
      new RegExp(
        `^::warning::.* needs ${ceiling + 1} chunks .*, more than the ceiling of ${ceiling}; it is reviewed unsplit, as a partial review$`,
        "mu",
      ),
    );
    const at = split(job, ceiling * perChunk);
    assert.equal(at.outputs.chunks, String(ceiling), job.name);
    assert.equal(at.outputs["over-chunks"], undefined, job.name);
  }
});

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// A github-script step's script, run with `values` in its env.
async function runScript(s, values) {
  const outputs = {};
  const saved = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, values);
  const summary = { addRaw: () => summary, write: async () => {} };
  try {
    await new AsyncFunction("require", "core", s.with.script)(require, {
      setOutput: (k, v) => {
        outputs[k] = v;
      },
      setFailed: (m) => {
        throw new Error(m);
      },
      info: () => {},
      warning: () => {},
      summary,
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return outputs;
}

const LOG_RECORD = JSON.stringify({
  num_turns: 3,
  total_cost_usd: 0.25,
  duration_ms: 1000,
  started_at: "2026-11-12T00:00:00.000Z",
  ended_at: "2026-11-12T00:01:00.000Z",
  models_used: {},
});

// The extract step of `job` over one unsplit review of `files` files.
async function extractOne(job, review, env = {}) {
  const dir = makeTemporaryDirectory("pr-review-cli-chunks-extract-");
  const write = (name, content) => {
    fs.writeFileSync(path.join(dir, name), content);
    return path.join(dir, name);
  };
  return runScript(
    job.steps.find((s) => s.id === "extract"),
    {
      STRUCTURED_FILE: write("structured.json", JSON.stringify(review)),
      LOG_FILE: write("log.jsonl", `${LOG_RECORD}\n`),
      MODE_OK: "true",
      SCOPE: "whole",
      FULL_DIFF: "true",
      WHOLE_FILES: "1",
      SCOPE_DIFF: write("pr.diff", "diff --git a/a b/a\n"),
      SCOPE_BYTES: "20",
      CHUNKS: "1",
      ...Object.fromEntries(
        [...LIMITS, "CHUNK_SUMMARY_CHARS", "CHUNK_COMMENTS"].map((name) => [
          name,
          workflow.env[name],
        ]),
      ),
      ...env,
    },
  );
}

test("the review summary of a diff over the ceiling names the count and the ceiling, and stays partial", async () => {
  const ceiling = Number(workflow.env.MAX_CHUNKS);
  const files = (ceiling + 1) * Number(workflow.env.MAX_CHUNK_FILES);
  for (const job of LEGS) {
    const outputs = await extractOne(
      job,
      { findings: 0, files_read: files, summary: "Read it all.", comments: [] },
      { WHOLE_FILES: String(files), OVER_CHUNKS: String(ceiling + 1) },
    );
    assert.equal(outputs.verdict, "complete", job.name);
    const review = JSON.parse(outputs.review);
    assert.match(
      review.summary,
      new RegExp(
        `needs ${ceiling + 1} chunks, more than the ceiling of ${ceiling}, so it was reviewed unsplit, as a partial review\\.$`,
        "u",
      ),
    );
    // publish-review calls a review with over_files partial, and fails it.
    assert.equal(
      review.coverage.over_files,
      files,
      `${job.name}: the coverage keeps the review partial`,
    );
  }
});

test("no leg assumes a fixed chunk count", () => {
  assert.doesNotMatch(text, /\[2-[0-9]\]/u, "a chunk-count range regex");
  for (const job of LEGS) {
    for (const s of job.steps) {
      assert.doesNotMatch(s.id ?? "", /^(claude|time)-[0-9]+$/u, s.id);
    }
  }
  assert.doesNotMatch(
    text,
    /(STRUCTURED|EXECUTION|LOG)_FILE_[0-9]|prompt-file-/u,
  );
  assert.equal(SHIPPED_LIMITS.MAX_CHUNKS, "1");
});

// --- the chunk loop ---

const ACTION_DIR = path.join(__dirname, "..", "actions", "run-review-chunks");
const { runChunks } = require(path.join(ACTION_DIR, "chunks.cjs"));

// A stand-in for lane.cjs run: writes the leg's files to the work dir and
// appends its outputs to GITHUB_OUTPUT the way writeOutputs does. `legs`
// maps a chunk number to how its leg ends.
function fakeLegs(work, legs = {}) {
  const ran = [];
  return {
    ran,
    runChunk: (promptFile) => {
      const k = Number(/prompt-([0-9]+)\.md$/u.exec(promptFile)[1]);
      ran.push(k);
      const end = legs[k] ?? {};
      if (end.killed) throw new Error(`step killed during chunk ${k}`);
      const execution = path.join(work, "leg-1-execution.json");
      fs.writeFileSync(
        execution,
        JSON.stringify([
          { type: "system", subtype: "init", permissionMode: "dontAsk", k },
          { type: "result", k },
        ]),
      );
      const structured = path.join(work, "structured-output.json");
      const log = path.join(work, "run-claude-cli-log.jsonl");
      fs.writeFileSync(log, `{"k":${k}}\n`);
      const writes = !end.failed && !end.noStructured;
      if (writes) fs.writeFileSync(structured, `{"k":${k}}`);
      fs.appendFileSync(
        process.env.FAKE_OUTPUT,
        [
          `lane-class=${end.laneClass ?? ""}`,
          `handoff=${end.handoff ?? "false"}`,
          `handoff-reason=${end.handoff === "true" ? "credit-stop" : ""}`,
          "credential=REVIEWS_CLAUDE_API_KEY",
          `execution-file=${execution}`,
          "execution-file-clean=true",
          `log-file=${log}`,
          `structured-output-file=${writes ? structured : ""}`,
          "",
        ].join("\n"),
      );
      return end.failed ? 1 : 0;
    },
  };
}

function loop(first, last, legs) {
  const dir = makeTemporaryDirectory("pr-review-cli-chunks-loop-");
  const work = path.join(dir, "work");
  const results = path.join(dir, "results");
  fs.mkdirSync(work);
  fs.mkdirSync(results);
  const output = path.join(dir, "output");
  fs.writeFileSync(output, "earlier=1\n");
  const fake = fakeLegs(work, legs);
  const saved = process.env.FAKE_OUTPUT;
  process.env.FAKE_OUTPUT = output;
  try {
    const result = runChunks(
      {
        CHUNK_FIRST: String(first),
        CHUNK_LAST: String(last),
        GITHUB_OUTPUT: output,
        RESULTS_DIR: results,
        PROMPT_DIR: path.join(dir, "prompts"),
      },
      { runChunk: fake.runChunk, now: () => 1_700_000_000_000 },
    );
    return { ...result, ran: fake.ran, results, output };
  } catch (error) {
    error.output = output;
    throw error;
  } finally {
    if (saved === undefined) delete process.env.FAKE_OUTPUT;
    else process.env.FAKE_OUTPUT = saved;
  }
}

test("the chunk loop runs every later chunk in order and keeps each one's files apart", () => {
  for (const n of [4, 5, 12, 20]) {
    const run = loop(2, n);
    assert.equal(run.ok, true, `${n} chunks`);
    assert.deepEqual(
      run.ran,
      Array.from({ length: n - 1 }, (_, i) => i + 2),
    );
    assert.equal(
      run.outputs["chunk-outcomes"],
      Array(n - 1)
        .fill("success")
        .join(","),
    );
    assert.equal(run.outputs["lane-class"], "");
    assert.equal(run.outputs.handoff, "false");
    for (let k = 2; k <= n; k++) {
      const dir = path.join(run.results, `chunk-${k}`);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(dir, "structured.json"), "utf8")),
        { k },
      );
      assert.equal(
        fs.readFileSync(path.join(dir, "log.jsonl"), "utf8"),
        `{"k":${k}}\n`,
      );
    }
    // One transcript of every chunk's messages, in chunk order.
    const messages = JSON.parse(
      fs.readFileSync(run.outputs["transcript-file"], "utf8"),
    );
    assert.equal(messages.length, 2 * (n - 1));
    assert.deepEqual(
      messages.filter((m) => m.type === "result").map((m) => m.k),
      run.ran,
    );
    // The legs' own outputs were taken back out of the step's file, which
    // holds what came before and one set of the loop's outputs.
    const lines = fs
      .readFileSync(run.output, "utf8")
      .split("\n")
      .filter(Boolean);
    assert.equal(lines[0], "earlier=1");
    const keys = lines.slice(1).map((line) => line.split("=")[0]);
    assert.deepEqual(keys, [...new Set(keys)]);
    assert.ok(keys.includes("chunk-outcomes"));
    assert.equal(keys.includes("structured-output-file"), false);
  }
});

test("a failed chunk stops the loop, skips the rest and fails the step", () => {
  const run = loop(2, 6, { 3: { failed: true, laneClass: "timeout" } });
  assert.equal(run.ok, false);
  assert.deepEqual(run.ran, [2, 3]);
  assert.equal(
    run.outputs["chunk-outcomes"],
    "success,failure,skipped,skipped,skipped",
  );
  assert.equal(run.outputs["lane-class"], "timeout");
  assert.equal(run.outputs["last-chunk"], "3");
  assert.equal(
    fs.existsSync(path.join(run.results, "chunk-3", "structured.json")),
    false,
  );
});

test("a handoff stops the loop and hands its reason on", () => {
  const run = loop(2, 6, {
    3: { failed: true, laneClass: "credit-stop", handoff: "true" },
  });
  assert.deepEqual(run.ran, [2, 3]);
  assert.equal(run.outputs.handoff, "true");
  assert.equal(run.outputs["handoff-reason"], "credit-stop");
  assert.equal(
    run.outputs["chunk-outcomes"],
    "success,failure,skipped,skipped,skipped",
  );
});

test("the loop gives every leg run-claude-cli's launcher environment and preamble", () => {
  const { parseWorkflow: parseYaml } = require("./workflow-yaml.cjs");
  const load = (name) =>
    parseYaml(
      fs.readFileSync(
        path.join(__dirname, "..", "actions", name, "action.yml"),
        "utf8",
      ),
    );
  const launcher = load("run-claude-cli");
  const chunks = load("run-review-chunks");
  const laneEnv = (s) =>
    Object.fromEntries(
      Object.entries(s.env).filter(([name]) => name.startsWith("LANE_")),
    );
  const run = launcher.runs.steps.find((s) => s.id === "run");
  const loopStep = chunks.runs.steps.find((s) => s.id === "loop");
  const expected = laneEnv(run);
  // The prompt file is per chunk, and the loop runs no loopback key proxy.
  delete expected.LANE_PROMPT_FILE;
  expected.LANE_LOOPBACK_BASE_URL = "";
  assert.deepEqual(laneEnv(loopStep), expected);
  assert.equal(
    chunks.inputs.preamble.default,
    launcher.inputs.preamble.default,
  );
  for (const id of ["isolation", "install"]) {
    const ours = chunks.runs.steps.find((s) => s.id === id);
    const theirs = launcher.runs.steps.find((s) => s.id === id);
    assert.equal(
      ours.run,
      theirs.run.replace(
        "$GITHUB_ACTION_PATH/",
        "$GITHUB_ACTION_PATH/../run-claude-cli/",
      ),
    );
  }
  for (const name of Object.keys(launcher.inputs))
    if (!["prompt-file", "loopback-base-url"].includes(name))
      assert.ok(name in chunks.inputs, name);
});

// --- chunk counts end to end: split, then extract over the loop's results ---

test("a 178-file diff left after verified renames are discounted is reviewed in 5 chunks", () => {
  for (const job of LEGS) {
    const cut = split(job, 178, {}, { renames: 42 });
    // 178 files at 40 per chunk: 40, 40, 40, 40, 18.
    assert.equal(cut.outputs.chunks, "5", job.name);
    assert.equal(cut.outputs.files, "40,40,40,40,18", job.name);
    assert.equal(cut.outputs.excluded, "42", job.name);
    assert.equal(cut.outputs["over-chunks"], undefined, job.name);
  }
});

const REVIEW = (files) => ({
  findings: 0,
  files_read: files,
  summary: "Nothing found.",
  comments: [],
});

// The extract step over an N-chunk review: chunk 1 from the first review
// step's files, chunks 2..N from the chunk loop's results directory,
// `outcomes` the loop's chunk-outcomes.
async function extractChunked(job, n, { outcomes, reviews } = {}) {
  const dir = makeTemporaryDirectory("pr-review-cli-chunks-n-");
  const chunkDir = path.join(dir, "chunks");
  const results = path.join(dir, "results");
  fs.mkdirSync(chunkDir);
  fs.mkdirSync(results);
  const review = (k) => reviews?.[k] ?? REVIEW(2);
  for (let k = 1; k <= n; k++) {
    fs.writeFileSync(path.join(chunkDir, `chunk-${k}.patch`), "+x\n");
    if (k === 1) continue;
    fs.mkdirSync(path.join(results, `chunk-${k}`));
    fs.writeFileSync(
      path.join(results, `chunk-${k}`, "structured.json"),
      JSON.stringify(review(k)),
    );
    fs.writeFileSync(
      path.join(results, `chunk-${k}`, "log.jsonl"),
      `${LOG_RECORD}\n`,
    );
  }
  const loopOutcomes =
    outcomes ??
    Array(n - 1)
      .fill("success")
      .join(",");
  return extractOne(job, review(1), {
    CHUNKS: String(n),
    CHUNK_FILES: Array(n).fill("2").join(","),
    CHUNK_DIR: chunkDir,
    RESULTS_DIR: results,
    CHUNK_OUTCOMES: `success,${loopOutcomes}`,
    WHOLE_FILES: String(2 * n),
    SCOPE_BYTES: String(n * Number(workflow.env.READ_BUDGET)),
  });
}

test("reviews of 1, 4, 5, 12 and 20 chunks complete, every chunk read", async () => {
  for (const job of LEGS) {
    for (const n of [1, 4, 5, 12, 20]) {
      const outputs =
        n === 1
          ? await extractOne(job, REVIEW(1), { CHUNK_OUTCOMES: "success," })
          : await extractChunked(job, n);
      assert.equal(outputs.verdict, "complete", `${job.name}: ${n} chunks`);
      const review = JSON.parse(outputs.review);
      assert.deepEqual(
        review.coverage,
        n === 1 ? { read: 1, changed: 1 } : { read: 2 * n, changed: 2 * n },
      );
      // Each chunk's log counted: 3 turns a chunk.
      assert.equal(outputs.turns, String(3 * n));
    }
  }
});

test("a 6-chunk review with one failed chunk is partial: no verdict, no review", async () => {
  for (const job of LEGS) {
    const outputs = await extractChunked(job, 6, {
      outcomes: "success,success,failure,skipped,skipped",
    });
    assert.equal(
      outputs.verdict,
      "chunk 4 of 6: the review step did not succeed",
      job.name,
    );
    assert.equal(outputs.review, undefined);
    // A loop that did not finish leaves no outcomes: the same.
    const killed = await extractChunked(job, 6, { outcomes: "" });
    assert.equal(
      killed.verdict,
      "chunk 2 of 6: the review step did not succeed",
      job.name,
    );
  }
});

// --- timeouts ---

const minutes = (value, context) => Number(evaluate(String(value), context));

test("a 1-chunk review keeps today's step limits, and the loop's limit grows with the chunk count", async () => {
  for (const job of LEGS) {
    const first = job.steps.find((s) => s.id === "claude");
    for (const [lane, limit, leg] of [
      ["code", 14, "11"],
      ["security", 16, "13"],
    ]) {
      assert.equal(
        minutes(first["timeout-minutes"], { inputs: { lane } }),
        limit,
      );
      assert.equal(
        evaluate(first.with["leg-timeout-minutes"], { inputs: { lane } }),
        leg,
      );
    }
    const loopStep = job.steps.find((s) => s.id === "chunks");
    const compose = job.steps.find((s) => s.id === "compose");
    assert.equal(compose.env.LEG_MINUTES, first.with["leg-timeout-minutes"]);
    assert.equal(
      loopStep.with["leg-timeout-minutes"],
      first.with["leg-timeout-minutes"],
    );
    // 3 minutes for the one install, then each later chunk's leg and a minute.
    for (const [n, leg, expected] of [
      ["2", "11", 15],
      ["5", "11", 51],
      ["20", "13", 269],
    ]) {
      const dir = makeTemporaryDirectory("pr-review-cli-chunks-compose-");
      const outputs = await runScript(compose, {
        LANE: "code",
        MODEL: "sonnet",
        EFFORT: "high",
        MAX_TURNS: "30",
        MODEL_ARGS: "",
        CLI_VERSION: "latest",
        REPOSITORY: "o/r",
        PR_NUMBER: "7",
        HEAD_SHA: "a".repeat(40),
        HOLD_PATHS: "",
        RUNNER_TEMP: dir,
        CHUNKS: n,
        CHUNK_FILES: Array(Number(n)).fill("1").join(","),
        LEG_MINUTES: leg,
        MAX_CHUNKS: workflow.env.MAX_CHUNKS,
      });
      assert.equal(outputs["loop-minutes"], String(expected), n);
      assert.equal(
        minutes(loopStep["timeout-minutes"], {
          steps: { compose: { outputs } },
        }),
        expected,
      );
    }
  }
});

test("each leg's job limit holds every step's limit at the chunk ceiling, inside GitHub's 6 hours", () => {
  const ceiling = Number(workflow.env.MAX_CHUNKS);
  for (const job of LEGS) {
    for (const [lane, leg] of [
      ["code", 11],
      ["security", 13],
    ]) {
      const atCeiling = 3 + (ceiling - 1) * (leg + 1);
      const total = job.steps.reduce(
        (sum, s) =>
          sum +
          minutes(s["timeout-minutes"], {
            inputs: { lane },
            steps: {
              compose: { outputs: { "loop-minutes": String(atCeiling) } },
            },
          }),
        0,
      );
      const limit = minutes(job["timeout-minutes"], { inputs: { lane } });
      assert.ok(
        total + 5 <= limit,
        `${job.name} (${lane}): steps ${total}, job ${limit}`,
      );
      assert.ok(limit <= 360, `${job.name} (${lane}): ${limit} minutes`);
    }
  }
});

// --- merging the chunks' comments ---

const finding = (path, line, level, text, pad = 0) => ({
  path,
  line,
  side: "RIGHT",
  body: `severity: ${level}\n\n${text}${"x".repeat(pad)}`,
});
const chunkReview = (comments, extra = {}) => ({
  findings: comments.length,
  files_read: 2,
  summary: "critical-findings: 0",
  comments,
  ...extra,
});
const listedLines = (summary) =>
  summary
    .split("\n")
    .filter((line) => /^- (CRITICAL|IMPORTANT|SUGGESTION) `/u.test(line));
// Listed findings, one a line at an excerpt tier, several a line when grouped
// by path at the last tier.
const listedCount = (summary) =>
  summary
    .split("\n")
    .filter((line) => /^- (?:(CRITICAL|IMPORTANT|SUGGESTION) )?`/u.test(line))
    .reduce(
      (sum, line) =>
        sum +
        (/^- `/u.test(line)
          ? [...line.matchAll(/ line [0-9]+ \((RIGHT|LEFT)\)/gu)].length
          : 1),
      0,
    );
const criticalLines = (summary) =>
  [...summary.matchAll(/^critical-findings: ([0-9]+)$/gmu)].map((m) =>
    Number(m[1]),
  );

test("two chunks reporting the same finding yield one comment", async () => {
  const same = finding("a.js", 3, "IMPORTANT", "Off by one.");
  for (const job of LEGS) {
    const outputs = await extractChunked(job, 2, {
      reviews: {
        1: chunkReview([same]),
        2: chunkReview([{ ...same, body: `${same.body}  \n` }]),
      },
    });
    assert.equal(outputs.verdict, "complete", job.name);
    const review = JSON.parse(outputs.review);
    assert.deepEqual(review.comments, [same]);
    assert.equal(review.findings, 1);
    assert.deepEqual(listedLines(review.summary), []);
  }
});

test("two different findings on one line, and one text at two lines, all post inline whole", async () => {
  const first = finding("a.js", 3, "IMPORTANT", "Off by one.");
  const sameLine = finding("a.js", 3, "SUGGESTION", "Rename this.");
  const sameText = finding("b.js", 9, "IMPORTANT", "Off by one.");
  for (const job of LEGS) {
    const outputs = await extractChunked(job, 2, {
      reviews: {
        1: chunkReview([first]),
        2: chunkReview([sameLine, sameText]),
      },
    });
    const review = JSON.parse(outputs.review);
    assert.deepEqual(review.comments, [first, sameText, sameLine]);
    assert.equal(review.findings, 3);
    assert.deepEqual(listedCount(review.summary), 0);
    // The chunks' critical-findings lines merge into one.
    assert.deepEqual(criticalLines(review.summary), [0]);
  }
});

test("30 findings keep 25 inline, most severe first, and list the other 5 with their CRITICAL count", async () => {
  // Two chunks of 12 and one of 6: 3 CRITICAL, 7 IMPORTANT, 20 SUGGESTION.
  const levels = [
    ...Array(20).fill("SUGGESTION"),
    ...Array(7).fill("IMPORTANT"),
    ...Array(3).fill("CRITICAL"),
  ];
  const all = levels.map((level, i) =>
    finding(`f${i}.js`, i + 1, level, `Finding ${i}.`),
  );
  for (const job of LEGS) {
    const outputs = await extractChunked(job, 3, {
      reviews: {
        1: chunkReview(all.slice(0, 12)),
        2: chunkReview(all.slice(12, 24)),
        3: chunkReview(all.slice(24)),
      },
    });
    assert.equal(outputs.verdict, "complete", job.name);
    const review = JSON.parse(outputs.review);
    assert.equal(review.comments.length, 25);
    assert.equal(review.findings, 30);
    // Every CRITICAL and IMPORTANT finding is inline; 5 suggestions are listed.
    assert.deepEqual(
      review.comments.slice(0, 10).map((c) => c.path),
      [
        "f27.js",
        "f28.js",
        "f29.js",
        "f20.js",
        "f21.js",
        "f22.js",
        "f23.js",
        "f24.js",
        "f25.js",
        "f26.js",
      ],
    );
    const listed = listedLines(review.summary);
    assert.equal(listed.length, 5);
    for (const line of listed)
      assert.match(line, /^- SUGGESTION `f(1[5-9])\.js:[0-9]+` \(RIGHT\): /u);
    // One line: the chunks' lines and the listed CRITICAL findings, none.
    assert.deepEqual(criticalLines(review.summary), [0]);
    // A listed CRITICAL finding is counted where a merge gate reads it.
    const severe = Array.from({ length: 27 }, (_, i) =>
      finding(`c${i}.js`, 1, "CRITICAL", `Severe ${i}.`),
    );
    const critical = await extractChunked(job, 3, {
      reviews: {
        1: chunkReview(severe.slice(0, 12)),
        2: chunkReview(severe.slice(12, 24)),
        3: chunkReview(severe.slice(24)),
      },
    });
    const merged = JSON.parse(critical.review);
    assert.equal(merged.comments.length, 25);
    assert.deepEqual(
      listedLines(merged.summary).map((line) => line.split(":")[0]),
      ["- CRITICAL `c25.js", "- CRITICAL `c26.js"],
    );
    assert.deepEqual(criticalLines(merged.summary), [2]);
  }
});

test("summary-only findings with no critical-findings line stay counted as CRITICAL once comments are listed", async () => {
  const all = Array.from({ length: 26 }, (_, i) =>
    finding(`f${i}.js`, 1, "SUGGESTION", `Finding ${i}.`),
  );
  for (const job of LEGS) {
    const outputs = await extractChunked(job, 3, {
      reviews: {
        1: chunkReview(all.slice(0, 12), {
          summary: "One cross-file finding.",
          findings: 13,
        }),
        2: chunkReview(all.slice(12, 24), { summary: "Nothing else." }),
        3: chunkReview(all.slice(24), { summary: "Nothing else." }),
      },
    });
    const review = JSON.parse(outputs.review);
    assert.equal(listedLines(review.summary).length, 1);
    // No chunk counted its summary findings, so the one summary finding
    // counts as CRITICAL, as publish-review would count it.
    assert.deepEqual(criticalLines(review.summary), [1]);
  }
});

test("20 chunks every one at its caps merge into a review under 100 KB that lists every finding", async () => {
  const comments = Number(workflow.env.CHUNK_COMMENTS);
  const chars = Number(workflow.env.CHUNK_SUMMARY_CHARS);
  for (const job of LEGS) {
    const reviews = {};
    for (let k = 1; k <= 20; k++) {
      reviews[k] = chunkReview(
        Array.from({ length: comments }, (_, i) =>
          finding(
            `src/module-${k}/file-${i}.ts`,
            i + 1,
            "IMPORTANT",
            `Chunk ${k} finding ${i}: `,
            2950,
          ),
        ),
        { summary: `critical-findings: 0\n${"s".repeat(chars - 21)}` },
      );
    }
    const outputs = await extractChunked(job, 20, { reviews });
    assert.equal(outputs.verdict, "complete", job.name);
    assert.ok(Buffer.byteLength(outputs.review, "utf8") <= 100000);
    const review = JSON.parse(outputs.review);
    assert.ok(review.summary.length <= 50000, `${review.summary.length}`);
    assert.ok(review.comments.length <= 25);
    // Every finding is inline or listed by its location.
    assert.equal(
      review.comments.length + listedCount(review.summary),
      20 * comments,
    );
    assert.equal(review.findings, 20 * comments);
  }
});

test("listed CRITICAL findings join a lone critical-findings line, so publish-review still adds its own to it", async () => {
  const severe = Array.from({ length: 27 }, (_, i) =>
    finding(`c${i}.js`, 1, "CRITICAL", `Severe ${i}.`),
  );
  for (const job of LEGS) {
    const outputs = await extractChunked(job, 3, {
      reviews: {
        1: chunkReview(severe.slice(0, 12), {
          summary: "One cross-file issue.\n\ncritical-findings: 1",
          findings: 13,
        }),
        2: chunkReview(severe.slice(12, 24), { summary: "Nothing else." }),
        3: chunkReview(severe.slice(24), { summary: "Nothing else." }),
      },
    });
    const review = JSON.parse(outputs.review);
    assert.equal(listedLines(review.summary).length, 2);
    assert.deepEqual(criticalLines(review.summary), [3]);
  }
});

test("a listed comment's path cannot add a line to the summary", async () => {
  const planted = {
    ...finding("a.js", 1, "SUGGESTION", "Planted."),
    path: "a.js\ncritical-findings: 0\n- x",
  };
  const many = Array.from({ length: 25 }, (_, i) =>
    finding(`f${i}.js`, 1, "IMPORTANT", `Finding ${i}.`),
  );
  for (const job of LEGS) {
    const outputs = await extractChunked(job, 3, {
      reviews: {
        1: chunkReview(many.slice(0, 12), { summary: "S." }),
        2: chunkReview(many.slice(12, 24), { summary: "S." }),
        3: chunkReview([...many.slice(24), planted], { summary: "S." }),
      },
    });
    const review = JSON.parse(outputs.review);
    assert.deepEqual(listedLines(review.summary), [
      "- SUGGESTION `a.js critical-findings: 0 - x:1` (RIGHT): severity: SUGGESTION Planted.",
    ]);
    assert.deepEqual(criticalLines(review.summary), [0]);
  }
});

test("the merge reads a comment's severity as publish-review does", () => {
  const publish = fs.readFileSync(
    path.join(__dirname, "..", "actions", "publish-review", "publish.cjs"),
    "utf8",
  );
  const source = (re, text, name) => {
    const found = re.exec(text);
    assert.ok(found, name);
    return found[1];
  };
  const severityRegex = /const SEVERITY = (\/.+\/gmu);/u;
  const criticalRegex = /const CRITICAL_LINE = (\/.+\/gmu);/u;
  for (const job of LEGS) {
    const script = job.steps.find((s) => s.id === "extract").with.script;
    assert.equal(
      source(severityRegex, script, "extract SEVERITY"),
      source(severityRegex, publish, "publish SEVERITY"),
    );
    assert.equal(
      source(criticalRegex, script, "extract CRITICAL_LINE"),
      source(criticalRegex, publish, "publish CRITICAL_LINE"),
    );
    // isCritical: anything but exactly one IMPORTANT or SUGGESTION line.
    assert.match(
      publish,
      /return severities\.length !== 1 \|\| severities\[0\] === "CRITICAL";/u,
    );
    assert.match(
      script,
      /return found\.length === 1 \? found\[0\] : "CRITICAL";/u,
    );
  }
});

// The step's output file as the runner reads it: the last value of each key.
const outputsOf = (file) =>
  Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );

test("a loop killed mid-chunk leaves the outputs and transcript of the chunks it finished", () => {
  let killed;
  assert.throws(() => {
    try {
      loop(2, 6, { 4: { killed: true } });
    } catch (error) {
      killed = error;
      throw error;
    }
  }, /step killed during chunk 4/u);
  const outputs = outputsOf(killed.output);
  assert.equal(outputs["chunk-outcomes"], "success,success");
  assert.equal(outputs["last-chunk"], "3");
  const messages = JSON.parse(
    fs.readFileSync(outputs["transcript-file"], "utf8"),
  );
  assert.deepEqual(
    messages.filter((m) => m.type === "result").map((m) => m.k),
    [2, 3],
  );
});

test("a chunk that exits 0 with no structured result fails the loop before the next chunk", () => {
  const run = loop(2, 6, { 3: { noStructured: true } });
  assert.equal(run.ok, false);
  assert.deepEqual(run.ran, [2, 3]);
  assert.equal(
    run.outputs["chunk-outcomes"],
    "success,failure,skipped,skipped,skipped",
  );
  assert.equal(run.outputs["lane-class"], "other");
});

test("comment 26 keeps its full text in the list while the budget allows", async () => {
  const all = Array.from({ length: 26 }, (_, i) =>
    finding(`f${i}.js`, 1, "SUGGESTION", `Finding ${i}: `, 900),
  );
  for (const job of LEGS) {
    const outputs = await extractChunked(job, 3, {
      reviews: {
        1: chunkReview(all.slice(0, 12)),
        2: chunkReview(all.slice(12, 24)),
        3: chunkReview(all.slice(24)),
      },
    });
    const review = JSON.parse(outputs.review);
    assert.equal(review.comments.length, 25);
    assert.deepEqual(listedLines(review.summary), [
      `- SUGGESTION \`f25.js:1\` (RIGHT): severity: SUGGESTION Finding 25: ${"x".repeat(900)}`,
    ]);
  }
});

const PUBLISH = path.join(
  __dirname,
  "..",
  "actions",
  "publish-review",
  "publish.cjs",
);
const publishReview = require(PUBLISH);
const PUBLISH_MAX = Number(
  /^const MAX_SUMMARY = ([0-9]+);$/mu.exec(fs.readFileSync(PUBLISH, "utf8"))[1],
);

// The summary publish-review posts when one bad anchor moves every inline
// comment to it; it slices at its MAX_SUMMARY, so a shorter text lost nothing.
function demotedSummary(review) {
  const lane = "claude-review";
  const unanchored = review.comments.map((c) => ({
    ...c,
    body: publishReview.commentBody(c.body, lane),
  }));
  return publishReview.summaryText(review, unanchored, lane);
}

test("the merge's summary limit is publish-review's, read from its file", () => {
  for (const job of LEGS) {
    const script = job.steps.find((s) => s.id === "extract").with.script;
    assert.equal(
      Number(/const PUBLISH_SUMMARY = ([0-9]+);/u.exec(script)?.[1]),
      PUBLISH_MAX,
    );
  }
});

test("a merged review publish-review would demote whole still fits its summary limit, or is incomplete saying why", async () => {
  // Two chunks of 12 comments of about 2900 characters: about 70000
  // characters demoted, over the limit, so the least severe move to the list.
  const big = (k) =>
    Array.from({ length: 12 }, (_, i) =>
      finding(
        `c${k}.js`,
        i + 1,
        i < 2 ? "CRITICAL" : "IMPORTANT",
        `Chunk ${k} finding ${i}: `,
        2880,
      ),
    );
  for (const job of LEGS) {
    const outputs = await extractChunked(job, 2, {
      reviews: { 1: chunkReview(big(1)), 2: chunkReview(big(2)) },
    });
    assert.equal(outputs.verdict, "complete", job.name);
    const review = JSON.parse(outputs.review);
    assert.ok(demotedSummary(review).length < PUBLISH_MAX);
    // Every CRITICAL finding stayed inline; every finding is inline or listed.
    assert.equal(
      review.comments.filter((c) => c.body.includes("CRITICAL")).length,
      4,
    );
    assert.equal(review.comments.length + listedCount(review.summary), 24);
  }
});

test("each chunk's summary cap is the larger of the fixed cap and its share of one review's, and a longer summary is incomplete", async () => {
  for (const job of LEGS) {
    const compose = job.steps.find((s) => s.id === "compose");
    for (const [n, cap] of [
      [2, 10000],
      [13, 1538],
      [14, 1500],
      [20, 1500],
    ]) {
      const dir = makeTemporaryDirectory("pr-review-cli-chunks-caps-");
      const outputs = await runScript(compose, {
        LANE: "code",
        MODEL: "sonnet",
        EFFORT: "high",
        MAX_TURNS: "30",
        MODEL_ARGS: "",
        CLI_VERSION: "latest",
        REPOSITORY: "o/r",
        PR_NUMBER: "7",
        HEAD_SHA: "a".repeat(40),
        HOLD_PATHS: "",
        RUNNER_TEMP: dir,
        CHUNKS: String(n),
        CHUNK_FILES: Array(n).fill("1").join(","),
        LEG_MINUTES: "11",
        MAX_CHUNKS: workflow.env.MAX_CHUNKS,
        CHUNK_SUMMARY_CHARS: workflow.env.CHUNK_SUMMARY_CHARS,
        CHUNK_COMMENTS: workflow.env.CHUNK_COMMENTS,
      });
      const schema = JSON.parse(
        fs.readFileSync(outputs["schema-file"], "utf8"),
      );
      assert.equal(schema.properties.summary.maxLength, cap, `${n} chunks`);
    }
    const over = await extractChunked(job, 20, {
      reviews: { 7: chunkReview([], { summary: "s".repeat(1501) }) },
    });
    assert.equal(
      over.verdict,
      "chunk 7 of 20: the review's summary is over its 1500-character cap",
      job.name,
    );
    assert.equal(over.review, undefined);
  }
});

test("the chunks' critical-findings lines merge into one line a merge gate reads", async () => {
  for (const job of LEGS) {
    const outputs = await extractChunked(job, 3, {
      reviews: {
        1: chunkReview([], { summary: "One.\n\ncritical-findings: 1" }),
        2: chunkReview([], { summary: "Two.\n\ncritical-findings: 2" }),
        // No line: its one summary-only finding counts as CRITICAL.
        3: chunkReview([], { summary: "Three.", findings: 1 }),
      },
    });
    const review = JSON.parse(outputs.review);
    assert.deepEqual(criticalLines(review.summary), [4]);
  }
});

test("20 chunks at their caps with 120-character paths fit once the list groups by path, and never drop a finding", async () => {
  const comments = Number(workflow.env.CHUNK_COMMENTS);
  const chars = Number(workflow.env.CHUNK_SUMMARY_CHARS);
  const long = (k, f) =>
    `src/${"d".repeat(100)}/m${String(k).padStart(2, "0")}/f${f}.ts`.padEnd(
      120,
      "x",
    );
  const run = (job, fileOf) => {
    const reviews = {};
    for (let k = 1; k <= 20; k++) {
      reviews[k] = chunkReview(
        Array.from({ length: comments }, (_, i) =>
          finding(
            fileOf(k, i),
            i + 1,
            "IMPORTANT",
            `Chunk ${k} finding ${i}: `,
            2950,
          ),
        ),
        { summary: `critical-findings: 0\n${"s".repeat(chars - 21)}` },
      );
    }
    return extractChunked(job, 20, { reviews });
  };
  for (const job of LEGS) {
    // Three files a chunk: the grouped list fits.
    const grouped = await run(job, (k, i) => long(k, i % 3));
    assert.equal(grouped.verdict, "complete", job.name);
    const review = JSON.parse(grouped.review);
    assert.equal(
      review.comments.length + listedCount(review.summary),
      20 * comments,
    );
    assert.ok(demotedSummary(review).length < PUBLISH_MAX);
    // A file a comment: no grouping fits, so it is incomplete, saying so.
    const unique = await run(job, (k, i) => long(k, i));
    assert.match(
      unique.verdict,
      /^the merged review does not fit: 240 findings need [0-9]+ summary characters with every inline comment demoted, over the [0-9]+ publish-review keeps$/u,
    );
    assert.equal(unique.review, undefined);
  }
});
