// pr-review-cli's hold step. No model runs here. It reads, from env:
// HOLD_LABEL, LANE_ID, STATUS_JOB (the name of the status job this step runs
// in, whose earlier runs' notices give a cost decision's decided head and
// the critical-security findings that still stand),
// PR_NUMBER, HEAD_SHA, BASE_REF (the pull request's base branch), PUBLISH_GATE, TRUSTED_AUTHOR_IDS (the people whose cost decision
// counts), LIFT_AUTHOR_IDS (the people whose removal of the hold label lifts
// the critical-security findings standing then; empty lifts none), and the
// legs' KEY_* and SUB_* outputs that publish-review's judge reads. It only
// adds: the label, one marker comment, and one comment naming the lifted
// findings it posts no hold for. Every write goes through issues.addLabels
// or issues.createComment.
"use strict";

const crypto = require("node:crypto");
const {
  bindingLine,
  judge,
  loadGate,
  scan,
  stripHtml,
  writeRecord,
} = require("../publish-review/publish.cjs");
const { createRetry } = require("../check-managed-files/retry.cjs");

// The criteria that stop a pull request: a real-charge cost and a CRITICAL
// security finding. A trusted path (the review's trust-gate, or hold-paths)
// is a reason for extra security scrutiny, never a stop by itself.
const CRITERIA = ["cost", "critical-security"];
const MAX_REASON = 2000;

// A critical-security hold names at most this many head-side ranges.
const MAX_LOCATIONS = 20;

// The review's flagged ranges, head side, as { path, start, end }, with null
// in place of each one no file read can check: a path that is not a plain
// repository path (a backtick would end the code span the comments quote it
// in), or a range that is not one. A list past MAX_LOCATIONS adds one null.
function holdLocations(raw) {
  if (!Array.isArray(raw)) return [];
  const out = raw.slice(0, MAX_LOCATIONS).map((l) => {
    const path = l?.path;
    const end = l?.line;
    const start = l?.start_line ?? end;
    const plain =
      typeof path === "string" &&
      path.length <= 500 &&
      !/[\0\r\n\\`]/u.test(path) &&
      path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
    return plain && Number.isSafeInteger(end) && Number.isSafeInteger(start) && start >= 1 && start <= end
      ? { path, start, end }
      : null;
  });
  return raw.length > MAX_LOCATIONS ? [...out, null] : out;
}

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
    locations: holdLocations(hold.locations),
  };
}

// A file's lines: its bytes split on 0x0A, a final 0x0A ending the last
// line and adding none.
function splitLines(bytes) {
  const lines = [];
  let from = 0;
  for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, from)) {
    lines.push(bytes.subarray(from, at));
    from = at + 1;
  }
  if (from < bytes.length) lines.push(bytes.subarray(from));
  return lines;
}

// A finding's identity: its path and the sha256 of its range's bytes, the
// lines joined by 0x0A, exactly as the head held them. The same bytes at
// other line numbers in the same file are the same finding; any other
// change, a second copy in the file, or another path is a different one.
const NEWLINE = Buffer.from([0x0a]);
function fingerprint(lines, start, end) {
  const hash = crypto.createHash("sha256");
  for (let i = start - 1; i < end; i += 1) {
    if (i > start - 1) hash.update(NEWLINE);
    hash.update(lines[i]);
  }
  return hash.digest("hex");
}
const identity = (f) => `${f.path}\n${f.fp}\n${f.end - f.start + 1}`;

// The first line of the one range of `size` lines in `lines` whose
// fingerprint is `fp`, or 0 when there is none or more than one.
function locate(lines, fp, size) {
  let at = 0;
  for (let start = 1; start + size - 1 <= lines.length; start += 1) {
    if (fingerprint(lines, start, start + size - 1) !== fp) continue;
    if (at) return 0;
    at = start;
  }
  return at;
}

// `path` at `ref`: { lines }, { gone } on a 404, or { unreadable: why } when
// something is there that cannot be read whole (a directory, a symlink, a
// submodule, a blob the API will not return). A file over 1 MB, which the
// contents API returns with encoding "none", is read through its blob
// (https://docs.github.com/en/rest/repos/contents#get-repository-content).
// Any other failed read throws.
async function readLines(github, owner, repo, ref, path, cache) {
  const key = `${ref}:${path}`;
  if (!cache.has(key)) {
    let result;
    try {
      const { data } = await github.rest.repos.getContent({ owner, repo, path, ref });
      if (data?.type !== "file") result = { unreadable: "it is not a regular file at this head" };
      else if (data.encoding === "base64" && typeof data.content === "string")
        result = { lines: splitLines(Buffer.from(data.content, "base64")) };
      else if (SHA.test(String(data.sha ?? ""))) {
        try {
          const blob = (await github.rest.git.getBlob({ owner, repo, file_sha: data.sha })).data;
          result =
            blob?.encoding === "base64" && typeof blob.content === "string"
              ? { lines: splitLines(Buffer.from(blob.content, "base64")) }
              : { unreadable: "its blob is not returned whole" };
        } catch (error) {
          result = { unreadable: `its blob could not be read (${error.message})` };
        }
      } else result = { unreadable: "the contents API does not return it whole" };
    } catch (error) {
      if (error?.status !== 404) throw error;
      result = { gone: true };
    }
    cache.set(key, result);
  }
  return cache.get(key);
}

// `where` as the comment names it: `path` line n, or lines n-m.
const where = (f) =>
  `\`${f.path}\` ${f.start === f.end ? `line ${f.start}` : `lines ${f.start}-${f.end}`}`;

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

// This lane's standing critical-security state for one pull request at one
// head, as the hold step records it in its status job's notice
// `claude-lane-findings lane=<lane> pr=<number> sha=<head> <state>`: every
// finding it holds there, each with the head it was first held at, and
// every lifted finding whose lines that head still holds, each with who
// lifted it and at which head. Every run of the step writes one, an empty
// state included, so a reader needs only the newest bound, vetted one.
const SHA_FIELD = /^[0-9a-f]{40}$/u;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/u;
function readState(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || !Array.isArray(raw.findings) || !Array.isArray(raw.lifts)) return null;
  const range = (f) => {
    const [loc] = holdLocations([{ path: f?.path, start_line: f?.start, line: f?.end }]);
    return loc && /^[0-9a-f]{64}$/u.test(f.fp ?? "") ? { ...loc, fp: f.fp } : null;
  };
  const findings = [];
  for (const f of raw.findings) {
    const r = range(f);
    if (!r || !SHA_FIELD.test(f.first ?? "")) return null;
    findings.push({ ...r, first: f.first });
  }
  const lifts = [];
  for (const f of raw.lifts) {
    const r = range(f);
    if (
      !r ||
      !LOGIN.test(f.by ?? "") ||
      !Number.isSafeInteger(f.by_id) ||
      !Number.isFinite(Date.parse(f.lifted_at)) ||
      !SHA_FIELD.test(f.head ?? "")
    )
      return null;
    lifts.push({ ...r, lift: { by: f.by, by_id: f.by_id, lifted_at: f.lifted_at, head: f.head } });
  }
  return { findings, lifts };
}

// This lane's state notice among one status job's annotations at `head`, its
// run's own head: { pr, state }, { pr, cut } when it is there but not
// readable whole, or { absent } when there is none, which is no record.
function stateNotice(annotations, lane, head) {
  const prefix = new RegExp(`^claude-lane-findings lane=${lane} pr=([1-9][0-9]{0,9}) sha=([0-9a-f]{40})(?: |$)`, "u");
  for (const a of Array.isArray(annotations) ? annotations : []) {
    const message = String(a?.message ?? "");
    const m = a?.annotation_level === "notice" ? prefix.exec(message) : null;
    if (!m || m[2] !== head) continue;
    const state = readState(message.slice(m[0].length));
    return state ? { pr: Number(m[1]), state } : { pr: Number(m[1]), cut: true };
  }
  return { absent: true };
}

// Why a state is not recorded: more than one notice records whole. The hold
// itself is posted first.
const overCap = (lane) =>
  `${lane}: this lane's standing critical-security state is over ${MAX_STATE_BYTES} bytes, more than one notice records whole, so it is not recorded`;

// Whether `e` is this lane's bot adding the hold label, as every hold of
// this lane does when the label is off.
const laneLabeled = (e, label) =>
  e?.event === "labeled" &&
  e.label?.name === label &&
  e.actor?.login === "github-actions[bot]" &&
  e.actor?.type === "Bot";

// At most this many runs of this lane are read for its newest record; past
// them the step fails.
const MAX_LANE_RUNS = 30;
// The state notice's size cap. GitHub documents no size limit for a
// workflow-command notice, so the step fails rather than write a longer one
// that might be cut short.
const MAX_STATE_BYTES = 4000;

// Whether run `r` belongs to pull request `pull` on its current base. A run's
// pull_requests field lists the pull requests open from its branch when it
// is read, not the one that started it, so the binding comes from times: the
// run started after the pull request opened and after its base last changed
// (`rebased`), while no other pull request from the branch (`others`) was
// open. A pull_request run takes its workflow from the merge of its head
// into the base it ran against, so a run of another pull request or of
// another base could write any notice.
function boundTo(r, pull, others, rebased) {
  const t = Date.parse(r.created_at);
  if (!Number.isFinite(t) || !(t >= Date.parse(pull.created_at)) || !(t > rebased)) return false;
  return !others.some((o) => {
    const opened = Date.parse(o?.created_at);
    const closed = o?.closed_at == null ? Number.POSITIVE_INFINITY : Date.parse(o.closed_at);
    return !(opened > t) && !(closed <= t);
  });
}

// Why the branch's push history shows a head pushed since `since` with no
// run of this lane (`ran`), else null: a deleted run could have held a
// record. The history is read newest first until an entry older than
// `since`. A failed read throws.
async function pushGap(github, owner, repo, branch, ran, since) {
  const seen = new Set(ran);
  let after;
  for (let pages = 0; pages < MAX_ACTIVITY_PAGES; pages += 1) {
    const { data, headers } = await github.request("GET /repos/{owner}/{repo}/activity", {
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      direction: "desc",
      per_page: ACTIVITY_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    if (!Array.isArray(data)) throw new Error("an activity page is not a list");
    for (const move of data) {
      const at = Date.parse(move?.timestamp);
      if (!Number.isFinite(at)) return "the branch's push history is unreadable";
      if (at < since) return null;
      const sha = String(move.after ?? "");
      if (SHA.test(sha) && !/^0{40}$/u.test(sha) && !seen.has(sha))
        return `${sha} was pushed after the label with no run of this lane`;
    }
    const next = NEXT_LINK.exec(String(headers?.link ?? ""));
    if (!next) return data.length < ACTIVITY_PAGE ? null : "the branch's activity page is full but carries no next cursor";
    after = new URL(next[1]).searchParams.get("after");
    if (!after) throw new Error("the next activity page has no cursor");
  }
  return `the branch's push history runs past ${MAX_ACTIVITY_PAGES} pages`;
}

// This lane's newest record for pull request `number`: { state, head, at }
// from the newest finished status job (this run's earlier attempts
// included) of the newest pull_request run of this run's workflow on the
// branch whose notice names `number`, `at` the job's completion. A job with
// no such notice is no record, and the walk goes on. A record from a run
// this pull request cannot be bound to (boundTo), or whose head's compare
// lists 300 or more files or changes this lane's workflow, fails the walk:
// { why }. So does a cut-short record with none older, and, with no record
// at all, a push since the label with no run (pushGap). A run last updated
// before `since`, when this lane's bot first added the label, holds no
// hold. { none } when no record names the pull request, { skip } when this
// run cannot walk (it is not a pull_request run of this repository). A
// failed read throws.
async function newestRecord(github, owner, repo, env, runId, since, events, number) {
  const statusJob = String(env.STATUS_JOB ?? "");
  if (!/^[A-Za-z0-9._ -]{1,100}$/u.test(statusJob)) return { why: "the status job name is not usable" };
  if (!BRANCH.test(String(env.BASE_REF ?? ""))) return { why: "the base branch name is not usable" };
  if (!Number.isSafeInteger(number) || number < 1) return { why: "the pull request number is not usable" };
  const self = `${owner}/${repo}`.toLowerCase();
  const current = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })).data;
  if (current?.event !== "pull_request" || String(current.head_repository?.full_name).toLowerCase() !== self)
    return { skip: "this run is not a pull_request run of this repository" };
  const branch = String(current.head_branch ?? "");
  const workflow = String(current.path ?? "");
  if (!BRANCH.test(branch) || !WORKFLOW_PATH.test(workflow) || !Number.isInteger(current.workflow_id))
    return { why: "this run's workflow or branch is not usable" };
  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "all",
    per_page: 100,
  });
  const pull = pulls.find((p) => p?.number === number);
  if (!pull) return { why: "this pull request is not among its branch's pull requests" };
  const others = pulls.filter((p) => p?.number !== number);
  const rebased = Math.max(
    ...events
      .filter((e) => ["base_ref_changed", "automatic_base_change_succeeded"].includes(e?.event))
      .map((e) => Date.parse(e.created_at))
      .filter(Number.isFinite),
  );
  const all = (
    await github.paginate(github.rest.actions.listWorkflowRuns, {
      owner,
      repo,
      workflow_id: current.workflow_id,
      event: "pull_request",
      branch,
      per_page: 100,
    })
  ).filter((r) => String(r?.head_repository?.full_name).toLowerCase() === self && SHA.test(String(r.head_sha ?? "")));
  const runs = all
    .filter((r) => !(Date.parse(r.updated_at) < since))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  let cut = "";
  for (const [i, run] of runs.entries()) {
    if (i === MAX_LANE_RUNS)
      return { why: `none of this lane's newest ${MAX_LANE_RUNS} runs holds a readable record of this pull request` };
    const head = run.head_sha;
    const jobs = (
      await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        owner,
        repo,
        run_id: run.id,
        filter: "all",
        per_page: 100,
      })
    )
      .filter((job) => {
        const name = String(job?.name ?? "");
        return (name === statusJob || name.endsWith(` / ${statusJob}`)) && Number.isFinite(Date.parse(job.completed_at));
      })
      .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at));
    for (const job of jobs) {
      const annotations = await github.paginate(github.rest.checks.listAnnotations, {
        owner,
        repo,
        check_run_id: job.id,
        per_page: 100,
      });
      const read = stateNotice(annotations, env.LANE_ID, head);
      if (read.absent || read.pr !== number) continue;
      if (!boundTo(run, pull, others, rebased))
        return {
          why: `the record at ${head} is from a run this pull request cannot be bound to: another pull request from this branch was open, or the base changed since`,
        };
      if (read.cut) {
        cut ||= `the record at ${head} is cut short and no older one is readable`;
        continue;
      }
      const files = (
        await github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${env.BASE_REF}...${head}` })
      ).data?.files;
      if (!Array.isArray(files) || files.length >= MAX_COMPARE_FILES || files.some((f) => f?.filename === workflow))
        return {
          why: `the record at ${head} is from a run whose head changes this lane's workflow or lists ${MAX_COMPARE_FILES} or more files`,
        };
      return { state: read.state, head, at: job.completed_at };
    }
  }
  if (cut) return { why: cut };
  const gap = await pushGap(
    github,
    owner,
    repo,
    branch,
    all.map((r) => r.head_sha),
    since,
  );
  return gap ? { why: gap } : { none: true };
}

// The findings lifted for the head, by identity, only while LIFT_AUTHOR_IDS
// lists someone: each lift the record holds whose removal of the hold label
// the events still show (same person, same time, a User on the list, no
// App), then, for the first such removal after the record, every finding the
// record holds, the findings standing when the label came off.
function liftsOf(env, events, record, label) {
  const ids = new Set(
    String(env.LIFT_AUTHOR_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[1-9][0-9]*$/u.test(id))
      .map(Number),
  );
  const lifted = new Map();
  if (ids.size === 0) return lifted;
  const removals = events.filter(
    (e) =>
      e?.event === "unlabeled" &&
      e.label?.name === label &&
      e.actor?.type === "User" &&
      ids.has(e.actor.id) &&
      LOGIN.test(String(e.actor.login ?? "")) &&
      e.performed_via_github_app == null &&
      Number.isFinite(Date.parse(e.created_at)),
  );
  for (const f of record.state.lifts)
    if (
      removals.some(
        (e) => e.actor.id === f.lift.by_id && e.actor.login === f.lift.by && e.created_at === f.lift.lifted_at,
      )
    )
      lifted.set(identity(f), f.lift);
  const after = Date.parse(record.at);
  const removal = removals
    .filter((e) => Date.parse(e.created_at) > after)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
  if (removal)
    for (const f of record.state.findings)
      if (!lifted.has(identity(f)))
        lifted.set(identity(f), {
          by: removal.actor.login,
          by_id: removal.actor.id,
          lifted_at: removal.created_at,
          head: record.head,
        });
  return lifted;
}

// One comment for the head naming each lifted finding that would otherwise
// hold, who lifted it and at which head, so a person can see why no hold was
// posted for it; a re-run that finds its marker posts none. A failed write
// goes on `errors`.
async function postLift(github, core, env, { owner, repo, number }, lifted, findSecret, listPrComments, errors) {
  const lane = env.LANE_ID;
  const marker = `<!-- claude-lane-lift lane=${lane} sha=${env.HEAD_SHA} -->`;
  let lines = lifted
    .map((f) => `- critical-security at ${where(f)}: lifted by ${f.lift.by} at \`${f.lift.head}\`.`)
    .join("\n");
  const scanned = findSecret
    ? scan(findSecret, [["the lifted findings", lines]])
    : { withheld: "the publish gate could not be loaded", warnings: [] };
  if (scanned.withheld) {
    core.warning(`${lane}: the lifted findings were withheld: ${scanned.withheld}.`);
    lines = `The findings were withheld: ${scanned.withheld}.`;
  }
  const binding = bindingLine(env);
  const body = [
    marker,
    `**${lane}** posts no hold for these findings at \`${env.HEAD_SHA}\`: a listed person lifted each one, and its lines are unchanged.`,
    stripHtml(lines),
    ...(binding ? [binding] : []),
    "",
    `claude-lane: ${lane}`,
  ].join("\n");
  try {
    const comments = (await listPrComments()).filter((c) => c.user?.login === "github-actions[bot]");
    writeRecord(
      env,
      comments.filter((c) => c.body === body).map((c) => ({ kind: "issue_comment", id: c.id, body: c.body })),
    );
    if (!comments.some((c) => c.body?.startsWith(`${marker}\n`))) {
      const { data: created } = await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
      writeRecord(env, [{ kind: "issue_comment", id: created.id, body: created.body }]);
    }
  } catch (error) {
    errors.push(`could not post the lift comment: ${error.message}`);
  }
}

async function run({ github, context, core, env = process.env, sleep }) {
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
  // The pull request's events, read on every run: with no event of this
  // lane's bot adding the hold label, no earlier hold of this lane stands
  // and nothing more is read. A server error is tried again
  // (check-managed-files/retry.cjs); a read that still fails fails the step.
  const withRetry = createRetry({ ...(sleep ? { sleep } : {}), log: (line) => core.info(`${lane}: ${line}`) });
  const events = await withRetry(
    () =>
      github.paginate(github.rest.issues.listEvents, {
        owner,
        repo,
        issue_number: number,
        per_page: 100,
      }),
    "the pull request's events",
  );
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

  // Critical-security findings by identity: the review's located ones at
  // this head, then those an earlier head recorded that still stand.
  const cache = new Map();
  const read = (path) => readLines(github, owner, repo, env.HEAD_SHA, path, cache);
  const notes = [];
  const reported = new Map();
  let loose = false;
  if (model?.criteria.includes("critical-security")) {
    if (model.locations.length === 0) loose = true;
    for (const loc of model.locations) {
      let lines = null;
      try {
        lines = loc ? (await read(loc.path)).lines : null;
      } catch {
        lines = null;
      }
      const fp = lines && loc.end <= lines.length ? fingerprint(lines, loc.start, loc.end) : "";
      if (!fp || locate(lines, fp, loc.end - loc.start + 1) !== loc.start) loose = true;
      else reported.set(identity({ ...loc, fp }), { ...loc, fp });
    }
  }
  // This lane's standing state, read only once its bot has added the label.
  // A walk that cannot finish fails the step and posts nothing: a hold is
  // carried only from a bound, vetted record of this lane's own.
  const gate = events.some((e) => laneLabeled(e, label));
  let record = null;
  if (gate) {
    const since = Math.min(...events.filter((e) => laneLabeled(e, label)).map((e) => Date.parse(e.created_at)));
    let walk;
    try {
      walk = await newestRecord(github, owner, repo, env, context.runId, Number.isFinite(since) ? since : 0, events, number);
    } catch (error) {
      walk = { why: `a read failed: ${error.message}` };
    }
    if (walk.why) throw new Error(`${lane}: could not read this lane's standing critical-security hold: ${walk.why}`);
    if (walk.skip) core.warning(`${lane}: no standing critical-security hold is read: ${walk.skip}.`);
    if (walk.state) record = walk;
  }
  const range = (f) => ({ path: f.path, start: f.start, end: f.end, fp: f.fp });
  const lifts = record ? liftsOf(env, events, record, label) : new Map();
  const first = new Map((record?.state.findings ?? []).map((f) => [identity(f), f.first]));
  const lifted = [];
  const carried = [];
  try {
    const seen = new Set();
    for (const f of [...(record?.state.findings ?? []), ...(record?.state.lifts ?? [])]) {
      const key = identity(f);
      if (seen.has(key)) continue;
      seen.add(key);
      const file = await read(f.path);
      const size = f.end - f.start + 1;
      // A file still there that cannot be read whole keeps the finding standing
      // where it was recorded, lifted or not: a lift needs its lines read
      // unchanged.
      if (file.unreadable) {
        carried.push({ ...range(f), first: first.get(key) ?? record.head, unreadable: file.unreadable });
        continue;
      }
      const start = file.lines ? locate(file.lines, f.fp, size) : 0;
      if (!start) continue;
      const now = { path: f.path, start, end: start + size - 1, fp: f.fp };
      if (lifts.has(key)) lifted.push({ ...now, lift: lifts.get(key) });
      else if (!reported.has(key)) carried.push({ ...now, first: first.get(key) ?? record.head });
    }
  } catch (error) {
    throw new Error(`${lane}: could not read this lane's standing critical-security hold: a read of the head failed: ${error.message}`);
  }
  const held = [...reported.values()].filter((f) => !lifts.has(identity(f)));
  if (model?.criteria.includes("critical-security")) {
    if (loose)
      notes.push(
        reported.size === 0
          ? "This critical-security hold names no usable location, so a later head cannot carry it and a lift cannot be matched to it."
          : "Part of this critical-security hold names no usable location: a later head carries only its usable ranges, and no lift clears it.",
      );
    else if (held.length === 0) {
      core.info(`${lane}: a listed person lifted every finding of this critical-security hold; it is not added again.`);
      model.criteria = model.criteria.filter((c) => c !== "critical-security");
    }
  }
  for (const f of carried) {
    found.add("critical-security");
    notes.push(
      f.unreadable
        ? `Carried from \`${f.first}\`: critical-security at ${where(f)} as recorded; the file cannot be read whole at this head (${f.unreadable}), so the finding stays.`
        : `Carried from \`${f.first}\`: critical-security at ${where(f)}, unchanged since that head; the review of this head did not return it.`,
    );
  }
  reasons.push(...notes);
  const state = {
    findings: [
      ...(model?.criteria.includes("critical-security") ? held : []).map((f) => ({
        ...range(f),
        first: first.get(identity(f)) ?? env.HEAD_SHA,
      })),
      ...carried.map((f) => ({ ...range(f), first: f.first })),
    ],
    lifts: lifted.map((f) => ({ ...range(f), ...f.lift })),
  };
  // Every run after this lane's bot added the label records its state, an
  // empty one included, and so does any run that holds a finding: a status
  // job with no notice of this lane is no record.
  const stateLine =
    gate || state.findings.length > 0
      ? `claude-lane-findings lane=${lane} pr=${number} sha=${env.HEAD_SHA} ${JSON.stringify(state)}`
      : "";
  const fits = Buffer.byteLength(stateLine) <= MAX_STATE_BYTES;

  if (model && model.criteria.length > 0) {
    for (const c of model.criteria) found.add(c);
    reasons.push(model.reason);
  }
  const errors = [];
  const criteria = CRITERIA.filter((c) => found.has(c));
  core.setOutput("hold", criteria.length > 0 ? "true" : "false");
  core.setOutput("criteria", criteria.join(","));
  if (criteria.length === 0 && lifted.length === 0) {
    if (!fits) throw new Error(overCap(lane));
    if (stateLine) core.notice(stateLine);
    return { hold: false, criteria };
  }
  const findSecret = await loadGate(env);
  const records = [];
  if (criteria.length > 0) {
    let reason = stripHtml(reasons.filter(Boolean).join("\n\n")).slice(
      0,
      2 * MAX_REASON,
    );
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
    const binding = bindingLine(env);
    const body = [
      marker,
      `**${lane}** holds this pull request for a person (${criteria.join(", ")}) at \`${env.HEAD_SHA}\`.`,
      "",
      reason,
      ...(binding ? [binding] : []),
      "",
      `claude-lane: ${lane}`,
    ].join("\n");
    try {
      const comments = (await listPrComments()).filter(
        (c) => c.user?.login === "github-actions[bot]",
      );
      // The same hold an earlier attempt of this run posted, word for word:
      // this attempt's record lists it too (publish.cjs writeRecord). Only an
      // exact match counts, so no other workflow's comment is ever recorded.
      writeRecord(
        env,
        comments
          .filter((c) => c.body === body)
          .map((c) => ({ kind: "issue_comment", id: c.id, body: c.body })),
      );
      // A hold with this marker is already on the pull request: one per head
      // and criteria. The label above holds either way, so a look-alike marker
      // can at most keep the reason text off.
      if (!comments.some((c) => c.body === marker || c.body?.startsWith(`${marker}\n`))) {
        const { data: created } = await github.rest.issues.createComment({
          owner,
          repo,
          issue_number: number,
          body,
        });
        writeRecord(env, [
          { kind: "issue_comment", id: created.id, body: created.body },
        ]);
      }
    } catch (error) {
      errors.push(`could not post the hold comment: ${error.message}`);
    }
    records.push(
      `claude-lane-hold lane=${lane} sha=${env.HEAD_SHA} criteria=${criteria.join(",")} label=${label}`,
    );
  }
  if (lifted.length > 0)
    await postLift(github, core, env, { owner, repo, number }, lifted, findSecret, listPrComments, errors);
  if (stateLine && fits) records.push(stateLine);
  // The record stands even when a write failed, so the next head carries it.
  for (const line of records) core.notice(line);
  if (!fits) errors.push(overCap(lane));
  if (errors.length > 0) throw new Error(`${lane}: ${errors.join("; ")}`);
  return { hold: criteria.length > 0, criteria };
}

module.exports = {
  CRITERIA,
  linkedIssue,
  modelHold,
  namesPull,
  refsIssue,
  run,
};
