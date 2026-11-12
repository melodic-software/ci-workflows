"use strict";

// The check-review-reads action: which files of a review's to-read list the
// leg's own transcript shows as read. The transcript shapes below are the
// CLI's stream-json messages as `claude -p --output-format stream-json
// --verbose` (2.1.322) wrote them in a local run: an assistant message holds
// the Read tool_use with its file_path, a user message the tool_result whose
// text numbers each line `N<TAB>`, and a subagent's messages carry
// parent_tool_use_id. The diffs are `git diff --text --find-renames` output.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  checkReads,
  diffSections,
  linesShown,
  main,
  readsOf,
} = require("../actions/check-review-reads/reads.cjs");
const {
  coverageText,
  partialReason,
} = require("../actions/publish-review/publish.cjs");
const { evaluate } = require("./actions-expression.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(__dirname, "..", "workflows", "pr-review-cli.yml"),
    "utf8",
  ),
);
const LEGS = ["review-key", "review-subscription", "review-fallback"].map(
  (id) => workflow.jobs[id],
);
const step = (job, id) => job.steps.find((s) => s.id === id);

// Lines 1-7 src/a.js, 8-14 the space path (git leaves it unquoted in the
// header and ends its ---/+++ lines with a tab), 15-21 the quoted path, 22-25
// a pure rename, 26-31 a deleted file, 32-37 a binary file shown as text.
const DIFF = [
  "diff --git a/src/a.js b/src/a.js",
  "index 1111111..2222222 100644",
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -1,2 +1,2 @@",
  " const x = 1;",
  "-const y = 2;",
  "diff --git a/docs/my file.md b/docs/my file.md",
  "index 3333333..4444444 100644",
  "--- a/docs/my file.md\t",
  "+++ b/docs/my file.md\t",
  "@@ -1,2 +1,2 @@",
  "-hello",
  "+hello world",
  'diff --git "a/docs/say \\"hi\\".md" "b/docs/say \\"hi\\".md"',
  "index 5555555..6666666 100644",
  '--- "a/docs/say \\"hi\\".md"\t',
  '+++ "b/docs/say \\"hi\\".md"\t',
  "@@ -1 +1 @@",
  "-quote",
  "+quoted",
  "diff --git a/src/old-name.js b/src/new-name.js",
  "similarity index 100%",
  "rename from src/old-name.js",
  "rename to src/new-name.js",
  "diff --git a/src/gone.js b/src/gone.js",
  "deleted file mode 100644",
  "index 7777777..0000000",
  "--- a/src/gone.js",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "diff --git a/data.bin b/data.bin",
  "index 8888888..9999999 100644",
  "--- a/data.bin",
  "+++ b/data.bin",
  "@@ -1 +1 @@",
  "-abc\0def",
].join("\n");
const LIST = [
  "data.bin",
  "docs/my file.md",
  '"docs/say \\"hi\\".md"',
  "src/a.js",
  "src/new-name.js",
];

// One Read call and its result, as the CLI streams them.
let ids = 0;
function read(
  file,
  text,
  from,
  to,
  { parent = null, error = false, whole = false } = {},
) {
  const id = `toolu_${++ids}`;
  const lines = text.split("\n");
  const shown = [];
  for (let n = from; n <= Math.min(to, lines.length); n++) {
    shown.push(`${n}\t${lines[n - 1]}`);
  }
  return [
    {
      type: "assistant",
      parent_tool_use_id: parent,
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: "Read",
            input: whole
              ? { file_path: file }
              : { file_path: file, offset: from, limit: to - from + 1 },
          },
        ],
      },
    },
    {
      type: "user",
      parent_tool_use_id: parent,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            ...(error ? { is_error: true } : {}),
            content: shown.join("\n"),
          },
        ],
      },
    },
  ];
}

// A workspace holding the job's files, and a transcript writer.
function lane(files) {
  const workspace = makeTemporaryDirectory("check-review-reads-");
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
    fs.writeFileSync(path.join(workspace, name), content);
  }
  const transcript = (name, messages) => {
    const file = path.join(
      workspace,
      "..",
      `${path.basename(workspace)}-${name}`,
    );
    fs.writeFileSync(file, JSON.stringify(messages));
    return file;
  };
  return { workspace, transcript };
}

const unreadOf = (workspace, diffs, toRead, messagesPerReview, binary) =>
  checkReads({
    workspace,
    toRead,
    binary,
    scopeDiff: diffs.scope,
    reviews: messagesPerReview.map((messages, i) => ({
      diffs: diffs.reviews?.[i] ?? [],
      shown: linesShown(messages, workspace),
    })),
  }).unread;

test("diffSections finds each file's lines from its diff --git line, and a rename's new path", () => {
  const sections = diffSections(DIFF);
  assert.deepEqual(
    sections.map((s) => [s.start, s.end]),
    [
      [1, 7],
      [8, 14],
      [15, 21],
      [22, 25],
      [26, 31],
      [32, 37],
    ],
  );
  assert.equal(sections[3].renameTo, "src/new-name.js");
  assert.equal(sections[0].renameTo, undefined);
  // An empty line carries no change: an incremental diff's separator.
  assert.deepEqual(
    diffSections(
      "diff --git a/x b/x\nstatus: modified\n@@ -1 +1 @@\n-a\n+b\n\ndiff --git a/y b/y\n",
    )[0].required,
    [1, 2, 3, 4, 5],
  );
});

test("a single review that read every listed file's section has no unread path", () => {
  const { workspace } = lane({ ".claude-lane/pr.diff": DIFF });
  const diff = path.join(workspace, ".claude-lane/pr.diff");
  const messages = read(diff, DIFF, 1, 37);
  assert.deepEqual(
    unreadOf(workspace, { scope: ".claude-lane/pr.diff" }, LIST, [messages]),
    [],
  );
});

test("a file read short of its last line is unread, and is named", () => {
  const { workspace } = lane({ ".claude-lane/pr.diff": DIFF });
  const diff = path.join(workspace, ".claude-lane/pr.diff");
  // Lines 1-13 stop one line short of the space path's last hunk line (14).
  const messages = [...read(diff, DIFF, 1, 13), ...read(diff, DIFF, 15, 37)];
  assert.deepEqual(
    unreadOf(workspace, { scope: ".claude-lane/pr.diff" }, LIST, [messages]),
    ["docs/my file.md"],
  );
});

test("a path with spaces or quotes matches git's header for it, and a deleted file is never required", () => {
  const { workspace } = lane({ ".claude-lane/pr.diff": DIFF });
  const diff = path.join(workspace, ".claude-lane/pr.diff");
  // Only the space path's and the quoted path's sections are read.
  const messages = read(diff, DIFF, 8, 21);
  assert.deepEqual(
    unreadOf(workspace, { scope: ".claude-lane/pr.diff" }, LIST, [messages]),
    ["data.bin", "src/a.js", "src/new-name.js"],
  );
  // src/gone.js (26-31) is in no list; leaving it unread changes nothing.
  const all = [...read(diff, DIFF, 1, 25), ...read(diff, DIFF, 32, 37)];
  assert.deepEqual(
    unreadOf(workspace, { scope: ".claude-lane/pr.diff" }, LIST, [all]),
    [],
  );
});

test("an unverified pure rename is read once its header lines are shown; a listed binary file needs only its lines before the first hunk, a text file all of its lines", () => {
  const { workspace } = lane({ ".claude-lane/pr.diff": DIFF });
  const diff = path.join(workspace, ".claude-lane/pr.diff");
  const scope = { scope: ".claude-lane/pr.diff" };
  const rename = read(diff, DIFF, 22, 25);
  assert.deepEqual(
    unreadOf(workspace, scope, ["src/new-name.js", "data.bin"], [rename]),
    ["data.bin"],
  );
  // data.bin's header is lines 32-35; its hunk starts at 36.
  const header = read(diff, DIFF, 32, 35);
  const binary = new Set(["data.bin"]);
  assert.deepEqual(
    unreadOf(workspace, scope, ["data.bin"], [header], binary),
    [],
  );
  assert.deepEqual(
    unreadOf(
      workspace,
      scope,
      ["data.bin"],
      [read(diff, DIFF, 32, 34)],
      binary,
    ),
    ["data.bin"],
  );
  // Off the binary list the same header alone is not enough.
  assert.deepEqual(unreadOf(workspace, scope, ["data.bin"], [header]), [
    "data.bin",
  ]);
  // A text file's header without its hunk lines is not read.
  assert.deepEqual(
    unreadOf(workspace, scope, ["src/a.js"], [read(diff, DIFF, 1, 4)], binary),
    ["src/a.js"],
  );
});

test("a diff longer than one Read counts when the Reads' ranges together cover each section", () => {
  const big = [
    "diff --git a/lib/big.js b/lib/big.js",
    "index 1..2 100644",
    "--- a/lib/big.js",
    "+++ b/lib/big.js",
    "@@ -1,3000 +1,3000 @@",
    ...Array.from({ length: 3000 }, (_, i) => `-export const v${i} = ${i};`),
  ].join("\n");
  const { workspace } = lane({ ".claude-lane/pr.diff": big });
  const diff = path.join(workspace, ".claude-lane/pr.diff");
  const covered = [...read(diff, big, 1, 2000), ...read(diff, big, 2001, 3005)];
  assert.deepEqual(
    unreadOf(
      workspace,
      { scope: ".claude-lane/pr.diff" },
      ["lib/big.js"],
      [covered],
    ),
    [],
  );
  const gap = [...read(diff, big, 1, 2000), ...read(diff, big, 2002, 3005)];
  assert.deepEqual(
    unreadOf(
      workspace,
      { scope: ".claude-lane/pr.diff" },
      ["lib/big.js"],
      [gap],
    ),
    ["lib/big.js"],
  );
});

test("a subagent's Read counts; an errored Read, Grep, or a Read of another file does not", () => {
  const { workspace } = lane({
    ".claude-lane/pr.diff": DIFF,
    "copy.diff": DIFF,
  });
  const diff = path.join(workspace, ".claude-lane/pr.diff");
  const scope = { scope: ".claude-lane/pr.diff" };
  const sub = read(diff, DIFF, 1, 7, { parent: "toolu_agent" });
  assert.deepEqual(unreadOf(workspace, scope, ["src/a.js"], [sub]), []);
  const failed = read(diff, DIFF, 1, 7, { error: true });
  assert.deepEqual(unreadOf(workspace, scope, ["src/a.js"], [failed]), [
    "src/a.js",
  ]);
  // The same bytes at a path the job did not write are no evidence.
  const elsewhere = read(path.join(workspace, "copy.diff"), DIFF, 1, 7);
  assert.deepEqual(unreadOf(workspace, scope, ["src/a.js"], [elsewhere]), [
    "src/a.js",
  ]);
  const grep = read(diff, DIFF, 1, 7);
  grep[0].message.content[0].name = "Grep";
  assert.deepEqual(unreadOf(workspace, scope, ["src/a.js"], [grep]), [
    "src/a.js",
  ]);
});

test("a relative, ./-prefixed or absolute file_path names the same diff file, and the older arrow numbering counts", () => {
  const { workspace } = lane({ ".claude-lane/pr.diff": DIFF });
  const scope = { scope: ".claude-lane/pr.diff" };
  for (const file of [
    ".claude-lane/pr.diff",
    "./.claude-lane/pr.diff",
    path.join(workspace, ".claude-lane/pr.diff"),
  ]) {
    assert.deepEqual(
      unreadOf(workspace, scope, ["src/a.js"], [read(file, DIFF, 1, 7)]),
      [],
      file,
    );
  }
  const arrow = read(".claude-lane/pr.diff", DIFF, 1, 7);
  arrow[1].message.content[0].content = DIFF.split("\n")
    .slice(0, 7)
    .map((line, i) => `${String(i + 1).padStart(6)}→${line}`)
    .join("\n");
  assert.deepEqual(unreadOf(workspace, scope, ["src/a.js"], [arrow]), []);
  // A result given as text blocks reads the same.
  const blocks = read(".claude-lane/pr.diff", DIFF, 1, 7);
  const text = blocks[1].message.content[0].content;
  blocks[1].message.content[0].content = [{ type: "text", text }];
  assert.deepEqual(unreadOf(workspace, scope, ["src/a.js"], [blocks]), []);
});

test("a listed path no section names is unread, and a header names a path only exactly", () => {
  const { workspace } = lane({ ".claude-lane/pr.diff": DIFF });
  const all = read(".claude-lane/pr.diff", DIFF, 1, 37);
  const scope = { scope: ".claude-lane/pr.diff" };
  assert.deepEqual(
    unreadOf(workspace, scope, ["src/a.js", "src/missing.js"], [all]),
    ["src/missing.js"],
  );
  // `y b/x`'s header ends with ` b/x`, yet only `x`'s header is x's.
  const pair =
    "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/x b/y b/x\n@@ -1 +1 @@\n-c\n+d";
  const { workspace: w2 } = lane({ "d.diff": pair });
  assert.deepEqual(
    unreadOf(
      w2,
      { scope: "d.diff" },
      ["x", "y b/x"],
      [read("d.diff", pair, 1, 8)],
    ),
    [],
  );
  // Reading only `y b/x`'s section leaves x unread.
  assert.deepEqual(
    unreadOf(
      w2,
      { scope: "d.diff" },
      ["x", "y b/x"],
      [read("d.diff", pair, 5, 8)],
    ),
    ["x"],
  );
  // The scope step's API-format rename names its new path after `a/<old>`.
  const moved =
    "diff --git a/old.js b/new.js\nstatus: renamed\n@@ -1 +1 @@\n-a\n+b\n";
  const { workspace: w3 } = lane({ "i.diff": moved });
  assert.deepEqual(
    unreadOf(
      w3,
      { scope: "i.diff" },
      ["new.js"],
      [read("i.diff", moved, 1, 5)],
    ),
    [],
  );
});

test("a type change is two sections of one path, and both must be read", () => {
  const change = [
    "diff --git a/link b/link",
    "deleted file mode 120000",
    "@@ -1 +0,0 @@",
    "-target",
    "diff --git a/link b/link",
    "new file mode 100644",
    "@@ -0,0 +1 @@",
    "+text",
  ].join("\n");
  const { workspace } = lane({ "d.diff": change });
  assert.deepEqual(
    unreadOf(
      workspace,
      { scope: "d.diff" },
      ["link"],
      [read("d.diff", change, 1, 4)],
    ),
    ["link"],
  );
  assert.deepEqual(
    unreadOf(
      workspace,
      { scope: "d.diff" },
      ["link"],
      [read("d.diff", change, 1, 8)],
    ),
    [],
  );
});

test("in a chunked review each chunk's own transcript must read its chunk's files, in its patch or the scope diff", () => {
  const lines = DIFF.split("\n");
  const one = lines.slice(0, 14).join("\n");
  const two = lines.slice(14).join("\n");
  const { workspace } = lane({
    ".claude-lane/pr.diff": DIFF,
    ".claude-lane/chunks/chunk-1.patch": one,
    ".claude-lane/chunks/chunk-2.patch": two,
  });
  const diffs = {
    scope: ".claude-lane/pr.diff",
    reviews: [
      [".claude-lane/chunks/chunk-1.patch"],
      [".claude-lane/chunks/chunk-2.patch"],
    ],
  };
  const chunk1 = read(".claude-lane/chunks/chunk-1.patch", one, 1, 14);
  const chunk2 = read(".claude-lane/chunks/chunk-2.patch", two, 1, 23);
  assert.deepEqual(unreadOf(workspace, diffs, LIST, [chunk1, chunk2]), []);
  // Chunk 2's files read only by chunk 1's reviewer are not read.
  const both = [...chunk1, ...read(".claude-lane/pr.diff", DIFF, 15, 37)];
  assert.deepEqual(unreadOf(workspace, diffs, LIST, [both, []]), [
    "data.bin",
    '"docs/say \\"hi\\".md"',
    "src/new-name.js",
  ]);
  // The owning chunk reading the same section in the scope diff counts.
  const scoped = read(".claude-lane/pr.diff", DIFF, 15, 37);
  assert.deepEqual(unreadOf(workspace, diffs, LIST, [chunk1, scoped]), []);
});

test("a chunk patch whose section differs from the scope diff's is no evidence", () => {
  const lines = DIFF.split("\n");
  const planted = [
    ...lines.slice(0, 6),
    " planted",
    ...lines.slice(7, 14),
  ].join("\n");
  const { workspace } = lane({
    ".claude-lane/pr.diff": DIFF,
    ".claude-lane/chunks/chunk-1.patch": planted,
  });
  const diffs = {
    scope: ".claude-lane/pr.diff",
    reviews: [[".claude-lane/chunks/chunk-1.patch"]],
  };
  const messages = read(".claude-lane/chunks/chunk-1.patch", planted, 1, 14);
  assert.deepEqual(
    unreadOf(workspace, diffs, ["src/a.js", "docs/my file.md"], [messages]),
    ["src/a.js"],
  );
});

// The runner, as the workflow step calls it.
function run(files, env) {
  const { workspace, transcript } = lane(files.workspace ?? {});
  const output = path.join(
    workspace,
    "..",
    `${path.basename(workspace)}-output`,
  );
  fs.writeFileSync(output, "");
  const transcripts = Object.fromEntries(
    Object.entries(files.transcripts ?? {}).map(([name, messages]) => [
      name,
      typeof messages === "string"
        ? (() => {
            const file = transcript(name, []);
            fs.writeFileSync(file, messages);
            return file;
          })()
        : transcript(
            name,
            typeof messages === "function" ? messages(workspace) : messages,
          ),
    ]),
  );
  let results = "";
  if (files.chunkTranscripts) {
    results = makeTemporaryDirectory("check-review-reads-results-");
    for (const [k, messages] of Object.entries(files.chunkTranscripts)) {
      fs.mkdirSync(path.join(results, `chunk-${k}`));
      fs.writeFileSync(
        path.join(results, `chunk-${k}`, "execution.json"),
        JSON.stringify(messages),
      );
    }
  }
  const stdout = [];
  main(
    {
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: output,
      VERDICT: "complete",
      CHUNKS: "1",
      SCOPE_DIFF: ".claude-lane/pr.diff",
      CHUNK_DIR: ".claude-lane/chunks",
      FILE_LIST: ".claude-lane/files.txt",
      TO_READ_FILE: ".claude-lane/to-read.txt",
      TO_READ: "",
      SKIPPED: "0",
      MODE: "enforce",
      EXECUTION_FILE: transcripts.first ?? "",
      RESULTS_DIR: results,
      ...env,
    },
    { write: (line) => stdout.push(line) },
  );
  const outputs = Object.fromEntries(
    fs
      .readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  return {
    outputs,
    stdout,
    review: outputs.review ? JSON.parse(outputs.review) : undefined,
  };
}

const REVIEW = (coverage) =>
  JSON.stringify({ findings: 0, coverage, summary: "S", comments: [] });
const FILES = `${LIST.join("\n")}\n`;

test("the runner passes a complete review on unchanged when every listed file was read", () => {
  const { outputs, review, stdout } = run(
    {
      workspace: {
        ".claude-lane/pr.diff": DIFF,
        ".claude-lane/files.txt": FILES,
      },
      transcripts: { first: read(".claude-lane/pr.diff", DIFF, 1, 37) },
    },
    { REVIEW: REVIEW({ read: 5, changed: 5 }) },
  );
  assert.equal(outputs.verdict, "complete");
  assert.deepEqual(review.coverage, { read: 5, changed: 5 });
  assert.deepEqual(stdout, [
    "::notice title=pr-review-cli reads::listed=5 unread=0 mode=enforce",
  ]);
});

test("the runner lowers the read count to the files with evidence and names the unread ones, path names only", () => {
  const { outputs, review, stdout } = run(
    {
      workspace: {
        ".claude-lane/pr.diff": DIFF,
        ".claude-lane/files.txt": FILES,
      },
      transcripts: { first: read(".claude-lane/pr.diff", DIFF, 8, 37) },
    },
    { REVIEW: REVIEW({ read: 5, changed: 5 }) },
  );
  assert.equal(outputs.verdict, "complete");
  assert.deepEqual(review.coverage, {
    read: 4,
    changed: 5,
    unread_files: ["src/a.js"],
  });
  assert.deepEqual(stdout, [
    "::notice title=pr-review-cli reads::listed=5 unread=1 mode=enforce",
    "::warning title=pr-review-cli reads::no Read showed the whole change of 1 listed file(s): src/a.js",
  ]);
  // A path outside the plain characters is counted, never printed.
  const quoted = run(
    {
      workspace: {
        ".claude-lane/pr.diff": DIFF,
        ".claude-lane/files.txt": FILES,
      },
      transcripts: { first: read(".claude-lane/pr.diff", DIFF, 1, 14) },
    },
    { REVIEW: REVIEW({ read: 5, changed: 5 }) },
  );
  assert.deepEqual(quoted.review.coverage.unread_files, [
    "data.bin",
    "src/new-name.js",
  ]);
  assert.equal(quoted.review.coverage.read, 2);
  assert.match(quoted.stdout[1], /: data\.bin, src\/new-name\.js and 1 more$/u);
  // A model count already lower stays.
  const lower = run(
    {
      workspace: {
        ".claude-lane/pr.diff": DIFF,
        ".claude-lane/files.txt": FILES,
      },
      transcripts: { first: read(".claude-lane/pr.diff", DIFF, 8, 37) },
    },
    { REVIEW: REVIEW({ read: 3, changed: 5 }) },
  );
  assert.equal(lower.review.coverage.read, 3);
});

test("with copies and verified renames counted as read, the job's to-read list is the list checked", () => {
  const toRead = "src/a.js\n";
  const { review } = run(
    {
      workspace: {
        ".claude-lane/pr.diff": DIFF,
        ".claude-lane/files.txt": "src/a.js\nsrc/new-name.js\n",
        ".claude-lane/to-read.txt": toRead,
      },
      transcripts: { first: read(".claude-lane/pr.diff", DIFF, 1, 7) },
    },
    {
      REVIEW: REVIEW({ read: 2, changed: 2, renames: 1 }),
      SKIPPED: "1",
      TO_READ: "1",
    },
  );
  assert.deepEqual(review.coverage, { read: 2, changed: 2, renames: 1 });
  // A to-read list the job did not report writing, or of the wrong length, cannot be checked.
  for (const env of [{ TO_READ: "" }, { TO_READ: "2" }]) {
    const { outputs } = run(
      {
        workspace: {
          ".claude-lane/pr.diff": DIFF,
          ".claude-lane/files.txt": "src/a.js\nsrc/new-name.js\n",
          ".claude-lane/to-read.txt": toRead,
        },
        transcripts: { first: read(".claude-lane/pr.diff", DIFF, 1, 7) },
      },
      {
        REVIEW: REVIEW({ read: 2, changed: 2, renames: 1 }),
        SKIPPED: "1",
        ...env,
      },
    );
    assert.equal(
      outputs.verdict,
      "the job could not list the files the review had to read",
      JSON.stringify(env),
    );
    assert.equal(outputs.review, undefined);
  }
});

test("a missing or unparseable transcript, or a missing diff, leaves every listed file unread", () => {
  const files = {
    ".claude-lane/pr.diff": DIFF,
    ".claude-lane/files.txt": FILES,
  };
  for (const [label, setup] of [
    ["no transcript", { workspace: files }],
    ["unparseable", { workspace: files, transcripts: { first: "{not json" } }],
    ["not an array", { workspace: files, transcripts: { first: "{}" } }],
    [
      "no diff",
      {
        workspace: { ".claude-lane/files.txt": FILES },
        transcripts: { first: read(".claude-lane/pr.diff", DIFF, 1, 37) },
      },
    ],
  ]) {
    const { outputs, review } = run(setup, {
      REVIEW: REVIEW({ read: 5, changed: 5 }),
    });
    assert.equal(outputs.verdict, "complete", label);
    assert.equal(review.coverage.read, 0, label);
    // The space and quoted paths are counted, not named.
    assert.deepEqual(
      review.coverage.unread_files,
      ["data.bin", "src/a.js", "src/new-name.js"],
      label,
    );
  }
});

test("the runner checks a chunked review per chunk, from each chunk's own execution file", () => {
  const lines = DIFF.split("\n");
  const one = lines.slice(0, 14).join("\n");
  const two = lines.slice(14).join("\n");
  const workspace = {
    ".claude-lane/pr.diff": DIFF,
    ".claude-lane/files.txt": FILES,
    ".claude-lane/chunks/chunk-1.patch": one,
    ".claude-lane/chunks/chunk-2.patch": two,
  };
  const env = { REVIEW: REVIEW({ read: 5, changed: 5 }), CHUNKS: "2" };
  const done = run(
    {
      workspace,
      transcripts: {
        first: read(".claude-lane/chunks/chunk-1.patch", one, 1, 14),
      },
      chunkTranscripts: {
        2: read(".claude-lane/chunks/chunk-2.patch", two, 1, 23),
      },
    },
    env,
  );
  assert.deepEqual(done.review.coverage, { read: 5, changed: 5 });
  const missing = run(
    {
      workspace,
      transcripts: {
        first: read(".claude-lane/chunks/chunk-1.patch", one, 1, 14),
      },
    },
    env,
  );
  assert.deepEqual(missing.review.coverage.unread_files, [
    "data.bin",
    "src/new-name.js",
  ]);
  assert.equal(missing.review.coverage.read, 2);
});

test("a review the extract step did not find complete passes through untouched", () => {
  const { outputs } = run(
    { workspace: {} },
    { VERDICT: "the review returned no summary", REVIEW: "" },
  );
  assert.equal(outputs.verdict, "the review returned no summary");
  assert.equal(outputs.review, undefined);
  const empty = run({ workspace: {} }, { VERDICT: "", REVIEW: "" });
  assert.equal(
    empty.outputs.verdict,
    "the job could not check which files the review read",
  );
});

test("publish-review names the files with no read evidence in a partial review's reason", () => {
  assert.equal(
    partialReason({ read: 4, changed: 5, unread_files: ["src/a.js"] }),
    "; no read evidence for `src/a.js`",
  );
  assert.equal(partialReason({ read: 4, changed: 5 }), "");
});

test("every leg checks the reads after the extract step and before the review leaves the job", () => {
  const [first, ...rest] = LEGS;
  for (const job of LEGS) {
    const names = job.steps.map((s) => s.id ?? s.name);
    const reads = step(job, "reads");
    assert.ok(
      names.indexOf("extract") + 1 === names.indexOf("reads"),
      job.name,
    );
    assert.ok(names.indexOf("reads") < names.indexOf("handoff-file"), job.name);
    assert.ok(
      names.indexOf("reads") < names.indexOf("Upload the sealed transcript"),
      job.name,
    );
    assert.equal(reads.uses, "$/.github/actions/check-review-reads");
    assert.equal(reads.if, step(job, "extract").if);
    assert.equal(reads["continue-on-error"], true);
    assert.equal(reads.with.review, `\${{ steps.extract.outputs.review }}`);
    assert.equal(reads.with.verdict, `\${{ steps.extract.outputs.verdict }}`);
    assert.equal(reads.with.skipped, `\${{ steps.extract.outputs.skipped }}`);
    assert.equal(
      reads.with["execution-file"],
      `\${{ steps.claude.outputs.execution-file }}`,
    );
    assert.equal(
      reads.with["results-dir"],
      `\${{ steps.chunks.outputs.results-dir }}`,
    );
    assert.equal(reads.with.chunks, `\${{ steps.compose.outputs.chunks }}`);
    assert.equal(reads.with["scope-diff"], step(job, "extract").env.SCOPE_DIFF);
    assert.equal(
      reads.with["to-read"],
      `\${{ steps.full-diff.outputs.to-read }}`,
    );
    assert.equal(reads.with.excluded, `\${{ steps.split.outputs.excluded }}`);
    // The mode resolves as cli-version does: the input, the variable, then report.
    const mode = (inputs, vars) => evaluate(reads.with.mode, { inputs, vars });
    assert.equal(mode({}, {}), "report");
    assert.equal(mode({}, { REVIEW_READS_CHECK_MODE: "enforce" }), "enforce");
    assert.equal(
      mode(
        { "reads-check-mode": "report" },
        { REVIEW_READS_CHECK_MODE: "enforce" },
      ),
      "report",
    );
    assert.equal(
      reads.with.binary,
      `\${{ steps.scope.outputs.scope != 'incremental' && steps.full-diff.outputs.binary || '' }}`,
    );
    assert.equal(
      evaluate(reads.with["file-list"], {
        steps: { scope: { outputs: { scope: "incremental" } } },
      }),
      ".claude-lane/incremental-files.txt",
    );
    assert.equal(
      evaluate(reads.with["file-list"], {
        steps: { scope: { outputs: { scope: "whole" } } },
      }),
      ".claude-lane/files.txt",
    );
    // The review and the verdict leave the job only through the check.
    assert.equal(
      step(job, "handoff-file").env.REVIEW,
      `\${{ steps.reads.outputs.review }}`,
    );
    assert.equal(
      step(job, "review-outcome").with.completion,
      `\${{ steps.reads.outputs.verdict }}`,
    );
    assert.equal(job.outputs.verdict, `\${{ steps.reads.outputs.verdict }}`);
    // Subagents report before the result, so their Reads are in the transcript.
    for (const id of ["claude", "chunks"]) {
      assert.equal(
        step(job, id).env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
        "1",
        `${job.name} ${id}`,
      );
    }
    assert.match(
      step(job, "extract").with.script,
      /core\.setOutput\("skipped", String\(skipped\)\);/u,
    );
  }
  for (const job of rest)
    assert.deepEqual(step(job, "reads"), step(first, "reads"));
  // A handoff, by the first chunk or a later one, skips the extract step and
  // so the check: the next leg reviews every chunk again.
  const ran = (firstChunk, later) =>
    evaluate(step(first, "reads").if, {
      steps: {
        compose: { outcome: "success" },
        credential: { outputs: { present: "true" } },
        claude: { outputs: { handoff: firstChunk } },
        chunks: { outputs: { handoff: later } },
      },
    });
  assert.equal(ran("true", ""), false);
  assert.equal(ran("false", "true"), false);
  assert.equal(ran("false", ""), true);
  assert.equal(ran("false", "false"), true);
});

test("the prompt tells the model the job checks its Read calls, in every leg", () => {
  for (const job of LEGS) {
    assert.match(
      step(job, "compose").with.script,
      /" {2}The job checks this against the Read calls of the review and its subagents: a listed file counts as read",\n\s*" {2}only when Read showed every line of its section, its diff --git line through its last line, in the diff",\n\s*" {2}file you review or the scope's diff \(the REVIEW SCOPE file for an incremental review, else the FULL DIFF",\n\s*" {2}file\)\. Grep output, a summary, or a count does not show a line\.",/u,
    );
  }
});

test("an incremental review is read in its own diff: the same file read in the whole pull request's diff is not", () => {
  // The scope step's API-format diff beside the full-diff step's git diff.
  const incremental =
    "diff --git a/src/a.js b/src/a.js\nstatus: modified\n@@ -1,2 +1,2 @@\n const x = 1;\n-const y = 2;\n";
  const { workspace } = lane({
    ".claude-lane/incremental.diff": incremental,
    ".claude-lane/pr.diff": DIFF,
  });
  const scope = { scope: ".claude-lane/incremental.diff" };
  assert.deepEqual(
    unreadOf(
      workspace,
      scope,
      ["src/a.js"],
      [read(".claude-lane/pr.diff", DIFF, 1, 7)],
    ),
    ["src/a.js"],
  );
  assert.deepEqual(
    unreadOf(
      workspace,
      scope,
      ["src/a.js"],
      [read(".claude-lane/incremental.diff", incremental, 1, 5)],
    ),
    [],
  );
});

// fixtures/check-review-reads: a local `claude -p --output-format stream-json
// --verbose` run (CLI 2.1.322) in which the main thread read lines 1-8 of the
// diff and a general-purpose subagent lines 9-16, kept to its tool_use and
// tool_result messages, with the run's directory replaced by /workspace.
function recorded() {
  const dir = path.join(__dirname, "fixtures", "check-review-reads");
  const { workspace } = lane({
    "lane/pr.diff": fs.readFileSync(path.join(dir, "pr.diff"), "utf8"),
  });
  const messages = JSON.parse(
    fs
      .readFileSync(path.join(dir, "transcript.json"), "utf8")
      .replaceAll("/workspace/", `${workspace}/`),
  );
  return {
    workspace,
    messages,
    key: fs.realpathSync(path.join(workspace, "lane/pr.diff")),
  };
}
const RECORDED_LIST = ["src/a.js", '"docs/my file.md"'];
const upTo = (n) => Array.from({ length: n }, (_, i) => i + 1);

test("a recorded CLI run's Reads, main thread and subagent, read as the CLI wrote them", () => {
  const { workspace, messages, key } = recorded();
  const { shown, recognised, unrecognised } = readsOf(messages, workspace);
  assert.ok(upTo(16).every((n) => shown.get(key).has(n)));
  assert.deepEqual([...recognised], [key]);
  assert.deepEqual([...unrecognised], []);
  const scope = { scope: "lane/pr.diff" };
  // The run read lines 1-16 of 17: src/a.js (1-9) whole, the second file
  // short of its last line.
  assert.equal(shown.get(key).has(17), false);
  assert.deepEqual(unreadOf(workspace, scope, RECORDED_LIST, [messages]), [
    '"docs/my file.md"',
  ]);
  // Without the subagent's Read, line 9 (src/a.js's last) is unread too.
  const mainOnly = messages.filter((m) => m.parent_tool_use_id === null);
  assert.deepEqual(
    unreadOf(workspace, scope, RECORDED_LIST, [mainOnly]),
    RECORDED_LIST,
  );
});

test("a Read result's structured range is used first, and its printed numbers when there is none", () => {
  const { workspace, messages, key } = recorded();
  const withRange = messages.find((m) => m.tool_use_result?.file);
  assert.deepEqual(
    {
      startLine: withRange.tool_use_result.file.startLine,
      numLines: withRange.tool_use_result.file.numLines,
    },
    { startLine: 1, numLines: 8 },
  );
  const blanked = structuredClone(messages);
  blanked.find((m) => m.tool_use_result?.file).message.content[0].content = "";
  assert.deepEqual(
    [...readsOf(blanked, workspace).shown.get(key)]
      .filter((n) => n <= 8)
      .sort((a, b) => a - b),
    upTo(8),
  );
  const unstructured = structuredClone(messages);
  delete unstructured.find((m) => m.tool_use_result?.file).tool_use_result;
  assert.deepEqual(
    unreadOf(
      workspace,
      { scope: "lane/pr.diff" },
      ["src/a.js"],
      [unstructured],
    ),
    [],
  );
});

// Every Read result's text with its line numbers taken off.
const unnumbered = (messages) => {
  for (const m of messages) {
    for (const block of m.message.content) {
      if (block.type === "tool_result")
        block.content = block.content.replace(/^\d+\t/gmu, "");
    }
  }
  return messages;
};
const FORMAT_WARNING =
  "::warning title=pr-review-cli reads::the CLI's Read output format was not recognised; the per-file read check did not run";

test("when no Read result of a job diff file gives a line number, the check does not run and the extract step's count stands", () => {
  const workspace = {
    ".claude-lane/pr.diff": DIFF,
    ".claude-lane/files.txt": FILES,
  };
  const env = { REVIEW: REVIEW({ read: 5, changed: 5 }) };
  const all = run(
    {
      workspace,
      transcripts: {
        first: unnumbered(
          read(".claude-lane/pr.diff", DIFF, 1, 37, { whole: true }),
        ),
      },
    },
    env,
  );
  assert.equal(all.outputs.verdict, "complete");
  assert.equal(all.outputs["reads-checked"], "false");
  assert.deepEqual(all.review.coverage, {
    read: 5,
    changed: 5,
    reads_checked: false,
  });
  assert.deepEqual(all.stdout, [FORMAT_WARNING]);
  // One recognised Read of a job diff file: the unrecognised ones are no evidence.
  const mixed = run(
    {
      workspace,
      transcripts: {
        first: [
          ...read(".claude-lane/pr.diff", DIFF, 1, 7),
          ...unnumbered(read(".claude-lane/pr.diff", DIFF, 8, 37)),
        ],
      },
    },
    env,
  );
  assert.equal(mixed.outputs["reads-checked"], "true");
  assert.equal(mixed.review.coverage.read, 1);
  // No Read at all, or an unrecognised Read of another file only, is no evidence either.
  for (const messages of [
    [],
    unnumbered(read(".claude-lane/files.txt", FILES, 1, 5)),
  ]) {
    const none = run({ workspace, transcripts: { first: messages } }, env);
    assert.equal(none.outputs["reads-checked"], "true");
    assert.equal(none.review.coverage.read, 0);
  }
});

test("publish-review says when the per-file read check was skipped", () => {
  assert.equal(
    coverageText({ read: 5, changed: 5, reads_checked: false }),
    "read 5 of 5 changed file(s); per-file read check skipped: the CLI's Read output format was not recognised",
  );
  assert.equal(
    coverageText({ read: 5, changed: 5 }),
    "read 5 of 5 changed file(s)",
  );
});

test("an output value holding a line break is no result", () => {
  const { outputs } = run(
    { workspace: {} },
    { VERDICT: "the review\nreturned no summary", REVIEW: "" },
  );
  assert.deepEqual(outputs, {
    verdict: "the job could not check which files the review read",
  });
});

test("distinct.diff counts only when the split step left files out", () => {
  const workspace = {
    ".claude-lane/pr.diff": DIFF,
    ".claude-lane/files.txt": FILES,
    ".claude-lane/chunks/distinct.diff": DIFF,
  };
  const transcripts = {
    first: read(".claude-lane/chunks/distinct.diff", DIFF, 1, 37),
  };
  const env = { REVIEW: REVIEW({ read: 5, changed: 5 }) };
  assert.equal(
    run({ workspace, transcripts }, { ...env, EXCLUDED: "" }).review.coverage
      .read,
    0,
  );
  assert.equal(
    run({ workspace, transcripts }, { ...env, EXCLUDED: "0" }).review.coverage
      .read,
    0,
  );
  assert.deepEqual(
    run({ workspace, transcripts }, { ...env, EXCLUDED: "2" }).review.coverage,
    { read: 5, changed: 5 },
  );
});

test("a file whose lines end in a carriage return is read like any other", () => {
  const crlf = [
    "diff --git a/win.txt b/win.txt",
    "index 1..2 100644",
    "--- a/win.txt",
    "+++ b/win.txt",
    "@@ -1 +1 @@",
    "-old\r",
    "+new\r",
  ].join("\n");
  const { workspace } = lane({ "d.diff": crlf });
  assert.deepEqual(
    unreadOf(
      workspace,
      { scope: "d.diff" },
      ["win.txt"],
      [read("d.diff", crlf, 1, 7)],
    ),
    [],
  );
  assert.deepEqual(
    unreadOf(
      workspace,
      { scope: "d.diff" },
      ["win.txt"],
      [read("d.diff", crlf, 1, 6)],
    ),
    ["win.txt"],
  );
});

test("names that would take the review past 100000 bytes are dropped, and the count still falls", () => {
  const base = {
    findings: 0,
    coverage: { read: 4, changed: 5 },
    summary: "",
    comments: [],
  };
  const summary = "x".repeat(99990 - JSON.stringify(base).length);
  const { review } = run(
    {
      workspace: {
        ".claude-lane/pr.diff": DIFF,
        ".claude-lane/files.txt": FILES,
      },
      transcripts: { first: read(".claude-lane/pr.diff", DIFF, 8, 37) },
    },
    {
      REVIEW: JSON.stringify({
        ...base,
        coverage: { read: 5, changed: 5 },
        summary,
      }),
    },
  );
  assert.deepEqual(review.coverage, { read: 4, changed: 5 });
});

// --- report mode: logs the check, passes the extract step's review on ---

const SHORT = {
  workspace: { ".claude-lane/pr.diff": DIFF, ".claude-lane/files.txt": FILES },
  transcripts: { first: read(".claude-lane/pr.diff", DIFF, 8, 37) },
};
const WHOLE_READ = {
  workspace: SHORT.workspace,
  transcripts: { first: read(".claude-lane/pr.diff", DIFF, 1, 37) },
};

test("report mode logs unread files and passes the extract step's verdict and review on unchanged", () => {
  const extracted = REVIEW({ read: 5, changed: 5 });
  const { outputs, stdout } = run(SHORT, { REVIEW: extracted, MODE: "report" });
  assert.deepEqual(outputs, {
    verdict: "complete",
    review: extracted,
    "reads-checked": "true",
  });
  assert.deepEqual(stdout, [
    "::notice title=pr-review-cli reads::listed=5 unread=1 mode=report",
    "::warning title=pr-review-cli reads::no Read showed the whole change of 1 listed file(s): src/a.js",
  ]);
  const clean = run(WHOLE_READ, { REVIEW: extracted, MODE: "report" });
  assert.equal(clean.outputs.review, extracted);
  assert.deepEqual(clean.stdout, [
    "::notice title=pr-review-cli reads::listed=5 unread=0 mode=report",
  ]);
});

test("unset mode reports; enforce lowers the count", () => {
  const extracted = REVIEW({ read: 5, changed: 5 });
  assert.equal(
    run(SHORT, { REVIEW: extracted, MODE: "" }).outputs.review,
    extracted,
  );
  const enforced = run(SHORT, { REVIEW: extracted, MODE: "enforce" });
  assert.deepEqual(enforced.review.coverage, {
    read: 4,
    changed: 5,
    unread_files: ["src/a.js"],
  });
  assert.equal(
    enforced.stdout[0],
    "::notice title=pr-review-cli reads::listed=5 unread=1 mode=enforce",
  );
});

test("a mode that is neither report nor enforce enforces, and says so", () => {
  const extracted = REVIEW({ read: 5, changed: 5 });
  const typo = run(SHORT, { REVIEW: extracted, MODE: "enforcing" });
  assert.equal(typo.review.coverage.read, 4);
  assert.deepEqual(typo.stdout.slice(0, 2), [
    "::warning title=pr-review-cli reads::the reads-check mode 'enforcing' is neither report nor enforce; the check enforces",
    "::notice title=pr-review-cli reads::listed=5 unread=1 mode=enforce",
  ]);
  const odd = run(SHORT, { REVIEW: extracted, MODE: "x y" });
  assert.match(odd.stdout[0], /mode an unrecognised value is neither/u);
  assert.equal(odd.review.coverage.read, 4);
});

test("report mode passes on what the extract step gave where enforce would refuse or fail", () => {
  const extracted = REVIEW({ read: 2, changed: 2, renames: 1 });
  // A to-read list the job cannot back: enforce makes the review incomplete.
  const unlisted = {
    workspace: {
      ".claude-lane/pr.diff": DIFF,
      ".claude-lane/files.txt": "src/a.js\nsrc/new-name.js\n",
    },
    transcripts: { first: read(".claude-lane/pr.diff", DIFF, 1, 7) },
  };
  const env = { REVIEW: extracted, SKIPPED: "1", TO_READ: "" };
  assert.equal(
    run(unlisted, { ...env, MODE: "enforce" }).outputs.verdict,
    "the job could not list the files the review had to read",
  );
  assert.deepEqual(run(unlisted, { ...env, MODE: "report" }).outputs, {
    verdict: "complete",
    review: extracted,
  });
  // A verdict that is not complete goes on as it came.
  assert.deepEqual(
    run(
      { workspace: {} },
      { VERDICT: "the review returned no summary", REVIEW: "", MODE: "report" },
    ).outputs,
    { verdict: "the review returned no summary" },
  );
  // A check that throws: report passes the review on, enforce fails.
  // path.join throws on a CHUNK_DIR that is not a string.
  const whole = REVIEW({ read: 5, changed: 5 });
  const throwing = { REVIEW: whole, EXCLUDED: "1", CHUNK_DIR: null };
  const reported = run(SHORT, { ...throwing, MODE: "report" });
  assert.deepEqual(reported.outputs, { verdict: "complete", review: whole });
  assert.deepEqual(reported.stdout, [
    "::warning title=pr-review-cli reads::the check failed (TypeError); the review goes on as the extract step gave it",
  ]);
  assert.throws(() => run(SHORT, { ...throwing, MODE: "enforce" }), TypeError);
});

test("the format fallback is the same in both modes", () => {
  const extracted = REVIEW({ read: 5, changed: 5 });
  for (const mode of ["report", "enforce"]) {
    const { outputs } = run(
      {
        workspace: SHORT.workspace,
        transcripts: {
          first: unnumbered(
            read(".claude-lane/pr.diff", DIFF, 1, 37, { whole: true }),
          ),
        },
      },
      { REVIEW: extracted, MODE: mode },
    );
    assert.equal(outputs["reads-checked"], "false", mode);
    assert.deepEqual(
      JSON.parse(outputs.review).coverage,
      { read: 5, changed: 5, reads_checked: false },
      mode,
    );
  }
});

// --- the fallback is reachable only by a real format change ---

// fixtures/check-review-reads/notices.json: a local CLI 2.1.322 run's Reads
// of a diff with offset 100 past its end, of an empty file, and of a file the
// token cap cut (its numbered lines removed), kept to their tool messages,
// the run's directory replaced by /workspace.
const NOTICES = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "check-review-reads", "notices.json"),
    "utf8",
  ),
);
// The offset-past-end Read, retargeted at the job's diff.
const pastEnd = (workspace, { structured = true } = {}) => {
  const [call, result] = structuredClone(NOTICES.slice(0, 2));
  const diff = path.join(workspace, ".claude-lane/pr.diff");
  call.message.content[0].input.file_path = diff;
  if (structured) result.tool_use_result.file.filePath = diff;
  else delete result.tool_use_result;
  return [call, result];
};

test("the recorded tool notices are what the CLI prints for an offset past the end and an empty file", () => {
  assert.match(
    NOTICES[1].message.content[0].content,
    /^<system-reminder>Warning: the file exists but is shorter than the provided offset \(100\)\. The file has 18 lines\.<\/system-reminder>$/u,
  );
  assert.deepEqual(NOTICES[1].tool_use_result.file.numLines, 0);
  assert.match(
    NOTICES[3].message.content[0].content,
    /^<system-reminder>Warning: the file exists but the contents are empty\.<\/system-reminder>$/u,
  );
});

test("a Read the model shapes past the end of a diff is no evidence, never the fallback", () => {
  const workspace = {
    ".claude-lane/pr.diff": DIFF,
    ".claude-lane/files.txt": FILES,
  };
  const env = { REVIEW: REVIEW({ read: 5, changed: 5 }) };
  for (const structured of [true, false]) {
    const { outputs, review, stdout } = run(
      { workspace, transcripts: { first: (w) => pastEnd(w, { structured }) } },
      env,
    );
    assert.equal(outputs["reads-checked"], "true", String(structured));
    assert.equal(review.coverage.read, 0, String(structured));
    assert.equal(
      stdout[0],
      "::notice title=pr-review-cli reads::listed=5 unread=5 mode=enforce",
    );
  }
});

test("only a whole-file Read returning enough unnumbered content lines of a non-empty job diff is unrecognised", () => {
  const { workspace } = lane({
    ".claude-lane/pr.diff": DIFF,
    "lane/empty.diff": "",
  });
  const key = fs.realpathSync(path.join(workspace, ".claude-lane/pr.diff"));
  const emptyKey = fs.realpathSync(path.join(workspace, "lane/empty.diff"));
  const lineCounts = new Map([
    [key, 37],
    [emptyKey, 0],
  ]);
  const of = (messages) => readsOf(messages, workspace, lineCounts);
  // A whole-file Read whose lines carry a prefix the parser does not know.
  const prefixed = unnumbered(read(key, DIFF, 1, 37, { whole: true }));
  for (const block of prefixed[1].message.content) {
    block.content = block.content
      .split("\n")
      .map((line) => `L: ${line}`)
      .join("\n");
  }
  assert.deepEqual([...of(prefixed).unrecognised], [key]);
  // The same text from a Read with a limit, or with an offset past 1, is no evidence.
  const limited = structuredClone(prefixed);
  limited[0].message.content[0].input = { file_path: key, limit: 37 };
  assert.deepEqual([...of(limited).unrecognised], []);
  const offset = structuredClone(prefixed);
  offset[0].message.content[0].input = { file_path: key, offset: 2 };
  assert.deepEqual([...of(offset).unrecognised], []);
  const first = structuredClone(prefixed);
  first[0].message.content[0].input = { file_path: key, offset: 1 };
  assert.deepEqual([...of(first).unrecognised], [key]);
  // Four content lines of a 37-line file are short of the five required.
  const short = structuredClone(prefixed);
  short[1].message.content[0].content = "a\nb\nc\nd";
  assert.deepEqual([...of(short).unrecognised], []);
  // Five lines of tool notices are not content.
  const notices = structuredClone(prefixed);
  notices[1].message.content[0].content = [
    NOTICES[1].message.content[0].content,
    NOTICES[3].message.content[0].content,
    NOTICES[5].message.content[0].content.trim(),
    "<system-reminder>",
    "</system-reminder>",
  ].join("\n");
  assert.deepEqual([...of(notices).unrecognised], []);
  // An empty job file never reads as an unknown format.
  const empty = unnumbered(
    read(emptyKey, "x\ny\nz\nu\nv", 1, 5, { whole: true }),
  );
  assert.deepEqual([...of(empty).unrecognised], []);
  // A structured range of 0 lines is recognised: evidence of nothing.
  const range = pastEnd(workspace);
  range[0].message.content[0].input.file_path = key;
  range[1].tool_use_result.file.filePath = key;
  assert.deepEqual([...of(range).recognised], [key]);
  assert.equal(of(range).shown.get(key).size, 0);
});

test("a whole-file Read whose lines carry an unknown prefix still gives the fallback", () => {
  const prefixed = (w) => {
    const messages = unnumbered(
      read(path.join(w, ".claude-lane/pr.diff"), DIFF, 1, 37, { whole: true }),
    );
    messages[1].message.content[0].content =
      messages[1].message.content[0].content
        .split("\n")
        .map((line) => `L: ${line}`)
        .join("\n");
    return messages;
  };
  const { outputs, stdout } = run(
    {
      workspace: {
        ".claude-lane/pr.diff": DIFF,
        ".claude-lane/files.txt": FILES,
      },
      transcripts: { first: prefixed },
    },
    { REVIEW: REVIEW({ read: 5, changed: 5 }) },
  );
  assert.equal(outputs["reads-checked"], "false");
  assert.deepEqual(stdout, [FORMAT_WARNING]);
});
