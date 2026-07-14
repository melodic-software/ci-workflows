"use strict";

const fs = require("node:fs");

const API_VERSION = "2026-03-10";
const ORGANIZATION = "melodic-software";
const PROOF_REPOSITORY = "melodic-software/ci-runner-canary";
const PROOF_CALLER_WORKFLOW =
  "melodic-software/ci-runner-canary/.github/workflows/production-ha-proof.yml@refs/heads/main";
const PRODUCTION_LABEL = "melodic-ubuntu-24.04-x64";
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const POLL_INTERVAL_MILLISECONDS = 15_000;
const REQUIRED_STABLE_DRAIN_OBSERVATIONS = 2;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/u;
const ACCEPTED_RUNNER_OSES = new Set(["linux", "unknown"]);
const ACCEPTED_MODES = new Set([
  "inventory",
  "desktop-only",
  "laptop-only",
  "failover",
  "laptop-power",
]);
const HOSTS = Object.freeze([
  Object.freeze({
    id: "melo-desk-001",
    group: "ci-local-melo-desk-001",
    runnerPrefix: "ci-runner-melo-desk-001-",
  }),
  Object.freeze({
    id: "melo-lap-001",
    group: "ci-local-melo-lap-001",
    runnerPrefix: "ci-runner-melo-lap-001-",
  }),
]);

class ProofError extends Error {
  constructor(code, message, evidence = undefined) {
    super(message);
    this.name = "ProofError";
    this.code = code;
    this.evidence = evidence;
  }
}

function invalid(message) {
  throw new ProofError("invalid-response", message);
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid(`${field} must be a positive integer`);
  }
  return value;
}

function assertSafeString(value, field, pattern = SAFE_NAME) {
  if (typeof value !== "string" || !pattern.test(value)) {
    invalid(`${field} is malformed`);
  }
  return value;
}

function apiFailure(error) {
  if (error instanceof ProofError) {
    return error;
  }
  const status = Number.isInteger(error?.status)
    ? String(error.status)
    : "unknown";
  return new ProofError(
    "api-error",
    `GitHub read-only inventory request failed (HTTP ${status})`,
  );
}

async function listAll(request, route, parameters, collectionKey) {
  const collected = [];
  let expectedTotal;
  let page = 1;

  while (true) {
    let response;
    try {
      response = await request(route, {
        ...parameters,
        page,
        per_page: PAGE_SIZE,
        headers: {
          accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
        },
        request: { timeout: REQUEST_TIMEOUT_MILLISECONDS },
      });
    } catch (error) {
      throw apiFailure(error);
    }

    const data = response?.data;
    if (
      !data ||
      !Number.isSafeInteger(data.total_count) ||
      data.total_count < 0 ||
      !Array.isArray(data[collectionKey])
    ) {
      invalid(`${collectionKey} response is malformed`);
    }
    if (expectedTotal === undefined) {
      expectedTotal = data.total_count;
    } else if (data.total_count !== expectedTotal) {
      invalid(`${collectionKey} total_count changed during pagination`);
    }

    const pageItems = data[collectionKey];
    collected.push(...pageItems);
    if (collected.length > expectedTotal) {
      invalid(`${collectionKey} pagination exceeded total_count`);
    }
    if (collected.length === expectedTotal) {
      break;
    }
    if (pageItems.length === 0 || pageItems.length > PAGE_SIZE) {
      invalid(`${collectionKey} pagination ended before total_count`);
    }
    page += 1;
    if (page > Math.ceil(expectedTotal / PAGE_SIZE) + 1) {
      invalid(`${collectionKey} pagination did not converge`);
    }
  }

  return collected;
}

function validateGroup(group, host) {
  if (!group || typeof group !== "object" || Array.isArray(group)) {
    invalid(`${host.group} group is malformed`);
  }
  assertPositiveInteger(group.id, `${host.group}.id`);
  if (group.name !== host.group) {
    invalid(`${host.group} name changed during validation`);
  }
  if (group.visibility !== "selected") {
    invalid(`${host.group} must use selected repository visibility`);
  }
  if (group.default !== false || group.inherited !== false) {
    invalid(`${host.group} must be independent, nondefault organization state`);
  }
  if (group.allows_public_repositories !== false) {
    invalid(`${host.group} must forbid public repositories`);
  }
  if (group.restricted_to_workflows !== false) {
    invalid(
      `${host.group} must leave group-wide workflow restriction disabled`,
    );
  }
  if (
    !Array.isArray(group.selected_workflows) ||
    group.selected_workflows.length !== 0
  ) {
    invalid(`${host.group} selected_workflows must be empty`);
  }
}

function validateRepository(repository, groupName) {
  if (
    !repository ||
    typeof repository !== "object" ||
    Array.isArray(repository)
  ) {
    invalid(`${groupName} repository entry is malformed`);
  }
  const id = assertPositiveInteger(repository.id, `${groupName}.repository.id`);
  const name = assertSafeString(
    repository.name,
    `${groupName}.repository.name`,
  );
  const fullName = assertSafeString(
    repository.full_name,
    `${groupName}.repository.full_name`,
    /^melodic-software\/[A-Za-z0-9._-]{1,100}$/u,
  );
  if (fullName !== `${ORGANIZATION}/${name}`) {
    invalid(`${groupName} repository name and full_name disagree`);
  }
  if (repository.private !== true) {
    invalid(`${groupName} exposes a nonprivate repository`);
  }
  return Object.freeze({ id, fullName, private: true });
}

function validateRunner(runner, host) {
  if (!runner || typeof runner !== "object" || Array.isArray(runner)) {
    invalid(`${host.group} runner entry is malformed`);
  }
  const id = assertPositiveInteger(runner.id, `${host.group}.runner.id`);
  const name = assertSafeString(runner.name, `${host.group}.runner.name`);
  if (!name.startsWith(host.runnerPrefix)) {
    invalid(`${host.group} contains a runner outside ${host.runnerPrefix}`);
  }
  const os = assertSafeString(
    runner.os,
    `${host.group}.runner.os`,
    /^[A-Za-z]+$/u,
  ).toLowerCase();
  if (!ACCEPTED_RUNNER_OSES.has(os)) {
    invalid(
      `${host.group} contains a runner outside the Linux/JIT-unknown contract`,
    );
  }
  if (runner.status !== "online" && runner.status !== "offline") {
    invalid(`${host.group}.runner.status is malformed`);
  }
  if (typeof runner.busy !== "boolean") {
    invalid(`${host.group}.runner.busy is malformed`);
  }
  if (
    Object.hasOwn(runner, "ephemeral") &&
    typeof runner.ephemeral !== "boolean"
  ) {
    invalid(`${host.group}.runner.ephemeral is malformed`);
  }
  if (runner.ephemeral === false) {
    invalid(`${host.group} contains an explicitly persistent runner`);
  }
  if (!Array.isArray(runner.labels) || runner.labels.length === 0) {
    invalid(`${host.group}.runner.labels is malformed`);
  }

  const labels = [];
  const labelKeys = new Set();
  for (const label of runner.labels) {
    if (!label || typeof label !== "object" || Array.isArray(label)) {
      invalid(`${host.group}.runner.labels contains a malformed label`);
    }
    const labelName = assertSafeString(
      label.name,
      `${host.group}.runner.label.name`,
    );
    const key = labelName.toLowerCase();
    if (!labelKeys.has(key)) {
      labelKeys.add(key);
      labels.push(labelName);
    }
  }
  if (!labelKeys.has(PRODUCTION_LABEL.toLowerCase())) {
    invalid(
      `${host.group} contains a runner without the production routing label`,
    );
  }

  labels.sort((left, right) => left.localeCompare(right, "en"));
  return Object.freeze({
    id,
    name,
    os,
    status: runner.status,
    busy: runner.busy,
    ephemeral: Object.hasOwn(runner, "ephemeral") ? runner.ephemeral : null,
    labels: Object.freeze(labels),
  });
}

function assertUniqueIds(items, field) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) {
      invalid(`${field} contains duplicate id ${item.id}`);
    }
    seen.add(item.id);
  }
}

function repositorySetKey(repositories) {
  return repositories.map(({ id, fullName }) => `${id}:${fullName}`).join("\n");
}

async function fetchTopology(request) {
  const groups = await listAll(
    request,
    "GET /orgs/{org}/actions/runner-groups",
    { org: ORGANIZATION },
    "runner_groups",
  );
  const groupIds = groups.map((group) => ({ id: group?.id }));
  for (const item of groupIds) {
    assertPositiveInteger(item.id, "runner_group.id");
  }
  assertUniqueIds(groupIds, "runner groups");

  const evidenceGroups = [];
  const seenRunnerIds = new Set();
  for (const host of HOSTS) {
    const matches = groups.filter((group) => group?.name === host.group);
    if (matches.length !== 1) {
      invalid(`expected exactly one ${host.group} group`);
    }
    const group = matches[0];
    validateGroup(group, host);

    const repositories = (
      await listAll(
        request,
        "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories",
        { org: ORGANIZATION, runner_group_id: group.id },
        "repositories",
      )
    )
      .map((repository) => validateRepository(repository, host.group))
      .sort((left, right) => left.id - right.id);
    assertUniqueIds(repositories, `${host.group} repositories`);

    const runners = (
      await listAll(
        request,
        "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/runners",
        { org: ORGANIZATION, runner_group_id: group.id },
        "runners",
      )
    )
      .map((runner) => validateRunner(runner, host))
      .sort((left, right) => left.id - right.id);
    assertUniqueIds(runners, `${host.group} runners`);
    for (const runner of runners) {
      if (seenRunnerIds.has(runner.id)) {
        invalid(`runner ${runner.id} appears in both production groups`);
      }
      seenRunnerIds.add(runner.id);
    }

    evidenceGroups.push(
      Object.freeze({
        host: host.id,
        group: Object.freeze({
          id: group.id,
          name: group.name,
          visibility: group.visibility,
          default: group.default,
          inherited: group.inherited,
          allowsPublicRepositories: group.allows_public_repositories,
          restrictedToWorkflows: group.restricted_to_workflows,
          selectedWorkflows: Object.freeze([]),
        }),
        selectedRepositories: Object.freeze(repositories),
        runners: Object.freeze(runners),
        onlineCount: runners.filter(({ status }) => status === "online").length,
        idleCount: runners.filter(
          ({ status, busy }) => status === "online" && !busy,
        ).length,
      }),
    );
  }

  if (evidenceGroups[0].group.id === evidenceGroups[1].group.id) {
    invalid("desktop and laptop must have distinct runner-group IDs");
  }
  const expectedRepositorySet = repositorySetKey(
    evidenceGroups[0].selectedRepositories,
  );
  if (
    repositorySetKey(evidenceGroups[1].selectedRepositories) !==
    expectedRepositorySet
  ) {
    invalid(
      "production groups do not expose identical selected-repository sets",
    );
  }
  if (
    !evidenceGroups[0].selectedRepositories.some(
      ({ fullName }) => fullName === PROOF_REPOSITORY,
    )
  ) {
    invalid("production groups do not expose the private proof repository");
  }

  return Object.freeze({ groups: Object.freeze(evidenceGroups) });
}

function stateForMode(mode) {
  switch (mode) {
    case "inventory":
    case "failover":
      return Object.freeze({ "melo-desk-001": "idle", "melo-lap-001": "idle" });
    case "desktop-only":
      return Object.freeze({
        "melo-desk-001": "idle",
        "melo-lap-001": "drained",
      });
    case "laptop-only":
    case "laptop-power":
      return Object.freeze({
        "melo-desk-001": "drained",
        "melo-lap-001": "idle",
      });
    default:
      throw new ProofError(
        "invalid-input",
        "unsupported production proof mode",
      );
  }
}

function assertMode(topology, mode) {
  if (!ACCEPTED_MODES.has(mode)) {
    throw new ProofError("invalid-input", "unsupported production proof mode");
  }
  const expected = stateForMode(mode);
  for (const group of topology.groups) {
    const state = expected[group.host];
    if (state === "idle" && group.idleCount < 1) {
      throw new ProofError(
        "topology-not-ready",
        `${group.host} has no online idle production runner`,
      );
    }
    if (state === "drained" && group.onlineCount !== 0) {
      throw new ProofError(
        "topology-not-ready",
        `${group.host} still has online production runners`,
      );
    }
  }
  return expected;
}

function observation(topology, now) {
  return Object.freeze({
    observedAt: new Date(now()).toISOString(),
    desktopOnline: topology.groups[0].onlineCount,
    desktopIdle: topology.groups[0].idleCount,
    laptopOnline: topology.groups[1].onlineCount,
    laptopIdle: topology.groups[1].idleCount,
  });
}

async function waitForDesktopDrain({
  request,
  maxWaitMinutes,
  now = Date.now,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onObservation = () => {},
}) {
  if (
    !Number.isSafeInteger(maxWaitMinutes) ||
    maxWaitMinutes < 5 ||
    maxWaitMinutes > 25
  ) {
    throw new ProofError("invalid-input", "drain wait must be 5-25 minutes");
  }
  const startedAt = now();
  const deadline = startedAt + maxWaitMinutes * 60_000;
  const observations = [];
  let stable = 0;

  while (true) {
    const topology = await fetchTopology(request);
    const current = observation(topology, now);
    observations.push(current);
    onObservation(current);
    if (current.desktopOnline === 0 && current.laptopIdle >= 1) {
      stable += 1;
    } else {
      stable = 0;
    }
    if (stable >= REQUIRED_STABLE_DRAIN_OBSERVATIONS) {
      return Object.freeze({
        startedAt: new Date(startedAt).toISOString(),
        completedAt: current.observedAt,
        observations: Object.freeze(observations),
        topology,
      });
    }
    if (now() >= deadline) {
      throw new ProofError(
        "drain-timeout",
        "desktop did not remain drained while laptop idle capacity stayed available",
        Object.freeze({
          startedAt: new Date(startedAt).toISOString(),
          observations: Object.freeze(observations),
        }),
      );
    }
    await sleep(POLL_INTERVAL_MILLISECONDS);
  }
}

function requiredEnvironment(env, name, pattern = undefined) {
  const value = env[name];
  if (typeof value !== "string" || value === "") {
    throw new ProofError("invalid-input", `${name} is required`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ProofError("invalid-input", `${name} is malformed`);
  }
  return value;
}

function commonEvidence(env, now) {
  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    organization: ORGANIZATION,
    repository: PROOF_REPOSITORY,
    callerWorkflow: PROOF_CALLER_WORKFLOW,
    run: {
      id: requiredEnvironment(env, "RUN_ID", /^\d+$/u),
      attempt: Number(requiredEnvironment(env, "RUN_ATTEMPT", /^1$/u)),
      url: requiredEnvironment(env, "RUN_URL", /^https:\/\/github\.com\//u),
    },
    source: {
      apiVersion: API_VERSION,
      endpoints: [
        "GET /orgs/{org}/actions/runner-groups",
        "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories",
        "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/runners",
      ],
    },
    limitations: {
      restGroupIdIsScaleSetId: false,
      scaleSetIdObserved: false,
      controllerCapacityObserved: false,
      batteryOrLogonStateObserved: false,
    },
  };
}

function writeEvidence(path, evidence) {
  fs.writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function appendSummary(path, lines) {
  fs.appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function safeFailure(error) {
  const proofError = apiFailure(error);
  return Object.freeze({ code: proofError.code, message: proofError.message });
}

async function runGitHubScript({ github, core, env, now = Date.now, sleep }) {
  const phase = requiredEnvironment(
    env,
    "PHASE",
    /^(inventory|wait-desktop-drain)$/u,
  );
  const evidencePath = requiredEnvironment(env, "EVIDENCE_PATH");
  const summaryPath = requiredEnvironment(
    { SUMMARY_PATH: env.SUMMARY_PATH || env.GITHUB_STEP_SUMMARY },
    "SUMMARY_PATH",
  );
  const base = commonEvidence(env, now);

  try {
    if (phase === "inventory") {
      const mode = requiredEnvironment(
        env,
        "MODE",
        /^(inventory|desktop-only|laptop-only|failover|laptop-power)$/u,
      );
      const topology = await fetchTopology(github.request);
      const expectedState = assertMode(topology, mode);
      const evidence = {
        ...base,
        phase,
        mode,
        status: "passed",
        expectedState,
        routingLabel: PRODUCTION_LABEL,
        topology,
      };
      writeEvidence(evidencePath, evidence);
      appendSummary(summaryPath, [
        "### Production runner topology passed",
        "",
        `- Mode: \`${mode}\``,
        `- Desktop group: \`${topology.groups[0].group.name}\` (REST group ID ${topology.groups[0].group.id}; ${topology.groups[0].onlineCount} online, ${topology.groups[0].idleCount} idle)`,
        `- Laptop group: \`${topology.groups[1].group.name}\` (REST group ID ${topology.groups[1].group.id}; ${topology.groups[1].onlineCount} online, ${topology.groups[1].idleCount} idle)`,
        `- Identical private repository access: ${topology.groups[0].selectedRepositories.map(({ fullName }) => `\`${fullName}\``).join(", ")}`,
        "- REST group IDs prove independent groups; they are not scale-set IDs.",
      ]);
      core.setOutput("desktop-idle", String(topology.groups[0].idleCount));
      core.setOutput("laptop-idle", String(topology.groups[1].idleCount));
      return evidence;
    }

    const selector = Object.freeze({
      runner: requiredEnvironment(env, "SELECTED_RUNNER"),
      route: requiredEnvironment(env, "SELECTED_ROUTE"),
      reason: requiredEnvironment(env, "SELECTED_REASON"),
      onlineRunnerCount: Number(
        requiredEnvironment(env, "SELECTED_ONLINE_COUNT", /^[1-9]\d*$/u),
      ),
    });
    if (
      selector.runner !== PRODUCTION_LABEL ||
      selector.route !== "self-hosted" ||
      selector.reason !== "online"
    ) {
      throw new ProofError(
        "invalid-input",
        "hosted hold did not receive the exact successful selector outputs",
      );
    }
    const maxWaitMinutes = Number(
      requiredEnvironment(env, "MAX_WAIT_MINUTES", /^(?:[5-9]|1\d|2[0-5])$/u),
    );
    const result = await waitForDesktopDrain({
      request: github.request,
      maxWaitMinutes,
      now,
      sleep,
      onObservation: (current) =>
        core.info(
          `read-only drain observation: desktop online=${current.desktopOnline}; laptop idle=${current.laptopIdle}; observed=${current.observedAt}`,
        ),
    });
    const evidence = {
      ...base,
      phase,
      mode: "failover",
      status: "passed",
      selector,
      stableObservationsRequired: REQUIRED_STABLE_DRAIN_OBSERVATIONS,
      pollIntervalSeconds: POLL_INTERVAL_MILLISECONDS / 1000,
      result,
    };
    writeEvidence(evidencePath, evidence);
    appendSummary(summaryPath, [
      "### Hosted failover hold passed",
      "",
      `- Selector completed first with \`${selector.runner}\` and ${selector.onlineRunnerCount} online runners.`,
      "- Desktop then remained at zero online runners for two observations.",
      "- Laptop retained at least one online idle runner.",
      "- The next governed job must still assert the acquired laptop identity.",
    ]);
    return evidence;
  } catch (error) {
    const failure = safeFailure(error);
    writeEvidence(evidencePath, {
      ...base,
      phase,
      status: "failed",
      failure,
      observations: error instanceof ProofError ? error.evidence : undefined,
    });
    throw new ProofError(failure.code, failure.message);
  }
}

module.exports = Object.freeze({
  ACCEPTED_MODES,
  API_VERSION,
  HOSTS,
  ORGANIZATION,
  POLL_INTERVAL_MILLISECONDS,
  PRODUCTION_LABEL,
  PROOF_CALLER_WORKFLOW,
  PROOF_REPOSITORY,
  REQUEST_TIMEOUT_MILLISECONDS,
  ProofError,
  assertMode,
  fetchTopology,
  listAll,
  runGitHubScript,
  waitForDesktopDrain,
});
