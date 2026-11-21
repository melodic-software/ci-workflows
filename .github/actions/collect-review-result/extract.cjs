// pr-review-cli's extract step: reads structured output from single or
// chunked review runs, validates coverage and schema, merges chunk reviews,
// and emits the final review JSON and verdict. Every value arrives through
// env.
"use strict";

async function run({ core }) {
  const fs = require("node:fs");
  const env = process.env;
  // One review, or one per chunk the compose step wrote a prompt for
  // (its check, repeated: anything else is one review).
  const chunkFiles = String(env.CHUNK_FILES ?? "").split(",");
  const chunks =
    /^[1-9][0-9]{0,5}$/u.test(env.CHUNKS ?? "") &&
    Number(env.CHUNKS) >= 2 &&
    Number(env.CHUNKS) <= Number(env.MAX_CHUNKS) &&
    chunkFiles.length === Number(env.CHUNKS) &&
    chunkFiles.every((n) => /^(?:0|[1-9][0-9]{0,5})$/u.test(n))
      ? Number(env.CHUNKS)
      : 1;
  // Chunk 1 is the first review step's; each later chunk's files are in
  // the chunk loop's results directory.
  const fileOf = (i, first, name) => (i === 0 ? env[first] : `${env.RESULTS_DIR}/chunk-${i + 1}/${name}`);
  const indexes = Array.from({ length: chunks }, (_, i) => i);
  const records = indexes.map((i) => {
    try {
      return JSON.parse(fs.readFileSync(fileOf(i, "LOG_FILE", "log.jsonl"), "utf8").trim().split("\n")[0]) ?? {};
    } catch {
      return {};
    }
  });
  // A fact is the chunks' sum, only when every chunk's log has it.
  const total = (field, valid) =>
    records.every((r) => valid(r[field])) ? String(records.reduce((sum, r) => sum + r[field], 0)) : "";
  const amount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const wall = Date.parse(records.at(-1).ended_at ?? "") - Date.parse(records[0].started_at ?? "");
  const turns = total("num_turns", Number.isSafeInteger);
  core.setOutput("turns", turns);
  core.setOutput("cost", total("total_cost_usd", amount));
  core.setOutput("leg-ms", total("duration_ms", Number.isSafeInteger));
  core.setOutput("wall-ms", Number.isSafeInteger(wall) && wall >= 0 ? String(wall) : "");
  core.setOutput(
    "models",
    [...new Set(records.flatMap((r) => Object.keys(r.models_used ?? {})))]
      .filter((name) => /^[\w.:@[\]-]{1,100}$/u.test(name))
      .slice(0, 8)
      .join(","),
  );
  const incomplete = (reason, verdictClass = "incomplete") => {
    core.setOutput("verdict", reason);
    core.setOutput("verdict-class", verdictClass);
    core.info(`no completed review: ${reason}.`);
  };
  if (env.MODE_OK !== "true") return incomplete("the leg's permission mode was not confirmed");
  if (env.SCOPE !== "incremental" && env.FULL_DIFF !== "true") {
    return incomplete("the full diff could not be written, so the review saw only part of the pull request");
  }
  // Each chunk's share of the caps one review has.
  // A chunk's summary keeps its share of one review's 20000
  // characters, and never less than CHUNK_SUMMARY_CHARS.
  const caps =
    chunks === 1
      ? { summary: 20000, comments: 25 }
      : { summary: Math.max(Number(env.CHUNK_SUMMARY_CHARS), Math.floor(20000 / chunks)), comments: Number(env.CHUNK_COMMENTS) };
  // A comment body's length, the compose step's schema maxLength.
  const MAX_BODY = 3000;
  // Uncovered rules caps, matching the compose schema and codify's reader.
  const MAX_UNCOVERED_RULES = 5;
  const MAX_UNCOVERED_RULE_CHARS = 300;
  const cleanUncoveredRule = (value) => {
    const cleaned = value
      .replace(/<!--[\s\S]*?-->/gu, "")
      .replaceAll("<!--", "&lt;!--")
      .replace(/[\r\n\p{Zl}\p{Zp}]+/gu, " ")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .trim()
      .replace(/^Uncovered rule:\s*/iu, "")
      .trim();
    return cleaned ? [...cleaned].slice(0, MAX_UNCOVERED_RULE_CHARS).join("") : "";
  };
  // One review's checks: a reason string on a gap, else its parts.
  const check = (file) => {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return "the leg wrote no structured output";
    }
    const summary =
      typeof raw?.summary === "string" ? raw.summary.replace(/<!--[\s\S]*?-->/gu, "").trim() : "";
    if (!Number.isSafeInteger(raw?.findings) || raw.findings < 0) return "the review returned no findings count";
    if (!summary) return "the review returned no summary";
    // Never cut: a cut summary could lose a finding or its
    // critical-findings line.
    if (summary.length > caps.summary) return `the review's summary is over its ${caps.summary}-character cap`;
    if (!Array.isArray(raw.comments) || raw.comments.length > caps.comments) return "the review returned no comment list";
    // A comment with no body is dropped. One whose path, line, side or
    // start_line is malformed goes on in `malformed`, with its path and
    // line where readable, and the status job lists it in the summary.
    const comments = [];
    const malformed = [];
    for (const c of raw.comments) {
      if (typeof c?.body !== "string" || c.body.trim() === "") {
        core.warning("a review comment with no body was dropped");
        continue;
      }
      const ok =
        typeof c.path === "string" &&
        /^[^/\0][^\0]{0,499}$/u.test(c.path) &&
        Number.isSafeInteger(c.line) &&
        c.line >= 1 &&
        (c.side === "RIGHT" || c.side === "LEFT") &&
        (c.start_line === undefined || (Number.isSafeInteger(c.start_line) && c.start_line >= 1 && c.start_line < c.line));
      if (!ok) {
        malformed.push({
          ...(typeof c.path === "string" && /^[^\0\r\n`]{1,500}$/u.test(c.path) ? { path: c.path } : {}),
          ...(Number.isSafeInteger(c.line) && c.line >= 1 ? { line: c.line } : {}),
          body: c.body.slice(0, MAX_BODY),
        });
        continue;
      }
      comments.push({
        path: c.path,
        line: c.line,
        side: c.side,
        ...(c.start_line === undefined ? {} : { start_line: c.start_line }),
        body: c.body.slice(0, MAX_BODY),
      });
    }
    // An optional hold for a person: known criteria, each once, and a
    // reason. A malformed hold makes the review incomplete.
    let hold;
    if (raw.hold !== undefined) {
      const criteria = raw.hold?.criteria;
      const reason =
        typeof raw.hold?.reason === "string" ? raw.hold.reason.replace(/<!--[\s\S]*?-->/gu, "").trim().slice(0, 2000) : "";
      if (
        !Array.isArray(criteria) ||
        criteria.length === 0 ||
        new Set(criteria).size !== criteria.length ||
        !criteria.every((c) => ["cost", "trust-gate", "critical-security"].includes(c)) ||
        !reason
      ) {
        return "the review's hold is malformed";
      }
      hold = { criteria, reason };
    }
    // Optional uncovered rules: at most 5 strings, each sanitized and capped
    // at 300 characters; never counted in findings or critical-findings.
    const uncoveredRules = [];
    if (raw.uncovered_rules !== undefined) {
      if (
        !Array.isArray(raw.uncovered_rules) ||
        raw.uncovered_rules.length > MAX_UNCOVERED_RULES ||
        !raw.uncovered_rules.every((r) => typeof r === "string")
      ) {
        return "the review's uncovered_rules is malformed";
      }
      const seen = new Set();
      for (const entry of raw.uncovered_rules) {
        const cleaned = cleanUncoveredRule(entry);
        if (cleaned && !seen.has(cleaned)) {
          seen.add(cleaned);
          uncoveredRules.push(cleaned);
        }
      }
    }
    if (!Number.isSafeInteger(raw.files_read) || raw.files_read < 0) return "the review returned no files_read count";
    // Every comment and every `manifest <field>: flag` summary line is
    // a finding, so a lower count is raised to them, never trusted.
    const flags = summary.match(/^[ \t]*(?:[-*+][ \t]+)?`?manifest \S+: flag/gmu)?.length ?? 0;
    return {
      findings: Math.max(raw.findings, comments.length + malformed.length, flags),
      filesRead: raw.files_read,
      summary,
      comments,
      malformed,
      hold,
      uncoveredRules,
    };
  };
  // A chunk counts only when its step succeeded; the first gap names
  // its chunk and makes the whole review incomplete.
  const outcomes = String(env.CHUNK_OUTCOMES ?? "").split(",");
  const reviews = [];
  for (const i of indexes) {
    const of = chunks === 1 ? "" : `chunk ${i + 1} of ${chunks}: `;
    if (chunks > 1 && outcomes[i] !== "success") return incomplete(`${of}the review step did not succeed`);
    const result = check(fileOf(i, "STRUCTURED_FILE", "structured.json"));
    // A session that returned no output or no summary left nothing to post.
    const unposted = ["the leg wrote no structured output", "the review returned no summary"].includes(result);
    if (typeof result === "string") return incomplete(`${of}${result}`, unposted ? "review-unposted" : "incomplete");
    reviews.push(result);
  }
  // Coverage: the changed files the review read, of those in scope. The
  // count in scope and the diff's size come from this job; the model
  // supplies only how many it read, capped at that count (per chunk,
  // at the files the split step counted in it). A diff over one
  // review's read budget (READ_BUDGET) is
  // partial whatever the model reports, unless each of its chunks,
  // each within the budget, was reviewed. So is one review of more
  // files that are not copies or verified renames than
  // MAX_CHUNK_FILES.
  if (!/^[1-9][0-9]{0,8}$/u.test(env.READ_BUDGET ?? "")) return incomplete("the job could not read one review's read budget");
  const READ_BUDGET = Number(env.READ_BUDGET);
  const counted = env.SCOPE === "incremental" ? env.SCOPE_FILES : env.WHOLE_FILES;
  if (!/^[0-9]{1,6}$/u.test(counted ?? "")) return incomplete("the job could not count the changed files in scope");
  // The size the writing step measured; the file must be a regular
  // file, never a symlink the head committed in its place.
  let regular = false;
  try {
    regular = fs.lstatSync(env.SCOPE_DIFF).isFile();
  } catch {}
  if (!regular) return incomplete("the diff file in scope is missing or not a regular file");
  if (!/^[0-9]{1,12}$/u.test(env.SCOPE_BYTES ?? "")) return incomplete("the job could not measure the diff in scope");
  if (!/^[1-9][0-9]{0,5}$/u.test(env.MAX_CHUNK_FILES ?? "")) return incomplete("the job could not read the files one review reads whole");
  for (let k = 1; chunks > 1 && k <= chunks; k++) {
    let size = -1;
    try {
      const stat = fs.lstatSync(`${env.CHUNK_DIR}/chunk-${k}.patch`);
      if (stat.isFile()) size = stat.size;
    } catch {}
    if (size < 0 || size > READ_BUDGET) {
      return incomplete(`chunk ${k} of ${chunks}: its diff file is missing, not a regular file, or over the read budget`);
    }
  }
  const changed = Number(counted);
  // The identical-change copies and verified renames in scope the
  // full-diff step listed count as read (the compose step told the
  // model to skip them), never past the files in scope: in one
  // review, or in chunks the split step left exactly them out of.
  // A copy group's first path is read, so the copies stay under the
  // files in scope; a pull request of renames alone is all renames.
  const listed = (value) => (/^[0-9]{1,6}$/u.test(value ?? "") ? Number(value) : 0);
  const leftOut = listed(env.COPIES) + listed(env.RENAMES);
  const counts =
    listed(env.COPIES) < changed &&
    leftOut <= changed &&
    (chunks === 1 ||
      (env.EXCLUDED === String(leftOut) && chunkFiles.reduce((sum, n) => sum + Number(n), 0) + leftOut === changed));
  const copies = counts ? listed(env.COPIES) : 0;
  const renames = counts ? listed(env.RENAMES) : 0;
  const skipped = copies + renames;
  core.setOutput("skipped", String(skipped));
  // One review of the diff the split step wrote without them reads
  // that diff's size, not the whole diff's.
  const bytes = Number(
    chunks === 1 && skipped > 0 && env.EXCLUDED === String(skipped) && /^[0-9]{1,12}$/u.test(env.DISTINCT_BYTES ?? "")
      ? env.DISTINCT_BYTES
      : env.SCOPE_BYTES,
  );
  // The generated data files the job left out of the scope's diff,
  // list and count, named in the coverage. A count the job's list
  // cannot back makes the review incomplete, so none goes unnamed.
  let dataFiles = [];
  if (/^[1-9][0-9]{0,5}$/u.test(env.DATA ?? "")) {
    try {
      if (fs.lstatSync(env.DATA_LIST).isFile()) dataFiles = fs.readFileSync(env.DATA_LIST, "utf8").split("\n").filter(Boolean);
    } catch {}
    if (dataFiles.length !== Number(env.DATA) || !dataFiles.every((name) => /^[A-Za-z0-9._/@+-]{1,500}$/u.test(name))) {
      return incomplete("the job could not name the generated data files it left out");
    }
  }
  // The binary files of a whole review's scope, named in the
  // coverage. They change no count; a list the count cannot back
  // names none.
  let binaryFiles = [];
  if (env.SCOPE !== "incremental" && /^[1-9][0-9]{0,5}$/u.test(env.BINARY ?? "")) {
    try {
      if (fs.lstatSync(env.BINARY_LIST).isFile()) binaryFiles = fs.readFileSync(env.BINARY_LIST, "utf8").split("\n").filter(Boolean);
    } catch {}
    if (binaryFiles.length !== Number(env.BINARY) || !binaryFiles.every((name) => /^[A-Za-z0-9._/@+-]{1,500}$/u.test(name))) binaryFiles = [];
  }
  // A chunk holding an earlier piece of a cut file reads it as one
  // more unit than the files counted in it, so a review is complete
  // only when every chunk read each of its units; a chunk short of
  // them, holding a piece, is named.
  const piecesIn = env.CHUNK_PIECES ? String(env.CHUNK_PIECES).split(",") : [];
  let pieceNames = [];
  try {
    pieceNames = env.PIECE_NAMES ? JSON.parse(env.PIECE_NAMES) : [];
  } catch {}
  // A split that cut a file always holds a piece in some chunk.
  const cutFiles = /^[1-9][0-9]{0,5}$/u.test(env.SLICED ?? "") && chunks > 1;
  if (
    (cutFiles && piecesIn.length === 0) ||
    (piecesIn.length > 0 &&
    (chunks === 1 ||
      piecesIn.length !== chunks ||
      !piecesIn.every((n) => /^(?:0|[1-9][0-9]{0,5})$/u.test(n)) ||
      !Array.isArray(pieceNames) ||
      pieceNames.length !== chunks ||
      !pieceNames.every((list) => Array.isArray(list) && list.every((name) => typeof name === "string"))))
  ) {
    return incomplete("the job could not read how many cut-file pieces each chunk holds");
  }
  const unitsOf = (i) => Number(chunkFiles[i]) + Number(piecesIn[i] ?? 0);
  const read =
    reviews.reduce((sum, r, i) => sum + (chunks === 1 ? r.filesRead : Math.min(r.filesRead, unitsOf(i))), 0) -
    piecesIn.reduce((sum, n) => sum + Number(n), 0);
  const shortPieces = reviews.flatMap((r, i) =>
    piecesIn.length > 0 && pieceNames[i].length > 0 && r.filesRead < unitsOf(i)
      ? [`chunk ${i + 1} of ${chunks} reported files_read ${r.filesRead} of ${unitsOf(i)} and holds ${pieceNames[i].join(", ")}`]
      : [],
  );
  if (shortPieces.length > 0) core.warning(`cut files not read whole: ${shortPieces.join("; ")}`);
  const coverage = {
    read: Math.max(Math.min(read, changed - skipped), 0) + skipped,
    changed,
    ...(renames > 0 ? { renames } : {}),
    ...(dataFiles.length > 0 ? { data_files: dataFiles } : {}),
    ...(binaryFiles.length > 0 ? { binary_files: binaryFiles } : {}),
    ...(chunks === 1 && bytes > READ_BUDGET ? { over_budget: bytes } : {}),
    // One review of more files than the split step's cap, past the
    // copies and renames it skips: a split refused or failed for
    // file count.
    ...(chunks === 1 && changed - skipped > Number(env.MAX_CHUNK_FILES) ? { over_files: changed - skipped } : {}),
  };
  const malformed = reviews.flatMap((r) => r.malformed);
  // A chunked review's comments, merged across chunks. One another
  // chunk made at the same line with the same text (whitespace and
  // case aside) is dropped as a duplicate; any other is a finding of
  // its own. Past the inline cap, most severe first, the rest are
  // listed in the summary, so no finding is lost. Severity is
  // publish-review's reading: exactly one severity line, else
  // CRITICAL.
  const INLINE = 25;
  const SEVERITY = /^\s*`?severity: (CRITICAL|IMPORTANT|SUGGESTION)`?\s*$/gmu;
  const severity = (body) => {
    const found = [...body.matchAll(SEVERITY)].map((m) => m[1]);
    return found.length === 1 ? found[0] : "CRITICAL";
  };
  const RANK = { CRITICAL: 0, IMPORTANT: 1, SUGGESTION: 2 };
  const plain = (body) => body.replace(/\s+/gu, " ").trim();
  let duplicates = 0;
  let comments = reviews[0].comments;
  let overflow = [];
  if (chunks > 1) {
    const both = new Set();
    const kept = [];
    for (const c of reviews.flatMap((r) => r.comments)) {
      const same = `${c.path}\0${c.line}\0${c.side}\0${plain(c.body).toLowerCase()}`;
      if (both.has(same)) {
        duplicates++;
        continue;
      }
      both.add(same);
      kept.push(c);
    }
    kept.sort((a, b) => RANK[severity(a.body)] - RANK[severity(b.body)]);
    comments = kept.slice(0, INLINE);
    overflow = kept.slice(INLINE);
  }
  const findings = reviews.reduce((sum, r) => sum + r.findings, 0) - duplicates;
  // The marker's summary says why the read count holds files no
  // review read the content of.
  const moved =
    renames > 0
      ? `\n\nVerified renames: ${renames} of ${changed} changed file(s) moved with no content or mode change; they count as read without a read of their unchanged content, and the review was asked to check each new path.`
      : "";
  const ceiling =
    chunks === 1 && /^[1-9][0-9]{0,5}$/u.test(env.OVER_CHUNKS ?? "")
      ? `\n\nChunk ceiling: the diff in scope needs ${env.OVER_CHUNKS} chunks, more than the ceiling of ${env.MAX_CHUNKS}, so it was reviewed unsplit, as a partial review.`
      : "";
  const cutShort = shortPieces.length > 0 ? `\n\nCut files not read whole: ${shortPieces.join("; ")}.` : "";
  // publish-review's CRITICAL_LINE. Its gates read a summary's
  // CRITICAL count only from exactly one such line:
  // claude-code-plugins clear-escalations.mjs (:578, :924) clears
  // only one line reading 0, babysit_review_evidence.py (:351)
  // counts every finding CRITICAL without exactly one, and
  // publish-review (countedSummary) adds its own demoted findings
  // only to a lone line. So a chunked review's lines merge into one:
  // each chunk's count (its one line, else its summary-only
  // findings, as publish-review counts a summary with no line, or
  // with several the larger of their sum and those findings), plus
  // the listed CRITICAL comments.
  const CRITICAL_LINE = /^(\s*`?critical-findings: )(\d{1,6})(`?\s*)$/gmu;
  const chunkCritical = reviews.reduce((sum, r) => {
    const counts = [...r.summary.matchAll(CRITICAL_LINE)].map((m) => Number(m[2]));
    const summaryOnly = Math.max(r.findings - r.comments.length - r.malformed.length, 0);
    return sum + (counts.length === 1 ? counts[0] : Math.max(summaryOnly, counts.reduce((a, b) => a + b, 0)));
  }, 0);
  const head =
    chunks === 1
      ? reviews[0].summary
      : reviews
          .map((r, i) => `#### Chunk ${i + 1} of ${chunks} (${chunkFiles[i]} files)\n\n${r.summary.replace(CRITICAL_LINE, "").trim()}`)
          .join("\n\n");
  // The summary listing the overflow comments, most severe first,
  // each with its first `excerpt` characters; at excerpt 0, only
  // their locations, grouped by path.
  const summaryOf = (excerpt) => {
    if (chunks === 1) return head + moved + ceiling;
    const ranked = overflow.toSorted((a, b) => RANK[severity(a.body)] - RANK[severity(b.body)]);
    let entries;
    if (excerpt > 0) {
      entries = ranked.map((c) => {
        const text = plain(c.body);
        return `- ${severity(c.body)} \`${plain(c.path)}:${c.line}\` (${c.side}): ${text.length > excerpt ? `${text.slice(0, excerpt)}...` : text}`;
      });
    } else {
      const byPath = new Map();
      for (const c of ranked) byPath.set(plain(c.path), [...(byPath.get(plain(c.path)) ?? []), c]);
      entries = [...byPath].map(([where, list]) => `- \`${where}\`: ${list.map((c) => `${severity(c.body)} line ${c.line} (${c.side})`).join(", ")}`);
    }
    const critical = chunkCritical + overflow.filter((c) => severity(c.body) === "CRITICAL").length;
    return (
      [
        head,
        ...(entries.length > 0
          ? ["", `Findings not posted inline (past the ${INLINE}-comment cap), most severe first:`, "", ...entries]
          : []),
        "",
        `critical-findings: ${critical}`,
      ].join("\n") +
      moved +
      ceiling +
      cutShort
    );
  };
  const uncoveredRules = [];
  {
    const seen = new Set();
    for (const r of reviews) {
      for (const rule of r.uncoveredRules ?? []) {
        if (!seen.has(rule) && uncoveredRules.length < MAX_UNCOVERED_RULES) {
          seen.add(rule);
          uncoveredRules.push(rule);
        }
      }
    }
  }
  const holds = reviews.flatMap((r, i) => (r.hold ? [{ ...r.hold, chunk: i + 1 }] : []));
  const hold =
    holds.length === 0
      ? undefined
      : chunks === 1
        ? { criteria: holds[0].criteria, reason: holds[0].reason }
        : {
            criteria: [...new Set(holds.flatMap((h) => h.criteria))],
            reason: holds
              .map((h) => `Chunk ${h.chunk}: ${h.reason}`)
              .join("\n")
              .slice(0, 2000),
          };
  // The status job receives the review as one environment string, which
  // Linux caps at 128 KiB (MAX_ARG_STRLEN), so a review over 100 KB is
  // not passed on.
  //
  // publish-review keeps PUBLISH_SUMMARY characters of the summary it
  // posts (publish.cjs MAX_SUMMARY; a test holds the two equal), and
  // when one inline anchor is bad it posts every inline comment in
  // that summary instead (placeComments, summaryText). So a chunked
  // review fits only when its summary plus every inline comment as
  // publish-review would list it, `- \`path:line\` (side): body` and
  // a newline, plus its malformed comments listed the same way, plus
  // RESERVE for the two list headings and a longer critical count,
  // stays within PUBLISH_SUMMARY. Each unclosed `<!--` counts 3 more,
  // as publish-review escapes it. To fit, the listed comments first
  // lose text (whole, then 300 and 120 characters, then locations
  // only, grouped by path); then the least severe inline comment
  // joins the list and the text tiers start again. A review that
  // still does not fit is incomplete, saying why. One review of the
  // whole diff is passed on as before.
  const PUBLISH_SUMMARY = 60000;
  const RESERVE = 200;
  const posted = (text) => text.length + 3 * (text.split("<!--").length - 1);
  const demoted = () =>
    comments.reduce((n, c) => n + posted(`- \`${c.path}:${c.line}\` (${c.side}): ${c.body}`) + 1, 0) +
    malformed.reduce((n, c) => n + posted(`- \`${c.path ?? ""}:${c.line ?? ""}\`: ${c.body}`) + 1, 0);
  const reviewOf = (excerpt) => {
    const summary = summaryOf(excerpt);
    const text = JSON.stringify({
      findings,
      coverage,
      summary,
      comments,
      ...(malformed.length > 0 ? { malformed } : {}),
      ...(hold ? { hold } : {}),
      ...(uncoveredRules.length > 0 ? { uncovered_rules: uncoveredRules } : {}),
    });
    const need = posted(summary) + demoted() + RESERVE;
    return { text, need, ok: Buffer.byteLength(text, "utf8") <= 100000 && (chunks === 1 || need <= PUBLISH_SUMMARY) };
  };
  let review;
  for (;;) {
    for (const excerpt of chunks === 1 ? [0] : [MAX_BODY, 300, 120, 0]) {
      review = reviewOf(excerpt);
      if (review.ok) break;
    }
    if (review.ok || comments.length === 0 || chunks === 1) break;
    overflow = [comments.at(-1), ...overflow];
    comments = comments.slice(0, -1);
  }
  if (!review.ok) {
    if (chunks === 1) return incomplete("the review is over 100,000 bytes, too large to pass on");
    return incomplete(
      `the merged review does not fit: ${comments.length + overflow.length} findings need ${review.need} summary characters with every inline comment demoted, over the ${PUBLISH_SUMMARY} publish-review keeps`,
    );
  }
  review = review.text;
  core.setOutput("review", review);
  core.setOutput("verdict", "complete");
  await core.summary
    .addRaw(
      `### review leg\n\n- Findings: ${findings}; comments: ${comments.length}; malformed: ${malformed.length}\n- Chunks: ${chunks}; data files left out: ${dataFiles.length}; verified renames counted as read: ${renames}\n- Turns: ${turns || "?"}\n`,
    )
    .write();
}

module.exports = { run };
