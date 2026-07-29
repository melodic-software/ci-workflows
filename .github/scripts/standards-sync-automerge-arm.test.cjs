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
    line.includes("- name: Arm auto-merge on the sync PR"),
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

test("the arming step runs for any existing sync PR, gated on matrix.automerge", () => {
  const stepIndex = workflow
    .split(/\r?\n/u)
    .findIndex((line) =>
      line.includes("- name: Arm auto-merge on the sync PR"),
    );
  const ifLine = workflow.split(/\r?\n/u)[stepIndex + 1];
  // Keyed on the PR existing, NOT on `pull-request-operation == 'created'`: a
  // PR opened while the target was opted out must still be armed once the
  // opt-out lifts, and every later sync reports `updated` or `none`.
  assert.match(ifLine, /pull-request-number != ''/u);
  assert.doesNotMatch(ifLine, /pull-request-operation/u);
  assert.match(ifLine, /matrix\.automerge/u);
});

test("the arming step uses the target-scoped App token, not the caller's default token", () => {
  const stepIndex = workflow
    .split(/\r?\n/u)
    .findIndex((line) =>
      line.includes("- name: Arm auto-merge on the sync PR"),
    );
  const block = workflow
    .split(/\r?\n/u)
    .slice(stepIndex, stepIndex + 10)
    .join("\n");
  assert.match(
    block,
    /github-token: \$\{\{ steps\.token\.outputs\.token \}\}/u,
  );
});

async function runArming({
  owner = "melodic-software",
  repo = "dotfiles",
  prNumber = 42,
  nodeId = "PR_kwFoo",
  pullRequest = {},
  missingPullRequest = false,
  graphqlError,
} = {}) {
  const keys = ["OWNER", "REPO", "PR_NUMBER"];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    OWNER: owner,
    REPO: repo,
    PR_NUMBER: String(prNumber),
  });
  const graphqlCalls = [];
  const warnings = [];
  const infos = [];
  try {
    const github = {
      graphql: async (query, variables) => {
        graphqlCalls.push({ query, variables });
        // The step reads the PR's id and arming history in one query, then
        // mutates; the mock discriminates on which shape it was handed.
        if (/enablePullRequestAutoMerge/u.test(query)) {
          if (graphqlError) throw graphqlError;
          return {
            enablePullRequestAutoMerge: {
              pullRequest: {
                autoMergeRequest: { enabledAt: "2026-07-22T00:00:00Z" },
              },
            },
          };
        }
        assert.equal(variables.owner, owner);
        assert.equal(variables.repo, repo);
        assert.equal(variables.number, prNumber);
        if (missingPullRequest) return { repository: { pullRequest: null } };
        return {
          repository: {
            pullRequest: {
              id: nodeId,
              autoMergeRequest: pullRequest.autoMergeRequest ?? null,
              timelineItems: {
                totalCount: pullRequest.armedEventCount ?? 0,
              },
            },
          },
        };
      },
    };
    const core = {
      info: (message) => infos.push(message),
      warning: (message) => warnings.push(message),
    };
    const execute = new AsyncFunction(
      "github",
      "core",
      "require",
      armingScript,
    );
    await execute(github, core, require);
    return { graphqlCalls, warnings, infos };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

test("arms auto-merge with the target PR's node id and squash merge method", async () => {
  const { graphqlCalls, infos, warnings } = await runArming();
  const mutation = graphqlCalls.at(-1);
  assert.equal(mutation.variables.pullRequestId, "PR_kwFoo");
  assert.match(mutation.query, /mergeMethod: SQUASH/u);
  assert.equal(warnings.length, 0);
  assert.ok(infos.some((message) => message.includes("Armed auto-merge")));
});

test("a PR that is currently armed is left alone", async () => {
  const { graphqlCalls, infos, warnings } = await runArming({
    pullRequest: { autoMergeRequest: { enabledAt: "2026-07-22T00:00:00Z" } },
  });
  assert.equal(
    graphqlCalls.filter((call) =>
      /enablePullRequestAutoMerge/u.test(call.query),
    ).length,
    0,
  );
  assert.equal(warnings.length, 0);
  assert.ok(infos.some((message) => message.includes("already armed")));
});

test("a PR that was armed and then disarmed is never re-armed", async () => {
  // The whole reason arming keys on history rather than current state: a
  // reviewer who disarms a sync PR to hold it back must not be overridden on
  // the next sync, and GitHub's own auto-disable must not be fought either.
  const { graphqlCalls, warnings } = await runArming({
    pullRequest: { armedEventCount: 1 },
  });
  assert.equal(
    graphqlCalls.filter((call) =>
      /enablePullRequestAutoMerge/u.test(call.query),
    ).length,
    0,
  );
  assert.equal(warnings.length, 0);
});

test("an unreadable pull request warns and does not attempt the mutation", async () => {
  const { graphqlCalls, warnings } = await runArming({
    missingPullRequest: true,
  });
  assert.equal(
    graphqlCalls.filter((call) =>
      /enablePullRequestAutoMerge/u.test(call.query),
    ).length,
    0,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not read/u);
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
