"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const workflowPath = path.join(
  __dirname,
  "..",
  "workflows",
  "standards-sync-stuck-automerge-alert.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");

// Same inline-script extraction technique standards-sync-app-attestation.test.cjs
// and standards-sync-automerge-arm.test.cjs use: pull the actions/github-script
// body out of the YAML by name and run it directly.
function extractScanScript() {
  const lines = workflow.split(/\r?\n/u);
  const stepIndex = lines.findIndex((line) =>
    line.includes("- name: Scan targets for stuck armed pull requests"),
  );
  assert.notEqual(stepIndex, -1, "scan step must exist");
  const scriptIndex = lines.findIndex(
    (line, index) => index > stepIndex && /^ {10}script: \|$/u.test(line),
  );
  assert.notEqual(scriptIndex, -1, "scan script block must exist");
  const body = [];
  for (let index = scriptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return body.join("\n");
}

const scanScript = extractScanScript();

function pullRequest({
  number = 1,
  login = "melodic-standards-sync",
  typename = "Bot",
  enabledAt = null,
  mergeStateStatus = "CLEAN",
} = {}) {
  return {
    number,
    url: `https://github.com/melodic-software/dotfiles/pull/${number}`,
    author: { login, __typename: typename },
    autoMergeRequest: enabledAt ? { enabledAt } : null,
    mergeStateStatus,
  };
}

async function runScan({ repoNames = ["dotfiles"], thresholdHours = 4, nodesByRepo = {}, workspace } = {}) {
  const keys = ["BOT_LOGIN", "REPO_NAMES", "THRESHOLD_HOURS", "GITHUB_WORKSPACE"];
  const originalValues = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const effectiveWorkspace = workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "stuck-alert-"));
  Object.assign(process.env, {
    BOT_LOGIN: "melodic-standards-sync",
    REPO_NAMES: repoNames.join(","),
    THRESHOLD_HOURS: String(thresholdHours),
    GITHUB_WORKSPACE: effectiveWorkspace,
  });
  const graphqlCalls = [];
  const outputs = {};
  const infos = [];
  try {
    const github = {
      graphql: async (query, variables) => {
        graphqlCalls.push({ query, variables });
        return {
          repository: {
            pullRequests: { nodes: nodesByRepo[variables.repo] ?? [] },
          },
        };
      },
    };
    const core = {
      setOutput: (key, value) => (outputs[key] = value),
      info: (message) => infos.push(message),
    };
    const execute = new AsyncFunction("github", "core", "require", "process", scanScript);
    await execute(github, core, require, process);
    const reportPath = path.join(effectiveWorkspace, ".stuck-automerge-report.md");
    const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : null;
    return { graphqlCalls, outputs, infos, report };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

test("queries every manifest-derived target repository, not a hardcoded subset", async () => {
  const { graphqlCalls } = await runScan({ repoNames: ["dotfiles", "medley", "ci-runner"] });
  assert.deepEqual(
    graphqlCalls.map((call) => call.variables.repo).sort(),
    ["ci-runner", "dotfiles", "medley"],
  );
  assert.ok(graphqlCalls.every((call) => call.variables.owner === "melodic-software"));
});

test("a PR with no auto-merge armed is not reported, regardless of merge state", async () => {
  const { outputs, report } = await runScan({
    nodesByRepo: { dotfiles: [pullRequest({ enabledAt: null, mergeStateStatus: "BLOCKED" })] },
  });
  assert.equal(outputs["stuck-count"], "0");
  assert.equal(report, null);
});

test("an armed PR that is CLEAN (not BLOCKED) is not reported", async () => {
  const { outputs } = await runScan({
    nodesByRepo: { dotfiles: [pullRequest({ enabledAt: "2020-01-01T00:00:00Z", mergeStateStatus: "CLEAN" })] },
  });
  assert.equal(outputs["stuck-count"], "0");
});

test("an armed, BLOCKED PR younger than the threshold is not reported", async () => {
  const recentlyArmed = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  const { outputs } = await runScan({
    thresholdHours: 4,
    nodesByRepo: { dotfiles: [pullRequest({ enabledAt: recentlyArmed, mergeStateStatus: "BLOCKED" })] },
  });
  assert.equal(outputs["stuck-count"], "0");
});

test("an armed, BLOCKED PR past the threshold is reported with a marker and a recovery section", async () => {
  const staleArmed = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5h ago
  const { outputs, report } = await runScan({
    repoNames: ["dotfiles"],
    thresholdHours: 4,
    nodesByRepo: { dotfiles: [pullRequest({ number: 7, enabledAt: staleArmed, mergeStateStatus: "BLOCKED" })] },
  });
  assert.equal(outputs["stuck-count"], "1");
  assert.match(report, /<!-- ci-workflows:standards-sync-stuck-automerge-alert:v1:active -->/u);
  assert.match(report, /#7/u);
  assert.match(report, /### Recover/u);
});

test("a bot-shaped author with an unrelated login is ignored (exact-login match, not a [bot]-suffix pattern)", async () => {
  const staleArmed = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const { outputs } = await runScan({
    nodesByRepo: {
      dotfiles: [pullRequest({ login: "some-other-app", enabledAt: staleArmed, mergeStateStatus: "BLOCKED" })],
    },
  });
  assert.equal(outputs["stuck-count"], "0");
});

test("a human author impersonating the bot's login string is ignored (__typename must also be Bot)", async () => {
  const staleArmed = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const { outputs } = await runScan({
    nodesByRepo: {
      dotfiles: [
        pullRequest({ login: "melodic-standards-sync", typename: "User", enabledAt: staleArmed, mergeStateStatus: "BLOCKED" }),
      ],
    },
  });
  assert.equal(outputs["stuck-count"], "0");
});

test("multiple stuck PRs across repos are all reported", async () => {
  const staleArmed = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
  const { outputs, report } = await runScan({
    repoNames: ["dotfiles", "medley"],
    nodesByRepo: {
      dotfiles: [pullRequest({ number: 3, enabledAt: staleArmed, mergeStateStatus: "BLOCKED" })],
      medley: [pullRequest({ number: 9, enabledAt: staleArmed, mergeStateStatus: "BLOCKED" })],
    },
  });
  assert.equal(outputs["stuck-count"], "2");
  assert.match(report, /#3/u);
  assert.match(report, /#9/u);
});
