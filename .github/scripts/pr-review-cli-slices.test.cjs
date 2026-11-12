"use strict";

// pr-review-cli.yml's split step: a file whose diff section is larger than
// one chunk's read budget is cut at its `@@` hunk boundaries into pieces of
// at most that budget, each piece carrying the file's header, so every hunk
// of every file reaches a review. A diff with no such file reaches the
// splitter byte for byte as before.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");
const reads = require("../actions/check-review-reads/reads.cjs");

const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(__dirname, "..", "workflows", "pr-review-cli.yml"),
    "utf8",
  ),
);
const LEGS = ["review-key", "review-subscription", "review-fallback"].map(
  (name) => workflow.jobs[name],
);
const LIMITS = ["MAX_CHUNK_FILES", "READ_BUDGET", "MAX_CHUNKS"];

// A stand-in for claude-code-plugins' split-diff.py with its documented
// contract (module docstring): greedy chunks of whole `diff --git` sections,
// at most max-bytes and max-files each; a section over max-bytes, or more
// than max-chunks chunks, exits 3 naming the reason. It copies the patch it
// was given to $SPLIT_RECORD.
const SPLITTER = [
  "import os, sys",
  "from pathlib import Path",
  "patch, out, max_bytes, max_chunks, manifest, _ = sys.argv[1:7]",
  "max_files = int(sys.argv[7]) if len(sys.argv) > 7 else 0",
  "data = Path(patch).read_bytes()",
  "Path(os.environ['SPLIT_RECORD']).write_bytes(data)",
  "files = []",
  "for line in data.splitlines(keepends=True):",
  "    if not files or line.startswith(b'diff --git '):",
  "        files.append(b'')",
  "    files[-1] += line",
  "over = [f.split(b'\\n')[0].decode() for f in files if len(f) > int(max_bytes)]",
  "if over:",
  "    print(f'split-diff: a file is larger than one chunk of {max_bytes} bytes: {over}', file=sys.stderr)",
  "    sys.exit(3)",
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

// The split step of `job` over `diff` (a string or bytes) as the scope's
// diff; `env` overrides the workflow's limits and the step's inputs.
function split(job, diff, env = {}, prepare = () => {}) {
  const dir = makeTemporaryDirectory("pr-review-cli-slices-");
  const scripts = path.join(
    dir,
    "source",
    ".github",
    "scripts",
    "pr-review-main",
  );
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "split-diff.py"), SPLITTER);
  const work = path.join(dir, "work");
  fs.mkdirSync(path.join(work, ".claude-lane"), { recursive: true });
  fs.writeFileSync(path.join(work, ".claude-lane", "pr.diff"), diff);
  prepare(work);
  const output = path.join(dir, "out");
  fs.writeFileSync(output, "");
  const record = path.join(dir, "splitter-input.patch");
  const s = job.steps.find((candidate) => candidate.id === "split");
  const result = spawnSync("bash", ["-e", "-c", s.run], {
    cwd: work,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SOURCE: path.join(dir, "source"),
      SCOPE_DIFF: ".claude-lane/pr.diff",
      SCOPE_BYTES: String(Buffer.byteLength(diff)),
      CHUNK_DIR: s.env.CHUNK_DIR,
      SCOPE: "whole",
      COPIES: "0",
      GITHUB_OUTPUT: output,
      SPLIT_RECORD: record,
      ...Object.fromEntries(LIMITS.map((name) => [name, workflow.env[name]])),
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const chunkDir = path.join(work, s.env.CHUNK_DIR);
  const chunk = (k) =>
    fs.readFileSync(path.join(chunkDir, `chunk-${k}.patch`), "utf8");
  return {
    outputs: Object.fromEntries(
      fs
        .readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    ),
    stdout: result.stdout,
    received: fs.existsSync(record) ? fs.readFileSync(record) : null,
    chunk,
    chunkDir,
    work,
  };
}

const HEADER = (file) =>
  [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    "",
  ].join("\n");
// Hunk n: a header naming its lines, one removed line and one added line of
// `width` characters.
const HUNK = (n, width) =>
  `@@ -${10 * n},1 +${10 * n},1 @@ context ${n}\n-old ${n}\n+${String(n % 10).repeat(width)}\n`;
const BIG = ".github/workflows/big.yml";
const SMALL = "src/small.js";
const SMALL_DIFF = `${HEADER(SMALL)}@@ -1 +1 @@\n-a\n+b\n`;

test("a file over one chunk's budget is cut at its hunks, each piece under its header, every hunk in order", () => {
  // A 1000-byte budget: the header and hunks 1 and 2 fit one piece (about
  // 820 bytes); hunk 3 starts the next, which the small file joins.
  const hunks = [1, 2, 3].map((n) => HUNK(n, 300));
  const diff = `${HEADER(BIG)}${hunks.join("")}${SMALL_DIFF}`;
  for (const job of LEGS) {
    const cut = split(job, diff, { READ_BUDGET: "1000" });
    assert.equal(cut.outputs.chunks, "2", job.name);
    assert.equal(cut.chunk(1), `${HEADER(BIG)}${hunks[0]}${hunks[1]}`);
    assert.equal(cut.chunk(2), `${HEADER(BIG)}${hunks[2]}${SMALL_DIFF}`);
    // The sliced file counts once, in the chunk holding its last piece, so
    // the chunks' counts still add up to the files in scope.
    assert.equal(cut.outputs.files, "0,2", job.name);
    assert.match(
      cut.stdout,
      /^::notice title=pr-review-cli chunks::chunks=2 bytes=[0-9]+ distinct-bytes=[0-9]+ files=0,2 excluded=0 sliced=1$/mu,
    );
    assert.equal(cut.outputs["over-chunks"], undefined);
  }
});

test("a single hunk over the budget is not cut: the review stays partial, the file and the hunk's size named", () => {
  const hunk = HUNK(1, 1200);
  const diff = `${HEADER(BIG)}${hunk}${SMALL_DIFF}`;
  for (const job of LEGS) {
    const cut = split(job, diff, { READ_BUDGET: "1000" });
    assert.equal(cut.outputs.chunks, "1", job.name);
    assert.equal(cut.outputs.files, undefined);
    assert.ok(
      cut.stdout.includes(
        `::warning::${BIG}: one hunk of ${Buffer.byteLength(HEADER(BIG) + hunk)} bytes with its header is larger than one chunk of 1000 bytes, so the file cannot be cut at its hunks; the diff is reviewed unsplit, as a partial review`,
      ),
      cut.stdout,
    );
    assert.match(
      cut.stdout,
      /^::warning::the diff in scope .* did not split .*partial review$/mu,
    );
  }
});

test("a path that could break an annotation is not printed", () => {
  const odd = "src/we ird%0A::x.js";
  const diff = `${HEADER(odd)}${HUNK(1, 1200)}`;
  const cut = split(LEGS[0], diff, { READ_BUDGET: "1000" });
  assert.match(
    cut.stdout,
    /^::warning::a file: one hunk of [0-9]+ bytes with its header is larger/mu,
  );
  assert.doesNotMatch(cut.stdout, /we ird/u);
});

test("slices past the chunk ceiling keep the review partial, the count and the ceiling named", () => {
  const ceiling = Number(workflow.env.MAX_CHUNKS);
  // One hunk a piece: two hunks with the header are over the budget.
  const n = ceiling + 5;
  const diff =
    HEADER(BIG) +
    Array.from({ length: n }, (_, i) => HUNK(i + 1, 500)).join("");
  for (const job of LEGS) {
    const cut = split(job, diff, { READ_BUDGET: "1000" });
    assert.equal(cut.outputs.chunks, "1", job.name);
    assert.equal(
      cut.outputs["over-chunks"],
      String(n),
      `${job.name}: ${cut.stdout}`,
    );
    assert.match(
      cut.stdout,
      new RegExp(
        `needs ${n} chunks .*, more than the ceiling of ${ceiling}; it is reviewed unsplit, as a partial review$`,
        "mu",
      ),
    );
  }
});

test("a deleted file over the budget is cut too, and counts no file", () => {
  const header = `diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/gone.txt\n+++ /dev/null\n`;
  const hunks = [1, 2].map((n) => HUNK(n, 600));
  const cut = split(LEGS[0], `${header}${hunks.join("")}${SMALL_DIFF}`, {
    READ_BUDGET: "1000",
  });
  assert.equal(cut.chunk(1), `${header}${hunks[0]}`);
  assert.equal(cut.chunk(2), `${header}${hunks[1]}${SMALL_DIFF}`);
  assert.equal(cut.outputs.files, "0,1");
});

// --- no change for a diff that fits today ---

test("with no file over the budget the splitter gets the step's input byte for byte, and the outputs are as before", () => {
  const many = Array.from(
    { length: 81 },
    (_, i) => `diff --git a/f${i} b/f${i}\n+line ${i}\n`,
  ).join("");
  // Five files of about 400 bytes: over a 1000-byte budget together, each under it.
  const five = Array.from(
    { length: 5 },
    (_, i) => `${HEADER(`f${i}`)}${HUNK(1, 300)}`,
  ).join("");
  // A file of exactly the budget, last, with no newline at the diff's end.
  const exact = `${HEADER("exact")}@@ -1 +1 @@\n-a\n+${"e".repeat(700)}\n\\ No newline at end of file`;
  const fixtures = [
    ["81 small files", many, {}],
    ["five files over the budget together", five, { READ_BUDGET: "1000" }],
    [
      "a file at the budget with no final newline",
      `${SMALL_DIFF}${exact}`,
      { READ_BUDGET: String(Buffer.byteLength(exact)) },
    ],
  ];
  for (const job of LEGS) {
    for (const [name, diff, env] of fixtures) {
      const cut = split(job, diff, env);
      assert.ok(cut.received, `${job.name}: ${name}: the splitter ran`);
      assert.ok(cut.received.equals(Buffer.from(diff)), `${job.name}: ${name}`);
      // The chunk directory holds only what the split wrote before.
      for (const entry of fs.readdirSync(cut.chunkDir))
        assert.match(
          entry,
          /^(?:chunk-[0-9]+\.patch|manifest\.txt|split-error\.txt)$/u,
          name,
        );
      assert.doesNotMatch(cut.stdout, /sliced=|cannot be cut/u, name);
      assert.equal(cut.outputs.sliced, undefined, name);
    }
  }
  // The 81-file split, as the existing chunk tests count it.
  const cut = split(LEGS[0], many);
  assert.equal(cut.outputs.chunks, "3");
  assert.equal(cut.outputs.files, "40,40,1");
  assert.match(
    cut.stdout,
    /^::notice title=pr-review-cli chunks::chunks=3 bytes=[0-9]+ distinct-bytes=[0-9]+ files=40,40,1 excluded=0$/mu,
  );
});

test("with verified renames left out, the splitter gets the distinct diff byte for byte", () => {
  const renames = Array.from({ length: 3 }, (_, i) => [`old${i}`, `new${i}`]);
  const moved = renames
    .map(
      ([a, b]) =>
        `diff --git a/${a} b/${b}\nsimilarity index 100%\nrename from ${a}\nrename to ${b}\n`,
    )
    .join("");
  const rest = Array.from(
    { length: 50 },
    (_, i) => `diff --git a/f${i} b/f${i}\n+line ${i}\n`,
  ).join("");
  const cut = split(LEGS[0], moved + rest, { RENAMES: "3" }, (work) =>
    fs.writeFileSync(
      path.join(work, ".claude-lane", "renames.txt"),
      renames.map((pair) => `${pair.join("\t")}\n`).join(""),
    ),
  );
  assert.ok(cut.received.equals(Buffer.from(rest)));
  assert.equal(cut.outputs.files, "40,10");
  assert.equal(cut.outputs.excluded, "3");
});

// --- the extract step's read count over the split step's chunks ---

const { isPartial } = require("../actions/publish-review/publish.cjs");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// The extract step of `job` over the chunks `cut` wrote, with the counts
// and piece names the compose step passes on (`composed`, its outputs; none
// when omitted) and a read budget of `budget`, chunk k's review returning files_read `filesRead[k - 1]`.
// Returns its outputs and the warnings it wrote.
async function extract(
  job,
  cut,
  filesRead,
  wholeFiles,
  composed = {},
  budget = "1000",
) {
  const dir = makeTemporaryDirectory("pr-review-cli-slices-extract-");
  const log = JSON.stringify({
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: 1,
    started_at: "2026-11-12T00:00:00.000Z",
    ended_at: "2026-11-12T00:01:00.000Z",
  });
  const review = (n) =>
    JSON.stringify({
      findings: 0,
      files_read: n,
      summary: "Nothing found.",
      comments: [],
    });
  fs.writeFileSync(path.join(dir, "structured.json"), review(filesRead[0]));
  fs.writeFileSync(path.join(dir, "log.jsonl"), `${log}\n`);
  for (let k = 2; k <= filesRead.length; k++) {
    fs.mkdirSync(path.join(dir, `chunk-${k}`));
    fs.writeFileSync(
      path.join(dir, `chunk-${k}`, "structured.json"),
      review(filesRead[k - 1]),
    );
    fs.writeFileSync(path.join(dir, `chunk-${k}`, "log.jsonl"), `${log}\n`);
  }
  const values = {
    STRUCTURED_FILE: path.join(dir, "structured.json"),
    LOG_FILE: path.join(dir, "log.jsonl"),
    RESULTS_DIR: dir,
    MODE_OK: "true",
    SCOPE: "whole",
    FULL_DIFF: "true",
    WHOLE_FILES: String(wholeFiles),
    SCOPE_DIFF: path.join(cut.work, ".claude-lane", "pr.diff"),
    SCOPE_BYTES: String(
      fs.statSync(path.join(cut.work, ".claude-lane", "pr.diff")).size,
    ),
    CHUNKS: cut.outputs.chunks,
    CHUNK_FILES: composed["chunk-files"] ?? cut.outputs.files,
    CHUNK_PIECES: composed["chunk-pieces"] ?? "",
    PIECE_NAMES: composed["chunk-piece-names"] ?? "",
    CHUNK_DIR: cut.chunkDir,
    CHUNK_OUTCOMES: Array(filesRead.length).fill("success").join(","),
    EXCLUDED: cut.outputs.excluded,
    ...Object.fromEntries(
      [...LIMITS, "CHUNK_SUMMARY_CHARS", "CHUNK_COMMENTS"].map((name) => [
        name,
        workflow.env[name],
      ]),
    ),
    READ_BUDGET: budget,
  };
  const outputs = {};
  const warnings = [];
  const saved = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, values);
  const summary = { addRaw: () => summary, write: async () => {} };
  try {
    await new AsyncFunction(
      "require",
      "core",
      job.steps.find((s) => s.id === "extract").with.script,
    )(require, {
      setOutput: (k, v) => {
        outputs[k] = v;
      },
      setFailed: (m) => {
        throw new Error(m);
      },
      info: () => {},
      warning: (m) => warnings.push(m),
      summary,
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { ...outputs, warnings };
}

test("a review of a cut file is complete only when every chunk holding a piece reports it read", async () => {
  // Chunk 1: the first two hunks of the big file; chunk 2: its last hunk and
  // the small file. Two files in scope; chunk 1 has one piece to read, chunk
  // 2 one piece and one file.
  const hunks = [1, 2, 3].map((n) => HUNK(n, 300));
  const diff = `${HEADER(BIG)}${hunks.join("")}${SMALL_DIFF}`;
  for (const job of LEGS) {
    const cut = split(job, diff, { READ_BUDGET: "1000" });
    assert.equal(cut.outputs.files, "0,2");
    const composed = (await compose(job, cut, cut.chunkDir)).outputs;
    assert.equal(composed["chunk-pieces"], "1,0");
    assert.deepEqual(JSON.parse(composed["chunk-piece-names"]), [
      [`piece 1 of 2 of ${BIG}`],
      [`piece 2 of 2 of ${BIG}`],
    ]);
    const all = await extract(job, cut, [1, 2], 2, composed);
    assert.equal(all.verdict, "complete", job.name);
    const whole = JSON.parse(all.review);
    assert.deepEqual(whole.coverage, { read: 2, changed: 2 });
    assert.equal(isPartial(whole.coverage), false);
    assert.doesNotMatch(whole.summary, /Cut files/u);
    assert.deepEqual(all.warnings, []);
    // Chunk 1 did not read the first piece: the last piece's chunk reading
    // everything cannot make the review complete.
    const first = await extract(job, cut, [0, 2], 2, composed);
    const firstReview = JSON.parse(first.review);
    assert.deepEqual(firstReview.coverage, { read: 1, changed: 2 });
    assert.equal(isPartial(firstReview.coverage), true);
    const named = `chunk 1 of 2 reported files_read 0 of 1 and holds piece 1 of 2 of ${BIG}`;
    assert.deepEqual(first.warnings, [`cut files not read whole: ${named}`]);
    assert.ok(
      firstReview.summary.endsWith(`\n\nCut files not read whole: ${named}.`),
      firstReview.summary,
    );
    // Chunk 2 read one of its two: partial, naming the piece it holds.
    const second = await extract(job, cut, [1, 1], 2, composed);
    assert.deepEqual(JSON.parse(second.review).coverage, {
      read: 1,
      changed: 2,
    });
    assert.deepEqual(second.warnings, [
      `cut files not read whole: chunk 2 of 2 reported files_read 1 of 2 and holds piece 2 of 2 of ${BIG}`,
    ]);
  }
});

test("a malformed piece count leaves no completed review", async () => {
  const diff = `${HEADER(BIG)}${[1, 2, 3].map((n) => HUNK(n, 300)).join("")}${SMALL_DIFF}`;
  const cut = split(LEGS[0], diff, { READ_BUDGET: "1000" });
  const out = await extract(LEGS[0], cut, [1, 2], 2, {
    "chunk-pieces": "1",
    "chunk-piece-names": "[]",
  });
  assert.equal(
    out.verdict,
    "the job could not read how many cut-file pieces each chunk holds",
  );
  assert.equal(out.review, undefined);
});

test("with no cut file the extract step's result is as before, whatever the piece inputs hold when empty", async () => {
  const many = Array.from(
    { length: 50 },
    (_, i) => `diff --git a/f${i} b/f${i}\n+line ${i}\n`,
  ).join("");
  for (const job of LEGS) {
    const cut = split(job, many);
    assert.equal(cut.outputs.files, "40,10");
    const composed = (await compose(job, cut, cut.chunkDir)).outputs;
    assert.equal(composed["chunk-pieces"], undefined);
    assert.equal(composed["chunk-piece-names"], undefined);
    for (const reads of [
      [40, 10],
      [39, 10],
    ]) {
      const out = await extract(
        job,
        cut,
        reads,
        50,
        composed,
        workflow.env.READ_BUDGET,
      );
      assert.ok(out.review, out.verdict);
      assert.deepEqual(JSON.parse(out.review).coverage, {
        read: reads[0] + reads[1],
        changed: 50,
      });
      assert.deepEqual(out.warnings, []);
    }
  }
});

// --- the per-file read check over a sliced file ---

// A Read result of every line of `file` but the 1-based line `skip`,
// numbered as the CLI prints them.
function readAll(id, file, skip = 0) {
  const lines = fs.readFileSync(file, "utf8").replace(/\n$/u, "").split("\n");
  return [
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id, name: "Read", input: { file_path: file } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: lines
              .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
              .filter((_, i) => i + 1 !== skip)
              .join("\n"),
          },
        ],
      },
    },
  ];
}

// The reads check in report mode over the cut-file fixture's two chunks:
// chunk 1 the big file's first piece, chunk 2 its second piece and the small
// file. `skip` drops one line of a chunk's Read; `tamper` edits the chunks
// first. Returns the lines the check wrote.
function checkCut({ skip = {}, tamper = () => {} } = {}) {
  const hunks = [1, 2, 3].map((n) => HUNK(n, 300));
  const diff = `${HEADER(BIG)}${hunks.join("")}${SMALL_DIFF}`;
  const cut = split(LEGS[0], diff, { READ_BUDGET: "1000" });
  const work = cut.work;
  fs.writeFileSync(
    path.join(work, ".claude-lane", "files.txt"),
    `${BIG}\n${SMALL}\n`,
  );
  tamper(cut.chunkDir);
  const chunk1 = path.join(cut.chunkDir, "chunk-1.patch");
  const chunk2 = path.join(cut.chunkDir, "chunk-2.patch");
  const results = path.join(work, "results");
  fs.mkdirSync(path.join(results, "chunk-2"), { recursive: true });
  const first = path.join(work, "execution-1.json");
  fs.writeFileSync(first, JSON.stringify(readAll("r1", chunk1, skip[1])));
  fs.writeFileSync(
    path.join(results, "chunk-2", "execution.json"),
    JSON.stringify(readAll("r2", chunk2, skip[2])),
  );
  const output = path.join(work, "reads-output");
  fs.writeFileSync(output, "");
  const lines = [];
  reads.main(
    {
      MODE: "report",
      VERDICT: "complete",
      REVIEW: JSON.stringify({
        findings: 0,
        coverage: { read: 2, changed: 2 },
        summary: "s",
        comments: [],
      }),
      SKIPPED: "0",
      CHUNKS: "2",
      EXECUTION_FILE: first,
      RESULTS_DIR: results,
      SCOPE_DIFF: ".claude-lane/pr.diff",
      FILE_LIST: ".claude-lane/files.txt",
      CHUNK_DIR: ".claude-lane/chunks",
      EXCLUDED: "0",
      GITHUB_OUTPUT: output,
      GITHUB_WORKSPACE: work,
    },
    { write: (line) => lines.push(line) },
  );
  // Report mode passes the extract step's verdict on unchanged.
  assert.match(fs.readFileSync(output, "utf8"), /^verdict=complete$/mu);
  return lines;
}

test("the reads check counts a cut file read when every piece was fully Read in the chunk that holds it", () => {
  assert.deepEqual(checkCut(), [
    "::notice title=pr-review-cli reads::listed=2 unread=0 mode=report",
  ]);
});

test("a piece Read short lists the cut file unread and names the piece", () => {
  // Line 7 of chunk 1 is its first hunk's added line.
  assert.deepEqual(checkCut({ skip: { 1: 7 } }), [
    "::notice title=pr-review-cli reads::listed=2 unread=1 mode=report",
    `::warning title=pr-review-cli reads::no Read showed the whole change of 1 listed file(s): ${BIG}`,
    `::warning title=pr-review-cli reads::cut files not read whole: piece 1 of 2 of ${BIG} (chunk 1)`,
  ]);
  // The last piece short: its own name.
  assert.deepEqual(checkCut({ skip: { 2: 6 } }).slice(1), [
    `::warning title=pr-review-cli reads::no Read showed the whole change of 1 listed file(s): ${BIG}`,
    `::warning title=pr-review-cli reads::cut files not read whole: piece 2 of 2 of ${BIG} (chunk 2)`,
  ]);
  // The small file short is an uncut file's result, as before.
  assert.deepEqual(checkCut({ skip: { 2: 9 } }), [
    "::notice title=pr-review-cli reads::listed=2 unread=1 mode=report",
    `::warning title=pr-review-cli reads::no Read showed the whole change of 1 listed file(s): ${SMALL}`,
  ]);
});

test("a piece no chunk holds lists the cut file unread, saying its pieces do not rebuild its change", () => {
  const drop = (dir) => {
    const file = path.join(dir, "chunk-2.patch");
    fs.writeFileSync(file, SMALL_DIFF);
  };
  assert.deepEqual(checkCut({ tamper: drop }), [
    "::notice title=pr-review-cli reads::listed=2 unread=1 mode=report",
    `::warning title=pr-review-cli reads::no Read showed the whole change of 1 listed file(s): ${BIG}`,
    `::warning title=pr-review-cli reads::cut files not read whole: ${BIG} (its pieces do not rebuild its change)`,
  ]);
});

// --- the chunk notes the compose step writes ---

// The compose step of `job` over the split `cut` (its chunk directory
// `chunkDir`); returns each chunk's prompt.
async function compose(job, cut, chunkDir) {
  const values = {
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
    RUNNER_TEMP: makeTemporaryDirectory("pr-review-cli-slices-compose-"),
    CHUNKS: cut.outputs.chunks,
    CHUNK_FILES: cut.outputs.files,
    CHUNK_DIR: chunkDir,
    LEG_MINUTES: "11",
    MAX_CHUNKS: workflow.env.MAX_CHUNKS,
    CHUNK_SUMMARY_CHARS: workflow.env.CHUNK_SUMMARY_CHARS,
    CHUNK_COMMENTS: workflow.env.CHUNK_COMMENTS,
  };
  const outputs = {};
  const saved = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, values);
  try {
    await new AsyncFunction(
      "require",
      "core",
      job.steps.find((s) => s.id === "compose").with.script,
    )(require, {
      setOutput: (k, v) => {
        outputs[k] = v;
      },
      setFailed: (m) => {
        throw new Error(m);
      },
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const prompts = Array.from({ length: Number(outputs.chunks) }, (_, i) =>
    fs.readFileSync(
      path.join(
        outputs["prompt-dir"],
        i === 0 ? "prompt.md" : `prompt-${i + 1}.md`,
      ),
      "utf8",
    ),
  );
  prompts.outputs = outputs;
  return prompts;
}

// Chunk 1: the big file's hunks 1 and 2; chunk 2: its hunk 3 and the small
// file; chunk 3: a file of about 600 bytes alone.
const MEDIUM = "src/medium.js";
const cutDiff = () =>
  `${HEADER(BIG)}${[1, 2, 3].map((n) => HUNK(n, 300)).join("")}${SMALL_DIFF}${HEADER(MEDIUM)}${HUNK(1, 500)}`;

test("a chunk holding a piece of a cut file names the path, the piece and its hunks, and asks for every hunk", async () => {
  for (const job of LEGS) {
    const cut = split(job, cutDiff(), { READ_BUDGET: "1000" });
    assert.equal(cut.outputs.files, "0,2,1", job.name);
    const prompts = await compose(job, cut, cut.chunkDir);
    const cutLine =
      "at file boundaries into 3 chunks, each file whole but a file larger than one chunk, which it cut at its hunks into pieces; each chunk gets its own review.";
    assert.ok(prompts[0].includes(cutLine), job.name);
    assert.ok(prompts[1].includes(cutLine), job.name);
    assert.ok(
      prompts[0].includes(
        [
          `PIECE 1 OF 2 of ${BIG}: this chunk holds 2 hunks, from @@ -10,1 +10,1 @@ to @@ -20,1 +20,1 @@, under the file's own diff --git header; its other hunks are in other chunks.`,
          "Read every hunk of this piece, and count it as one in files_read once you have.",
        ].join("\n"),
      ),
      prompts[0],
    );
    assert.ok(
      prompts[1].includes(
        [
          `PIECE 2 OF 2 of ${BIG}: this chunk holds the hunk @@ -30,1 +30,1 @@, under the file's own diff --git header; its other hunks are in other chunks.`,
          "Read every hunk of this piece, and count it as one in files_read once you have.",
        ].join("\n"),
      ),
      prompts[1],
    );
    for (const prompt of prompts.slice(0, 2))
      assert.doesNotMatch(prompt, /each file whole, into/u);
    // Each piece counts as one in its own chunk's files_read.
    for (const [k, units] of [
      [0, 1],
      [1, 2],
    ])
      assert.ok(
        prompts[k].includes(
          [
            `TO READ: ${units} in this chunk, each counted once you read every hunk of it: each file of the scope's file list it holds whole, and each piece of a cut file.`,
            `A review that read all of them returns files_read ${units}. The other listed files are context, never counted.`,
          ].join("\n"),
        ),
        prompts[k],
      );
  }
});

test("a chunk with no piece keeps today's note, byte for byte", async () => {
  for (const job of LEGS) {
    const cut = split(job, cutDiff(), { READ_BUDGET: "1000" });
    // The same chunk counts with no cut file: today's notes.
    const plain = await compose(
      job,
      cut,
      makeTemporaryDirectory("pr-review-cli-slices-none-"),
    );
    const prompts = await compose(job, cut, cut.chunkDir);
    assert.equal(prompts[2], plain[2], job.name);
    assert.match(
      prompts[2],
      /^at file boundaries, each file whole, into 3 chunks, and each chunk gets its own review\.$/mu,
    );
    assert.doesNotMatch(prompts[2], /PIECE/u);
  }
});

test("a cut file's path that is not plain is named by its header's line", async () => {
  const odd = "src/we ird.js";
  const diff = `${HEADER(odd)}${[1, 2, 3].map((n) => HUNK(n, 300)).join("")}${SMALL_DIFF}`;
  const cut = split(LEGS[0], diff, { READ_BUDGET: "1000" });
  const prompts = await compose(LEGS[0], cut, cut.chunkDir);
  assert.match(
    prompts[0],
    /^PIECE 1 OF 2 of the file whose diff --git line is line 1 of chunk-1\.patch: /mu,
  );
  assert.doesNotMatch(prompts[0], /we ird/u);
});
