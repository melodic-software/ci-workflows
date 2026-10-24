// pr-review-cli's hold step. No model runs here. It reads, from env:
// HOLD_LABEL, HOLD_PATHS (newline-separated globs), LANE_ID, PR_NUMBER,
// HEAD_SHA, BASE_REF (the pull request's base branch), PUBLISH_GATE, PR_FILES (the scope step's file list),
// TRUSTED_AUTHOR_IDS (the people whose cost decision counts), and the
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

// A cost decision: an unedited comment by a trusted person whose first line
// opens `**Decision recorded.** Cost:` (claude-code-plugins@eda837d4c8
// .github/scripts/pr-merge/merge-holds.mjs:422 DECISION_LINE, read after
// trimStart as at :470; author, App and edit checks as at :466-476). It binds
// to one pull request: one on the pull request counts, and so does one on its
// linked issue that names `#<number>` and is newer than the pull request. It
// covers only the net diff it was made at (carryDecision).
const DECISION_LINE = /^\*\*Decision recorded\.\*\*[ \t]+Cost:/u;
const PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { createdAt body closingIssuesReferences(first: 2) { totalCount nodes { number repository { nameWithOwner } } } }
  }
}`;
const EDITED_QUERY =
  "query($id: ID!) { node(id: $id) { ... on IssueComment { lastEditedAt } } }";

// Whether comment `c` was ever edited: "unedited" when GraphQL answers
// lastEditedAt null, "edited" when it answers a time, else "unknown" (a
// failed read, no node, or no lastEditedAt).
async function editState(github, c) {
  try {
    const node = (await github.graphql(EDITED_QUERY, { id: String(c.node_id) }))
      ?.node;
    if (!node || !("lastEditedAt" in node)) return "unknown";
    return node.lastEditedAt === null ? "unedited" : "edited";
  } catch {
    return "unknown";
  }
}

// The issue one plain `Refs: #<n>` line names, or null: claude-code-plugins@eda837d4c8
// plugins/source-control/skills/babysit-prs/scripts/babysit_merge_policy.py:1851-1895
// refs_issue. A line counts from its first column, outside an HTML comment
// and a fenced code block; any `Refs:` line in another form, or two issues,
// name none.
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/gu;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
function refsIssue(body) {
  const numbers = new Set();
  let fence = "";
  for (const line of String(body ?? "")
    .replace(HTML_COMMENT, "")
    .split(/\r\n|\r|\n/u)) {
    const marker = FENCE.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        line.slice(marker[0].length).replace(/[ \t]/gu, "") === ""
      )
        fence = "";
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    if (!/^[Rr][Ee][Ff][Ss]:/u.test(line)) continue;
    const plain = /^Refs:[ \t]*#([1-9][0-9]{0,8})[ \t]*$/u.exec(line);
    if (!plain) return null;
    numbers.add(Number(plain[1]));
  }
  return numbers.size === 1 ? [...numbers][0] : null;
}

// The pull request's linked issue: its one closing issue in this repository,
// else, with no closing issue at all, its one `Refs:` issue
// (babysit_merge_policy.py:1905-1931 _linked_issue, :1934-1947
// _closing_issue). `refs` is checked to be an issue, not a pull request.
function linkedIssue(pull, owner, repo) {
  const closing = pull?.closingIssuesReferences;
  if (closing?.totalCount === 1 && closing.nodes?.length === 1) {
    const node = closing.nodes[0];
    return String(node?.repository?.nameWithOwner).toLowerCase() ===
      `${owner}/${repo}`.toLowerCase() && Number.isInteger(node?.number)
      ? { number: node.number }
      : null;
  }
  if (closing?.totalCount !== 0) return null;
  const refs = refsIssue(pull.body);
  return refs === null ? null : { number: refs, refs: true };
}

// Whether `text` names pull request `number` as `#<number>`: not part of a
// longer number, and not after a letter, digit, `_`, `#`, `&`, `/`, `.` or
// `-`, so `owner/repo#<number>` and `&#<number>;` do not count
// (claude-code-plugins .github/scripts/pr-merge/merge-holds.mjs:436-438
// namesPull at #9569's head 6c3b6ae9).
const namesPull = (text, number) =>
  new RegExp(`(?:^|[^A-Za-z0-9_#&/.-])#${number}(?:[^0-9]|$)`, "u").test(
    String(text ?? ""),
  );

// The newest unedited cost decision a trusted person recorded for pull
// request `number`, or null: the pull request's own first, else its linked
// issue's. `prComments` is the pull request's comment list. Reads only when a
// cost hold would be added; a read that fails decides nothing.
async function costDecided(github, owner, repo, number, env, prComments) {
  const trusted = new Set(
    String(env.TRUSTED_AUTHOR_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[1-9][0-9]*$/u.test(id))
      .map(Number),
  );
  if (trusted.size === 0) return null;
  const candidate = (c) =>
    c?.user?.type === "User" &&
    c.performed_via_github_app == null &&
    trusted.has(c.user.id) &&
    DECISION_LINE.test(String(c.body ?? "").trimStart());
  const newest = async (list) => {
    for (const c of list
      .filter(candidate)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)))
      if ((await editState(github, c)) === "unedited") return c;
    return null;
  };
  const own = await newest(prComments);
  if (own) return own;
  try {
    const pull = (
      await github.graphql(PULL_QUERY, { owner, name: repo, number })
    )?.repository?.pullRequest;
    const issue = linkedIssue(pull, owner, repo);
    if (!issue) return null;
    if (issue.refs) {
      const read = (
        await github.rest.issues.get({ owner, repo, issue_number: issue.number })
      ).data;
      // An issue whose number is the Refs number (merge-holds.mjs:484 at
      // #9569's head 6c3b6ae9), never a pull request.
      if (read?.number !== issue.number || read.pull_request != null) return null;
    }
    const opened = Date.parse(pull.createdAt);
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issue.number,
      per_page: 100,
    });
    return await newest(
      comments.filter(
        (c) => Date.parse(c.created_at) > opened && namesPull(c.body, number),
      ),
    );
  } catch {
    // Nothing read, nothing decided: the cost hold stays.
  }
  return null;
}

// GitHub's compare lists at most 300 files
// (https://docs.github.com/en/rest/commits/commits#compare-two-commits).
const MAX_COMPARE_FILES = 300;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/u;

// Whether `decision` covers the head: { carry, why }. The decided head is
// the sha of this lane's newest cost hold marker posted before the decision,
// and only while that marker is unedited: an edited marker, or one whose
// edit state cannot be read, carries nothing, and no older marker is used.
// The decision carries when the head is that sha, or when the pull request's
// net diff against its base branch is the same at both: compare
// base...decided and base...head (three-dot, so each is the diff from its
// merge base) list the same files, each with the same status,
// previous_filename and patch text. So a base-only merge or a rebase that
// leaves every patch as it was carries, and any other change does not. One
// edit read and at most two compare reads; any failure, a missing patch, or
// a list of 300 or more files carries nothing.
async function carryDecision(github, owner, repo, env, prComments, decision) {
  const cutoff = Date.parse(decision.created_at);
  if (!Number.isFinite(cutoff)) return { carry: false, why: "the decision has no time" };
  const markerLine = new RegExp(
    `^<!-- claude-lane-hold lane=${env.LANE_ID} sha=([0-9a-f]{40}) criteria=([a-z,-]+) -->(?:\n|$)`,
    "u",
  );
  let decided = null;
  let held = null;
  let at = -Infinity;
  for (const c of prComments) {
    if (c?.user?.login !== "github-actions[bot]") continue;
    const m = markerLine.exec(String(c.body ?? ""));
    const t = Date.parse(c.created_at);
    if (!m || !m[2].split(",").includes("cost")) continue;
    if (!(t < cutoff) || t <= at) continue;
    decided = m[1];
    held = c;
    at = t;
  }
  if (!decided)
    return { carry: false, why: "no cost hold marker of this lane precedes the decision" };
  const state = await editState(github, held);
  if (state === "edited")
    return { carry: false, why: "the decided-head marker was edited" };
  if (state !== "unedited")
    return { carry: false, why: "could not confirm the marker is unedited" };
  if (decided === env.HEAD_SHA)
    return { carry: true, why: `the head is the decided head ${decided}` };
  const base = String(env.BASE_REF ?? "");
  if (!BRANCH.test(base)) return { carry: false, why: "the base branch name is not usable" };
  const files = async (sha) => {
    const data = (
      await github.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${sha}`,
      })
    ).data;
    const list = data?.files;
    if (!Array.isArray(list) || list.length >= MAX_COMPARE_FILES) return null;
    const byName = new Map();
    for (const f of list) {
      if (typeof f?.filename !== "string" || typeof f.patch !== "string") return null;
      if (byName.has(f.filename)) return null;
      byName.set(f.filename, [f.status, f.previous_filename ?? null, f.patch]);
    }
    return byName;
  };
  let then;
  let now;
  try {
    then = await files(decided);
    now = await files(env.HEAD_SHA);
  } catch {
    return { carry: false, why: "a compare read failed" };
  }
  if (!then || !now)
    return {
      carry: false,
      why: `a compare listed ${MAX_COMPARE_FILES} or more files, or a file without a patch`,
    };
  const same =
    then.size === now.size &&
    [...then].every(([name, v]) => {
      const w = now.get(name);
      return w !== undefined && v.every((x, i) => x === w[i]);
    });
  return same
    ? { carry: true, why: `the net diff against ${base} is the same as at the decided head ${decided}` }
    : { carry: false, why: `the net diff against ${base} differs from the decided head ${decided}` };
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
  // The pull request's comments, read once: for the cost decision and for
  // the marker this step posts.
  let prComments;
  const listPrComments = async () => {
    prComments ??= await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    });
    return prComments;
  };
  if (model?.criteria.includes("cost")) {
    let result = { carry: false, why: "no recorded cost decision" };
    try {
      const comments = await listPrComments();
      const decision = await costDecided(github, owner, repo, number, env, comments);
      if (decision)
        result = await carryDecision(github, owner, repo, env, comments, decision);
    } catch {
      result = { carry: false, why: "a read failed" };
    }
    if (result.carry) {
      core.info(`${lane}: the recorded cost decision carries (${result.why}); the cost hold is not added again.`);
      model.criteria = model.criteria.filter((c) => c !== "cost");
    } else {
      core.info(`${lane}: no recorded cost decision carries (${result.why}); the cost hold stays.`);
    }
  }
  if (model && model.criteria.length > 0) {
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
    const comments = await listPrComments();
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

module.exports = {
  CRITERIA,
  globToRegExp,
  linkedIssue,
  modelHold,
  namesPull,
  refsIssue,
  run,
};
