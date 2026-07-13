"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  HOSTS,
  POLL_INTERVAL_MILLISECONDS,
  PRODUCTION_LABEL,
  PROOF_CALLER_WORKFLOW,
  PROOF_REPOSITORY,
  ProofError,
  assertMode,
  fetchTopology,
  listAll,
  runGitHubScript,
  waitForDesktopDrain,
} = require("./production-ha-proof.cjs");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const workflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "production-ha-proof.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");
const readme = fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8");
const templateRoot = path.join(repositoryRoot, "templates", "ci-runner-canary");
const templateWorkflowPath = path.join(
  templateRoot,
  ".github",
  "workflows",
  "production-ha-proof.yml",
);
const templateWorkflow = fs.readFileSync(templateWorkflowPath, "utf8");
const templateReadme = fs.readFileSync(
  path.join(templateRoot, "README.md"),
  "utf8",
);
const implementationSha = "169e3a4287211a536eddcd3a757dd06132fb556e";

function jobBlock(jobId) {
  const start = workflow.indexOf(`  ${jobId}:\n`);
  assert.notEqual(start, -1, `missing job ${jobId}`);
  const afterFirstLine = workflow.indexOf("\n", start) + 1;
  const nextJob = /^ {2}[a-z][a-z0-9-]*:$/gmu;
  nextJob.lastIndex = afterFirstLine;
  const next = nextJob.exec(workflow);
  return workflow.slice(start, next ? next.index : undefined);
}

function jobHeader(jobId) {
  const block = jobBlock(jobId);
  const boundaries = ["\n    steps:", "\n    uses:"]
    .map((marker) => block.indexOf(marker))
    .filter((index) => index >= 0);
  return block.slice(
    0,
    boundaries.length === 0 ? undefined : Math.min(...boundaries),
  );
}

const preflightBlock = jobBlock("preflight");
const preflightRunMarker = "        run: |\n";
const preflightRunStart =
  preflightBlock.indexOf(preflightRunMarker) + preflightRunMarker.length;
const preflightScript = preflightBlock
  .slice(preflightRunStart)
  .split("\n")
  .map((line) => line.replace(/^ {10}/u, ""))
  .join("\n");

function runPreflight(overrides = {}) {
  return spawnSync(process.env.BASH_PATH || "bash", ["-c", preflightScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ARTIFACT_RETENTION_DAYS: "3",
      CALLER_WORKFLOW_REF: PROOF_CALLER_WORKFLOW,
      DRAIN_WAIT_MINUTES: "20",
      EVENT_NAME: "workflow_dispatch",
      EXPECTED_CALLER_WORKFLOW_REF: PROOF_CALLER_WORKFLOW,
      EXPECTED_REPOSITORY: PROOF_REPOSITORY,
      LAPTOP_PROOF_MINUTES: "20",
      MODE: "inventory",
      OBSERVER_CLIENT_ID: "Iv23observer",
      REF_PROTECTED: "true",
      REPOSITORY: PROOF_REPOSITORY,
      REPOSITORY_PRIVATE: "true",
      RUN_ATTEMPT: "1",
      SOURCE_REF: "refs/heads/main",
      ...overrides,
    },
  });
}

function group(host, id) {
  return {
    id,
    name: host.group,
    visibility: "selected",
    default: false,
    inherited: false,
    allows_public_repositories: false,
    restricted_to_workflows: false,
    selected_workflows: [],
  };
}

function repository(id, name) {
  return {
    id,
    name,
    full_name: `melodic-software/${name}`,
    private: true,
  };
}

function runner(host, id, overrides = {}) {
  return {
    id,
    name: `${host.runnerPrefix}job-${id}`,
    os: "unknown",
    status: "online",
    busy: false,
    labels: [{ name: PRODUCTION_LABEL }],
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    groups: [group(HOSTS[0], 101), group(HOSTS[1], 202)],
    repositories: {
      101: [repository(11, "ci-runner-canary"), repository(12, "medley")],
      202: [repository(11, "ci-runner-canary"), repository(12, "medley")],
    },
    runners: {
      101: [runner(HOSTS[0], 1001)],
      202: [runner(HOSTS[1], 2001)],
    },
    ...overrides,
  };
}

function response(key, items) {
  return { data: { total_count: items.length, [key]: items } };
}

function requestForStates(states, calls = []) {
  let stateIndex = -1;
  let current;
  return async (route, parameters) => {
    calls.push({ route, parameters });
    if (route === "GET /orgs/{org}/actions/runner-groups") {
      stateIndex += 1;
      current = states[Math.min(stateIndex, states.length - 1)];
      return response("runner_groups", current.groups);
    }
    if (
      route ===
      "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories"
    ) {
      return response(
        "repositories",
        current.repositories[parameters.runner_group_id],
      );
    }
    if (
      route ===
      "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/runners"
    ) {
      return response("runners", current.runners[parameters.runner_group_id]);
    }
    throw new Error(`unexpected route ${route}`);
  };
}

function tempEvidenceEnvironment(overrides = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "production-ha-proof-"),
  );
  return {
    directory,
    env: {
      EVIDENCE_PATH: path.join(directory, "evidence.json"),
      GITHUB_STEP_SUMMARY: path.join(directory, "summary.md"),
      MODE: "inventory",
      PHASE: "inventory",
      RUN_ATTEMPT: "1",
      RUN_ID: "123456",
      RUN_URL:
        "https://github.com/melodic-software/ci-runner-canary/actions/runs/123456",
      ...overrides,
    },
  };
}

test("proof constants freeze the production topology and exact caller", () => {
  assert.equal(PRODUCTION_LABEL, "melodic-ubuntu-24.04-x64");
  assert.equal(PROOF_REPOSITORY, "melodic-software/ci-runner-canary");
  assert.equal(
    PROOF_CALLER_WORKFLOW,
    "melodic-software/ci-runner-canary/.github/workflows/production-ha-proof.yml@refs/heads/main",
  );
  assert.deepEqual(
    HOSTS.map(({ id, group, runnerPrefix }) => ({ id, group, runnerPrefix })),
    [
      {
        id: "melo-desk-001",
        group: "ci-local-melo-desk-001",
        runnerPrefix: "ci-runner-melo-desk-001-",
      },
      {
        id: "melo-lap-001",
        group: "ci-local-melo-lap-001",
        runnerPrefix: "ci-runner-melo-lap-001-",
      },
    ],
  );
});

test("inventory proves independent groups, identical private access, and both idle", async () => {
  const calls = [];
  const topology = await fetchTopology(requestForStates([state()], calls));
  const expected = assertMode(topology, "inventory");
  assert.deepEqual(expected, {
    "melo-desk-001": "idle",
    "melo-lap-001": "idle",
  });
  assert.deepEqual(
    topology.groups.map(({ group: item }) => item.id),
    [101, 202],
  );
  assert.deepEqual(
    topology.groups[0].selectedRepositories,
    topology.groups[1].selectedRepositories,
  );
  assert.ok(
    topology.groups[0].selectedRepositories.some(
      ({ fullName }) => fullName === PROOF_REPOSITORY,
    ),
  );
  assert.ok(calls.every(({ route }) => route.startsWith("GET ")));
  assert.ok(
    calls.every(
      ({ parameters }) =>
        parameters.headers["X-GitHub-Api-Version"] === "2026-03-10",
    ),
  );
});

test("REST collection pagination is complete and versioned", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
  }));
  const items = await listAll(
    async (route, parameters) => {
      calls.push({ route, parameters });
      return {
        data: {
          total_count: 101,
          repositories: parameters.page === 1 ? firstPage : [{ id: 101 }],
        },
      };
    },
    "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories",
    { org: "melodic-software", runner_group_id: 101 },
    "repositories",
  );
  assert.equal(items.length, 101);
  assert.deepEqual(
    calls.map(({ parameters }) => parameters.page),
    [1, 2],
  );
  assert.ok(
    calls.every(
      ({ parameters }) =>
        parameters.headers["X-GitHub-Api-Version"] === "2026-03-10",
    ),
  );
});

test("mode assertions encode both single-host preparations", async () => {
  const desktopOnly = state({
    runners: { 101: [runner(HOSTS[0], 1001)], 202: [] },
  });
  const laptopOnly = state({
    runners: { 101: [], 202: [runner(HOSTS[1], 2001)] },
  });
  assert.deepEqual(
    assertMode(
      await fetchTopology(requestForStates([desktopOnly])),
      "desktop-only",
    ),
    { "melo-desk-001": "idle", "melo-lap-001": "drained" },
  );
  for (const mode of ["laptop-only", "laptop-power"]) {
    assert.deepEqual(
      assertMode(await fetchTopology(requestForStates([laptopOnly])), mode),
      { "melo-desk-001": "drained", "melo-lap-001": "idle" },
    );
  }
});

test("mode assertions fail closed when the requested host state is absent", async () => {
  const topology = await fetchTopology(requestForStates([state()]));
  for (const mode of ["desktop-only", "laptop-only", "laptop-power"]) {
    assert.throws(
      () => assertMode(topology, mode),
      (error) =>
        error instanceof ProofError && error.code === "topology-not-ready",
    );
  }
});

test("group policy rejects public, inherited, default, and workflow-restricted state", async () => {
  const mutations = [
    (item) => {
      item.groups[0].visibility = "all";
    },
    (item) => {
      item.groups[0].allows_public_repositories = true;
    },
    (item) => {
      item.groups[0].inherited = true;
    },
    (item) => {
      item.groups[0].default = true;
    },
    (item) => {
      item.groups[0].restricted_to_workflows = true;
      item.groups[0].selected_workflows = [PROOF_CALLER_WORKFLOW];
    },
  ];
  for (const mutate of mutations) {
    const fixture = state();
    mutate(fixture);
    await assert.rejects(
      () => fetchTopology(requestForStates([fixture])),
      (error) =>
        error instanceof ProofError && error.code === "invalid-response",
    );
  }
});

test("selected repository access must be identical, private, and include the proof repo", async () => {
  const fixtures = [state(), state(), state()];
  fixtures[0].repositories[202] = [repository(11, "ci-runner-canary")];
  fixtures[1].repositories[101][0].private = false;
  fixtures[2].repositories[101] = [repository(12, "medley")];
  fixtures[2].repositories[202] = [repository(12, "medley")];
  for (const fixture of fixtures) {
    await assert.rejects(
      () => fetchTopology(requestForStates([fixture])),
      (error) =>
        error instanceof ProofError && error.code === "invalid-response",
    );
  }
});

test("group runner membership rejects namespace, OS, label, and persistence drift", async () => {
  const runnerMutations = [
    { name: "ci-runner-melo-lap-001-wrong-group" },
    { os: "windows" },
    { labels: [{ name: "unrelated" }] },
    { ephemeral: false },
    { busy: "false" },
  ];
  for (const mutation of runnerMutations) {
    const fixture = state();
    fixture.runners[101] = [runner(HOSTS[0], 1001, mutation)];
    await assert.rejects(
      () => fetchTopology(requestForStates([fixture])),
      (error) =>
        error instanceof ProofError && error.code === "invalid-response",
    );
  }
});

test("omitted ephemeral and case-normalized Linux inventory remain accepted", async () => {
  const fixture = state();
  fixture.runners[101] = [
    runner(HOSTS[0], 1001, {
      os: "LiNuX",
      labels: [{ name: PRODUCTION_LABEL.toUpperCase() }],
    }),
  ];
  const topology = await fetchTopology(requestForStates([fixture]));
  assert.equal(topology.groups[0].runners[0].ephemeral, null);
  assert.equal(topology.groups[0].runners[0].os, "linux");
});

test("duplicate group and cross-group runner IDs fail closed", async () => {
  const duplicateGroup = state();
  duplicateGroup.groups[1].id = 101;
  const duplicateRunner = state();
  duplicateRunner.runners[202][0].id = 1001;
  for (const fixture of [duplicateGroup, duplicateRunner]) {
    await assert.rejects(
      () => fetchTopology(requestForStates([fixture])),
      (error) =>
        error instanceof ProofError && error.code === "invalid-response",
    );
  }
});

test("hosted hold waits for two stable observations after selection", async () => {
  const both = state();
  const drained = state({
    runners: { 101: [], 202: [runner(HOSTS[1], 2001)] },
  });
  let time = Date.parse("2026-07-11T12:00:00Z");
  const sleeps = [];
  const observations = [];
  const calls = [];
  const result = await waitForDesktopDrain({
    request: requestForStates([both, drained, drained], calls),
    maxWaitMinutes: 5,
    now: () => time,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      time += milliseconds;
    },
    onObservation: (item) => observations.push(item),
  });
  assert.equal(result.observations.length, 3);
  assert.equal(observations.at(-1).desktopOnline, 0);
  assert.equal(observations.at(-1).laptopIdle, 1);
  assert.deepEqual(sleeps, [
    POLL_INTERVAL_MILLISECONDS,
    POLL_INTERVAL_MILLISECONDS,
  ]);
  assert.ok(calls.every(({ route }) => route.startsWith("GET ")));
});

test("hosted hold times out without controlling or replaying work", async () => {
  let time = Date.parse("2026-07-11T12:00:00Z");
  await assert.rejects(
    () =>
      waitForDesktopDrain({
        request: requestForStates([state()]),
        maxWaitMinutes: 5,
        now: () => time,
        sleep: async (milliseconds) => {
          time += milliseconds;
        },
      }),
    (error) =>
      error instanceof ProofError &&
      error.code === "drain-timeout" &&
      error.evidence.observations.length > 1,
  );
});

test("GitHub-script inventory writes sanitized explicit limitations", async (t) => {
  const { directory, env } = tempEvidenceEnvironment();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outputs = new Map();
  await runGitHubScript({
    github: { request: requestForStates([state()]) },
    core: {
      setOutput: (name, value) => outputs.set(name, value),
      info: () => {},
    },
    env,
    now: () => Date.parse("2026-07-11T12:00:00Z"),
  });
  const evidence = JSON.parse(fs.readFileSync(env.EVIDENCE_PATH, "utf8"));
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.limitations.restGroupIdIsScaleSetId, false);
  assert.equal(evidence.limitations.scaleSetIdObserved, false);
  assert.equal(evidence.limitations.controllerCapacityObserved, false);
  assert.equal(evidence.limitations.batteryOrLogonStateObserved, false);
  assert.equal(outputs.get("desktop-idle"), "1");
  assert.equal(outputs.get("laptop-idle"), "1");
  assert.doesNotMatch(JSON.stringify(evidence), /token|private[-_ ]key/iu);
});

test("GitHub-script failures preserve only sanitized evidence", async (t) => {
  const { directory, env } = tempEvidenceEnvironment();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      runGitHubScript({
        github: {
          request: async () => {
            throw Object.assign(new Error("secret response body"), {
              status: 403,
            });
          },
        },
        core: { setOutput: () => {}, info: () => {} },
        env,
      }),
    (error) => error instanceof ProofError && error.code === "api-error",
  );
  const evidence = fs.readFileSync(env.EVIDENCE_PATH, "utf8");
  assert.match(
    evidence,
    /GitHub read-only inventory request failed \(HTTP 403\)/u,
  );
  assert.doesNotMatch(evidence, /secret response body/u);
});

test("workflow is reusable-only and binds the exact private caller before secret use", () => {
  assert.match(workflow, /^ {2}workflow_call:/mu);
  assert.doesNotMatch(
    workflow,
    /^ {2}(workflow_dispatch|push|pull_request):/mu,
  );
  const preflight = workflow.slice(
    workflow.indexOf("  preflight:"),
    workflow.indexOf("  inventory:"),
  );
  for (const contract of [
    "github.workflow_ref",
    PROOF_CALLER_WORKFLOW,
    "github.event.repository.private",
    "github.ref_protected",
    "refs/heads/main",
    "github.run_attempt",
    "workflow_dispatch",
  ]) {
    assert.ok(preflight.includes(contract), contract);
  }
  const tokenStep = workflow.indexOf("Mint read-only observer token");
  assert.ok(tokenStep > workflow.indexOf("  inventory:"));
});

test("preflight rejects an unprotected main ref and every rerun attempt", () => {
  const accepted = runPreflight();
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);

  for (const overrides of [
    { REF_PROTECTED: "false" },
    { REF_PROTECTED: "" },
    { RUN_ATTEMPT: "2" },
  ]) {
    const rejected = runPreflight(overrides);
    assert.notEqual(
      rejected.status,
      0,
      `preflight accepted ${JSON.stringify(overrides)}`,
    );
  }
});

test("every routed or evidence-producing job independently rejects reruns", () => {
  for (const jobId of [
    "inventory",
    "select-production-runner",
    "validate-selection",
    "failover-hold",
    "production-execution",
  ]) {
    assert.match(
      jobHeader(jobId),
      /github\.run_attempt == 1/u,
      `${jobId} can reuse attempt-1 outputs during a specific-job rerun`,
    );
  }
});

test("production execution is cancellation-aware while allowing a skipped hold", () => {
  const header = jobHeader("production-execution");
  assert.match(header, /\$\{\{ !cancelled\(\) &&/u);
  assert.doesNotMatch(header, /always\(\)/u);
  assert.match(
    header,
    /\(inputs\.mode != 'failover' \|\| needs\.failover-hold\.result == 'success'\)/u,
  );
});

test("inventory and control stay hosted while execution consumes only selector output", () => {
  for (const job of [
    "preflight",
    "inventory",
    "validate-selection",
    "failover-hold",
  ]) {
    assert.match(
      workflow,
      new RegExp(`^  ${job}:[\\s\\S]*?^    runs-on: ubuntu-24\\.04$`, "mu"),
      job,
    );
  }
  const execution = workflow.slice(workflow.indexOf("  production-execution:"));
  assert.match(
    execution,
    /runs-on: \$\{\{ needs\.select-production-runner\.outputs\.runner \}\}/u,
  );
  assert.doesNotMatch(workflow, /runs-on:\s+melodic-ubuntu-24\.04-x64/u);
  assert.match(workflow, /self-hosted-label: melodic-ubuntu-24\.04-x64/u);
  assert.match(workflow, /managed-runner-prefix: ci-runner-melo-/u);
  assert.match(
    workflow,
    /select-runner\.yml@3415de3ff2fafee40e4d087eb6073d2f6952b595/u,
  );
});

test("observer secret is explicit and every API contract remains read-only", () => {
  assert.doesNotMatch(workflow, /secrets:\s+inherit/u);
  assert.match(
    workflow,
    /observer-private-key: \$\{\{ secrets\.observer-private-key \}\}/u,
  );
  assert.equal(
    [
      ...workflow.matchAll(
        /permission-organization-self-hosted-runners: read/gu,
      ),
    ].length,
    2,
  );
  assert.equal(
    [...workflow.matchAll(/repositories: ci-runner-canary/gu)].length,
    2,
  );
  assert.doesNotMatch(
    workflow,
    /permission-organization-self-hosted-runners: write/u,
  );
  assert.doesNotMatch(
    workflow,
    /\b(?:POST|PUT|PATCH|DELETE) \/(?:orgs|repos)\//u,
  );
  assert.doesNotMatch(workflow, /\/(?:cancel|rerun)(?:\b|\/)/u);
  assert.doesNotMatch(workflow, /\bgh (?:api|run)\b/u);
});

test("failover selector precedes a hosted observation hold and laptop assertion", () => {
  const hold = workflow.slice(
    workflow.indexOf("  failover-hold:"),
    workflow.indexOf("  production-execution:"),
  );
  assert.match(
    hold,
    /needs: \[inventory, select-production-runner, validate-selection\]/u,
  );
  assert.match(hold, /ci-runner host disable --wait/u);
  assert.match(hold, /It never drains, cancels, or replays work/u);
  const execution = workflow.slice(workflow.indexOf("  production-execution:"));
  assert.match(execution, /needs\.failover-hold\.result == 'success'/u);
  assert.match(execution, /ci-runner-melo-lap-001-\*/u);
  assert.match(execution, /RUNNER_OS.*runner\.os/su);
  assert.match(execution, /RUNNER_ARCH.*runner\.arch/su);
});

test("laptop power mode records UTC heartbeats without claiming controller evidence", () => {
  assert.match(workflow, /Record laptop power-survival heartbeats/u);
  assert.match(workflow, /production-ha-laptop-heartbeats\.jsonl/u);
  assert.match(workflow, /date -u \+%Y-%m-%dT%H:%M:%SZ/u);
  assert.match(workflow, /sleep_for=15/u);
  assert.match(
    workflow,
    /Correlate its UTC heartbeats with external controller status and Windows power evidence/u,
  );
  assert.doesNotMatch(
    workflow,
    /heartbeats prove (?:battery|capacity|logon)/iu,
  );
});

test("documentation preserves the REST and physical-evidence boundaries with official citations", () => {
  assert.match(readme, /response contains no scale-set ID/u);
  assert.match(readme, /controller status\/logs and Windows power\s+evidence/u);
  assert.match(readme, /A workflow\s+cannot prove the negative condition/u);
  assert.match(
    readme,
    /\[runner-group-rest\]: https:\/\/docs\.github\.com\/en\/rest\/actions\/self-hosted-runner-groups\?apiVersion=2026-03-10/u,
  );
  assert.match(
    readme,
    /\[runner-scale-set-ha\]: https:\/\/docs\.github\.com\/en\/actions\/how-tos\/manage-runners\/use-actions-runner-controller\/deploy-runner-scale-sets#high-availability-and-automatic-failover/u,
  );
});

test("every external action is immutable with a reviewable release comment", () => {
  const uses = [
    ...workflow.matchAll(/^\s+uses: ([^\s@]+)@([^\s]+)(?:\s+#\s+(.+))?$/gmu),
  ];
  assert.ok(uses.length > 0);
  for (const [, action, ref, comment] of uses) {
    assert.match(ref, /^[0-9a-f]{40}$/u, `${action} is not immutable`);
    if (action.endsWith("/.github/workflows/select-runner.yml")) {
      assert.equal(comment, "governed selector review");
    } else {
      assert.match(comment ?? "", /^v\d+\.\d+\.\d+$/u, action);
    }
  }
});

test("generated workflow bundles match the single tested implementation", () => {
  const renderer = path.join(
    __dirname,
    "render-production-ha-proof-workflow.cjs",
  );
  const result = spawnSync(process.execPath, [renderer, "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    [
      ...workflow.matchAll(
        /Source: \.github\/scripts\/production-ha-proof\.cjs/gu,
      ),
    ].length,
    2,
  );
});

test("private production caller pins the corrected immutable implementation", () => {
  assert.match(templateWorkflow, /^ {2}workflow_dispatch:/mu);
  assert.doesNotMatch(
    templateWorkflow,
    /^ {2}(?:push|pull_request|pull_request_target|schedule):/mu,
  );
  assert.match(
    templateWorkflow,
    new RegExp(
      `uses: melodic-software/ci-workflows/\\.github/workflows/production-ha-proof\\.yml@${implementationSha} # reviewed production HA contract`,
      "u",
    ),
  );
  assert.match(
    templateWorkflow,
    /observer-client-id: \$\{\{ vars\.CI_RUNNER_OBSERVER_CLIENT_ID \}\}/u,
  );
  assert.match(
    templateWorkflow,
    /observer-private-key: \$\{\{ secrets\.CI_RUNNER_OBSERVER_PRIVATE_KEY \}\}/u,
  );
  assert.doesNotMatch(templateWorkflow, /secrets:\s+inherit/u);
  assert.doesNotMatch(templateWorkflow, /melodic-ubuntu-24\.04-x64/u);
  assert.doesNotMatch(templateWorkflow, /ci-runner-melo-/u);
  assert.match(
    templateWorkflow,
    /options: \[inventory, desktop-only, laptop-only, failover, laptop-power\]/u,
  );
  assert.match(
    templateWorkflow,
    /drain-wait-minutes: \$\{\{ fromJSON\(inputs\.drain-wait-minutes\) \}\}/u,
  );
  assert.match(
    templateWorkflow,
    /laptop-proof-minutes: \$\{\{ fromJSON\(inputs\.laptop-proof-minutes\) \}\}/u,
  );
});

test("pinned reusable commit contains the exact caller and selector contracts", () => {
  const pinned = spawnSync(
    "git",
    ["show", `${implementationSha}:.github/workflows/production-ha-proof.yml`],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.match(pinned.stdout, new RegExp(PROOF_CALLER_WORKFLOW, "u"));
  assert.match(
    pinned.stdout,
    /select-runner\.yml@3415de3ff2fafee40e4d087eb6073d2f6952b595/u,
  );
  assert.match(
    pinned.stdout,
    /runs-on: \$\{\{ needs\.select-production-runner\.outputs\.runner \}\}/u,
  );
  assert.match(
    pinned.stdout,
    /REF_PROTECTED: \$\{\{ github\.ref_protected \}\}/u,
  );
  assert.match(pinned.stdout, /\$\{\{ !cancelled\(\) &&/u);
  assert.equal(
    [...pinned.stdout.matchAll(/repositories: ci-runner-canary/gu)].length,
    2,
  );
  assert.doesNotMatch(pinned.stdout, /runs-on:\s+melodic-ubuntu-24\.04-x64/u);
});

test("bootstrap stages the exact production caller without committing or pushing", () => {
  const bootstrap = fs.readFileSync(
    path.join(templateRoot, "bootstrap.ps1"),
    "utf8",
  );
  assert.match(bootstrap, /'\.github\/workflows\/production-ha-proof\.yml'/u);
  assert.doesNotMatch(bootstrap, /ArgumentList[^\n]*(?:'commit'|'push')/u);
});

test("operator runbook requires external scale-set, capacity, and battery evidence", () => {
  for (const mode of [
    "inventory",
    "desktop-only",
    "laptop-only",
    "failover",
    "laptop-power",
  ]) {
    assert.match(templateReadme, new RegExp(`\`${mode}\``, "u"));
  }
  for (const evidence of [
    "pools[].scaleSetId",
    "pools[].listenerId",
    "pools[].maxCapacity",
    "pools[].capacityAcknowledged",
    "power.acConnected=false",
    "Fresh-logon-on-battery",
    "docker desktop status",
    "docker info",
  ]) {
    assert.ok(templateReadme.includes(evidence), evidence);
  }
  assert.match(templateReadme, /do not report listener capacity/u);
  assert.match(templateReadme, /Heartbeats prove only/u);
  assert.match(
    templateReadme,
    /workflow cannot run\s+on the runner whose absence it must prove/u,
  );
  assert.match(templateReadme, /Never use \*\*Re-run jobs\*\*/u);
});
