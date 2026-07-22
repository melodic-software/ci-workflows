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
  "standards-sync.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");

// Same inline-script extraction technique standards-sync-app-attestation.test.cjs
// uses: pull the actions/github-script body out of the YAML by name and run it
// directly, so the arming logic (not just its structural presence) is exercised.
function extractArmingScript() {
  const lines = workflow.split(/\r?\n/u);
  const stepIndex = lines.findIndex((line) =>
    line.includes("- name: Arm auto-merge on the newly created sync PR"),
  );
  assert.notEqual(stepIndex, -1, "arming step must exist");
  const scriptIndex = lines.findIndex(
    (line, index) => index > stepIndex && /^ {10}script: \|$/u.test(line),
  );
  assert.notEqual(scriptIndex, -1, "arming script block must exist");
  const body = [];
  for (let index = scriptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return body.join("\n");
}

const armingScript = extractArmingScript();

test("the arming step only runs on PR creation, gated on matrix.automerge", () => {
  const stepIndex = workflow
    .split(/\r?\n/u)
    .findIndex((line) =>
      line.includes("- name: Arm auto-merge on the newly created sync PR"),
    );
  const ifLine = workflow.split(/\r?\n/u)[stepIndex + 1];
  assert.match(ifLine, /pull-request-operation == 'created'/u);
  assert.match(ifLine, /matrix\.automerge/u);
});

test("the arming step uses the target-scoped App token, not the caller's default token", () => {
  const stepIndex = workflow
    .split(/\r?\n/u)
    .findIndex((line) =>
      line.includes("- name: Arm auto-merge on the newly created sync PR"),
    );
  const block = workflow.split(/\r?\n/u).slice(stepIndex, stepIndex + 10).join("\n");
  assert.match(block, /github-token: \$\{\{ steps\.token\.outputs\.token \}\}/u);
});

async function runArming({ owner = "melodic-software", repo = "dotfiles", prNumber = 42, nodeId = "PR_kwFoo", graphqlError } = {}) {
  const keys = ["OWNER", "REPO", "PR_NUMBER"];
  const originalValues = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OWNER: owner, REPO: repo, PR_NUMBER: String(prNumber) });
  const graphqlCalls = [];
  const warnings = [];
  const infos = [];
  try {
    const github = {
      rest: {
        pulls: {
          get: async ({ owner: calledOwner, repo: calledRepo, pull_number }) => {
            assert.equal(calledOwner, owner);
            assert.equal(calledRepo, repo);
            assert.equal(pull_number, prNumber);
            return { data: { node_id: nodeId } };
          },
        },
      },
      graphql: async (query, variables) => {
        graphqlCalls.push({ query, variables });
        if (graphqlError) throw graphqlError;
        return { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: "2026-07-22T00:00:00Z" } } } };
      },
    };
    const core = {
      info: (message) => infos.push(message),
      warning: (message) => warnings.push(message),
    };
    const execute = new AsyncFunction("github", "core", "require", armingScript);
    await execute(github, core, require);
    return { graphqlCalls, warnings, infos };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

test("arms auto-merge with the target PR's node_id and squash merge method", async () => {
  const { graphqlCalls, infos, warnings } = await runArming();
  assert.equal(graphqlCalls.length, 1);
  assert.equal(graphqlCalls[0].variables.pullRequestId, "PR_kwFoo");
  assert.match(graphqlCalls[0].query, /mergeMethod: SQUASH/u);
  assert.equal(warnings.length, 0);
  assert.ok(infos.some((message) => message.includes("Armed auto-merge")));
});

test("a rejected mutation (e.g. clean-status) is logged and swallowed, not thrown", async () => {
  const { warnings } = await runArming({
    graphqlError: new Error("Pull request is in clean status"),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not arm auto-merge/u);
  assert.match(warnings[0], /clean status/u);
});

test("an unrelated mutation failure is also swallowed rather than failing the run", async () => {
  const { warnings } = await runArming({
    graphqlError: new Error("some other transient GraphQL error"),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not arm auto-merge/u);
});
