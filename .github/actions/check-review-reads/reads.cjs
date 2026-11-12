// Which files of a review's to-read list the leg's own transcript shows as
// read. The model's files_read is its word; this reads the CLI's stream-json
// messages (run-claude-cli's execution file, one per chunk) for the Read
// calls of the review and its subagents, and takes the line numbers each
// Read result printed. A listed file is read only when, in the transcript of
// the review that holds it, Read results printed every non-empty line of each
// of its sections in a diff file the job wrote. Anything this cannot parse or
// match counts as not read.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// A Read result's line: its number, then a tab (or, in older CLIs, an arrow).
const NUMBERED = /^ *([1-9][0-9]{0,8})(?:\t|→)/u;
// Paths printed in a log line or kept by name in the coverage: publish-review's
// DATA_PATH. Any other path is counted only.
const PLAIN_PATH = /^[A-Za-z0-9._/@+-]{1,500}$/u;
const NAMED = 50;
const MAX_REVIEW_BYTES = 100000;
const UNCHECKED = "the job could not check which files the review read";
const UNLISTED = "the job could not list the files the review had to read";
const FORMAT_UNKNOWN = "the CLI's Read output format was not recognized";

/** Each `diff --git` section: its line range, header, rename target, text and non-empty lines. */
function diffSections(text) {
  const lines = String(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const sections = [];
  lines.forEach((line, i) => {
    if (line.startsWith("diff --git ")) {
      sections.push({ start: i + 1, header: line, lines: [] });
    }
    sections.at(-1)?.lines.push(line);
  });
  return sections.map((s) => {
    let renameTo;
    let renamed = false;
    for (const line of s.lines.slice(1)) {
      if (line.startsWith("@@") || line.startsWith("--- ")) break;
      for (const key of ["rename to ", "copy to "]) {
        if (line.startsWith(key)) renameTo = line.slice(key.length);
      }
      if (line === "status: renamed" || line === "status: copied")
        renamed = true;
    }
    const required = s.lines.flatMap((line, i) =>
      line === "" ? [] : [s.start + i],
    );
    const hunk = s.lines.findIndex((line) => line.startsWith("@@"));
    return {
      start: s.start,
      end: s.start + s.lines.length - 1,
      header: s.header,
      renameTo,
      renamed,
      text: s.lines.join("\n"),
      required,
      headerRequired:
        hunk < 0 ? required : required.filter((n) => n < s.start + hunk),
    };
  });
}

// One file name as the check compares it: resolved against the workspace,
// symlinks followed when it exists.
function fileKey(workspace, file) {
  const resolved = path.resolve(workspace, file);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

const resultText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block) =>
            block?.type === "text" && typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("\n")
      : "";

// The line range a Read result's structured record states, when its message
// holds that one result for the same file: the CLI attaches it on the main
// thread, not to a subagent's results.
function structuredRange(message, file, workspace) {
  const record = message?.tool_use_result?.file;
  const results = message.message.content.filter(
    (block) => block?.type === "tool_result",
  );
  if (
    results.length !== 1 ||
    typeof record?.filePath !== "string" ||
    fileKey(workspace, record.filePath) !== file ||
    !Number.isSafeInteger(record.startLine) ||
    !Number.isSafeInteger(record.numLines) ||
    record.startLine < 1 ||
    record.numLines < 0
  ) {
    return null;
  }
  return Array.from(
    { length: record.numLines },
    (_, i) => record.startLine + i,
  );
}

// A tool notice line the CLI adds to a Read result: a system reminder (an
// offset past the end, an empty file) or a bracketed note (NUL bytes).
const NOTICE = /^\s*(?:<\/?system-reminder>|\[.*\]\s*$)/u;
// How many unnumbered content lines a whole-file Read must return before its
// result reads as content the parser failed on.
const CONTENT_LINES = 5;

/**
 * The line numbers Read results printed, per file, over every message (main
 * thread and subagents), and which files' results were recognized or not.
 *
 * Recognized: a result with the CLI's structured range for that file (even of
 * 0 lines), or with at least one numbered line. Unrecognized, only for a file
 * of `lineCounts` with n > 0 lines: a result with no structured range, of a
 * Read with no limit and no offset other than 1, whose text holds at least
 * min(n, CONTENT_LINES) non-empty lines that are not tool notices and none
 * numbered. Every other result is neither: no evidence, never the fallback.
 */
function readsOf(messages, workspace, lineCounts = new Map()) {
  const shown = new Map();
  const recognized = new Set();
  const unrecognized = new Set();
  if (!Array.isArray(messages)) return { shown, recognized, unrecognized };
  const reads = new Map();
  for (const m of messages) {
    if (m?.type !== "assistant" || !Array.isArray(m.message?.content)) continue;
    for (const block of m.message.content) {
      if (
        block?.type === "tool_use" &&
        block.name === "Read" &&
        typeof block.input?.file_path === "string"
      ) {
        reads.set(block.id, {
          file: fileKey(workspace, block.input.file_path),
          whole:
            block.input.limit === undefined &&
            (block.input.offset === undefined || block.input.offset === 1),
        });
      }
    }
  }
  for (const m of messages) {
    if (m?.type !== "user" || !Array.isArray(m.message?.content)) continue;
    for (const block of m.message.content) {
      if (
        block?.type !== "tool_result" ||
        block.is_error === true ||
        !reads.has(block.tool_use_id)
      )
        continue;
      const { file, whole } = reads.get(block.tool_use_id);
      if (!shown.has(file)) shown.set(file, new Set());
      const lines = resultText(block.content).split("\n");
      const range = structuredRange(m, file, workspace);
      const numbers =
        range ??
        lines.flatMap((line) => {
          const match = NUMBERED.exec(line);
          return match ? [Number(match[1])] : [];
        });
      for (const n of numbers) shown.get(file).add(n);
      const length = lineCounts.get(file) ?? 0;
      if (range !== null || numbers.length > 0) recognized.add(file);
      else if (
        whole &&
        length > 0 &&
        lines.filter((line) => line.trim() !== "" && !NOTICE.test(line))
          .length >= Math.min(length, CONTENT_LINES)
      )
        unrecognized.add(file);
    }
  }
  return { shown, recognized, unrecognized };
}

const linesShown = (messages, workspace) => readsOf(messages, workspace).shown;

// The text of a diff file the job wrote: a regular file, never a link.
function diffFile(workspace, file) {
  try {
    const full = path.resolve(workspace, file);
    if (!fs.lstatSync(full).isFile()) return null;
    const text = fs.readFileSync(full, "utf8");
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return {
      key: fileKey(workspace, file),
      lines: lines.length,
      sections: diffSections(text),
    };
  } catch {
    return null;
  }
}

// Whether a section is a listed path's: git's rename or copy target names it,
// or its header is exactly `diff --git a/<p> b/<p>` (git's quoted form when
// the list quotes it). The scope step's API-format rename names only its new
// path last, after `a/<old>`.
function owns(section, listed) {
  if (section.renameTo !== undefined) return section.renameTo === listed;
  if (listed.startsWith('"')) {
    const inner = listed.slice(1);
    return section.header === `diff --git "a/${inner} "b/${inner}`;
  }
  if (section.header === `diff --git a/${listed} b/${listed}`) return true;
  return (
    section.renamed &&
    section.header.startsWith("diff --git a/") &&
    section.header.endsWith(` b/${listed}`)
  );
}

/**
 * The listed paths with no read evidence. scopeDiff is the diff the job wrote
 * for the scope; each review gives the extra diff files it was handed (its
 * chunk) and the lines its own transcript showed. alternates are diff files
 * any review may have read a section in. A section counts only where its text
 * is the scope diff's own.
 */
function checkReads({
  workspace,
  toRead,
  scopeDiff,
  reviews,
  alternates = [],
  binary = new Set(),
}) {
  const scope = diffFile(workspace, scopeDiff);
  if (!scope) return { unread: [...toRead] };
  const shared = [
    scope,
    ...alternates.map((file) => diffFile(workspace, file)).filter(Boolean),
  ];
  const handed = reviews.map((review) =>
    (review.diffs ?? []).map((file) => diffFile(workspace, file)),
  );
  const claims = new Map(
    toRead.map((listed) => [
      listed,
      scope.sections.filter((s) => owns(s, listed)),
    ]),
  );
  const claimed = new Map();
  for (const sections of claims.values()) {
    for (const s of sections) claimed.set(s, (claimed.get(s) ?? 0) + 1);
  }
  // A binary file's section holds raw bytes no review reads as text: its
  // header lines, up to its first hunk, are what must be shown.
  const covered = (section, review, i, binaryFile) => {
    const files = [...shared, ...handed[i].filter(Boolean)];
    return files.some((file) => {
      const lines = review.shown.get(file.key);
      return (
        lines !== undefined &&
        file.sections.some(
          (s) =>
            s.text === section.text &&
            (binaryFile ? s.headerRequired : s.required).every((n) =>
              lines.has(n),
            ),
        )
      );
    });
  };
  const holds = (i, section) =>
    reviews.length === 1 ||
    handed[i].some((file) =>
      file?.sections.some((s) => s.text === section.text),
    );
  const read = (listed) => {
    const sections = claims.get(listed);
    return (
      sections.length > 0 &&
      sections.every(
        (section) =>
          claimed.get(section) === 1 &&
          reviews.some(
            (review, i) =>
              holds(i, section) &&
              covered(section, review, i, binary.has(listed)),
          ),
      )
    );
  };
  return { unread: toRead.filter((listed) => !read(listed)) };
}

// A job-written list: a regular file of one path per line.
function listOf(workspace, file) {
  try {
    const full = path.resolve(workspace, file);
    if (!fs.lstatSync(full).isFile()) return null;
    const lines = fs.readFileSync(full, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  } catch {
    return null;
  }
}

function transcript(file) {
  try {
    if (file === "" || !fs.lstatSync(file).isFile()) return [];
    const messages = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

const WHOLE = /^(?:0|[1-9][0-9]{0,5})$/u;

// The mode the step runs in: `report` when unset, a value that is neither
// enforces, and names itself only when plain.
function modeOf(value, write) {
  if (value === "" || value === "report") return "report";
  if (value === "enforce") return "enforce";
  const named = /^[A-Za-z0-9._-]{1,40}$/u.test(value)
    ? `'${value}'`
    : "an unrecognized value";
  write(
    `::warning title=pr-review-cli reads::the reads-check mode ${named} is neither report nor enforce; the check enforces`,
  );
  return "enforce";
}

// One line per output: a value that would break the line is no result.
function output(file, values) {
  const lines = Object.values(values).some((value) => /[\r\n]/u.test(value))
    ? { verdict: UNCHECKED }
    : values;
  fs.appendFileSync(
    file,
    Object.entries(lines)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
}

/**
 * The step. `enforce`: the extract step's review with its read count held to
 * the files the transcripts show read. `report`: the same check is logged, and
 * the extract step's verdict and review go on as they came, apart from the
 * format fallback's skipped-check note.
 */
function main(
  env = process.env,
  { write = (line) => process.stdout.write(`${line}\n`) } = {},
) {
  const mode = modeOf(env.MODE ?? "", write);
  let result;
  try {
    result = check(env, write, mode);
  } catch (error) {
    // A failed check must not change what report mode passes on.
    if (mode === "enforce") throw error;
    write(
      `::warning title=pr-review-cli reads::the check failed (${error.name}); the review goes on as the extract step gave it`,
    );
    result = {};
  }
  if (mode === "enforce" || result["reads-checked"] === "false") {
    return output(env.GITHUB_OUTPUT, result);
  }
  output(env.GITHUB_OUTPUT, {
    verdict: env.VERDICT ?? "",
    ...(env.REVIEW ? { review: env.REVIEW } : {}),
    ...(result["reads-checked"]
      ? { "reads-checked": result["reads-checked"] }
      : {}),
  });
}

/** The check's outputs, as enforce mode gives them. */
function check(env, write, mode) {
  const verdict = env.VERDICT ?? "";
  if (verdict !== "complete") return { verdict: verdict || UNCHECKED };
  let review;
  try {
    review = JSON.parse(env.REVIEW ?? "");
  } catch {
    return { verdict: UNCHECKED };
  }
  const coverage = review?.coverage;
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const chunks = /^[1-9][0-9]{0,5}$/u.test(env.CHUNKS ?? "")
    ? Number(env.CHUNKS)
    : 0;
  if (
    !Number.isSafeInteger(coverage?.changed) ||
    !Number.isSafeInteger(coverage?.read) ||
    chunks === 0 ||
    !WHOLE.test(env.SKIPPED ?? "")
  ) {
    return { verdict: UNCHECKED };
  }
  // With copies or verified renames counted as read, the list the full-diff
  // step wrote without them; it reports a count only for a list it wrote.
  const skipped = Number(env.SKIPPED);
  const toRead =
    skipped > 0
      ? WHOLE.test(env.TO_READ ?? "")
        ? listOf(workspace, env.TO_READ_FILE)
        : null
      : listOf(workspace, env.FILE_LIST);
  if (
    toRead === null ||
    toRead.length !== coverage.changed - skipped ||
    (skipped > 0 && toRead.length !== Number(env.TO_READ))
  ) {
    return { verdict: UNLISTED };
  }
  const files = [env.EXECUTION_FILE ?? ""];
  for (let k = 2; k <= chunks; k++)
    files.push(
      env.RESULTS_DIR
        ? path.join(env.RESULTS_DIR, `chunk-${k}`, "execution.json")
        : "",
    );
  // distinct.diff is the split step's only when it left files out.
  const alternates = /^[1-9][0-9]{0,5}$/u.test(env.EXCLUDED ?? "")
    ? [path.join(env.CHUNK_DIR, "distinct.diff")]
    : [];
  const chunkDiffs = (i) =>
    chunks > 1 ? [path.join(env.CHUNK_DIR, `chunk-${i + 1}.patch`)] : [];
  // The job's diff files and their line counts, the lengths readsOf weighs
  // an unrecognized result against.
  const lineCounts = new Map();
  for (const file of [
    env.SCOPE_DIFF,
    ...alternates,
    ...files.flatMap((_, i) => chunkDiffs(i)),
  ]) {
    const diff = diffFile(workspace, file);
    if (diff) lineCounts.set(diff.key, diff.lines);
  }
  const reviews = files.map((file, i) => ({
    diffs: chunkDiffs(i),
    ...readsOf(transcript(file), workspace, lineCounts),
  }));
  // Read results of the job's diff files that no line number could be read
  // from, and none that could: the CLI's Read output changed shape, so the
  // per-file check cannot run and the extract step's count stands.
  const any = (set) => [...set].some((file) => lineCounts.has(file));
  if (
    reviews.some((r) => any(r.unrecognized)) &&
    !reviews.some((r) => any(r.recognized))
  ) {
    write(
      `::warning title=pr-review-cli reads::${FORMAT_UNKNOWN}; the per-file read check did not run`,
    );
    review.coverage = { ...coverage, reads_checked: false };
    return {
      verdict: "complete",
      "reads-checked": "false",
      review: JSON.stringify(review),
    };
  }
  const binary = new Set(
    WHOLE.test(env.BINARY ?? "")
      ? (listOf(workspace, env.BINARY_LIST) ?? [])
      : [],
  );
  if (binary.size !== Number(env.BINARY || 0)) binary.clear();
  const { unread } = checkReads({
    workspace,
    toRead,
    scopeDiff: env.SCOPE_DIFF,
    alternates,
    binary,
    reviews,
  });
  write(
    `::notice title=pr-review-cli reads::listed=${toRead.length} unread=${unread.length} mode=${mode}`,
  );
  if (unread.length > 0) {
    const named = unread
      .filter((name) => PLAIN_PATH.test(name))
      .slice(0, NAMED);
    const more = unread.length - named.length;
    const names = [named.join(", "), more > 0 ? `${more} more` : ""]
      .filter(Boolean)
      .join(" and ");
    write(
      `::warning title=pr-review-cli reads::no Read showed the whole change of ${unread.length} listed file(s): ${names}`,
    );
    const read = Math.min(coverage.read, coverage.changed - unread.length);
    review.coverage = {
      ...coverage,
      read,
      ...(named.length > 0 ? { unread_files: named } : {}),
    };
    // The extract step's cap on what leaves the job; the names go first.
    if (Buffer.byteLength(JSON.stringify(review), "utf8") > MAX_REVIEW_BYTES)
      review.coverage = { ...coverage, read };
  }
  return {
    verdict: "complete",
    "reads-checked": "true",
    review: JSON.stringify(review),
  };
}

module.exports = { check, checkReads, diffSections, linesShown, main, readsOf };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stdout.write(
      `::error::check-review-reads: the check failed (${error.name})\n`,
    );
    process.exitCode = 1;
  }
}
