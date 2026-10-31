// pr-review-cli's hold step. No model runs here. It reads, from env:
// HOLD_LABEL, LANE_ID, STATUS_JOB (the name of the status job this step runs
// in, whose earlier runs' notices give a cost decision's decided head),
// PR_NUMBER, HEAD_SHA, BASE_REF (the pull request's base branch), PUBLISH_GATE, TRUSTED_AUTHOR_IDS (the people whose cost decision
// counts), and the legs' KEY_* and SUB_* outputs that publish-review's judge
// reads. It only adds: the label and one marker comment. Every write goes
// through issues.addLabels or issues.createComment.
"use strict";

const { judge, loadGate, scan, stripHtml } = require("../publish-review/publish.cjs");

// The criteria that stop a pull request: a real-charge cost and a CRITICAL
// security finding. A trusted path (the review's trust-gate, or hold-paths)
// is a reason for extra security scrutiny, never a stop by itself.
const CRITERIA = ["cost", "critical-security"];
const MAX_REASON = 2000;

// The hold the counted leg's checked review returned, or null.
function modelHold(env, core) {
  const verdict = judge(env);
  const hold = verdict.ok ? verdict.review.hold : undefined;
  if (!hold || !Array.isArray(hold.criteria)) return null;
  if (hold.criteria.includes("trust-gate"))
    core.info(`${env.LANE_ID}: the review returned trust-gate; trust-gate is not a hold.`);
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
const SHA = /^[0-9a-f]{40}$/u;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;

// The cost hold notices of lane `lane` among one status job's annotations,
// as { sha, at } with `at` the job's completion: only those naming `head`,
// the head its run ran on, so a notice speaks for no other commit
// (claude-code-plugins .github/scripts/pr-merge/merge-holds.mjs costNotices).
function costNotices(annotations, lane, head, at) {
  const line = new RegExp(
    `^claude-lane-hold lane=${lane} sha=([0-9a-f]{40}) criteria=([a-z,-]+) label=`,
    "u",
  );
  return (Array.isArray(annotations) ? annotations : []).flatMap((a) => {
    const m = a?.annotation_level === "notice" ? line.exec(String(a.message ?? "")) : null;
    return m && m[1] === head && m[2].split(",").includes("cost") ? [{ sha: m[1], at }] : [];
  });
}

// The sha of the newest of `notices` before `cutoff`, or null, null too when
// two heads share that time (merge-holds.mjs decidedHead).
function decidedHead(notices, cutoff) {
  const before = notices.filter((n) => Date.parse(n.at) < cutoff);
  const newest = Math.max(...before.map((n) => Date.parse(n.at)));
  const heads = new Set(before.filter((n) => Date.parse(n.at) === newest).map((n) => n.sha));
  return heads.size === 1 ? [...heads][0] : heads.size === 0 ? null : undefined;
}

// The repository activity API keeps a branch name's history across
// deletions, so a name recreated for each sync passes a page of 100 (564
// entries on one such branch). Its pages are cursor pages: `after` takes the
// cursor the Link header gives
// (https://docs.github.com/en/rest/repos/repos#list-repository-activities).
// github.paginate is not used: it answers a 409 or an empty body with an
// empty list and appends a body that is not a list (actions/github-script
// @3a2844b7 dist/index.js:64366 and :64426). Only the cursor is taken from
// the link, never its URL. Twenty pages hold 2,000 entries; past them the
// history counts as unreadable.
const MAX_ACTIVITY_PAGES = 20;
const ACTIVITY_PAGE = 100;
const NEXT_LINK = /<([^>]+)>;\s*rel="next"/u;

// The branch's push history, newest first, read page by page until a page
// reaches an entry older than the last push of `decided` before `cutoff`
// (no older entry changes unranHead), or a page shorter than 100 ends it,
// as { activity }. { why } when a full page carries no next cursor (a
// dropped or changed Link header is not the end of the history) or a next
// page would pass MAX_ACTIVITY_PAGES. A failed read, a page that is not a
// list, or a next link with no cursor throws.
async function branchActivity(github, owner, repo, branch, decided, cutoff) {
  const activity = [];
  let after;
  for (let pages = 0; ; pages += 1) {
    if (pages === MAX_ACTIVITY_PAGES)
      return { why: `the branch's push history runs past ${MAX_ACTIVITY_PAGES} pages` };
    const { data, headers } = await github.request("GET /repos/{owner}/{repo}/activity", {
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      direction: "desc",
      per_page: ACTIVITY_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    if (!Array.isArray(data)) throw new Error("an activity page is not a list");
    activity.push(...data);
    const last = Math.max(
      ...activity
        .filter((m) => m?.after === decided && Date.parse(m.timestamp) < cutoff)
        .map((m) => Date.parse(m.timestamp)),
    );
    if (data.some((m) => Date.parse(m?.timestamp) < last)) return { activity };
    const next = NEXT_LINK.exec(String(headers?.link ?? ""));
    if (!next) {
      if (data.length < ACTIVITY_PAGE) return { activity };
      return { why: "the branch's activity page is full but carries no next cursor" };
    }
    after = new URL(next[1]).searchParams.get("after");
    if (!after) throw new Error("the next activity page has no cursor");
  }
}

// Why the branch's push history shows a head with no run of this lane
// before the decision, else null (merge-holds.mjs unranHead, for one lane).
// `activity` is the branch's activity (branchActivity), which deleting a
// run leaves; `ran` the heads of this lane's runs started before the
// decision. Every head the branch moved to after its last push of `decided`
// before the decision needs a run: with one deleted, an older notice would
// become the decided head (claude-code-plugins#10437).
function unranHead(activity, ran, decided, cutoff) {
  if (!Array.isArray(activity)) return "the branch's push history is unreadable";
  const moves = [];
  for (const move of activity) {
    const after = String(move?.after ?? "");
    if (!SHA.test(after) || /^0{40}$/u.test(after)) continue;
    const made = Date.parse(move.timestamp);
    if (!Number.isFinite(made)) return "the branch's push history is unreadable";
    moves.push({ after, made });
  }
  const before = moves.filter((m) => m.made < cutoff);
  const last = Math.max(...before.filter((m) => m.after === decided).map((m) => m.made));
  if (!Number.isFinite(last))
    return `the branch shows no push of ${decided} before the decision`;
  const gap = before.find((m) => m.after !== decided && m.made >= last && !ran.includes(m.after));
  return gap
    ? `${gap.after} was pushed after the decided head with no run of this lane before the decision`
    : null;
}

// Whether `decision` covers the head: { carry, why }. The decided head comes
// from this lane's own check-run notices, never a comment: any workflow on
// GITHUB_TOKEN posts as github-actions[bot] (claude-code-plugins#9635). It
// reads every pull_request run of this run's workflow on the pull request's
// head branch of this repository started before the decision; vets each
// run's head (compare base...head lists under 300 files and does not change
// this workflow's file, which a pull_request run takes from the head and so
// could write the notice); takes, from each run's STATUS_JOB done before the
// decision, the `claude-lane-hold lane=<LANE_ID>` cost notices naming that
// run's own head; and keeps the newest (decidedHead) while the branch's push
// history shows no run missing since it (unranHead). The decision carries
// when the head is that sha, or when the pull request's net diff against its
// base branch is the same at both: compare base...decided and base...head
// (three-dot, so each is the diff from its merge base) list the same files,
// each with the same status, previous_filename and patch. So a base-only
// merge or a rebase that leaves every patch as it was carries, and any other
// change does not. A read that fails throws, and the caller keeps the hold.
// Reads need actions: read (runs, jobs), checks: read (annotations) and
// contents: read (compare, activity).
async function carryDecision(github, owner, repo, env, runId, decision) {
  const cutoff = Date.parse(decision.created_at);
  if (!Number.isFinite(cutoff)) return { carry: false, why: "the decision has no time" };
  const base = String(env.BASE_REF ?? "");
  if (!BRANCH.test(base)) return { carry: false, why: "the base branch name is not usable" };
  const statusJob = String(env.STATUS_JOB ?? "");
  if (!/^[A-Za-z0-9._ -]{1,100}$/u.test(statusJob))
    return { carry: false, why: "the status job name is not usable" };
  const self = `${owner}/${repo}`.toLowerCase();
  const current = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })).data;
  if (
    current?.event !== "pull_request" ||
    String(current.head_repository?.full_name).toLowerCase() !== self
  )
    return { carry: false, why: "this run is not a pull_request run of this repository" };
  const branch = String(current.head_branch ?? "");
  const workflow = String(current.path ?? "");
  if (!BRANCH.test(branch) || !WORKFLOW_PATH.test(workflow) || !Number.isInteger(current.workflow_id))
    return { carry: false, why: "this run's workflow or branch is not usable" };

  // Each compare is read once: base...sha's files by name, or null when it
  // lists 300 or more, a file with no patch, or one twice.
  const compared = new Map();
  const compare = async (sha) => {
    if (!compared.has(sha))
      compared.set(
        sha,
        (await github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${sha}` }))
          .data?.files,
      );
    return compared.get(sha);
  };
  const byName = (list) => {
    if (!Array.isArray(list) || list.length >= MAX_COMPARE_FILES) return null;
    const names = new Map();
    for (const f of list) {
      if (typeof f?.filename !== "string" || typeof f.patch !== "string") return null;
      if (names.has(f.filename)) return null;
      names.set(f.filename, [f.status, f.previous_filename ?? null, f.patch]);
    }
    return names;
  };

  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner,
    repo,
    workflow_id: current.workflow_id,
    event: "pull_request",
    branch,
    per_page: 100,
  });
  const notices = [];
  const ran = [];
  for (const run of runs) {
    if (String(run?.head_repository?.full_name).toLowerCase() !== self) continue;
    if (!(Date.parse(run.created_at) < cutoff)) continue;
    const head = String(run.head_sha ?? "");
    if (!SHA.test(head)) return { carry: false, why: "a run of this lane has no head commit" };
    ran.push(head);
    const files = await compare(head);
    if (!Array.isArray(files) || files.length >= MAX_COMPARE_FILES)
      return { carry: false, why: `the head ${head} lists 300 or more files, or no file list` };
    if (files.some((f) => f?.filename === workflow))
      return { carry: false, why: `the head ${head} changes this lane's workflow` };
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      owner,
      repo,
      run_id: run.id,
      filter: "all",
      per_page: 100,
    });
    for (const job of jobs) {
      const name = String(job?.name ?? "");
      if (name !== statusJob && !name.endsWith(` / ${statusJob}`)) continue;
      if (!(Date.parse(job.completed_at) < cutoff)) continue;
      const annotations = await github.paginate(github.rest.checks.listAnnotations, {
        owner,
        repo,
        check_run_id: job.id,
        per_page: 100,
      });
      notices.push(...costNotices(annotations, env.LANE_ID, head, job.completed_at));
    }
  }
  const decided = decidedHead(notices, cutoff);
  if (decided === undefined)
    return { carry: false, why: "two heads were noticed at the newest time before the decision" };
  if (decided === null)
    return { carry: false, why: "no cost hold notice of this lane precedes the decision" };
  const { activity, why } = await branchActivity(github, owner, repo, branch, decided, cutoff);
  if (why) return { carry: false, why };
  const gap = unranHead(activity, ran, decided, cutoff);
  if (gap) return { carry: false, why: gap };
  if (decided === env.HEAD_SHA)
    return { carry: true, why: `the head is the decided head ${decided}` };
  const then = byName(await compare(decided));
  const now = byName(await compare(env.HEAD_SHA));
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
  const model = modelHold(env, core);
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
        result = await carryDecision(github, owner, repo, env, context.runId, decision);
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
  const errors = [];
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
  linkedIssue,
  modelHold,
  namesPull,
  refsIssue,
  run,
};
