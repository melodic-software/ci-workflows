"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const workflowPath = path.join(
  __dirname,
  "..",
  "workflows",
  "maintenance-sync-standards.yml",
);
const workflowLines = fs.readFileSync(workflowPath, "utf8").split(/\r?\n/u);

function stepIndex(name) {
  return workflowLines.findIndex((line) => line.includes(`- name: ${name}`));
}

const STEP = "Replace the sync branch when the target refuses its update";
const replaceStepIndex = stepIndex(STEP);

// Same inline-script extraction technique standards-sync-merge-queue-wait.test.cjs uses.
function extractReplaceScript() {
  assert.notEqual(replaceStepIndex, -1, "replace step must exist");
  const scriptIndex = workflowLines.findIndex(
    (line, index) =>
      index > replaceStepIndex && /^ {10}script: \|$/u.test(line),
  );
  assert.notEqual(scriptIndex, -1, "replace script block must exist");
  const body = [];
  for (let index = scriptIndex + 1; index < workflowLines.length; index += 1) {
    const line = workflowLines[index];
    if (line.length > 0 && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return body.join("\n");
}

const replaceScript = extractReplaceScript();
const stepBlock = (index) => workflowLines.slice(index, index + 14).join("\n");

test("the replace step runs after the components apply and right before the PR step", () => {
  const apply = stepIndex("Apply managed components");
  const prepared = stepIndex("Compute the prepared sync tree");
  const pr = stepIndex("Open or update reviewed sync PR");
  assert.ok(apply !== -1 && prepared !== -1 && pr !== -1);
  assert.ok(
    apply < prepared && prepared < replaceStepIndex && replaceStepIndex < pr,
  );
  const between = workflowLines
    .slice(replaceStepIndex + 1, pr)
    .filter((line) => /^ {6}- name: /u.test(line));
  assert.deepEqual(between, []);
});

test("the replace step deletes only the branch the PR step pushes, with the target token", () => {
  const replaceBranch = /BRANCH: (\S+)/u.exec(stepBlock(replaceStepIndex))?.[1];
  const prBranch = /branch: (\S+)/u.exec(
    workflowLines
      .slice(stepIndex("Open or update reviewed sync PR"))
      .join("\n"),
  )?.[1];
  assert.equal(replaceBranch, "chore/standards-sync");
  assert.equal(prBranch, replaceBranch);
  assert.match(
    stepBlock(replaceStepIndex),
    /github-token: \$\{\{ steps\.token\.outputs\.token \}\}/u,
  );
  assert.match(replaceScript, /ref: `heads\/\$\{branch\}`/u);
  assert.doesNotMatch(replaceScript, /updateRef|force/u);
});

test("the prepared tree is staged in a throwaway index outside the target checkout", () => {
  const block = stepBlock(stepIndex("Compute the prepared sync tree"));
  assert.match(block, /working-directory: \.target/u);
  assert.match(
    block,
    /GIT_INDEX_FILE: \$\{\{ runner\.temp \}\}\/standards-sync-prepared\.index/u,
  );
});

const BASE_SHA = "b".repeat(40);
const BASE_TREE = "1".repeat(40);
const PREPARED_TREE = "2".repeat(40);
const updateRule = {
  type: "update",
  ruleset_source: "melodic-software/azure-iac",
  ruleset_id: 24659680,
};
const branchHead = ({ tree = PREPARED_TREE, parents = [BASE_SHA] } = {}) => ({
  commit: { tree: { sha: tree } },
  parents: parents.map((sha) => ({ sha })),
});
const sameRepoPull = (number) => ({
  number,
  head: { repo: { owner: { login: "melodic-software" } } },
});

async function runReplace({
  rules = [updateRule],
  head = branchHead({ tree: "3".repeat(40) }),
  pulls = [sameRepoPull(155)],
  preparedTree = PREPARED_TREE,
  deleteError,
} = {}) {
  const keys = [
    "OWNER",
    "REPO",
    "BRANCH",
    "BASE_SHA",
    "BASE_TREE",
    "PREPARED_TREE",
  ];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    OWNER: "melodic-software",
    REPO: "azure-iac",
    BRANCH: "chore/standards-sync",
    BASE_SHA,
    BASE_TREE,
    PREPARED_TREE: preparedTree,
  });
  const calls = [];
  const outputs = {};
  const infos = [];
  const warnings = [];
  const failures = [];
  const summaries = [];
  const record = (name, result) => async (args) => {
    calls.push({ name, args });
    if (result instanceof Error) throw result;
    return result;
  };
  try {
    const github = {
      request: async (route, args) => {
        calls.push({ name: "rules", route, args });
        if (rules instanceof Error) throw rules;
        return { data: rules };
      },
      rest: {
        repos: {
          getBranch: record(
            "getBranch",
            head instanceof Error ? head : { data: { commit: head } },
          ),
        },
        pulls: {
          list: record("list", { data: pulls }),
          update: record("close", {}),
        },
        git: { deleteRef: record("deleteRef", deleteError ?? {}) },
      },
    };
    const core = {
      info: (message) => infos.push(message),
      warning: (message) => warnings.push(message),
      setFailed: (message) => failures.push(message),
      setOutput: (name, value) => {
        outputs[name] = value;
      },
      summary: {
        addRaw(text) {
          summaries.push(text);
          return this;
        },
        write: async () => {},
      },
    };
    await new AsyncFunction("github", "core", replaceScript)(github, core);
    return { calls, outputs, infos, warnings, failures, summaries };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

const names = (calls) => calls.map((call) => call.name);
const notFound = Object.assign(new Error("Branch not found"), { status: 404 });

test("a target with no update rule reads nothing more and keeps its branch (every target but azure-iac)", async () => {
  const result = await runReplace({ rules: [] });
  assert.deepEqual(names(result.calls), ["rules"]);
  assert.equal(
    result.calls[0].route,
    "GET /repos/{owner}/{repo}/rules/branches/{branch}",
  );
  assert.equal(result.calls[0].args.branch, "chore/standards-sync");
  assert.equal(result.outputs["branch-operation"], "kept");
  assert.equal(result.failures.length, 0);
});

test("other rule types do not trigger a replace", async () => {
  const result = await runReplace({
    rules: [{ type: "deletion" }, { type: "required_signatures" }],
  });
  assert.deepEqual(names(result.calls), ["rules"]);
  assert.equal(result.outputs["branch-operation"], "kept");
});

test("an unreadable rule set warns and leaves the update in place, as before", async () => {
  const result = await runReplace({
    rules: new Error("Resource not accessible"),
  });
  assert.deepEqual(names(result.calls), ["rules"]);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.failures.length, 0);
});

test("a missing sync branch leaves creation to the PR step", async () => {
  const result = await runReplace({ head: notFound });
  assert.deepEqual(names(result.calls), ["rules", "getBranch"]);
  assert.equal(result.outputs["branch-operation"], "kept");
});

test("a branch read failure other than 404 fails the step", async () => {
  await assert.rejects(
    runReplace({ head: Object.assign(new Error("boom"), { status: 500 }) }),
    /boom/u,
  );
});

test("a branch already holding the prepared tree on the current base is left alone", async () => {
  const result = await runReplace({ head: branchHead() });
  assert.deepEqual(names(result.calls), ["rules", "getBranch"]);
  assert.equal(result.outputs["branch-operation"], "kept");
  assert.equal(result.summaries.length, 0);
});

test("a changed tree closes the open sync PR, then deletes the branch", async () => {
  const result = await runReplace();
  assert.deepEqual(names(result.calls), [
    "rules",
    "getBranch",
    "list",
    "close",
    "deleteRef",
  ]);
  const list = result.calls.find((call) => call.name === "list").args;
  assert.equal(list.head, "melodic-software:chore/standards-sync");
  assert.equal(list.state, "open");
  assert.deepEqual(result.calls.find((call) => call.name === "close").args, {
    owner: "melodic-software",
    repo: "azure-iac",
    pull_number: 155,
    state: "closed",
  });
  assert.deepEqual(
    result.calls.find((call) => call.name === "deleteRef").args,
    {
      owner: "melodic-software",
      repo: "azure-iac",
      ref: "heads/chore/standards-sync",
    },
  );
  assert.equal(result.outputs["branch-operation"], "replaced");
  assert.equal(result.summaries.length, 1);
  assert.match(
    result.summaries[0],
    /Replaced melodic-software\/azure-iac:chore\/standards-sync/u,
  );
  assert.match(result.summaries[0], /ruleset 24659680/u);
  assert.match(result.summaries[0], /#155/u);
});

test("the same tree on a moved base is replaced, since the PR step would rebase it", async () => {
  const result = await runReplace({
    head: branchHead({ parents: ["c".repeat(40)] }),
  });
  assert.equal(result.outputs["branch-operation"], "replaced");
});

test("an extra commit on the branch is replaced, since the PR step would reset it", async () => {
  const result = await runReplace({
    head: branchHead({ parents: [BASE_SHA, "d".repeat(40)] }),
  });
  assert.equal(result.outputs["branch-operation"], "replaced");
});

test("nothing left to sync deletes the branch and reports it closed, not replaced", async () => {
  const result = await runReplace({
    head: branchHead({ tree: BASE_TREE }),
    preparedTree: BASE_TREE,
  });
  assert.ok(names(result.calls).includes("deleteRef"));
  assert.equal(result.outputs["branch-operation"], "closed");
  assert.match(result.summaries[0], /^Closed /u);
});

test("a fork PR that reuses the branch name is not closed", async () => {
  const result = await runReplace({
    pulls: [
      { number: 7000, head: { repo: { owner: { login: "someone-else" } } } },
    ],
  });
  assert.ok(!names(result.calls).includes("close"));
  assert.equal(result.outputs["branch-operation"], "replaced");
});

test("a refused delete fails the job naming the target, the rule and the closed PR", async () => {
  const result = await runReplace({
    deleteError: new Error("Cannot delete this protected ref"),
  });
  assert.equal(result.failures.length, 1);
  assert.match(
    result.failures[0],
    /melodic-software\/azure-iac:chore\/standards-sync/u,
  );
  assert.match(result.failures[0], /ruleset 24659680/u);
  assert.match(result.failures[0], /after closing #155/u);
  assert.equal(result.outputs["branch-operation"], "kept");
  assert.equal(result.summaries.length, 0);
});
