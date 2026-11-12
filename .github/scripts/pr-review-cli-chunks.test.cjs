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
const { parseWorkflow } = require("./workflow-yaml.cjs");

const WORKFLOW_FILE = path.join(
  __dirname,
  "..",
  "workflows",
  "pr-review-cli.yml",
);
const text = fs.readFileSync(WORKFLOW_FILE, "utf8");
const workflow = parseWorkflow(text);
const LEGS = ["review-key", "review-subscription", "review-fallback"].map(
  (name) => workflow.jobs[name],
);
const LIMITS = ["MAX_CHUNK_FILES", "READ_BUDGET", "MAX_CHUNKS"];

test("each chunk limit is defined once, in the workflow env, and read from there", () => {
  for (const name of LIMITS) {
    assert.match(workflow.env[name] ?? "", /^[1-9][0-9]*$/u, name);
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
      assert.doesNotMatch(body, /\b300000\b/u, `${job.name} / ${s.name}`);
    }
  }
  // The data floor is one file's even share of one review's read budget.
  assert.equal(
    Number(workflow.env.DATA_FLOOR_BYTES),
    Math.floor(
      Number(workflow.env.READ_BUDGET) / Number(workflow.env.MAX_CHUNK_FILES),
    ),
  );
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

// The split step as shipped, over a diff of `files` added one-line files.
function split(job, files, env = {}) {
  const dir = makeTemporaryDirectory("pr-review-cli-chunks-split-");
  const source = path.join(dir, "source");
  const scripts = path.join(source, ".github", "scripts", "pr-review-main");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "split-diff.py"), SPLITTER);
  const work = path.join(dir, "work");
  fs.mkdirSync(path.join(work, ".claude-lane"), { recursive: true });
  const diff = Array.from(
    { length: files },
    (_, i) => `diff --git a/f${i} b/f${i}\n+line ${i}\n`,
  ).join("");
  fs.writeFileSync(path.join(work, ".claude-lane", "pr.diff"), diff);
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
      ...Object.fromEntries(LIMITS.map((name) => [name, workflow.env[name]])),
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
