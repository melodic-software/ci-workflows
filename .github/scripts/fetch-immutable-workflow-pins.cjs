"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CANONICAL_WORKFLOW_PREFIX =
  "melodic-software/ci-workflows/.github/workflows/";
const IMMUTABLE_SHA = /^[0-9a-f]{40}$/u;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MILLISECONDS = 5_000;
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;

function stripYamlString(value) {
  const withoutComment = value.replace(/\s+#.*$/u, "").trim();
  const first = withoutComment.at(0);
  const last = withoutComment.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

function parseCanonicalWorkflowUses(
  source,
  { requireMatches = true, sourceName = "<workflow>" } = {},
) {
  const references = [];
  const lines = source.split(/\r?\n/u);

  for (const [index, line] of lines.entries()) {
    const uses = line.match(/^\s*uses:\s*(?<value>.+?)\s*$/u);
    if (!uses) {
      continue;
    }

    const value = stripYamlString(uses.groups.value);
    if (!value.startsWith(CANONICAL_WORKFLOW_PREFIX)) {
      continue;
    }

    const canonical = value.match(
      /^melodic-software\/ci-workflows\/\.github\/workflows\/(?<workflow>[A-Za-z0-9][A-Za-z0-9_.-]*\.ya?ml)@(?<sha>[0-9a-f]{40})$/u,
    );
    if (!canonical) {
      throw new Error(
        `${sourceName}:${index + 1}: canonical self-workflow uses must end in a 40-character lowercase hexadecimal commit SHA`,
      );
    }

    references.push({
      sha: canonical.groups.sha,
      workflow: canonical.groups.workflow,
    });
  }

  if (requireMatches && references.length === 0) {
    throw new Error(`${sourceName}: no canonical self-workflow uses found`);
  }

  return references;
}

function workflowSha(source, workflow, options = {}) {
  const references = parseCanonicalWorkflowUses(source, options).filter(
    (reference) => reference.workflow === workflow,
  );
  if (references.length !== 1) {
    throw new Error(
      `${options.sourceName ?? "<workflow>"}: expected exactly one canonical ${workflow} use; found ${references.length}`,
    );
  }
  return references[0].sha;
}

function templateWorkflowFiles(repositoryRoot, run = spawnSync) {
  const args = ["ls-files", "-z", "--", "templates"];
  const result = run("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    timeout: DEFAULT_TIMEOUT_MILLISECONDS,
  });
  if (result.status !== 0) {
    throw commandFailure("git", args, result);
  }

  return result.stdout
    .split("\0")
    .filter((file) =>
      /^templates\/.+\/\.github\/workflows\/[^/]+\.ya?ml$/u.test(file),
    )
    .map((file) => path.join(repositoryRoot, ...file.split("/")))
    .sort();
}

function immutableTemplatePins(repositoryRoot) {
  const references = templateWorkflowFiles(repositoryRoot).flatMap((file) =>
    parseCanonicalWorkflowUses(fs.readFileSync(file, "utf8"), {
      requireMatches: false,
      sourceName: path.relative(repositoryRoot, file),
    }),
  );
  const pins = [...new Set(references.map((reference) => reference.sha))].sort();
  if (pins.length === 0) {
    throw new Error("no immutable template workflow pins found");
  }
  return pins;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function commandFailure(command, args, result) {
  const detail = result.error?.message || result.stderr?.trim() || "no stderr";
  return new Error(
    `${command} ${args.join(" ")} failed with status ${String(result.status)}: ${detail}`,
  );
}

function fetchImmutablePins({
  attempts = DEFAULT_ATTEMPTS,
  backoffMilliseconds = DEFAULT_BACKOFF_MILLISECONDS,
  cwd,
  pins,
  run = spawnSync,
  sleepFor = sleep,
  timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }
  if (pins.length === 0 || pins.some((pin) => !IMMUTABLE_SHA.test(pin))) {
    throw new Error("pins must contain immutable lowercase commit SHAs");
  }

  const fetchArgs = [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--depth=1",
    "origin",
    ...[...new Set(pins)].sort(),
  ];
  let fetchResult;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    fetchResult = run("git", fetchArgs, {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: timeoutMilliseconds,
    });
    if (fetchResult.status === 0) {
      break;
    }
    if (attempt < attempts) {
      sleepFor(backoffMilliseconds);
    }
  }
  if (fetchResult.status !== 0) {
    throw commandFailure("git", fetchArgs, fetchResult);
  }

  for (const pin of [...new Set(pins)].sort()) {
    const verifyArgs = ["cat-file", "-e", `${pin}^{commit}`];
    const verifyResult = run("git", verifyArgs, {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: timeoutMilliseconds,
    });
    if (verifyResult.status !== 0) {
      throw commandFailure("git", verifyArgs, verifyResult);
    }
  }
}

function main() {
  const repositoryRoot = path.resolve(__dirname, "..", "..");
  const pins = immutableTemplatePins(repositoryRoot);
  fetchImmutablePins({ cwd: repositoryRoot, pins });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CANONICAL_WORKFLOW_PREFIX,
  fetchImmutablePins,
  immutableTemplatePins,
  parseCanonicalWorkflowUses,
  templateWorkflowFiles,
  workflowSha,
};
