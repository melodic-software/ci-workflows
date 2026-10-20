"use strict";

// Merge-group mode. A merge_group payload carries no pull request, so the
// guard maps the group to the pull requests it holds and checks each one's own
// diff, read through the pulls API. Any step it cannot complete fails the run.
//
// The group's head ref names its last pull request:
// gh-readonly-queue/<base>/pr-<N>-<sha> (the pattern check-contract/run.sh
// reads). A stack lands as one group, so the guard walks down from that pull
// request through each base branch to the queue's target branch. The walk is
// cross-checked: every path in merge_group.base_sha...head_sha must be a path
// one of the mapped pull requests changes, or the run fails closed.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const verifySyncCommits = require("./sync-commits.cjs");

const { dependabotMode } = verifySyncCommits;

const QUEUE_REF =
  /^(?:refs\/heads\/)?gh-readonly-queue\/.+\/pr-([0-9]+)-[0-9a-f]{40}$/u;
// A stack deeper than this is treated as a walk that never reaches the base.
const MAX_GROUP_PULLS = 50;
// pulls/{n}/files lists at most 3000 files, so a list that long may be cut.
const FILE_LIST_CAP = 3000;

// The rules of the action's "Select the guard mode" step, applied to a pull
// request read with pulls.get. A parity test holds the two copies together.
function selectMode(pr) {
  const author = pr.user?.login ?? "";
  const authorId = String(pr.user?.id ?? "");
  const headRepo = pr.head?.repo?.full_name ?? "";
  const baseRepo = pr.base?.repo?.full_name ?? "";
  let mode = "hand-edit";
  if (
    author === "melodic-standards-sync[bot]" &&
    pr.head?.ref === "chore/standards-sync" &&
    headRepo !== "" &&
    headRepo === baseRepo
  ) {
    mode = "sync";
  }
  if (author === "dependabot[bot]" && authorId === "49699333") {
    mode = "dependabot";
  }
  return mode;
}

class GroupError extends Error {}

async function getPull({ github, owner, repo }, number) {
  try {
    const { data } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
    });
    return data;
  } catch (error) {
    throw new GroupError(
      `could not read pull request #${number}: ${error.message}`,
    );
  }
}

// The queued pull request and, for a stack, each pull request below it,
// bottom first.
async function groupPulls(args, number, target) {
  const pulls = [await getPull(args, number)];
  for (;;) {
    const top = pulls.at(-1);
    const base = top.base?.ref;
    if (base === target) return pulls.reverse();
    if (pulls.length >= MAX_GROUP_PULLS) {
      throw new GroupError(
        `the pull requests below #${pulls[0].number} never reach ${target} within ${MAX_GROUP_PULLS} pull requests`,
      );
    }
    let below;
    try {
      ({ data: below } = await args.github.rest.pulls.list({
        owner: args.owner,
        repo: args.repo,
        state: "open",
        head: `${args.owner}:${base}`,
        per_page: 100,
      }));
    } catch (error) {
      throw new GroupError(
        `could not find the pull request below #${top.number}: ${error.message}`,
      );
    }
    if (below.length !== 1) {
      throw new GroupError(
        `pull request #${top.number} targets ${base}, not ${target}, and ${below.length} open pull requests come from ${base}`,
      );
    }
    if (pulls.some((pr) => pr.number === below[0].number)) {
      throw new GroupError(
        `pull request #${below[0].number} appears twice below #${pulls[0].number}`,
      );
    }
    pulls.push(await getPull(args, below[0].number));
  }
}

async function pullFiles({ github, owner, repo }, number) {
  let files;
  try {
    files = await github.paginate(github.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });
  } catch (error) {
    throw new GroupError(
      `could not list the files of pull request #${number}: ${error.message}`,
    );
  }
  if (files.length >= FILE_LIST_CAP) {
    throw new GroupError(
      `pull request #${number} lists ${files.length} files, the API cap, so the list may be incomplete`,
    );
  }
  // Both paths of a rename, as run.sh's --no-renames diff lists them.
  return files.flatMap((file) =>
    file.previous_filename
      ? [file.filename, file.previous_filename]
      : [file.filename],
  );
}

function groupDiff({ workspace, baseSha, headSha }) {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "-z", "--no-renames", `${baseSha}...${headSha}`],
      { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.split("\0").filter(Boolean);
  } catch (error) {
    throw new GroupError(
      `could not diff the merge group ${baseSha}...${headSha}: ${error.message}`,
    );
  }
}

// Resolves the group to a guard mode for the steps that follow:
//   sync      the group is one sync pull request; verify-sync.sh checks the
//             group's commits against standards main
//   hand-edit run.sh checks each file written to pathsDir (pr-<N>, NUL-separated)
//   skip      every pull request is a verified Dependabot one
// Returns null, with the run failed, when the group cannot be checked.
async function resolveMergeGroup(args) {
  const { core, headRef, baseRef, pathsDir } = args;
  const problems = [];
  try {
    const match = QUEUE_REF.exec(headRef ?? "");
    if (!match) {
      throw new GroupError(
        `cannot read a pull request number from the merge-group head ref '${headRef ?? ""}'`,
      );
    }
    const target = (baseRef ?? "").replace(/^refs\/heads\//u, "");
    const pulls = await groupPulls(args, Number(match[1]), target);
    core.info(
      `Merge group holds pull request(s) ${pulls.map((pr) => `#${pr.number}`).join(", ")}.`,
    );

    const covered = new Set();
    const checked = [];
    let sync = false;
    for (const pr of pulls) {
      const files = await pullFiles(args, pr.number);
      for (const file of files) covered.add(file);
      const commitArgs = {
        ...args,
        pullNumber: pr.number,
        headSha: pr.head?.sha,
      };
      let mode = selectMode(pr);
      if (mode === "dependabot") mode = await dependabotMode(commitArgs);
      core.info(`#${pr.number}: managed-files-guard mode ${mode}`);
      if (mode === "sync") {
        if (pulls.length > 1) {
          problems.push(
            `sync pull request #${pr.number} shares its merge group with other pull requests; a sync pull request must be queued alone`,
          );
        } else if (!(await verifySyncCommits(commitArgs))) {
          return null;
        }
        sync = true;
      } else if (mode === "hand-edit") {
        checked.push({ number: pr.number, files });
      }
    }

    for (const file of groupDiff(args)) {
      if (!covered.has(file)) {
        problems.push(
          `${file} changes in the merge group but in none of its pull requests`,
        );
      }
    }
    if (problems.length === 0) {
      if (sync) return "sync";
      if (checked.length === 0) return "skip";
      for (const { number, files } of checked) {
        const body = files.map((file) => `${file}\0`).join("");
        fs.writeFileSync(path.join(pathsDir, `pr-${number}`), body);
      }
      return "hand-edit";
    }
  } catch (error) {
    if (!(error instanceof GroupError)) throw error;
    problems.push(error.message);
  }
  for (const problem of problems) core.error(problem);
  core.setFailed(
    `Cannot verify the merge group's managed files (${problems.length} problem(s) above).`,
  );
  return null;
}

module.exports = { resolveMergeGroup, selectMode };
