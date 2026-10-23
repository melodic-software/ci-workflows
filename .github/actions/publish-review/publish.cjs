// pr-review-cli's publish step: the one place a review lane's model output
// reaches the pull request. No model runs here. Every value arrives through
// env; the review is model text and is checked before anything is posted.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// The one findSecret label that warns instead of withholding: a review quotes
// assignments from the diff it reviews.
const WARN_ONLY = "password or secret assignment";
const MAX_SUMMARY = 60000;
const MAX_BODY = 8000;
const CLASSES = new Set([
  "auth",
  "rate-limit",
  "overloaded",
  "max-turns",
  "timeout",
  "install-failed",
  "skipped-validation",
  "incomplete",
  "no-execution",
  "other",
]);

// The workflow compares publish with `!=`, which GitHub evaluates ignoring case.
const isComments = (env) => (env.PUBLISH ?? "").toLowerCase() === "comments";

// The head-side (RIGHT) and base-side (LEFT) line numbers a review comment
// can sit on in one file's unified-diff patch.
function commentableLines(patch) {
  const lines = { RIGHT: new Set(), LEFT: new Set() };
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const text of (patch ?? "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (!inHunk || text.startsWith("\\")) {
      // Before the first hunk, or "\ No newline at end of file".
    } else if (text.startsWith("+")) {
      lines.RIGHT.add(newLine++);
    } else if (text.startsWith("-")) {
      lines.LEFT.add(oldLine++);
    } else {
      lines.RIGHT.add(newLine++);
      lines.LEFT.add(oldLine++);
    }
  }
  return lines;
}

// Why a comment cannot be anchored to the pull request's diff, or "".
function anchorProblem(comment, files) {
  const lines = files.get(comment.path);
  if (!lines) return `${comment.path} is not a changed file with a diff`;
  const side = lines[comment.side];
  if (!side?.has(comment.line)) {
    return `${comment.path}:${comment.line} (${comment.side}) is not a line of the diff`;
  }
  if (comment.start_line !== undefined && !side.has(comment.start_line)) {
    return `${comment.path}:${comment.start_line} (${comment.side}) is not a line of the diff`;
  }
  return "";
}

// Model text with its HTML comments removed, so no hidden line can pose as a
// marker, and any unclosed opener escaped.
function stripHtml(text) {
  return String(text ?? "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replaceAll("<!--", "&lt;!--")
    .trim();
}

// A comment body as posted: stripped, capped, and footed for its lane on its
// last line.
function commentBody(body, lane) {
  return `${stripHtml(body).slice(0, MAX_BODY)}\n\nclaude-lane: ${lane}`;
}

// The review the model job extracted, or null when it is not one.
function parseReview(text) {
  let review;
  try {
    review = JSON.parse(text || "null");
  } catch {
    return null;
  }
  if (
    !Number.isSafeInteger(review?.findings) ||
    review.findings < 0 ||
    typeof review.summary !== "string" ||
    !Array.isArray(review.comments)
  ) {
    return null;
  }
  return review;
}

// The leg whose outputs count: the subscription job's when it ran, else the
// key job's. Each value is read from env by its leg prefix.
function pickLeg(env) {
  const leg = env.SUB_RESULT && env.SUB_RESULT !== "skipped" ? "SUB" : "KEY";
  const value = (name) => env[`${leg}_${name}`] ?? "";
  return { leg, value };
}

// What the leg's outputs say happened: { ok: true, review } or
// { ok: false, failureClass }.
function judge(env) {
  const { leg, value } = pickLeg(env);
  const keyClass = env.KEY_LANE_CLASS ?? "";
  if (value("PRESENT") === "false") {
    if (keyClass === "credit-stop")
      return { ok: false, leg, failureClass: "rate-limit" };
    if (keyClass === "auth") return { ok: false, leg, failureClass: "auth" };
    return { ok: false, leg, failureClass: "no-credential" };
  }
  const failed = value("FAILED");
  if (failed === "") return { ok: false, leg, failureClass: "no-outcome" };
  const failureClass = value("CLASS");
  if (failed === "true" || failureClass !== "") {
    return {
      ok: false,
      leg,
      failureClass: CLASSES.has(failureClass) ? failureClass : "other",
    };
  }
  const review =
    value("VERDICT") === "complete" ? parseReview(value("REVIEW")) : null;
  if (!review) return { ok: false, leg, failureClass: "incomplete" };
  return { ok: true, leg, review };
}

// Splits the review's comments into those that can post inline and those
// that go to the summary. One bad anchor sends the whole batch to the summary.
function placeComments(review, files, lane) {
  const prepared = review.comments.map((comment) => ({
    path: comment.path,
    line: comment.line,
    side: comment.side,
    ...(comment.start_line === undefined
      ? {}
      : { start_line: comment.start_line, start_side: comment.side }),
    body: commentBody(comment.body, lane),
  }));
  const problems = prepared
    .map((comment) => anchorProblem(comment, files))
    .filter(Boolean);
  return problems.length === 0
    ? { inline: prepared, unanchored: [], problems }
    : { inline: [], unanchored: prepared, problems };
}

// The summary as posted: the model's summary, then any finding that could not
// sit on a line, with its location.
function summaryText(review, unanchored, lane) {
  const extra = unanchored.map(
    (comment) =>
      `- \`${comment.path}:${comment.line}\` (${comment.side}): ${comment.body.replace(`\n\nclaude-lane: ${lane}`, "")}`,
  );
  return [
    stripHtml(review.summary),
    ...(extra.length > 0
      ? [
          "",
          "Findings not posted inline (their lines are not in the diff):",
          "",
          ...extra,
        ]
      : []),
  ]
    .join("\n")
    .slice(0, MAX_SUMMARY);
}

// The first credential-shaped text in what would be published, as
// { withheld: label } for a blocking hit, else { warnings: [labels] }.
function scan(findSecret, texts) {
  const warnings = [];
  for (const [name, text] of texts) {
    const hit = findSecret(text);
    if (!hit) continue;
    if (hit[0] === WARN_ONLY) warnings.push(`${hit[0]} in ${name}`);
    else return { withheld: `${hit[0]} in ${name}`, warnings };
  }
  return { withheld: "", warnings };
}

const commentKey = (c) => `${c.path}\n${c.line}\n${c.side}\n${c.body}`;

// The diff's commentable lines per file, from a fresh read at the head.
async function diffLines(github, owner, repo, number) {
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  return new Map(
    files
      .filter((f) => typeof f.patch === "string")
      .map((f) => [f.filename, commentableLines(f.patch)]),
  );
}

async function writeMarker(github, owner, repo, env, status, summary) {
  const base = /^[0-9a-f]{40}$/u.test(env.MERGE_BASE ?? "")
    ? [
        `<!-- claude-lane-reviewed-base ref=${env.BASE_REF} merge-base=${env.MERGE_BASE} -->`,
      ]
    : [];
  const body = [
    `<!-- claude-lane-reviewed-head lane=${env.LANE_ID} sha=${env.HEAD_SHA} -->`,
    ...base,
    status,
    ...(summary ? ["", summary] : []),
  ].join("\n");
  if (env.MARKER_ID) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: Number(env.MARKER_ID),
      body,
    });
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: Number(env.PR_NUMBER),
      body,
    });
  }
}

const WHY = {
  auth: "the Claude credential was rejected; the owner replaces the secret",
  "rate-limit": "usage limit or credit stop reached; re-run after it resets",
  overloaded: "the Claude service was overloaded (5xx); re-run later",
  "max-turns": "the review used every turn before finishing",
  timeout: "the review leg reached its time limit",
  "install-failed": "the Claude Code CLI install or its integrity check failed",
  incomplete:
    "the model returned no usable review (findings, summary and comments)",
  "no-credential": "both secrets were empty, so no review ran",
  "no-outcome": "the review job ended before it reported an outcome",
  withheld:
    "the review looked like it carried a credential, so nothing was posted",
  "publish-failed": "posting the review failed",
};

// findSecret from the publish gate the job fetched, or null.
async function loadGate(env) {
  try {
    const gate = await import(
      require("node:url").pathToFileURL(env.PUBLISH_GATE ?? "").href
    );
    return typeof gate.findSecret === "function" ? gate.findSecret : null;
  } catch {
    return null;
  }
}

// Summary mode never fails the step, whatever goes wrong.
async function run(args) {
  const env = args.env ?? process.env;
  try {
    return await publish({ ...args, env });
  } catch (error) {
    if (isComments(env)) throw error;
    args.core.notice(
      `shadow ${env.LANE_ID}: publish step error: ${error.message}`,
    );
    return { error: error.message };
  }
}

async function publish({ github, context, core, env }) {
  const { owner, repo } = context.repo;
  const comments = isComments(env);
  const lane = env.LANE_ID;
  const head = env.HEAD_SHA;
  const number = Number(env.PR_NUMBER);
  const record = `claude-lane-review-complete lane=${lane} sha=${head}`;
  // Comments mode goes red on a failure; summary mode never fails.
  const fail = (failureClass, detail = "") => {
    const line = `${lane}: failure-class=${failureClass}: ${WHY[failureClass] ?? "an unclassified failure"}${detail ? ` (${detail})` : ""}`;
    if (comments) core.setFailed(line);
    else core.notice(`shadow ${line}`);
    return { failureClass };
  };

  if (env.KEY_LANE_CLASS === "auth") {
    core.warning(
      `${lane} key: class=auth: the API refused the key; the owner must replace the secret.`,
    );
  }

  // A review not needed: comments mode carries the last summary forward.
  if (env.SCOPE_REVIEW === "false") {
    if (!comments) {
      await core.summary
        .addRaw(
          `### ${lane} (shadow)\n\n- No review needed: ${env.SKIP_REASON}.\n`,
        )
        .write();
      return { skipped: true };
    }
    await writeMarker(
      github,
      owner,
      repo,
      env,
      `**${lane}** needs no new review of \`${head}\`: ${env.SKIP_REASON}.`,
      stripHtml(env.LAST_SUMMARY).slice(0, MAX_SUMMARY),
    );
    if (env.SKIP === "no-change")
      core.notice(`${record} skip=no-change through=${env.SINCE}`);
    else if (env.SKIP === "docs-only") core.notice(`${record} skip=docs-only`);
    return { skipped: true };
  }

  const verdict = judge(env);
  const { value } = pickLeg(env);
  const facts = {
    lane,
    head,
    leg: verdict.leg === "SUB" ? "subscription" : "key",
    scope: env.SCOPE || "whole",
    turns: value("TURNS"),
    models: value("MODELS"),
    total_cost_usd: value("COST"),
    leg_ms: value("LEG_MS"),
    wall_ms: value("WALL_MS"),
  };
  if (!verdict.ok) {
    if (!comments)
      await shadowReport(core, env, {
        ...facts,
        failure_class: verdict.failureClass,
      });
    return fail(verdict.failureClass);
  }

  const { review } = verdict;
  const live = (
    await github.rest.pulls.get({ owner, repo, pull_number: number })
  ).data.head.sha;
  const files =
    live === head ? await diffLines(github, owner, repo, number) : new Map();
  const placed = placeComments(review, files, lane);
  if (live !== head)
    placed.problems.unshift(`the pull request's head moved to ${live}`);
  const summary = summaryText(review, placed.unanchored, lane);
  const findings = Math.max(review.findings, review.comments.length);

  const findSecret = await loadGate(env);
  if (!findSecret)
    return fail("publish-failed", "the publish gate could not be loaded");
  const scanned = scan(findSecret, [
    ["the summary", summary],
    ...placed.inline.map((c, i) => [`inline comment ${i + 1}`, c.body]),
  ]);
  for (const warning of scanned.warnings)
    core.warning(`${lane}: ${warning}; published anyway.`);
  if (scanned.withheld) {
    if (!comments)
      await shadowReport(core, env, { ...facts, failure_class: "withheld" });
    return fail("withheld", scanned.withheld);
  }

  if (!comments) {
    await shadowReport(core, env, {
      ...facts,
      findings,
      inline: placed.inline.length,
      anchor_problems: placed.problems,
      review: {
        findings: review.findings,
        summary,
        comments: [...placed.inline, ...placed.unanchored],
      },
    });
    return { findings, inline: placed.inline.length };
  }

  let inline = 0;
  try {
    // A rerun posts only what this lane has not posted on this head.
    const posted = new Set(
      (
        await github.paginate(github.rest.pulls.listReviewComments, {
          owner,
          repo,
          pull_number: number,
          per_page: 100,
        })
      )
        .filter(
          (c) =>
            c.user?.login === "github-actions[bot]" && c.commit_id === head,
        )
        .map((c) => commentKey({ ...c, side: c.side ?? "RIGHT" })),
    );
    const fresh = placed.inline.filter((c) => !posted.has(commentKey(c)));
    inline = placed.inline.length;
    if (fresh.length > 0) {
      await github.rest.pulls.createReview({
        owner,
        repo,
        pull_number: number,
        commit_id: head,
        event: "COMMENT",
        body: `**${lane}**: ${inline} inline finding(s) on \`${head}\`; the summary is in this lane's pull request comment.\n\nclaude-lane: ${lane}`,
        comments: fresh,
      });
    }
    await writeMarker(
      github,
      owner,
      repo,
      env,
      `**${lane}** reviewed \`${head}\`: ${findings} finding(s), ${inline} as inline comments.`,
      summary,
    );
  } catch (error) {
    return fail("publish-failed", error.message);
  }
  const scope =
    env.SCOPE === "incremental"
      ? `scope=incremental since=${env.SINCE}`
      : "scope=whole";
  const account = verdict.leg === "SUB" ? " account=fallback" : "";
  core.notice(
    `${record} findings=${findings} inline=${inline} ${scope}${account}`,
  );
  return { findings, inline };
}

// Summary mode's whole output: a job summary and, when it scans clean, the
// JSON file the artifact step uploads.
async function shadowReport(core, env, report) {
  const lines = [
    `### ${report.lane} (shadow)`,
    "",
    `- Leg: ${report.leg}; scope: ${report.scope}`,
    `- Outcome: ${report.failure_class ?? "complete"}`,
    `- Findings: ${report.findings ?? "none"}; inline-ready: ${report.inline ?? 0}`,
    `- Anchor problems: ${report.anchor_problems?.length ?? 0}`,
    `- Turns: ${report.turns || "?"}; models: ${report.models || "?"}`,
    `- Leg ms: ${report.leg_ms || "?"}; wall ms: ${report.wall_ms || "?"}`,
  ];
  await core.summary.addRaw(`${lines.join("\n")}\n`).write();
  if (!env.ARTIFACT_DIR) return;
  const findSecret = await loadGate(env);
  const text = JSON.stringify(report, null, 2);
  const hit = findSecret
    ? scan(findSecret, [["the shadow report", text]]).withheld
    : "no publish gate";
  if (hit) {
    core.warning(`${report.lane}: the shadow report was not written: ${hit}.`);
    return;
  }
  fs.mkdirSync(env.ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.ARTIFACT_DIR, `${report.lane}.json`), text);
}

module.exports = {
  anchorProblem,
  commentBody,
  commentableLines,
  judge,
  parseReview,
  placeComments,
  run,
  scan,
  stripHtml,
  summaryText,
};
