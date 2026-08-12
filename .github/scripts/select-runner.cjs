"use strict";

const DEFAULT_HOSTED_RUNNER = "ubuntu-24.04";
const APPROVED_HOSTED_RUNNERS = new Set([DEFAULT_HOSTED_RUNNER]);
const GITHUB_API_VERSION = "2026-03-10";
const PAGE_SIZE = 100;
const V1_MANAGED_RUNNER_OSES = new Set(["linux", "unknown"]);
// Strict routing admits the always-on default fleet tier and the dedicated
// capped review tier. The selector job itself still runs on the default tier,
// so selecting a review job never consumes the review tier's small capacity.
const SELF_HOSTED_ONLY_LABELS = new Set([
  "melodic-ubuntu-24.04-x64",
  "melodic-review-ubuntu-24.04-x64",
]);
// Reviewed local event classes. merge_group and pull_request_target are
// admitted for metadata-only gates: merge_group has no fork variant and only
// write-access users can enqueue one, and pull_request_target executes the
// trusted base-ref definition. The fork guard below still keeps every
// fork-origin pull-request context off the managed fleet on both PR events.
const LOCAL_EVENT_ALLOWLIST = new Set([
  "push",
  "schedule",
  "workflow_dispatch",
  "merge_group",
  "pull_request",
  "pull_request_target",
]);
const FORK_GUARDED_EVENTS = new Set(["pull_request", "pull_request_target"]);
// Ancillary event classes (comment, review, and issue-lifecycle activity) are
// NOT unconditionally reviewed like LOCAL_EVENT_ALLOWLIST above: their
// eligibility depends entirely on what the triggered job does, not on the event
// class itself. A caller opts a specific job into local routing by setting
// admits-ancillary-events, and that is the caller's declaration that its
// comment/review/issue-triggered job performs NO checkout of PR/issue content
// -- see the workflow input's doc for the caller obligation this rests on.
// permitsLocalExecution treats this set as per-caller opt-in, never an
// automatic local route the way the classes above are.
const ANCILLARY_EVENTS = new Set([
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
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

class StrictRoutingError extends Error {
  constructor(reason, detail = null) {
    super(
      exactNonEmptyString(detail)
        ? detail
        : `self-hosted-only selection failed: ${reason}`,
    );
    this.name = "StrictRoutingError";
    this.reason = reason;
  }
}

// Operator-facing text for zero ONLINE managed capacity (ci-workflows#246).
// GitHub sometimes annotates a drained self-hosted queue as a billing failure;
// this wording names the real cause so operators check the runner host first.
function formatNoOnlineRunnerMessage({
  labels = [],
  failingClosed = false,
} = {}) {
  const labelList = Array.isArray(labels)
    ? labels.filter((label) => exactNonEmptyString(label))
    : [];
  let labelPart = "";
  if (labelList.length === 1) {
    labelPart = ` for \`${labelList[0]}\``;
  } else if (labelList.length > 1) {
    labelPart = ` for \`${labelList.join("`, `")}\``;
  }
  const disposition = failingClosed
    ? "Failing closed so the check names local capacity instead of hanging or falling through."
    : "Falling back to the configured hosted runner; downstream work is not on the drained self-hosted pool.";
  return (
    `No ONLINE managed self-hosted runner${labelPart}. ` +
    "This is local/self-hosted capacity offline — not a GitHub billing failure. " +
    "Check `ci-runner host status` (enable with `ci-runner host enable --wait`). " +
    disposition
  );
}

async function announceNoOnlineRunner(core, { labels, failingClosed }) {
  const message = formatNoOnlineRunnerMessage({ labels, failingClosed });
  // Prefer-self-hosted still succeeds with a hosted route; use warning so the
  // annotation is visible without painting a green selector red. Strict
  // fail-closed paths rethrow after error so the check fails on the real cause.
  if (failingClosed) {
    core.error(message);
  } else {
    core.warning(message);
  }
  if (core.summary && typeof core.summary.addRaw === "function") {
    await core.summary
      .addHeading("Self-hosted capacity offline")
      .addRaw(message)
      .addEOL()
      .write();
  }
  return message;
}

function hostedResult(hostedRunner, reason) {
  return Object.freeze({
    runner: hostedRunner || DEFAULT_HOSTED_RUNNER,
    route: "hosted",
    reason,
    onlineRunnerCount: 0,
  });
}

function selfHostedResult(runner, reason) {
  return Object.freeze({
    runner,
    route: "self-hosted",
    reason,
    onlineRunnerCount: 0,
  });
}

function exactNonEmptyString(value) {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

// Cached prefer-hosted-while-free signal from the billing probe/poll
// (CI_HOSTED_MINUTES_STATE). Anything other than exact "free" fails toward the
// fleet — including missing, malformed, or JSON payloads whose state is not free.
function normalizeBillingMinutesState(value) {
  if (typeof value !== "string") {
    return "unknown";
  }
  const trimmed = value.trim();
  if (trimmed === "free" || trimmed === "exhausted" || trimmed === "unknown") {
    return trimmed;
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed?.state === "free" ||
        parsed?.state === "exhausted" ||
        parsed?.state === "unknown"
      ) {
        return parsed.state;
      }
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

function fleetFirstPolicy(policy) {
  return policy === "self-hosted-only" || policy === "prefer-hosted-while-free";
}

function fleetFirstReason(policy, billingMinutesState) {
  if (policy === "self-hosted-only") {
    return "self-hosted-only";
  }
  return normalizeBillingMinutesState(billingMinutesState) === "exhausted"
    ? "hosted-pool-exhausted"
    : "billing-unknown";
}

function normalizedLabel(value) {
  // GitHub documents self-hosted runner labels as case-insensitive. Preserve
  // the configured spelling for the output, but use one normalized key for
  // every comparison and set membership decision.
  return value.toLowerCase();
}

function configuredCandidateLabels(input) {
  // This is deliberately a safety-only superset for the hosted-label
  // collision check: keep every exact non-empty configured value, including a
  // reserved label, and retain the legacy single label if JSON is malformed.
  // parseCandidateLabels remains the authoritative local-routing parser and
  // rejects malformed JSON, reserved labels, and duplicates before selection.
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
  const configuredLower = normalizedLabel(configured);
  const unsafe =
    !APPROVED_HOSTED_RUNNERS.has(configured) ||
    RESERVED_SELF_HOSTED_LABELS.has(configuredLower) ||
    configuredCandidateLabels(input).some(
      (label) => normalizedLabel(label) === configuredLower,
    );

  return {
    runner: unsafe ? DEFAULT_HOSTED_RUNNER : configured,
    unsafe,
  };
}

function validManagedLabel(value) {
  return (
    exactNonEmptyString(value) &&
    !RESERVED_SELF_HOSTED_LABELS.has(normalizedLabel(value))
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
      new Set(labels.map(normalizedLabel)).size !== labels.length
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
  if (LOCAL_EVENT_ALLOWLIST.has(input.eventName)) {
    return (
      !FORK_GUARDED_EVENTS.has(input.eventName) ||
      input.isForkPullRequest === false
    );
  }
  if (ANCILLARY_EVENTS.has(input.eventName)) {
    return input.admitsAncillaryEvents === true;
  }
  return false;
}

function preflight(input) {
  // The fallback is itself an untrusted operational value. Canonicalize it
  // before every early return so hosted-only and security guards can never
  // be redirected to a generic or managed self-hosted label.
  const hosted = canonicalHostedRunner(input);
  const hostedRunner = hosted.runner;

  if (input.policy === "hosted-only") {
    return { result: hostedResult(hostedRunner, "hosted-only") };
  }

  const selfHostedOnly = input.policy === "self-hosted-only";
  const preferHostedWhileFree = input.policy === "prefer-hosted-while-free";
  const fleetFirst = fleetFirstPolicy(input.policy);

  // Public repositories do not save billed minutes. Only explicitly reviewed
  // caller event classes may route locally, and fork code must never receive
  // the observer credential. This guard is duplicated on the token-minting
  // step so these cases are rejected before that action runs. Same-repository
  // Dependabot branches are a reviewed local class: their lane code runs in
  // ephemeral one-job workers, and the observer key stays inside the selector
  // job, sourced from the Dependabot secrets store on Dependabot events.
  if (input.repositoryPrivate !== true || !permitsLocalExecution(input)) {
    return { result: hostedResult(hostedRunner, "hosted-only") };
  }

  // prefer-hosted-while-free (ci-workflows#252): private repos consume included
  // hosted minutes first while the cached billing probe reports free headroom;
  // otherwise — and on any unreadable/missing billing state — fail toward the
  // fleet. Phase 0 (2026-08-12) got HTTP 200 on the usage API with classic PAT
  // admin:org, so this policy path is ON (not behind a default-off kill switch).
  if (preferHostedWhileFree) {
    const billingState = normalizeBillingMinutesState(
      input.billingMinutesState,
    );
    if (billingState === "free") {
      return { result: hostedResult(hostedRunner, "hosted-while-free") };
    }
  }

  const validScope =
    input.scope === "organization" || input.scope === "repository";
  const validTimeout =
    Number.isFinite(input.apiTimeoutSeconds) &&
    input.apiTimeoutSeconds >= 1 &&
    input.apiTimeoutSeconds <= 60;
  if (!fleetFirst && input.policy !== "prefer-self-hosted") {
    return { result: hostedResult(hostedRunner, "missing-config") };
  }

  if (!exactNonEmptyString(input.hostedRunner)) {
    if (fleetFirst) {
      throw new StrictRoutingError("missing-config");
    }
    return { result: hostedResult(hostedRunner, "missing-config") };
  }

  if (
    !fleetFirst &&
    (!validScope ||
      !exactNonEmptyString(input.managedRunnerPrefix) ||
      !exactNonEmptyString(input.observerClientID) ||
      !exactNonEmptyString(input.owner) ||
      (input.scope === "repository" &&
        !exactNonEmptyString(input.repository)) ||
      !validTimeout)
  ) {
    return { result: hostedResult(hostedRunner, "missing-config") };
  }

  const candidates = parseCandidateLabels(input);
  if ("error" in candidates) {
    if (fleetFirst) {
      throw new StrictRoutingError(candidates.error);
    }
    return { result: hostedResult(hostedRunner, candidates.error) };
  }
  if (
    hosted.unsafe ||
    candidates.labels.some(
      (label) => label.toLowerCase() === input.hostedRunner.toLowerCase(),
    )
  ) {
    if (fleetFirst) {
      throw new StrictRoutingError("invalid-response");
    }
    return { result: hostedResult(hostedRunner, "invalid-response") };
  }
  if (fleetFirst) {
    if (
      candidates.labels.length !== 1 ||
      !SELF_HOSTED_ONLY_LABELS.has(normalizedLabel(candidates.labels[0]))
    ) {
      throw new StrictRoutingError("unapproved-label");
    }
    const label = candidates.labels[0];
    const reviewTier =
      normalizedLabel(label) === "melodic-review-ubuntu-24.04-x64";
    // CI tier may blind-queue so a scale-set can wake (scale-from-zero). Do not
    // move that selector onto hosted or inventorize the default tier here —
    // that is Option A on ci-workflows#246 and would spend hosted minutes on
    // every self-hosted-only invocation. The capped review tier must not
    // blind-queue: an offline review fleet hangs forever with no signal
    // (ci-workflows#386). Probe inventory when credentials exist; otherwise
    // fail closed rather than emit a label nothing will ever claim.
    // prefer-hosted-while-free uses the same fleet-first shape when billing
    // state is exhausted or unknown (fail toward the fleet).
    if (reviewTier) {
      if (!input.hasObserverSecret) {
        throw new StrictRoutingError("missing-secret");
      }
      if (input.tokenOutcome !== "success") {
        throw new StrictRoutingError("auth-error");
      }
      return { hostedRunner, labels: candidates.labels };
    }
    return {
      result: selfHostedResult(
        label,
        fleetFirstReason(input.policy, input.billingMinutesState),
      ),
    };
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
  if (runner === null || typeof runner !== "object") {
    throw new InvalidResponseError(
      "runner inventory contains a malformed runner",
    );
  }
  if (
    !Number.isInteger(runner.id) ||
    typeof runner.name !== "string" ||
    !exactNonEmptyString(runner.os) ||
    typeof runner.status !== "string" ||
    (Object.hasOwn(runner, "ephemeral") &&
      typeof runner.ephemeral !== "boolean") ||
    !Array.isArray(runner.labels) ||
    runner.labels.some(
      (label) =>
        label === null ||
        typeof label !== "object" ||
        !exactNonEmptyString(label.name),
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
  const runnerIDs = new Set();
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
      // The REST pages are separate observations, not a transactional snapshot.
      // A changed total means they cannot be reconciled as one complete result.
      throw new InvalidResponseError(
        "runner inventory total changed during pagination",
      );
    }

    const pageRunners = response.data.runners.map(validateRunner);
    for (const runner of pageRunners) {
      if (runnerIDs.has(runner.id)) {
        throw new InvalidResponseError(
          "runner inventory contains a duplicate runner id",
        );
      }
      runnerIDs.add(runner.id);
      runners.push(runner);
    }
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

function selectOnlineCandidate(runners, labels, managedRunnerPrefix) {
  // `runs-on` contains only the selected label, so GitHub may assign any
  // runner carrying it. Treat that case-insensitive label as contaminated
  // if even one bearer falls outside the managed namespace, reports itself
  // non-ephemeral, or reports an OS outside the V1 Linux/JIT-unknown contract.
  // Contamination is per label: a later distinct configured label remains safe
  // when none of its own bearers violate the contract.
  const configuredLabels = labels.map((label) => ({
    label,
    key: normalizedLabel(label),
  }));
  const configuredLabelKeys = new Set(
    configuredLabels.map((candidate) => candidate.key),
  );
  const soleConfiguredLabelKey =
    configuredLabels.length === 1 ? configuredLabels[0].key : undefined;
  const inventory = runners.map((runner) => {
    // A Set matches GitHub's case-insensitive semantics and prevents duplicate
    // casing variants in one response from affecting counts or priority.
    const observedLabelKeys = new Set(
      runner.labels.map((runnerLabel) => normalizedLabel(runnerLabel.name)),
    );
    // GitHub runner-scale-set jobs target the scale-set name, but live REST
    // inventory can represent an owned JIT runner with `labels: []`. Only a
    // single configured route is unambiguous: attribute an empty-label runner
    // inside the governed name prefix to that sole candidate. Ordered
    // multi-route selection still requires an observed label and fails closed.
    const routingLabelKeys =
      observedLabelKeys.size === 0 &&
      soleConfiguredLabelKey !== undefined &&
      runner.name.startsWith(managedRunnerPrefix)
        ? new Set([soleConfiguredLabelKey])
        : observedLabelKeys;
    const hasUnattributedManagedRoute =
      observedLabelKeys.size === 0 &&
      soleConfiguredLabelKey === undefined &&
      runner.name.startsWith(managedRunnerPrefix);
    return { runner, routingLabelKeys, hasUnattributedManagedRoute };
  });
  const contaminatedLabelKeys = new Set();
  for (const {
    runner,
    routingLabelKeys,
    hasUnattributedManagedRoute,
  } of inventory) {
    if (
      !runner.name.startsWith(managedRunnerPrefix) ||
      runner.ephemeral === false ||
      !V1_MANAGED_RUNNER_OSES.has(runner.os.toLowerCase())
    ) {
      // In multi-route mode, an empty-label managed runner cannot be mapped to
      // one candidate. If it violates the lifecycle or OS contract, fail every
      // candidate closed because the hidden scale-set target may be any one of
      // them. A conforming but unattributed runner remains merely ineligible.
      const possiblyAffectedLabelKeys = hasUnattributedManagedRoute
        ? configuredLabelKeys
        : routingLabelKeys;
      for (const labelKey of possiblyAffectedLabelKeys) {
        if (configuredLabelKeys.has(labelKey)) {
          contaminatedLabelKeys.add(labelKey);
        }
      }
    }
  }
  const safeLabels = configuredLabels.filter(
    (candidate) => !contaminatedLabelKeys.has(candidate.key),
  );
  const safeLabelKeys = new Set(safeLabels.map((candidate) => candidate.key));

  // Liveness, not idleness: a busy online runner is proof the fleet is alive,
  // and GitHub natively queues the job until a matching runner frees up. Only
  // a fully offline fleet falls back to the hosted route.
  const onlineRunners = inventory.filter(({ runner, routingLabelKeys }) => {
    // GitHub's 2026-03-10 OpenAPI makes `ephemeral` optional, and live list
    // responses can omit it. An explicit false is authoritative exclusion;
    // omission relies on the governed assumption that the exact prefix and
    // case-insensitive label namespace are reserved for controller-created,
    // one-job JIT workers. validateRunner has already rejected every present
    // non-boolean value.
    const eligibleEphemeralState =
      !Object.hasOwn(runner, "ephemeral") || runner.ephemeral === true;
    return (
      runner.name.startsWith(managedRunnerPrefix) &&
      runner.status === "online" &&
      eligibleEphemeralState &&
      [...routingLabelKeys].some((labelKey) => safeLabelKeys.has(labelKey))
    );
  });

  const selectedLabel = safeLabels.find((candidate) =>
    onlineRunners.some(({ routingLabelKeys }) =>
      routingLabelKeys.has(candidate.key),
    ),
  );
  return {
    onlineRunnerCount: onlineRunners.length,
    selectedLabel: selectedLabel?.label,
    labelNamespaceInvalid:
      contaminatedLabelKeys.size > 0 && safeLabels.length === 0,
  };
}

function errorResult(error, controller, hostedRunner, fleetFirst = false) {
  const status = Number(error?.status);
  let reason = "api-error";
  if (error instanceof InvalidResponseError) {
    reason = "invalid-response";
  } else if (error?.name === "AbortError" || controller.signal.aborted) {
    reason = "api-timeout";
  } else if (status === 401 || status === 403) {
    reason = "auth-error";
  }
  if (fleetFirst) {
    throw new StrictRoutingError(reason);
  }
  return hostedResult(hostedRunner, reason);
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
  const fleetFirst = fleetFirstPolicy(input.policy);

  try {
    const runners = await listRunners(
      input,
      dependencies.request,
      controller.signal,
    );
    throwIfAborted(controller.signal);
    const selection = selectOnlineCandidate(
      runners,
      prepared.labels,
      input.managedRunnerPrefix,
    );
    if (selection.labelNamespaceInvalid) {
      if (fleetFirst) {
        throw new StrictRoutingError("invalid-response");
      }
      return hostedResult(prepared.hostedRunner, "invalid-response");
    }
    if (!selection.selectedLabel) {
      if (fleetFirst) {
        throw new StrictRoutingError(
          "no-online-runner",
          formatNoOnlineRunnerMessage({
            labels: prepared.labels,
            failingClosed: true,
          }),
        );
      }
      return hostedResult(prepared.hostedRunner, "no-online-runner");
    }
    return Object.freeze({
      runner: selection.selectedLabel,
      route: "self-hosted",
      reason: fleetFirst
        ? fleetFirstReason(input.policy, input.billingMinutesState)
        : "online",
      onlineRunnerCount: selection.onlineRunnerCount,
    });
  } catch (error) {
    if (error instanceof StrictRoutingError) {
      throw error;
    }
    return errorResult(error, controller, prepared.hostedRunner, fleetFirst);
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
    owner: env.REPOSITORY_OWNER,
    repository: env.REPOSITORY_NAME,
    apiTimeoutSeconds: Number(env.API_TIMEOUT_SECONDS),
    repositoryPrivate: env.REPOSITORY_PRIVATE === "true",
    eventName: env.EVENT_NAME,
    isForkPullRequest: env.IS_FORK_PULL_REQUEST === "true",
    admitsAncillaryEvents: env.ADMITS_ANCILLARY_EVENTS === "true",
    billingMinutesState: env.BILLING_MINUTES_STATE || "",
  };
}

function configuredLabelsForAnnouncement(env) {
  const parsed = parseCandidateLabels(inputsFromEnvironment(env));
  return "labels" in parsed ? parsed.labels : [];
}

async function runGitHubScript({ github, core, env }) {
  let result;
  try {
    result = await selectRunner(inputsFromEnvironment(env), {
      request: (...args) => github.request(...args),
    });
  } catch (error) {
    // Surface a check annotation + job summary before the step fails so the
    // operator sees local capacity offline instead of a GitHub billing lead
    // (ci-workflows#246). Prefer-self-hosted uses the success path below.
    if (
      error instanceof StrictRoutingError &&
      error.reason === "no-online-runner"
    ) {
      await announceNoOnlineRunner(core, {
        labels: configuredLabelsForAnnouncement(env),
        failingClosed: true,
      });
    }
    throw error;
  }
  // Empty runner must never be published as a successful selection: GitHub
  // Actions treats "" as falsy in `success && runner || fallback`, which is
  // billing-leak mechanism B (ci-workflows#278).
  if (typeof result.runner !== "string" || result.runner.trim() === "") {
    throw new Error("select-runner produced an empty runner label");
  }
  core.setOutput("runner", result.runner);
  core.setOutput("route", result.route);
  core.setOutput("reason", result.reason);
  core.setOutput("online-runner-count", String(result.onlineRunnerCount));
  if (result.reason === "no-online-runner") {
    await announceNoOnlineRunner(core, {
      labels: configuredLabelsForAnnouncement(env),
      failingClosed: false,
    });
  }
  return result;
}

module.exports = Object.freeze({
  InvalidResponseError,
  StrictRoutingError,
  announceNoOnlineRunner,
  fleetFirstPolicy,
  fleetFirstReason,
  formatNoOnlineRunnerMessage,
  inputsFromEnvironment,
  normalizeBillingMinutesState,
  parseCandidateLabels,
  permitsLocalExecution,
  preflight,
  runGitHubScript,
  selectOnlineCandidate,
  selectRunner,
});
