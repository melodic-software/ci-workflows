"use strict";

// A pull request's changed paths, read through the pulls API. Merge-group
// mode reads each queued pull request's list here; a pull request run reads
// its own, so the hand-edit check needs no clone of the repository.

const fs = require("node:fs");
const path = require("node:path");
const { createRetry, ReadError } = require("./retry.cjs");

// pulls/{n}/files lists at most 3000 files, so a list that long may be cut.
const FILE_LIST_CAP = 3000;

// A retry restarts the listing from page 1, so no page is kept from a failed
// pass. Returns the listed file count and the paths, both paths of a rename
// included, as run.sh's --no-renames diff lists them.
async function pullFiles({ github, owner, repo, withRetry }, number) {
  const files = await withRetry(
    () =>
      github.paginate(github.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      }),
    `could not list the files of pull request #${number}`,
  );
  return {
    count: files.length,
    paths: files.flatMap((file) =>
      file.previous_filename
        ? [file.filename, file.previous_filename]
        : [file.filename],
    ),
  };
}

// Writes the pull request's paths, NUL-separated, to a new file under dir for
// run.sh and returns its path. Returns "" when the list may be incomplete (at
// the API cap) or cannot be read, so the action diffs a clone instead.
async function writePullPaths(input) {
  const { core, pullNumber, dir } = input;
  const withRetry = createRetry({
    sleep: input.sleep,
    now: input.now,
    log: (message) => core.warning(message),
  });
  let listed;
  try {
    listed = await pullFiles({ ...input, withRetry }, pullNumber);
  } catch (error) {
    if (!(error instanceof ReadError)) throw error;
    core.warning(`${error.message}; diffing a clone instead.`);
    return "";
  }
  if (listed.count >= FILE_LIST_CAP) {
    core.info(
      `Pull request #${pullNumber} lists ${listed.count} files, the API cap; diffing a clone instead.`,
    );
    return "";
  }
  const file = path.join(dir, `pr-${pullNumber}`);
  fs.writeFileSync(file, listed.paths.map((p) => `${p}\0`).join(""));
  return file;
}

module.exports = { FILE_LIST_CAP, pullFiles, writePullPaths };
