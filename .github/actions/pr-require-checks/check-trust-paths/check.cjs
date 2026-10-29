// check-trust-paths: holds a pull request for a person when an agent App
// named in the default branch's config touched it and it changes a privileged
// path. It posts the commit status `ci-status` on the head SHA: `pending`
// first, then `failure` on a hold or on data it cannot trust, else
// `success`. When a ruleset requires `ci-status`, both the check run and this
// status of that name must pass, so a failure here blocks the merge whatever
// the pull request's own workflows report.
//
// It runs from a `pull_request_target` caller, so this file and the caller
// come from the default branch. The config is read at the default branch's last
// commit (GITHUB_SHA) through the contents API, never from the head. Nothing
// from the head is checked out or run: file names, logins and emails are
// data, compared and logged as JSON.
//
// An App counts as involved when it is the pull request's author, the author
// or committer (account login or noreply address) of one of its commits, or
// the actor of an entry in the head branch's activity that bears on it (see
// relevantActivity) whose `after` is one of its commits.
// Commits and activity are read only once a path matched. A path matches on a
// changed file's path or a renamed file's old path. Data that may hide a
// match or an App fails closed: a file list shorter than the pull request or
// at GitHub's 3000-file cap counts as a match; more than 250 commits, a
// commit list shorter than the pull request, a deleted head repository, a
// missing date or field, history not traced within 10 pages, or an App entry
// that bears on it whose `after` is not one of its commits posts `failure`. A read that errors throws, and the caller's fallback step posts
// `failure`.
"use strict";

const CONTEXT = "ci-status";
const APP_LOGIN = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*\[bot\]$/u;
const SHA = /^[0-9a-f]{40}$/u;
const MAX_FILES = 3000;
const MAX_COMMITS = 250;
const ACTIVITY_PAGE = 100;
const MAX_ACTIVITY_PAGES = 10;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const ZERO_SHA = "0".repeat(40);
const DESCRIPTION_MAX = 140;
const NOREPLY = "@users.noreply.github.com";
const WORKFLOW_REF = /^[^/]+\/[^/]+\/(\.github\/workflows\/[^@]+)@/u;

const HOLD =
  "An agent App changed a privileged path; a person must merge this pull request.";

// The config: {"paths": [glob, ...], "apps": ["name[bot]", ...]}, both
// non-empty, no other key. Throws on anything else.
function parseConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`the config is not JSON: ${error.message}`);
  }
  if (config === null || typeof config !== "object" || Array.isArray(config))
    throw new Error("the config is not a JSON object");
  const extra = Object.keys(config).filter(
    (key) => key !== "paths" && key !== "apps" && key !== "$schema",
  );
  if (extra.length > 0)
    throw new Error(`the config has unknown keys ${JSON.stringify(extra)}`);
  const list = (key, valid) => {
    const value = config[key];
    if (!Array.isArray(value) || value.length === 0)
      throw new Error(`the config's ${key} is not a non-empty array`);
    for (const item of value)
      if (typeof item !== "string" || !valid(item))
        throw new Error(`the config's ${key} has an invalid entry ${JSON.stringify(item)}`);
    return value;
  };
  return {
    paths: list("paths", (glob) => glob.trim() === glob && glob.length > 0),
    apps: list("apps", (login) => APP_LOGIN.test(login)).map((login) =>
      login.toLowerCase(),
    ),
  };
}

// A glob as a case-insensitive whole-path pattern: `*` and `**` match any
// run of characters, `/` included; `?` matches one character.
function globToRegExp(glob) {
  const body = glob
    .split(/(\*+|\?)/u)
    .map((part) => {
      if (part.startsWith("*")) return ".*";
      if (part === "?") return ".";
      return part.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
    })
    .join("");
  return new RegExp(`^${body}$`, "iu");
}

// The changed paths, old paths of renames included, that match a pattern,
// sorted and unique.
function matchedPaths(files, globs) {
  const patterns = globs.map(globToRegExp);
  const matched = new Set();
  for (const file of files)
    for (const name of [file?.filename, file?.previous_filename])
      if (typeof name === "string" && patterns.some((pattern) => pattern.test(name)))
        matched.add(name);
  return [...matched].sort();
}

// The caller workflow's own path, from GITHUB_WORKFLOW_REF, which in a
// called workflow names the caller.
function callerWorkflowPath(workflowRef) {
  return WORKFLOW_REF.exec(String(workflowRef ?? ""))?.[1];
}

// Why a listed App counts as involved: one line per reason, empty when none.
function involvement({ apps, author, commits, activity }) {
  const isApp = (login) =>
    typeof login === "string" && apps.includes(login.toLowerCase());
  const isAppMail = (mail) => {
    if (typeof mail !== "string") return false;
    const address = mail.toLowerCase();
    return apps.some(
      (app) => address === `${app}${NOREPLY}` || address.endsWith(`+${app}${NOREPLY}`),
    );
  };
  const reasons = [];
  if (isApp(author)) reasons.push(`${author} opened it`);
  for (const commit of commits) {
    const logins = [commit?.author?.login, commit?.committer?.login];
    const mails = [commit?.commit?.author?.email, commit?.commit?.committer?.email];
    if (logins.some(isApp) || mails.some(isAppMail))
      reasons.push(`an agent App authored or committed ${String(commit?.sha).slice(0, 12)}`);
  }
  for (const entry of activity)
    if (isApp(entry?.actor?.login))
      reasons.push(
        `${entry.actor.login} ${entry.activity_type ?? "pushed"} ${String(entry.after ?? "").slice(0, 12)}`.trim(),
      );
  return [...new Set(reasons)];
}

// The earliest moment an activity entry can bear on this pull request, in
// epoch milliseconds, or NaN when a date is missing: the earliest of the pull
// request's `created_at` and each commit's committer date, less a clock-skew
// margin. A push of one of its commits comes after that commit was made, and
// a push that predates both the pull request and every one of its commits
// cannot have put one of them on the branch. The activity list takes
// `direction` (default `desc`) and gives each entry a `timestamp`, "the time
// when the activity occurred" ("List repository activities",
// https://docs.github.com/en/rest/repos/repos#list-repository-activities).
// The page does not name the sort key; its Link-header cursor encodes an
// entry's timestamp and id, so `desc` is read as newest first, and reading
// stops at the first page that holds an entry older than this. A
// committer date is set by the client: a commit dated later than its push
// narrows the window, which the margin covers for clock skew only. Author
// dates are not used: a rebase keeps them, which would reach back into a
// reused branch's earlier pull requests.
function windowStart({ pr, commits }) {
  const times = [pr?.created_at, ...commits.map((c) => c?.commit?.committer?.date)].map(
    (value) => (typeof value === "string" ? Date.parse(value) : Number.NaN),
  );
  if (times.some(Number.isNaN)) return Number.NaN;
  return Math.min(...times) - CLOCK_SKEW_MS;
}

// The activity entries, newest first, that bear on this pull request: those
// at or after `start`, and, at any age, the push that put on the branch each
// `before` SHA that is not one of `ours` (the pull request's commits and
// head). Following those SHAs traces the head's history back through force
// pushes to a branch creation, so an App's push that a later rewrite
// replaced still counts however long before the pull request it came; the
// time window bounds only the pushes of commits still in the pull request.
// Returns { entries, unknown, open, reachedStart }: `unknown` lists entries
// without a readable `timestamp`, or bearing ones without `before` and
// `after`; `open` is true while a traced SHA's push is not yet listed.
function relevantActivity(activity, start, ours) {
  const entries = [];
  const unknown = [];
  const wanted = new Set();
  let reachedStart = false;
  for (const entry of activity) {
    const time = typeof entry?.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isNaN(time)) {
      unknown.push(entry);
      continue;
    }
    const traced = typeof entry?.after === "string" && wanted.delete(entry.after);
    if (time < start) reachedStart = true;
    if (time < start && !traced) continue;
    if (typeof entry?.after !== "string" || typeof entry?.before !== "string") {
      unknown.push(entry);
      continue;
    }
    entries.push(entry);
    if (entry.before !== ZERO_SHA && !ours.has(entry.before)) wanted.add(entry.before);
  }
  return { entries, unknown, open: wanted.size > 0, reachedStart };
}

// The pull request's commits and head.
function ownShas(pr, commits) {
  return new Set([pr?.head?.sha, ...commits.map((c) => c?.sha)].filter(Boolean));
}

// The verdict from what was read: { state, description, detail }.
// `files` and `commits` are the listed arrays; `activity` is
// { entries, complete } (complete: reading stopped within the page cap), or
// null when it was not read.
function decide({ config, pr, files, commits, activity, extraPaths = [] }) {
  const globs = [...config.paths, ...extraPaths];
  const matched = matchedPaths(files, globs);
  const truncated =
    files.length >= MAX_FILES || files.length < Number(pr.changed_files ?? 0);
  if (matched.length === 0 && !truncated)
    return {
      state: "success",
      description: "No privileged path changed.",
      detail: "no changed path matches the config",
    };
  const paths = truncated ? [...matched, "(files GitHub did not list)"] : matched;
  const want = Number(pr.commits);
  if (!Number.isInteger(want) || want > MAX_COMMITS || commits.length < want)
    return {
      state: "failure",
      description:
        "Privileged paths changed and the commit list is incomplete; a person must merge.",
      detail: `paths ${JSON.stringify(paths)}; ${commits.length} of ${pr.commits} commits listed (at most ${MAX_COMMITS})`,
    };
  const unreadable = (why) => ({
    state: "failure",
    description:
      "Privileged paths changed and the push history is unreadable; a person must merge.",
    detail: `paths ${JSON.stringify(paths)}; activity ${why}`,
  });
  if (!Array.isArray(activity?.entries)) return unreadable("was not readable");
  const start = windowStart({ pr, commits });
  if (Number.isNaN(start))
    return unreadable("has no window: the pull request or a commit has no date");
  const since = new Date(start).toISOString();
  if (!activity.complete)
    return unreadable(
      `was not traced back past ${since} in ${MAX_ACTIVITY_PAGES} pages of ${ACTIVITY_PAGE}`,
    );
  const ours = ownShas(pr, commits);
  const window = relevantActivity(activity.entries, start, ours);
  if (window.unknown.length > 0)
    return unreadable(`has ${window.unknown.length} entries without a timestamp, before or after SHA`);
  if (window.open) return unreadable("ends before the head's history reaches a branch creation");
  // A push that put one of this pull request's commits on the branch counts.
  // An App entry that bears on it but did not (it pushed commits a later push
  // rewrote away) may still have added content that survived, so it holds; a
  // branch deletion adds nothing.
  const isApp = (entry) =>
    typeof entry?.actor?.login === "string" &&
    config.apps.includes(entry.actor.login.toLowerCase());
  const stray = window.entries.filter(
    (entry) => isApp(entry) && !ours.has(entry.after) && entry.after !== ZERO_SHA,
  );
  if (stray.length > 0)
    return {
      state: "failure",
      description: HOLD,
      detail: `paths ${JSON.stringify(paths)}; an agent App pushed ${JSON.stringify(stray.map((e) => String(e.after).slice(0, 12)))} in the head's history or since ${since}, not a commit of this pull request`,
    };
  const reasons = involvement({
    apps: config.apps,
    author: pr.user?.login,
    commits,
    activity: window.entries.filter((entry) => ours.has(entry.after)),
  });
  if (reasons.length > 0)
    return {
      state: "failure",
      description: HOLD,
      detail: `paths ${JSON.stringify(paths)}; ${JSON.stringify(reasons)}`,
    };
  return {
    state: "success",
    description: "Privileged paths changed; no agent App touched this pull request.",
    detail: `paths ${JSON.stringify(paths)}; no listed App is involved`,
  };
}

function clip(text) {
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 3)}...`;
}

async function postStatus({ github, owner, repo, sha, state, description, targetUrl }) {
  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state,
    context: CONTEXT,
    description: clip(description),
    target_url: targetUrl,
  });
}

async function readConfig({ github, owner, repo, path, ref }) {
  const { data } = await github.rest.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data) || data?.type !== "file" || data.encoding !== "base64")
    throw new Error(`${path} at ${ref} is not a readable file`);
  return parseConfig(Buffer.from(data.content, "base64").toString("utf8"));
}

// The head branch's activity, newest first, page by page through the Link
// header's next cursor, until it has passed `start` with no traced SHA left
// open (see relevantActivity) or the list ends: { entries, complete }.
// `complete` is false when MAX_ACTIVITY_PAGES pages were read and GitHub
// still offers a next one.
async function readActivity({ github, owner, repo, ref, start, ours }) {
  const entries = [];
  let pages = 0;
  for await (const response of github.paginate.iterator("GET /repos/{owner}/{repo}/activity", {
    owner,
    repo,
    ref,
    direction: "desc",
    per_page: ACTIVITY_PAGE,
  })) {
    pages += 1;
    const page = Array.isArray(response.data) ? response.data : [];
    entries.push(...page);
    const read = relevantActivity(entries, start, ours);
    const closed =
      Number.isNaN(start) || read.unknown.length > 0 || (read.reachedStart && !read.open);
    if (closed) return { entries, complete: true };
    if (pages >= MAX_ACTIVITY_PAGES)
      return { entries, complete: !/rel="next"/u.test(String(response.headers?.link ?? "")) };
  }
  return { entries, complete: true };
}

async function run({ github, context, core, env = process.env }) {
  if (context.eventName !== "pull_request_target")
    throw new Error(
      `the caller must run on pull_request_target, not ${context.eventName}: only a default-branch run keeps the hold out of the pull request's reach`,
    );
  const pr = context.payload.pull_request;
  const { owner, repo } = context.repo;
  const sha = pr?.head?.sha;
  // The default branch's last commit, which this run's workflow came from. A
  // pull request's recorded base can predate the config file.
  const configSha = context.sha;
  if (!SHA.test(String(sha)) || !SHA.test(String(configSha)))
    throw new Error("the event has no head SHA or default-branch SHA");
  const configPath = env.CONFIG_PATH;
  if (!configPath) throw new Error("CONFIG_PATH is empty");
  const targetUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const post = (state, description) =>
    postStatus({ github, owner, repo, sha, state, description, targetUrl });

  await post("pending", "Checking whether an agent App changed a privileged path.");
  const config = await readConfig({ github, owner, repo, path: configPath, ref: configSha });
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const extraPaths = [configPath, callerWorkflowPath(env.GITHUB_WORKFLOW_REF)].filter(Boolean);
  let commits = [];
  let activity = null;
  if (
    matchedPaths(files, [...config.paths, ...extraPaths]).length > 0 ||
    files.length >= MAX_FILES ||
    files.length < Number(pr.changed_files ?? 0)
  ) {
    commits = await github.paginate(github.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    });
    const head = pr.head.repo;
    if (head?.owner?.login && head?.name)
      activity = await readActivity({
        github,
        owner: head.owner.login,
        repo: head.name,
        ref: `refs/heads/${pr.head.ref}`,
        start: windowStart({ pr, commits }),
        ours: ownShas(pr, commits),
      });
  }
  const verdict = decide({ config, pr, files, commits, activity, extraPaths });
  const log = verdict.state === "success" ? core.info : core.error;
  log(`${verdict.description} ${verdict.detail}`);
  await post(verdict.state, verdict.description);
  core.setOutput("state", verdict.state);
  return verdict;
}

module.exports = {
  ACTIVITY_PAGE,
  CLOCK_SKEW_MS,
  CONTEXT,
  HOLD,
  MAX_ACTIVITY_PAGES,
  MAX_COMMITS,
  MAX_FILES,
  callerWorkflowPath,
  clip,
  decide,
  globToRegExp,
  involvement,
  matchedPaths,
  parseConfig,
  readActivity,
  relevantActivity,
  run,
  windowStart,
};
