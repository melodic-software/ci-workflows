"use strict";

// The Dependabot auto-merge gate, shared by the pull_request path
// (action.yml, called from pr-automerge-dependabot.yml) and the scheduled
// queue (queue.cjs, run by pr-automerge-dependabot-queue.yml). gateFailure
// returns the first reason a pull request must be left for a person, or "".
//
// Every PR-derived value (title, body, branch, commit message, metadata) is
// untrusted: it is only compared and logged, never executed.

const DEPENDABOT_ID = 49699333;
// web-flow: GitHub's signing identity for Dependabot commits.
const WEB_FLOW_ID = 19864447;
const ACTIONS_ECOSYSTEM = "github_actions";
// fetch-metadata's ids for npm, pip, uv and NuGet (Dependabot branch names).
const PACKAGE_ECOSYSTEMS = new Set(["npm_and_yarn", "pip", "uv", "nuget"]);
const UPDATE_TYPES = new Set([
  "version-update:semver-patch",
  "version-update:semver-minor",
]);

const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*")}$`,
    "u",
  );

const majorMinor = (version) =>
  /^v?(\d+)\.(\d+)/u.exec(String(version ?? ""));
function breaksBelowOne(update) {
  const previous = majorMinor(update?.prevVersion);
  if (previous?.[1] !== "0") return false;
  const next = majorMinor(update?.newVersion);
  return next === null || next[1] !== "0" || next[2] !== previous[2];
}

// The metadata comes from the commit message, the title and body from the
// PR; both are Dependabot's, so a disagreement means one was edited. A
// grouped PR names its updates in `Updates` lines.
function metadataMismatch(pr, updates) {
  const claimed = new Set();
  const title = /\bbump (\S+) from (\S+) to (\S+)/iu.exec(
    String(pr.title ?? ""),
  );
  if (title) claimed.add(`${title[1]} from ${title[2]} to ${title[3]}`);
  for (const line of String(pr.body ?? "").matchAll(
    /^Updates `([^`]+)` from (\S+) to (\S+)\s*$/gmu,
  )) {
    claimed.add(`${line[1]} from ${line[2]} to ${line[3]}`);
  }
  const actual = new Set();
  for (const update of updates) {
    if (!update?.prevVersion || !update?.newVersion) {
      return `${update?.dependencyName} has no from or to version in the metadata`;
    }
    actual.add(
      `${update.dependencyName} from ${update.prevVersion} to ${update.newVersion}`,
    );
  }
  for (const entry of actual) {
    if (!claimed.has(entry))
      return `the title and Updates lines do not name ${entry}`;
  }
  for (const entry of claimed) {
    if (!actual.has(entry))
      return `the metadata does not include ${entry}, which the title or an Updates line names`;
  }
  return "";
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// `pr` is the REST pull request (user.id, title, body, head.sha). `updates`
// is fetch-metadata's updated-dependencies shape. `listCommits` returns the
// REST commit list, read only once every cheaper gate holds. `inputs` holds
// the caller's raw strings: publisherAllowlist and reviewOnly (JSON arrays)
// and packageAutoMerge ("true" or anything else).
async function gateFailure({ pr, updates, listCommits, inputs }) {
  if (pr?.user?.id !== DEPENDABOT_ID) return "the PR author is not Dependabot";
  if (!Array.isArray(updates) || updates.length === 0)
    return "no updated dependencies";
  const reviewOnly = parseJson(inputs.reviewOnly);
  if (
    !Array.isArray(reviewOnly) ||
    !reviewOnly.every((entry) => typeof entry === "string")
  ) {
    return "the review-only-dependencies input is not a JSON array of names";
  }
  const publishers = parseJson(inputs.publisherAllowlist);
  if (
    !Array.isArray(publishers) ||
    !publishers.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    return "the publisher-allowlist input is not a JSON array of non-empty globs";
  }
  const allowlist = publishers.map(globToRegExp);
  const packageAutoMerge = inputs.packageAutoMerge === "true";
  for (const update of updates) {
    const name = String(update?.dependencyName ?? "");
    const ecosystem = update?.packageEcosystem;
    if (ecosystem === ACTIONS_ECOSYSTEM) {
      if (!allowlist.some((pattern) => pattern.test(name)))
        return `${name} is not an allowlisted publisher`;
    } else if (!PACKAGE_ECOSYSTEMS.has(ecosystem)) {
      return `${name} is not a GitHub Actions, npm, pip, uv or NuGet update`;
    } else if (!packageAutoMerge) {
      return `${name} is a package update and this repository turned package auto-merge off`;
    } else if (reviewOnly.includes(name)) {
      return `${name} is a review-only dependency`;
    }
    if (!UPDATE_TYPES.has(update?.updateType))
      return `${name} is not a patch or minor update`;
    if (breaksBelowOne(update))
      return `${name} changes its minor version below 1.0`;
  }
  const mismatch = metadataMismatch(pr, updates);
  if (mismatch) return mismatch;
  const commits = await listCommits();
  if (commits.length === 0 || commits.at(-1).sha !== pr.head?.sha) {
    return "the PR head moved after this event";
  }
  for (const commit of commits) {
    const verification = commit.commit?.verification;
    if (
      commit.author?.id !== DEPENDABOT_ID ||
      commit.committer?.id !== WEB_FLOW_ID ||
      verification?.verified !== true ||
      verification?.reason !== "valid"
    ) {
      return `commit ${commit.sha} is not a verified Dependabot commit`;
    }
  }
  return "";
}

// fetch-metadata's update-type rule for an entry whose metadata names none.
function calculateUpdateType(previous, next) {
  if (!previous || !next || previous === next) return "";
  const from = previous.replace("v", "").split(".");
  const to = next.replace("v", "").split(".");
  if (from[0] !== to[0]) return "version-update:semver-major";
  if (from.length < 2 || to.length < 2 || from[1] !== to[1])
    return "version-update:semver-minor";
  return "version-update:semver-patch";
}

const METADATA_KEYS = new Set([
  "dependency-name",
  "dependency-version",
  "dependency-type",
  "update-type",
  "dependency-group",
]);

// The updated-dependencies list of a Dependabot commit message, in
// fetch-metadata's shape, for the scheduled path, which has no pull_request
// event for fetch-metadata to read. It follows fetch-metadata's parse (the
// `---`/`...` block, `Updates` lines for grouped versions, the `Bumps` line
// for a single one, the ecosystem from the branch name) but reads only the
// flat list Dependabot writes: any other line, or an entry without a name,
// returns null, so the pull request is left for a person.
function parseCommitMetadata(message, branch) {
  const text = String(message ?? "");
  const ref = String(branch ?? "");
  if (!ref.startsWith("dependabot") || ref.length < 11) return null;
  const ecosystem = ref.split(ref[10])[1];
  const block = /^-{3}\n([\s\S]*?)\n^\.{3}$/mu.exec(text);
  if (!block || !ecosystem) return null;
  const lines = block[1].split("\n");
  if (lines.shift() !== "updated-dependencies:") return null;
  const entries = [];
  for (const line of lines) {
    const field = /^(- | {2})([a-z-]+): (.+)$/u.exec(line);
    if (!field || !METADATA_KEYS.has(field[2])) return null;
    if (field[1] === "- ") entries.push({});
    const entry = entries.at(-1);
    if (!entry || field[2] in entry) return null;
    entry[field[2]] = field[3].trim().replace(/^(['"])(.*)\1$/u, "$2");
  }
  if (entries.length === 0) return null;
  const linked = new Map();
  for (const line of text.matchAll(
    /^Updates `(\S+)` (?:from (\S+) )?to (\S+)$/gmu,
  )) {
    linked.set(line[1], [
      ...(linked.get(line[1]) ?? []),
      { prevVersion: line[2] ?? "", newVersion: line[3] },
    ]);
  }
  const bump = /^Bumps .* from (v?\d[^ ]*) to (v?\d[^ ]*)\.$/mu.exec(text);
  const seen = new Map();
  const updates = [];
  for (const [index, entry] of entries.entries()) {
    const name = entry["dependency-name"];
    if (!name) return null;
    const nth = seen.get(name) ?? 0;
    seen.set(name, nth + 1);
    const link = linked.get(name)?.[nth];
    const prevVersion =
      link?.prevVersion || (index === 0 ? (bump?.[1] ?? "") : "");
    const newVersion =
      entry["dependency-version"] ||
      link?.newVersion ||
      (index === 0 ? (bump?.[2] ?? "") : "");
    updates.push({
      dependencyName: name,
      updateType:
        entry["update-type"] || calculateUpdateType(prevVersion, newVersion),
      packageEcosystem: ecosystem,
      prevVersion,
      newVersion,
    });
  }
  return updates;
}

const ARM = `mutation($id: ID!, $head: GitObjectID!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $head}) {
    clientMutationId
  }
}`;
const DISARM = `mutation($id: ID!) {
  disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId }
}`;

// The pull_request path. Its event pre-checks stay here: the scheduled path
// has no sender, and reads the metadata itself. A skipped PR that is already
// armed is disarmed, since GitHub keeps auto-merge on when a user with write
// access pushes to the branch. The arm passes the verified head as
// `expectedHeadOid`, so a push between the check and the arm fails the arm.
async function runEvent({ github, context, core, env }) {
  const pr = context.payload.pull_request;
  async function eventFailure() {
    if (pr.user?.id !== DEPENDABOT_ID) return "the PR author is not Dependabot";
    if (env.SENDER_ID !== String(DEPENDABOT_ID))
      return "this event was not sent by Dependabot";
    if (env.METADATA_OUTCOME !== "success")
      return "fetching the Dependabot metadata failed";
    const updates = parseJson(env.UPDATED_DEPENDENCIES_JSON || "");
    if (updates === undefined) return "the Dependabot metadata is not valid JSON";
    return gateFailure({
      pr,
      updates,
      listCommits: () =>
        github.paginate(github.rest.pulls.listCommits, {
          ...context.repo,
          pull_number: pr.number,
          per_page: 100,
        }),
      inputs: {
        publisherAllowlist: env.PUBLISHER_ALLOWLIST,
        packageAutoMerge: env.PACKAGE_AUTO_MERGE,
        reviewOnly: env.REVIEW_ONLY_DEPENDENCIES,
      },
    });
  }

  const reason = await eventFailure();
  if (reason) {
    core.notice(`Auto-merge not armed: ${reason}.`);
    if (pr.auto_merge) {
      await github.graphql(DISARM, { id: pr.node_id });
      core.notice("Disarmed the auto-merge armed on an earlier head.");
    }
    return;
  }
  try {
    await github.graphql(ARM, { id: pr.node_id, head: pr.head.sha });
  } catch (error) {
    // An already-mergeable PR (mergeStateStatus CLEAN or UNSTABLE) makes
    // the mutation error instead of no-op, as in the standards-sync arm.
    if (!/is in (clean|unstable) status/iu.test(error.message)) throw error;
    core.warning(`Could not arm auto-merge on #${pr.number}: ${error.message}`);
    return;
  }
  core.info(`Armed squash auto-merge on #${pr.number} at ${pr.head.sha}.`);
}

module.exports = {
  DEPENDABOT_ID,
  WEB_FLOW_ID,
  gateFailure,
  parseCommitMetadata,
  runEvent,
};
