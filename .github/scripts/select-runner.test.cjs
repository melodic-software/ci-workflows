"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { selectRunner } = require("./select-runner.cjs");

const workflowPath = path.join(
  __dirname,
  "..",
  "workflows",
  "select-runner.yml",
);
const rootCIPath = path.join(__dirname, "..", "workflows", "ci.yml");
const ALLOWED_LOCAL_EVENTS = [
  "push",
  "schedule",
  "workflow_dispatch",
  "pull_request",
];
const BLOCKED_LOCAL_EVENTS = [
  "pull_request_target",
  "workflow_run",
  "issue_comment",
  "commit_comment",
  "discussion_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "repository_dispatch",
  "merge_group",
  "unknown-event",
];
let nextRunnerID = 1;

function input(overrides = {}) {
  return {
    policy: "prefer-self-hosted",
    selfHostedLabel: "melodic-ubuntu-24.04-x64",
    selfHostedLabelsJSON: "",
    hostedRunner: "ubuntu-24.04",
    scope: "organization",
    managedRunnerPrefix: "ci-runner-melo-",
    observerClientID: "Iv23observer",
    hasObserverSecret: true,
    tokenOutcome: "success",
    owner: "melodic-software",
    repository: "medley",
    apiTimeoutSeconds: 10,
    repositoryPrivate: true,
    eventName: "push",
    isForkPullRequest: false,
    ...overrides,
  };
}

function runner(overrides = {}) {
  return {
    id: nextRunnerID++,
    name: "ci-runner-melo-desk-001-1",
    os: "linux",
    status: "online",
    busy: false,
    ephemeral: true,
    labels: [{ name: "melodic-ubuntu-24.04-x64" }],
    ...overrides,
  };
}

function runnerWithoutEphemeral(overrides = {}) {
  const candidate = runner(overrides);
  delete candidate.ephemeral;
  return candidate;
}

function response(runners, totalCount = runners.length) {
  return { data: { total_count: totalCount, runners } };
}

function requestMustNotRun() {
  throw new Error("inventory request must not run");
}

test("hosted-only returns without an inventory request", async () => {
  const result = await selectRunner(input({ policy: "hosted-only" }), {
    request: requestMustNotRun,
  });
  assert.deepEqual(result, {
    runner: "ubuntu-24.04",
    route: "hosted",
    reason: "hosted-only",
    onlineRunnerCount: 0,
  });
});

test("self-hosted-only queues the primary managed label without credentials or inventory", async () => {
  const result = await selectRunner(
    input({
      policy: "self-hosted-only",
      selfHostedLabel: "",
      selfHostedLabelsJSON: '["melodic-ubuntu-24.04-x64"]',
      scope: "",
      managedRunnerPrefix: "",
      observerClientID: "",
      hasObserverSecret: false,
      tokenOutcome: "skipped",
      owner: "",
      repository: "",
      apiTimeoutSeconds: Number.NaN,
    }),
    { request: requestMustNotRun },
  );
  assert.deepEqual(result, {
    runner: "melodic-ubuntu-24.04-x64",
    route: "self-hosted",
    reason: "self-hosted-only",
    onlineRunnerCount: 0,
  });
});

for (const [name, overrides, reason] of [
  ["missing label", { selfHostedLabel: "" }, "missing-config"],
  [
    "malformed labels",
    { selfHostedLabelsJSON: "{bad-json" },
    "invalid-response",
  ],
  ["arbitrary label", { selfHostedLabel: "legacy-runner" }, "unapproved-label"],
  [
    "multiple labels",
    {
      selfHostedLabel: "",
      selfHostedLabelsJSON: '["melodic-ubuntu-24.04-x64","legacy-runner"]',
    },
    "unapproved-label",
  ],
]) {
  test(`self-hosted-only rejects ${name} instead of spending hosted minutes`, async () => {
    await assert.rejects(
      selectRunner(input({ policy: "self-hosted-only", ...overrides }), {
        request: requestMustNotRun,
      }),
      (error) => error.name === "StrictRoutingError" && error.reason === reason,
    );
  });
}

for (const [name, overrides] of [
  ["public repository", { repositoryPrivate: false }],
  ["fork pull request", { eventName: "pull_request", isForkPullRequest: true }],
  ["blocked event", { eventName: "pull_request_target" }],
]) {
  test(`self-hosted-only keeps ${name} on the hosted security route`, async () => {
    const result = await selectRunner(
      input({
        policy: "self-hosted-only",
        tokenOutcome: "skipped",
        ...overrides,
      }),
      { request: requestMustNotRun },
    );
    assert.equal(result.route, "hosted");
    assert.equal(result.reason, "hosted-only");
  });
}

for (const [routeName, overrides, reason] of [
  ["hosted-only", { policy: "hosted-only" }, "hosted-only"],
  [
    "public guard",
    { repositoryPrivate: false, tokenOutcome: "skipped" },
    "hosted-only",
  ],
]) {
  for (const [fallbackName, fallback] of [
    ["reserved", { hostedRunner: "self-hosted" }],
    ["unapproved label", { hostedRunner: "some-other-self-hosted-label" }],
    ["unreviewed hosted generation", { hostedRunner: "ubuntu-26.04" }],
    [
      "managed-label",
      {
        hostedRunner: "melodic-ubuntu-24.04-x64",
        selfHostedLabel: "melodic-ubuntu-24.04-x64",
      },
    ],
    [
      "managed-label with malformed JSON override",
      {
        hostedRunner: "melodic-ubuntu-24.04-x64",
        selfHostedLabel: "melodic-ubuntu-24.04-x64",
        selfHostedLabelsJSON: "{bad-json",
      },
    ],
    [
      "managed-label with empty JSON candidate list",
      {
        hostedRunner: "melodic-ubuntu-24.04-x64",
        selfHostedLabel: "melodic-ubuntu-24.04-x64",
        selfHostedLabelsJSON: "[]",
      },
    ],
  ]) {
    test(`${routeName} canonicalizes an unsafe ${fallbackName} hosted fallback`, async () => {
      const result = await selectRunner(input({ ...overrides, ...fallback }), {
        request: requestMustNotRun,
      });
      assert.deepEqual(result, {
        runner: "ubuntu-24.04",
        route: "hosted",
        reason,
        onlineRunnerCount: 0,
      });
    });
  }
}

for (const [name, overrides] of [
  ["public repository", { repositoryPrivate: false }],
  ["fork pull request", { eventName: "pull_request", isForkPullRequest: true }],
]) {
  test(`${name} routes hosted before authentication or inventory`, async () => {
    const result = await selectRunner(
      input({ ...overrides, tokenOutcome: "skipped" }),
      {
        request: requestMustNotRun,
      },
    );
    assert.equal(result.route, "hosted");
    assert.equal(result.reason, "hosted-only");
  });
}

for (const eventName of ALLOWED_LOCAL_EVENTS) {
  test(`${eventName} is allowed to select local capacity`, async () => {
    const result = await selectRunner(input({ eventName }), {
      request: async () => response([runner()]),
    });
    assert.equal(result.route, "self-hosted");
    assert.equal(result.reason, "online");
  });
}

for (const eventName of BLOCKED_LOCAL_EVENTS) {
  test(`${eventName} routes hosted before authentication or inventory`, async () => {
    const result = await selectRunner(
      input({ eventName, tokenOutcome: "skipped" }),
      {
        request: requestMustNotRun,
      },
    );
    assert.equal(result.route, "hosted");
    assert.equal(result.reason, "hosted-only");
  });
}

test("invalid scope fails hosted without an inventory request", async () => {
  const result = await selectRunner(input({ scope: "enterprise" }), {
    request: requestMustNotRun,
  });
  assert.equal(result.reason, "missing-config");
});

test("missing observer secret and failed token mint fail hosted", async (t) => {
  await t.test("missing secret", async () => {
    const result = await selectRunner(
      input({ hasObserverSecret: false, tokenOutcome: "skipped" }),
      {
        request: requestMustNotRun,
      },
    );
    assert.equal(result.reason, "missing-secret");
  });
  await t.test("failed token mint", async () => {
    const result = await selectRunner(input({ tokenOutcome: "failure" }), {
      request: requestMustNotRun,
    });
    assert.equal(result.reason, "auth-error");
  });
});

test("malformed and duplicate ordered candidate lists fail hosted", async () => {
  for (const labelsJSON of [
    "{not-json",
    "[]",
    '["duplicate","duplicate"]',
    '["duplicate","DUPLICATE"]',
    '[" spaced "]',
    '["self-hosted"]',
    '["Linux"]',
  ]) {
    const result = await selectRunner(
      input({ selfHostedLabel: "", selfHostedLabelsJSON: labelsJSON }),
      { request: requestMustNotRun },
    );
    assert.equal(result.reason, "invalid-response", labelsJSON);
  }
});

test("reserved default self-hosted label cannot be returned as runs-on", async () => {
  const result = await selectRunner(input({ selfHostedLabel: "x64" }), {
    request: requestMustNotRun,
  });
  assert.equal(result.route, "hosted");
  assert.equal(result.reason, "invalid-response");
});

test("self-hosted candidate cannot equal the configured hosted runner", async () => {
  const result = await selectRunner(
    input({ selfHostedLabel: "Ubuntu-24.04" }),
    {
      request: requestMustNotRun,
    },
  );
  assert.equal(result.route, "hosted");
  assert.equal(result.runner, "ubuntu-24.04");
  assert.equal(result.reason, "invalid-response");
});

test("malformed candidate JSON cannot hide an unsafe legacy single-label fallback", async () => {
  const result = await selectRunner(
    input({
      hostedRunner: "melodic-ubuntu-24.04-x64",
      selfHostedLabel: "melodic-ubuntu-24.04-x64",
      selfHostedLabelsJSON: "{bad-json",
    }),
    { request: requestMustNotRun },
  );
  assert.equal(result.route, "hosted");
  assert.equal(result.runner, "ubuntu-24.04");
  assert.equal(result.reason, "invalid-response");
});

test("organization inventory success uses the exact API contract", async () => {
  let observedRoute;
  let observedParameters;
  const result = await selectRunner(input(), {
    request: async (route, parameters) => {
      observedRoute = route;
      observedParameters = parameters;
      return response([runner()]);
    },
  });
  assert.equal(observedRoute, "GET /orgs/{org}/actions/runners");
  assert.equal(observedParameters.org, "melodic-software");
  assert.equal(observedParameters.per_page, 100);
  assert.equal(observedParameters.page, 1);
  assert.equal(
    observedParameters.headers["X-GitHub-Api-Version"],
    "2026-03-10",
  );
  assert.ok(observedParameters.request.signal);
  assert.deepEqual(result, {
    runner: "melodic-ubuntu-24.04-x64",
    route: "self-hosted",
    reason: "online",
    onlineRunnerCount: 1,
  });
});

test("repository inventory success targets only the caller repository", async () => {
  let observed;
  const result = await selectRunner(
    input({ scope: "repository", owner: "kyle-sexton" }),
    {
      request: async (route, parameters) => {
        observed = { route, parameters };
        return response([runner()]);
      },
    },
  );
  assert.equal(observed.route, "GET /repos/{owner}/{repo}/actions/runners");
  assert.equal(observed.parameters.owner, "kyle-sexton");
  assert.equal(observed.parameters.repo, "medley");
  assert.equal(result.route, "self-hosted");
});

test("filter requires exact label, managed prefix, and online state", async () => {
  const inventory = [
    runner({ name: "unmanaged-1", labels: [{ name: "unrelated-label" }] }),
    runner({ status: "offline" }),
    runner({ labels: [{ name: "melodic-ubuntu-24.04-x64-other" }] }),
    runner({ name: "ci-runner-melo-lap-001-1" }),
  ];
  const result = await selectRunner(input(), {
    request: async () => response(inventory),
  });
  assert.equal(result.route, "self-hosted");
  assert.equal(result.onlineRunnerCount, 1);
});

test("a busy online runner keeps the self-hosted route so GitHub queues the job", async () => {
  const result = await selectRunner(input(), {
    request: async () => response([runner({ busy: true })]),
  });
  assert.deepEqual(result, {
    runner: "melodic-ubuntu-24.04-x64",
    route: "self-hosted",
    reason: "online",
    onlineRunnerCount: 1,
  });
});

test("an unrelated runner with omitted optional ephemeral is valid but ineligible", async () => {
  const result = await selectRunner(input(), {
    request: async () =>
      response([
        runnerWithoutEphemeral({ labels: [{ name: "unrelated-label" }] }),
      ]),
  });
  assert.equal(result.route, "hosted");
  assert.equal(result.reason, "no-online-runner");
});

test("a matching managed runner remains eligible when optional ephemeral is omitted", async () => {
  const result = await selectRunner(input(), {
    request: async () =>
      response([
        runnerWithoutEphemeral({
          labels: [{ name: "MELODIC-UBUNTU-24.04-X64" }],
        }),
      ]),
  });
  assert.deepEqual(result, {
    runner: "melodic-ubuntu-24.04-x64",
    route: "self-hosted",
    reason: "online",
    onlineRunnerCount: 1,
  });
});

test("a single scale-set route selects a live managed runner with an empty REST label list", async () => {
  const result = await selectRunner(input(), {
    request: async () =>
      response([
        runnerWithoutEphemeral({
          os: "unknown",
          labels: [],
        }),
      ]),
  });
  assert.deepEqual(result, {
    runner: "melodic-ubuntu-24.04-x64",
    route: "self-hosted",
    reason: "online",
    onlineRunnerCount: 1,
  });
});

test("an empty REST label list cannot be attributed across ordered scale-set routes", async () => {
  const result = await selectRunner(
    input({
      selfHostedLabel: "",
      selfHostedLabelsJSON: JSON.stringify([
        "kyle-desk-ubuntu-24.04-x64",
        "kyle-lap-ubuntu-24.04-x64",
      ]),
    }),
    {
      request: async () =>
        response([runnerWithoutEphemeral({ os: "unknown", labels: [] })]),
    },
  );
  assert.equal(result.route, "hosted");
  assert.equal(result.reason, "no-online-runner");
  assert.equal(result.onlineRunnerCount, 0);
});

for (const incompatible of [
  { ephemeral: false, os: "unknown" },
  { os: "windows" },
]) {
  test(`an incompatible unattributed managed runner contaminates every ordered route: ${JSON.stringify(incompatible)}`, async () => {
    const labels = ["kyle-desk-ubuntu-24.04-x64", "kyle-lap-ubuntu-24.04-x64"];
    const result = await selectRunner(
      input({
        selfHostedLabel: "",
        selfHostedLabelsJSON: JSON.stringify(labels),
      }),
      {
        request: async () =>
          response([
            runnerWithoutEphemeral({
              name: "ci-runner-melo-lap-001-1",
              labels: [{ name: labels[1] }],
            }),
            runner({
              labels: [],
              ...incompatible,
            }),
          ]),
      },
    );
    assert.equal(result.route, "hosted");
    assert.equal(result.reason, "invalid-response");
    assert.equal(result.onlineRunnerCount, 0);
  });
}

test("empty-label scale-set inference still requires the managed prefix and online state", async () => {
  const result = await selectRunner(input(), {
    request: async () =>
      response([
        runnerWithoutEphemeral({
          name: "unmanaged-empty-label-runner",
          os: "unknown",
          labels: [],
        }),
        runnerWithoutEphemeral({
          status: "offline",
          os: "unknown",
          labels: [],
        }),
      ]),
  });
  assert.equal(result.route, "hosted");
  assert.equal(result.reason, "no-online-runner");
  assert.equal(result.onlineRunnerCount, 0);
});

test("a busy empty-label scale-set runner keeps the inferred single route live", async () => {
  const result = await selectRunner(input(), {
    request: async () =>
      response([
        runnerWithoutEphemeral({
          busy: true,
          os: "unknown",
          labels: [],
        }),
      ]),
  });
  assert.equal(result.route, "self-hosted");
  assert.equal(result.reason, "online");
  assert.equal(result.onlineRunnerCount, 1);
});

for (const incompatible of [
  { ephemeral: false, os: "unknown" },
  { os: "windows" },
]) {
  test(`an incompatible empty-label managed runner contaminates the inferred single route: ${JSON.stringify(incompatible)}`, async () => {
    const result = await selectRunner(input(), {
      request: async () =>
        response([
          runner({
            labels: [],
            ...incompatible,
          }),
        ]),
    });
    assert.equal(result.route, "hosted");
    assert.equal(result.reason, "invalid-response");
    assert.equal(result.onlineRunnerCount, 0);
  });
}

test("an explicit ephemeral false remains authoritative exclusion", async () => {
  const result = await selectRunner(input(), {
    request: async () => response([runner({ ephemeral: false })]),
  });
  assert.equal(result.route, "hosted");
  assert.equal(result.reason, "invalid-response");
});

for (const ephemeral of [undefined, null, "true", 1]) {
  test(`a present non-boolean ephemeral value ${String(ephemeral)} invalidates inventory`, async () => {
    const result = await selectRunner(input(), {
      request: async () => response([runner({ ephemeral })]),
    });
    assert.equal(result.route, "hosted");
    assert.equal(result.reason, "invalid-response");
  });
}

test("mixed live-shape inventory selects only the exact managed omitted-field runner", async () => {
  const inventory = [
    runnerWithoutEphemeral({
      name: "unmanaged-1",
      labels: [{ name: "unrelated-label" }],
    }),
    runnerWithoutEphemeral({ status: "offline" }),
    runnerWithoutEphemeral({ labels: [{ name: "unrelated-label" }] }),
    runnerWithoutEphemeral({ name: "ci-runner-melo-lap-001-1" }),
  ];
  const result = await selectRunner(input(), {
    request: async () => response(inventory),
  });
  assert.equal(result.route, "self-hosted");
  assert.equal(result.onlineRunnerCount, 1);
});

test("same-label wrong-prefix sibling contaminates the complete label namespace", async () => {
  const result = await selectRunner(input(), {
    request: async () =>
      response([
        runnerWithoutEphemeral(),
        runnerWithoutEphemeral({
          name: "unmanaged-same-label",
          labels: [{ name: "MeLoDiC-UbUnTu-24.04-X64" }],
        }),
      ]),
  });
  assert.equal(result.route, "hosted");
  assert.equal(result.reason, "invalid-response");
  assert.equal(result.onlineRunnerCount, 0);
});

test("same-label explicit-false sibling contaminates the complete label namespace", async () => {
  const result = await selectRunner(input(), {
    request: async () =>
      response([
        runnerWithoutEphemeral(),
        runner({
          name: "ci-runner-melo-lap-001-persistent",
          ephemeral: false,
          labels: [{ name: "MELODIC-UBUNTU-24.04-X64" }],
        }),
      ]),
  });
  assert.equal(result.route, "hosted");
  assert.equal(result.reason, "invalid-response");
  assert.equal(result.onlineRunnerCount, 0);
});

for (const os of ["unknown", "UNKNOWN", "LiNuX"]) {
  test(`managed omitted-field runner accepts the V1 ${os} inventory OS`, async () => {
    const configuredLabel = "Melodic-Ubuntu-24.04-X64";
    const result = await selectRunner(
      input({ selfHostedLabel: configuredLabel }),
      {
        request: async () =>
          response([
            runnerWithoutEphemeral({
              os,
              labels: [{ name: configuredLabel.toUpperCase() }],
            }),
          ]),
      },
    );
    assert.equal(result.route, "self-hosted");
    assert.equal(result.runner, configuredLabel);
  });
}

for (const os of ["windows", "macOS"]) {
  test(`same-label ${os} sibling contaminates the V1 Linux namespace`, async () => {
    const configuredLabel = "Melodic-Ubuntu-24.04-X64";
    const result = await selectRunner(
      input({ selfHostedLabel: configuredLabel }),
      {
        request: async () =>
          response([
            runnerWithoutEphemeral({
              os: "unknown",
              labels: [{ name: configuredLabel.toLowerCase() }],
            }),
            runnerWithoutEphemeral({
              name: `ci-runner-melo-wrong-os-${os}`,
              os,
              labels: [{ name: configuredLabel.toUpperCase() }],
            }),
          ]),
      },
    );
    assert.equal(result.route, "hosted");
    assert.equal(result.reason, "invalid-response");
    assert.equal(result.onlineRunnerCount, 0);
  });
}

test("an omitted-field runner on an unrelated label does not poison a good sibling", async () => {
  const result = await selectRunner(input(), {
    request: async () =>
      response([
        runnerWithoutEphemeral({
          name: "unmanaged-unrelated",
          labels: [{ name: "unrelated-label" }],
        }),
        runnerWithoutEphemeral(),
      ]),
  });
  assert.equal(result.route, "self-hosted");
  assert.equal(result.onlineRunnerCount, 1);
});

test("a wrong-OS runner on an unrelated label does not poison the V1 namespace", async () => {
  const result = await selectRunner(input(), {
    request: async () =>
      response([
        runnerWithoutEphemeral({
          name: "ci-runner-melo-windows-unrelated",
          os: "windows",
          labels: [{ name: "unrelated-label" }],
        }),
        runnerWithoutEphemeral({ os: "unknown" }),
      ]),
  });
  assert.equal(result.route, "self-hosted");
  assert.equal(result.onlineRunnerCount, 1);
});

test("ordered candidates skip a contaminated label and select a clean lower priority", async () => {
  const labels = ["Kyle-Desk-Ubuntu-24.04-X64", "Kyle-Lap-Ubuntu-24.04-X64"];
  const result = await selectRunner(
    input({
      selfHostedLabel: "",
      selfHostedLabelsJSON: JSON.stringify(labels),
    }),
    {
      request: async () =>
        response([
          runnerWithoutEphemeral({
            name: "unmanaged-desktop-label",
            labels: [{ name: labels[0].toUpperCase() }],
          }),
          runnerWithoutEphemeral({
            name: "ci-runner-melo-lap-001-1",
            labels: [{ name: labels[1].toLowerCase() }],
          }),
        ]),
    },
  );
  assert.equal(result.route, "self-hosted");
  assert.equal(result.runner, labels[1]);
  assert.equal(result.onlineRunnerCount, 1);
});

test("ordered candidates skip a wrong-OS label and preserve clean configured spelling", async () => {
  const labels = ["Kyle-Desk-Ubuntu-24.04-X64", "Kyle-Lap-Ubuntu-24.04-X64"];
  const result = await selectRunner(
    input({
      selfHostedLabel: "",
      selfHostedLabelsJSON: JSON.stringify(labels),
    }),
    {
      request: async () =>
        response([
          runnerWithoutEphemeral({
            os: "Windows",
            labels: [{ name: labels[0].toUpperCase() }],
          }),
          runnerWithoutEphemeral({
            name: "ci-runner-melo-lap-001-1",
            os: "UNKNOWN",
            labels: [{ name: labels[1].toLowerCase() }],
          }),
        ]),
    },
  );
  assert.equal(result.route, "self-hosted");
  assert.equal(result.runner, labels[1]);
  assert.equal(result.onlineRunnerCount, 1);
});

test("runner label case variants dedupe while configured spelling is returned", async () => {
  const configuredLabel = "Melodic-Ubuntu-24.04-X64";
  const result = await selectRunner(
    input({ selfHostedLabel: configuredLabel }),
    {
      request: async () =>
        response([
          runnerWithoutEphemeral({
            labels: [
              { name: configuredLabel.toLowerCase() },
              { name: configuredLabel.toUpperCase() },
            ],
          }),
        ]),
    },
  );
  assert.equal(result.route, "self-hosted");
  assert.equal(result.runner, configuredLabel);
  assert.equal(result.onlineRunnerCount, 1);
});

test("ordered candidates win independent of API runner ordering", async () => {
  const labels = ["kyle-desk-ubuntu-24.04-x64", "kyle-lap-ubuntu-24.04-x64"];
  const inventory = [
    runner({ labels: [{ name: labels[1] }] }),
    runner({
      name: "ci-runner-melo-desk-001-2",
      labels: [{ name: labels[0] }],
    }),
  ];
  const result = await selectRunner(
    input({
      selfHostedLabel: "",
      selfHostedLabelsJSON: JSON.stringify(labels),
    }),
    { request: async () => response(inventory) },
  );
  assert.equal(result.runner, labels[0]);
  assert.equal(result.onlineRunnerCount, 2);
});

test("a fully offline fleet routes hosted", async () => {
  const result = await selectRunner(input(), {
    request: async () => response([runner({ status: "offline" })]),
  });
  assert.equal(result.route, "hosted");
  assert.equal(result.reason, "no-online-runner");
});

test("pagination reads every page before selecting", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    runnerWithoutEphemeral({
      name: `other-managed-${index}`,
      labels: [{ name: "unrelated" }],
    }),
  );
  const request = async (_route, parameters) => {
    calls.push(parameters.page);
    return parameters.page === 1
      ? response(firstPage, 101)
      : response([runnerWithoutEphemeral()], 101);
  };
  const result = await selectRunner(input(), { request });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.route, "self-hosted");
});

test("pagination failure on a later page routes hosted", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    runner({ name: `other-managed-${index}`, labels: [{ name: "unrelated" }] }),
  );
  const result = await selectRunner(input(), {
    request: async (_route, parameters) => {
      if (parameters.page === 1) {
        return response(firstPage, 101);
      }
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    },
  });
  assert.equal(result.route, "hosted");
  assert.equal(result.reason, "api-error");
});

test("a duplicate runner id across pagination fails hosted", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    runner({ name: `other-managed-${index}`, labels: [{ name: "unrelated" }] }),
  );
  const result = await selectRunner(input(), {
    request: async (_route, parameters) =>
      parameters.page === 1
        ? response(firstPage, 101)
        : response([runner({ id: firstPage[0].id })], 101),
  });
  assert.equal(result.route, "hosted");
  assert.equal(result.reason, "invalid-response");
});

test("malformed inventory responses fail hosted", async () => {
  const cases = [
    undefined,
    { data: { total_count: "1", runners: [] } },
    { data: { total_count: 1, runners: "not-an-array" } },
    response([{ name: "missing-fields" }]),
    response([], 1),
  ];
  for (const invalid of cases) {
    const result = await selectRunner(input(), {
      request: async () => invalid,
    });
    assert.equal(result.reason, "invalid-response");
  }
});

test("malformed required runner id and os fields fail hosted", async () => {
  for (const malformed of [
    runner({ id: undefined }),
    runner({ id: "1" }),
    runner({ id: 1.5 }),
    runner({ os: undefined }),
    runner({ os: "" }),
    runner({ os: " linux " }),
  ]) {
    const result = await selectRunner(input(), {
      request: async () => response([malformed]),
    });
    assert.equal(result.route, "hosted");
    assert.equal(result.reason, "invalid-response");
  }
});

for (const [status, expected] of [
  [401, "auth-error"],
  [403, "auth-error"],
  [404, "api-error"],
  [429, "api-error"],
  [500, "api-error"],
  [503, "api-error"],
]) {
  test(`HTTP ${status} routes hosted with ${expected}`, async () => {
    const error = Object.assign(new Error(`HTTP ${status}`), { status });
    const result = await selectRunner(input(), {
      request: async () => {
        throw error;
      },
    });
    assert.equal(result.route, "hosted");
    assert.equal(result.reason, expected);
  });
}

test("request timeout wins even when the request ignores abort and returns valid inventory", async () => {
  const result = await selectRunner(input(), {
    request: async (_route, parameters) => {
      assert.equal(parameters.request.signal.aborted, true);
      return response([runner()]);
    },
    setTimer: (callback, delay) => {
      assert.equal(delay, 10_000);
      callback();
      return "timer";
    },
    clearTimer: (timer) => assert.equal(timer, "timer"),
  });
  assert.equal(result.reason, "api-timeout");
});

test("token mint is statically guarded before the App action runs", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const tokenStep = workflow.slice(
    workflow.indexOf("- name: Mint read-only observer token"),
    workflow.indexOf("- name: Select runner"),
  );
  assert.match(tokenStep, /inputs\.policy == 'prefer-self-hosted'/u);
  assert.doesNotMatch(tokenStep, /inputs\.policy == 'self-hosted-only'/u);
  for (const requiredGuard of [
    "(inputs.scope == 'organization' || inputs.scope == 'repository')",
    "github.event_name == 'push'",
    "github.event_name == 'schedule'",
    "github.event_name == 'workflow_dispatch'",
    "github.event_name == 'pull_request'",
    "github.event.repository.private == true",
    "github.event.pull_request.head.repo.full_name == github.repository",
  ]) {
    assert.ok(tokenStep.includes(requiredGuard), requiredGuard);
  }
  const comparedEvents = [
    ...tokenStep.matchAll(/github\.event_name == '([^']+)'/gu),
  ].map((match) => match[1]);
  assert.deepEqual(comparedEvents, ALLOWED_LOCAL_EVENTS);
  assert.doesNotMatch(tokenStep, /inputs\.scope\s*!=\s*''/u);
  assert.doesNotMatch(tokenStep, /github\.event_name\s*!=/u);
  for (const eventName of BLOCKED_LOCAL_EVENTS) {
    assert.ok(
      !tokenStep.includes(`github.event_name == '${eventName}'`),
      eventName,
    );
  }

  const selectStep = workflow.slice(workflow.indexOf("- name: Select runner"));
  assert.match(selectStep, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
});

test("strict selector scheduling is local while adaptive policies stay hosted", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(
    workflow,
    /runs-on: \$\{\{ inputs\.policy == 'self-hosted-only' && 'melodic-ubuntu-24\.04-x64' \|\| 'ubuntu-slim' \}\}/u,
  );
  assert.doesNotMatch(
    workflow,
    /runs-on: \$\{\{[^\n]*(?:inputs\.self-hosted-label|inputs\.self-hosted-labels-json)/u,
  );
});

test("root CI requires every selector and OSV guard contract", () => {
  const workflow = fs.readFileSync(rootCIPath, "utf8");
  const selectorLane = workflow.slice(
    workflow.indexOf("  selector-contract:"),
    workflow.indexOf("  zizmor:"),
  );
  assert.match(selectorLane, /node --test \.github\/scripts\/\*\.test\.cjs/u);
  assert.match(
    selectorLane,
    /bash \.github\/scripts\/osv-scan-guard\.test\.sh/u,
  );
  assert.match(workflow, /needs: \[[^\]]*selector-contract[^\]]*\]/u);
  assert.match(workflow, /paths: fixtures\/shell\/good \.github\/scripts/u);
});

test("workflow rejects partial outputs when github-script infrastructure fails", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const selectStep = workflow.slice(workflow.indexOf("- name: Select runner"));
  assert.match(
    workflow,
    /runner: \$\{\{ steps\.select\.outcome == 'success' && steps\.select\.outputs\.runner \|\| inputs\.policy == 'self-hosted-only' && 'ci-runner-selection-failed' \|\| 'ubuntu-24\.04' \}\}/u,
  );
  assert.doesNotMatch(
    workflow,
    /steps\.select\.outputs\.runner \|\| inputs\.hosted-runner/u,
  );
  assert.match(
    workflow,
    /route: \$\{\{ steps\.select\.outcome == 'success' && steps\.select\.outputs\.route \|\| inputs\.policy == 'self-hosted-only' && 'error' \|\| 'hosted' \}\}/u,
  );
  assert.match(
    workflow,
    /reason: \$\{\{ steps\.select\.outcome == 'success' && steps\.select\.outputs\.reason \|\| inputs\.policy == 'self-hosted-only' && 'selector-error' \|\| 'api-error' \}\}/u,
  );
  assert.match(
    workflow,
    /online-runner-count: \$\{\{ steps\.select\.outcome == 'success' && steps\.select\.outputs\.online-runner-count \|\| '0' \}\}/u,
  );
  assert.equal(
    [...workflow.matchAll(/steps\.select\.outcome == 'success'/gu)].length,
    4,
  );
  assert.match(
    selectStep,
    /id: select\n\s+continue-on-error: \$\{\{ inputs\.policy != 'self-hosted-only' \}\}\n\s+uses: actions\/github-script@/u,
  );
});

test("generated workflow implementation matches the tested source", () => {
  const renderer = path.join(__dirname, "render-select-runner-workflow.cjs");
  const result = spawnSync(process.execPath, [renderer, "--check"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("generated github-script bundle executes the tested adapter", async () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const blockStart = workflow.indexOf("          script: |\n");
  assert.notEqual(blockStart, -1);
  const script = workflow
    .slice(blockStart + "          script: |\n".length)
    .split("\n")
    .map((line) => line.replace(/^ {12}/u, ""))
    .join("\n");
  const outputs = new Map();
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const execute = new AsyncFunction("github", "core", "process", script);
  await execute(
    { request: async () => response([runner()]) },
    { setOutput: (name, value) => outputs.set(name, value) },
    {
      env: {
        POLICY: "prefer-self-hosted",
        SELF_HOSTED_LABEL: "melodic-ubuntu-24.04-x64",
        SELF_HOSTED_LABELS_JSON: "",
        HOSTED_RUNNER: "ubuntu-24.04",
        RUNNER_SCOPE: "organization",
        MANAGED_RUNNER_PREFIX: "ci-runner-melo-",
        OBSERVER_CLIENT_ID: "Iv23observer",
        HAS_OBSERVER_SECRET: "true",
        TOKEN_OUTCOME: "success",
        REPOSITORY_OWNER: "melodic-software",
        REPOSITORY_NAME: "medley",
        REPOSITORY_PRIVATE: "true",
        EVENT_NAME: "push",
        IS_FORK_PULL_REQUEST: "false",
        API_TIMEOUT_SECONDS: "10",
      },
    },
  );
  assert.equal(outputs.get("runner"), "melodic-ubuntu-24.04-x64");
  assert.equal(outputs.get("route"), "self-hosted");
  assert.equal(outputs.get("reason"), "online");
  assert.equal(outputs.get("online-runner-count"), "1");
});

test("native security workflows expose governed runners without Docker exceptions", () => {
  const osv = fs.readFileSync(
    path.join(__dirname, "..", "workflows", "osv-scanner.yml"),
    "utf8",
  );
  assert.match(osv, /runs-on: \$\{\{ inputs\.runner \}\}/u);
  assert.doesNotMatch(osv, /runner-policy-exception-template/u);
  assert.doesNotMatch(osv, /\bdocker\s+(?:run|pull|image|buildx)\b/iu);

  const zizmor = fs.readFileSync(
    path.join(__dirname, "..", "workflows", "zizmor.yml"),
    "utf8",
  );
  assert.doesNotMatch(zizmor, /runner-policy-exception-template/u);
  assert.doesNotMatch(zizmor, /\bdocker\b/iu);
});
