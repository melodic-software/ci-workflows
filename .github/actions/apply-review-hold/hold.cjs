// pr-review-cli's hold step. No model runs here. It reads, from env:
// HOLD_LABEL, HOLD_PATHS (newline-separated globs), LANE_ID, PR_NUMBER,
// HEAD_SHA, PUBLISH_GATE, PR_FILES (the scope step's file list), and the
// legs' KEY_* and SUB_* outputs that publish-review's judge reads. It only adds: the label and one marker
// comment. Every write goes through issues.addLabels or issues.createComment.
"use strict";

const {
  judge,
  loadGate,
  scan,
  scopedFiles,
  stripHtml,
} = require("../publish-review/publish.cjs");

const CRITERIA = ["cost", "trust-gate", "critical-security"];
const MAX_REASON = 2000;
const MAX_LISTED = 20;

// The same conversion as pr-review-cli.yml's scope step (a test holds them
// equal): `**/` any directories, `**` anything, `*` and `?` within one name.
const globToRegExp = (glob) => {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 1;
    } else if (glob[i] === "*") {
      out += "[^/]*";
    } else if (glob[i] === "?") {
      out += "[^/]";
    } else {
      out += glob[i].replace(/[.+^$(){}|[\]\\]/u, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "u");
};

const patterns = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(globToRegExp);

const names = (file) =>
  [file.filename, file.previous_filename].filter(Boolean);

// The hold the counted leg's checked review returned, or null.
function modelHold(env) {
  const verdict = judge(env);
  const hold = verdict.ok ? verdict.review.hold : undefined;
  if (!hold || !Array.isArray(hold.criteria)) return null;
  const criteria = hold.criteria.filter((c) => CRITERIA.includes(c));
  if (criteria.length === 0) return null;
  return {
    criteria,
    reason: typeof hold.reason === "string" ? hold.reason : "",
  };
}

// trust-gate when a changed file, or a renamed file's old path, matches a
// hold path, or when GitHub listed fewer files than the pull request changed.
// The list is the scope step's at the head (PR_FILES); without one it is read.
async function pathHold(github, owner, repo, number, globs, env) {
  if (globs.length === 0) return null;
  const scoped = scopedFiles(env);
  const files = scoped
    ? scoped.files.map((f) => ({ filename: f.n, previous_filename: f.p }))
    : await github.paginate(github.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
  const matched = [
    ...new Set(
      files.flatMap(names).filter((name) => globs.some((re) => re.test(name))),
    ),
  ];
  if (matched.length > 0) {
    // File names are the author's text: no backticks, line breaks or mentions.
    const shown = matched
      .slice(0, MAX_LISTED)
      .map((name) => `\`${name.replace(/[`\r\n]/gu, "?").replaceAll("@", "@\u200b")}\``);
    if (matched.length > shown.length)
      shown.push(`and ${matched.length - shown.length} more`);
    return `Changed files match hold-paths: ${shown.join(", ")}.`;
  }
  const changed = scoped
    ? scoped.changed
    : ((await github.rest.pulls.get({ owner, repo, pull_number: number })).data
        .changed_files ?? 0);
  if (files.length < changed) {
    return `GitHub listed ${files.length} of the pull request's ${changed} changed files, so hold-paths could not be checked against every file.`;
  }
  return null;
}

async function run({ github, context, core, env = process.env }) {
  const label = env.HOLD_LABEL ?? "";
  if (label === "") {
    core.setOutput("hold", "false");
    core.setOutput("criteria", "");
    return { hold: false, criteria: [] };
  }
  if (!/^[^,\n]{1,50}$/u.test(label))
    throw new Error("hold-label must be one label name of 1 to 50 characters");
  if (!/^[0-9a-f]{40}$/u.test(env.HEAD_SHA ?? ""))
    throw new Error("HEAD_SHA is not a commit");
  if (!/^[a-z-]+$/u.test(env.LANE_ID ?? ""))
    throw new Error("LANE_ID is not a lane id");
  const { owner, repo } = context.repo;
  const number = Number(env.PR_NUMBER);
  const lane = env.LANE_ID;

  const found = new Set();
  const reasons = [];
  const model = modelHold(env);
  if (model) {
    for (const c of model.criteria) found.add(c);
    reasons.push(model.reason);
  }
  // A listing that fails holds too, so a model hold is never lost to it;
  // the error still fails the step after the writes.
  const errors = [];
  let byPath;
  try {
    byPath = await pathHold(
      github,
      owner,
      repo,
      number,
      patterns(env.HOLD_PATHS),
      env,
    );
  } catch (error) {
    errors.push(`could not list the changed files: ${error.message}`);
    byPath = "The changed files could not be listed, so hold-paths could not be checked.";
  }
  if (byPath) {
    found.add("trust-gate");
    reasons.push(byPath);
  }
  const criteria = CRITERIA.filter((c) => found.has(c));
  core.setOutput("hold", criteria.length > 0 ? "true" : "false");
  core.setOutput("criteria", criteria.join(","));
  if (criteria.length === 0) return { hold: false, criteria };

  let reason = stripHtml(reasons.filter(Boolean).join("\n\n")).slice(
    0,
    2 * MAX_REASON,
  );
  const findSecret = await loadGate(env);
  const scanned = findSecret
    ? scan(findSecret, [["the hold reason", reason]])
    : { withheld: "the publish gate could not be loaded", warnings: [] };
  for (const warning of scanned.warnings)
    core.warning(`${lane}: ${warning}; published anyway.`);
  const { withheld } = scanned;
  if (withheld) {
    core.warning(`${lane}: the hold reason was withheld: ${withheld}.`);
    reason = `The reason was withheld: ${withheld}.`;
  }

  // Both writes are tried; either failing fails the step afterwards.
  try {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: number,
      labels: [label],
    });
  } catch (error) {
    errors.push(`could not add the ${label} label: ${error.message}`);
  }
  const marker = `<!-- claude-lane-hold lane=${lane} sha=${env.HEAD_SHA} criteria=${criteria.join(",")} -->`;
  try {
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    });
    const posted = comments.some(
      (c) =>
        c.user?.login === "github-actions[bot]" &&
        (c.body === marker || c.body?.startsWith(`${marker}\n`)),
    );
    if (!posted) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body: [
          marker,
          `**${lane}** holds this pull request for a person (${criteria.join(", ")}) at \`${env.HEAD_SHA}\`.`,
          "",
          reason,
          "",
          `claude-lane: ${lane}`,
        ].join("\n"),
      });
    }
  } catch (error) {
    errors.push(`could not post the hold comment: ${error.message}`);
  }
  if (errors.length > 0) throw new Error(`${lane}: ${errors.join("; ")}`);
  core.notice(
    `claude-lane-hold lane=${lane} sha=${env.HEAD_SHA} criteria=${criteria.join(",")} label=${label}`,
  );
  return { hold: true, criteria };
}

module.exports = { CRITERIA, globToRegExp, modelHold, run };
