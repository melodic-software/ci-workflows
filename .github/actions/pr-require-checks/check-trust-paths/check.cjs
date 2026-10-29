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
// the actor of an entry in the head branch's activity (a push, force push or
// branch creation). The activity API keeps a branch name's history across
// deletions, so a name recreated for each sync fills any one page: it is read
// newest first, page by page, until it ends, a listed App's entry shows (a
// hold), or MAX_ACTIVITY_PAGES pages were read. Commits and activity are read
// only once a path matched.
// A path matches on a changed file's path or a renamed file's old path. Data
// that may hide a match or an App fails closed: a file list shorter than the
// pull request or at GitHub's 3000-file cap counts as a match; more than 250
// commits, a commit list shorter than the pull request, a deleted head
// repository or activity longer than the page cap posts `failure`. A read
// that errors or answers with anything but a list throws, and the caller's
// fallback step posts `failure`.
"use strict";

const CONTEXT = "ci-status";
const APP_LOGIN = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*\[bot\]$/u;
const SHA = /^[0-9a-f]{40}$/u;
const MAX_FILES = 3000;
const MAX_COMMITS = 250;
const ACTIVITY_PAGE = 100;
// 2000 entries: the busiest reused branch seen, chore/standards-sync in
// claude-code-plugins, held 564 after four months. The cap bounds what a fork
// owner can make this base-repository token spend.
const MAX_ACTIVITY_PAGES = 20;
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

// The verdict from what was read: { state, description, detail }.
// `files` and `commits` are the listed arrays; `activity` is null when it
// was not read, and `activityCapped` is true when it stopped at the page cap.
function decide({ config, pr, files, commits, activity, activityCapped = false, extraPaths = [] }) {
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
  if (!Array.isArray(activity))
    return {
      state: "failure",
      description:
        "Privileged paths changed and the push history is unreadable; a person must merge.",
      detail: `paths ${JSON.stringify(paths)}; activity was not readable`,
    };
  const reasons = involvement({
    apps: config.apps,
    author: pr.user?.login,
    commits,
    activity,
  });
  if (reasons.length > 0)
    return {
      state: "failure",
      description: HOLD,
      detail: `paths ${JSON.stringify(paths)}; ${JSON.stringify(reasons)}`,
    };
  if (activityCapped)
    return {
      state: "failure",
      description:
        "Privileged paths changed and the push history is too long to read; a person must merge.",
      detail: `paths ${JSON.stringify(paths)}; activity too long: more than ${MAX_ACTIVITY_PAGES * ACTIVITY_PAGE} entries`,
    };
  return {
    state: "success",
    description: "Privileged paths changed; no agent App touched this pull request.",
    detail: `paths ${JSON.stringify(paths)}; no listed App is involved`,
  };
}

// The `after` cursor of a Link header's rel="next" link, else null. Only the
// cursor is taken; the link's URL is never followed.
function nextCursor(link) {
  for (const part of String(link ?? "").split(",")) {
    const match = /^\s*<([^>]*)>\s*;\s*rel="next"\s*$/u.exec(part);
    if (!match) continue;
    const after = new URL(match[1]).searchParams.get("after");
    if (!after) throw new Error("the activity's next link has no after cursor");
    return after;
  }
  return null;
}

// The head branch's activity, newest first, as { activity, capped }. Each
// page comes from `request`, which throws on an HTTP error, never `paginate`,
// which answers some errors with an empty page. The cursor parameters are
// documented at
// https://docs.github.com/en/rest/repos/repos#list-repository-activity.
async function readActivity({ github, owner, repo, ref, apps }) {
  const activity = [];
  let after;
  for (let page = 0; page < MAX_ACTIVITY_PAGES; page += 1) {
    const response = await github.request("GET /repos/{owner}/{repo}/activity", {
      owner,
      repo,
      ref,
      direction: "desc",
      per_page: ACTIVITY_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    if (!Array.isArray(response?.data))
      throw new Error("the activity page is not a list");
    activity.push(...response.data);
    if (involvement({ apps, author: undefined, commits: [], activity: response.data }).length > 0)
      return { activity, capped: false };
    const next = nextCursor(response.headers?.link);
    if (next === null) return { activity, capped: false };
    after = next;
  }
  return { activity, capped: true };
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
  let activityCapped = false;
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
    if (head?.owner?.login && head?.name) {
      ({ activity, capped: activityCapped } = await readActivity({
        github,
        owner: head.owner.login,
        repo: head.name,
        ref: `refs/heads/${pr.head.ref}`,
        apps: config.apps,
      }));
    }
  }
  const verdict = decide({ config, pr, files, commits, activity, activityCapped, extraPaths });
  const log = verdict.state === "success" ? core.info : core.error;
  log(`${verdict.description} ${verdict.detail}`);
  await post(verdict.state, verdict.description);
  core.setOutput("state", verdict.state);
  return verdict;
}

module.exports = {
  ACTIVITY_PAGE,
  CONTEXT,
  HOLD,
  MAX_COMMITS,
  MAX_ACTIVITY_PAGES,
  MAX_FILES,
  callerWorkflowPath,
  clip,
  decide,
  globToRegExp,
  involvement,
  matchedPaths,
  nextCursor,
  parseConfig,
  run,
};
