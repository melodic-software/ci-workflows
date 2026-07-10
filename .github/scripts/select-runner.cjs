"use strict";

const DEFAULT_HOSTED_RUNNER = "ubuntu-24.04";
const GITHUB_API_VERSION = "2026-03-10";
const PAGE_SIZE = 100;
const LOCAL_EVENT_ALLOWLIST = new Set([
  "push",
  "schedule",
  "workflow_dispatch",
  "pull_request",
]);
const RESERVED_SELF_HOSTED_LABELS = new Set([
  "self-hosted",
  "linux",
  "windows",
  "macos",
  "x64",
  "arm",
  "arm32",
  "arm64",
]);

class InvalidResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidResponseError";
  }
}

function hostedResult(hostedRunner, reason) {
  return Object.freeze({
    runner: hostedRunner || DEFAULT_HOSTED_RUNNER,
    route: "hosted",
    reason,
    idleRunnerCount: 0,
  });
}

function exactNonEmptyString(value) {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function configuredCandidateLabels(input) {
  const labels = exactNonEmptyString(input.selfHostedLabel)
    ? [input.selfHostedLabel]
    : [];

  if (
    typeof input.selfHostedLabelsJSON === "string" &&
    input.selfHostedLabelsJSON.length > 0
  ) {
    try {
      const configured = JSON.parse(input.selfHostedLabelsJSON);
      if (Array.isArray(configured)) {
        labels.push(...configured.filter(exactNonEmptyString));
      }
    } catch {
      // The raw single-label input still participates in the safety check even
      // when the preferred JSON candidate list is malformed.
    }
  }

  return labels;
}

function canonicalHostedRunner(input) {
  const configured = exactNonEmptyString(input.hostedRunner)
    ? input.hostedRunner
    : DEFAULT_HOSTED_RUNNER;
  const configuredLower = configured.toLowerCase();
  const unsafe =
    RESERVED_SELF_HOSTED_LABELS.has(configuredLower) ||
    configuredCandidateLabels(input).some(
      (label) => label.toLowerCase() === configuredLower,
    );

  return {
    runner: unsafe ? DEFAULT_HOSTED_RUNNER : configured,
    unsafe,
  };
}

function validManagedLabel(value) {
  return (
    exactNonEmptyString(value) &&
    !RESERVED_SELF_HOSTED_LABELS.has(value.toLowerCase())
  );
}

function parseCandidateLabels(input) {
  if (
    typeof input.selfHostedLabelsJSON === "string" &&
    input.selfHostedLabelsJSON.length > 0
  ) {
    let labels;
    try {
      labels = JSON.parse(input.selfHostedLabelsJSON);
    } catch {
      return { error: "invalid-response" };
    }

    if (
      !Array.isArray(labels) ||
      labels.length === 0 ||
      labels.some((label) => !validManagedLabel(label)) ||
      new Set(labels).size !== labels.length
    ) {
      return { error: "invalid-response" };
    }
    return { labels };
  }

  if (!exactNonEmptyString(input.selfHostedLabel)) {
    return { error: "missing-config" };
  }
  if (!validManagedLabel(input.selfHostedLabel)) {
    return { error: "invalid-response" };
  }
  return { labels: [input.selfHostedLabel] };
}

function permitsLocalExecution(input) {
  if (!LOCAL_EVENT_ALLOWLIST.has(input.eventName)) {
    return false;
  }
  return (
    input.eventName !== "pull_request" || input.isForkPullRequest === false
  );
}

function preflight(input) {
  // The fallback is itself an untrusted operational value. Canonicalize it
  // before every early return so hosted-only, rerun, and security guards can
  // never be redirected to a generic or managed self-hosted label.
  const hosted = canonicalHostedRunner(input);
  const hostedRunner = hosted.runner;

  if (input.policy === "hosted-only") {
    return { result: hostedResult(hostedRunner, "hosted-only") };
  }

  if (Number.isInteger(input.runAttempt) && input.runAttempt > 1) {
    return { result: hostedResult(hostedRunner, "rerun") };
  }

  // Public repositories do not save billed minutes. Only explicitly reviewed
  // caller event classes may route locally, and fork/Dependabot code must never
  // receive the observer credential. This guard is duplicated on the token-
  // minting step so these cases are rejected before that action runs.
  if (
    input.repositoryPrivate !== true ||
    !permitsLocalExecution(input) ||
    input.isDependabot
  ) {
    return { result: hostedResult(hostedRunner, "hosted-only") };
  }

  const validScope =
    input.scope === "organization" || input.scope === "repository";
  const validTimeout =
    Number.isFinite(input.apiTimeoutSeconds) &&
    input.apiTimeoutSeconds >= 1 &&
    input.apiTimeoutSeconds <= 60;
  if (
    input.policy !== "prefer-self-hosted" ||
    !exactNonEmptyString(input.hostedRunner) ||
    !validScope ||
    !exactNonEmptyString(input.managedRunnerPrefix) ||
    !exactNonEmptyString(input.observerClientID) ||
    !exactNonEmptyString(input.owner) ||
    (input.scope === "repository" && !exactNonEmptyString(input.repository)) ||
    input.runAttempt !== 1 ||
    !validTimeout
  ) {
    return { result: hostedResult(hostedRunner, "missing-config") };
  }

  const candidates = parseCandidateLabels(input);
  if ("error" in candidates) {
    return { result: hostedResult(hostedRunner, candidates.error) };
  }
  if (
    hosted.unsafe ||
    candidates.labels.some(
      (label) => label.toLowerCase() === input.hostedRunner.toLowerCase(),
    )
  ) {
    return { result: hostedResult(hostedRunner, "invalid-response") };
  }
  if (!input.hasObserverSecret) {
    return { result: hostedResult(hostedRunner, "missing-secret") };
  }
  if (input.tokenOutcome !== "success") {
    return { result: hostedResult(hostedRunner, "auth-error") };
  }

  return { hostedRunner, labels: candidates.labels };
}

function validateRunner(runner) {
  if (
    runner === null ||
    typeof runner !== "object" ||
    typeof runner.name !== "string" ||
    typeof runner.status !== "string" ||
    typeof runner.busy !== "boolean" ||
    typeof runner.ephemeral !== "boolean" ||
    !Array.isArray(runner.labels) ||
    runner.labels.some(
      (label) =>
        label === null ||
        typeof label !== "object" ||
        typeof label.name !== "string",
    )
  ) {
    throw new InvalidResponseError(
      "runner inventory contains a malformed runner",
    );
  }
  return runner;
}

async function listRunners(input, request, signal) {
  const route =
    input.scope === "organization"
      ? "GET /orgs/{org}/actions/runners"
      : "GET /repos/{owner}/{repo}/actions/runners";
  const resource =
    input.scope === "organization"
      ? { org: input.owner }
      : { owner: input.owner, repo: input.repository };
  const runners = [];
  let declaredTotal;

  for (let page = 1; ; page += 1) {
    const response = await request(route, {
      ...resource,
      per_page: PAGE_SIZE,
      page,
      headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION },
      request: { signal },
    });

    throwIfAborted(signal);

    if (
      response === null ||
      typeof response !== "object" ||
      response.data === null ||
      typeof response.data !== "object" ||
      !Number.isInteger(response.data.total_count) ||
      response.data.total_count < 0 ||
      !Array.isArray(response.data.runners) ||
      response.data.runners.length > PAGE_SIZE
    ) {
      throw new InvalidResponseError(
        "runner inventory response has an invalid envelope",
      );
    }

    if (declaredTotal === undefined) {
      declaredTotal = response.data.total_count;
    } else if (declaredTotal !== response.data.total_count) {
      // A changing inventory snapshot cannot support a deterministic ordered
      // choice. Failing hosted is safer than selecting from a partial snapshot.
      throw new InvalidResponseError(
        "runner inventory total changed during pagination",
      );
    }

    runners.push(...response.data.runners.map(validateRunner));
    if (runners.length > declaredTotal) {
      throw new InvalidResponseError(
        "runner inventory exceeds its declared total",
      );
    }
    if (runners.length === declaredTotal) {
      return runners;
    }
    if (response.data.runners.length < PAGE_SIZE) {
      throw new InvalidResponseError(
        "runner inventory ended before its declared total",
      );
    }
  }
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    const error = new Error("runner inventory request exceeded its timeout");
    error.name = "AbortError";
    throw error;
  }
}

function selectIdleCandidate(runners, labels, managedRunnerPrefix) {
  const idleRunners = runners.filter(
    (runner) =>
      runner.name.startsWith(managedRunnerPrefix) &&
      runner.status === "online" &&
      runner.busy === false &&
      runner.ephemeral === true &&
      runner.labels.some((runnerLabel) => labels.includes(runnerLabel.name)),
  );

  const selectedLabel = labels.find((label) =>
    idleRunners.some((runner) =>
      runner.labels.some((runnerLabel) => runnerLabel.name === label),
    ),
  );
  return { idleRunnerCount: idleRunners.length, selectedLabel };
}

function errorResult(error, controller, hostedRunner) {
  const status = Number(error?.status);
  if (error instanceof InvalidResponseError) {
    return hostedResult(hostedRunner, "invalid-response");
  }
  if (error?.name === "AbortError" || controller.signal.aborted) {
    return hostedResult(hostedRunner, "api-timeout");
  }
  if (status === 401 || status === 403) {
    return hostedResult(hostedRunner, "auth-error");
  }
  return hostedResult(hostedRunner, "api-error");
}

async function selectRunner(input, dependencies = {}) {
  const prepared = preflight(input);
  if (prepared.result) {
    return prepared.result;
  }

  if (typeof dependencies.request !== "function") {
    return hostedResult(prepared.hostedRunner, "api-error");
  }

  const createAbortController =
    dependencies.createAbortController || (() => new AbortController());
  const setTimer = dependencies.setTimer || setTimeout;
  const clearTimer = dependencies.clearTimer || clearTimeout;
  const controller = createAbortController();
  const timeout = setTimer(
    () => controller.abort(),
    input.apiTimeoutSeconds * 1000,
  );

  try {
    const runners = await listRunners(
      input,
      dependencies.request,
      controller.signal,
    );
    throwIfAborted(controller.signal);
    const idle = selectIdleCandidate(
      runners,
      prepared.labels,
      input.managedRunnerPrefix,
    );
    if (!idle.selectedLabel) {
      return hostedResult(prepared.hostedRunner, "no-idle-runner");
    }
    return Object.freeze({
      runner: idle.selectedLabel,
      route: "self-hosted",
      reason: "idle",
      idleRunnerCount: idle.idleRunnerCount,
    });
  } catch (error) {
    return errorResult(error, controller, prepared.hostedRunner);
  } finally {
    clearTimer(timeout);
  }
}

function inputsFromEnvironment(env) {
  return {
    policy: env.POLICY,
    selfHostedLabel: env.SELF_HOSTED_LABEL,
    selfHostedLabelsJSON: env.SELF_HOSTED_LABELS_JSON,
    hostedRunner: env.HOSTED_RUNNER,
    scope: env.RUNNER_SCOPE,
    managedRunnerPrefix: env.MANAGED_RUNNER_PREFIX,
    observerClientID: env.OBSERVER_CLIENT_ID,
    hasObserverSecret: env.HAS_OBSERVER_SECRET === "true",
    tokenOutcome: env.TOKEN_OUTCOME,
    runAttempt: Number(env.RUN_ATTEMPT),
    owner: env.REPOSITORY_OWNER,
    repository: env.REPOSITORY_NAME,
    apiTimeoutSeconds: Number(env.API_TIMEOUT_SECONDS),
    repositoryPrivate: env.REPOSITORY_PRIVATE === "true",
    eventName: env.EVENT_NAME,
    isForkPullRequest: env.IS_FORK_PULL_REQUEST === "true",
    isDependabot: env.IS_DEPENDABOT === "true",
  };
}

async function runGitHubScript({ github, core, env }) {
  const result = await selectRunner(inputsFromEnvironment(env), {
    request: (...args) => github.request(...args),
  });
  core.setOutput("runner", result.runner);
  core.setOutput("route", result.route);
  core.setOutput("reason", result.reason);
  core.setOutput("idle-runner-count", String(result.idleRunnerCount));
  return result;
}

module.exports = Object.freeze({
  InvalidResponseError,
  inputsFromEnvironment,
  parseCandidateLabels,
  permitsLocalExecution,
  preflight,
  runGitHubScript,
  selectIdleCandidate,
  selectRunner,
});
