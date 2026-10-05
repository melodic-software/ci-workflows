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
const workflow = fs.readFileSync(workflowPath, "utf8");
const workflowLines = workflow.split(/\r?\n/u);
const waitStepIndex = workflowLines.findIndex((line) =>
  line.includes("- name: Wait for a queued sync PR to leave the merge queue"),
);

// Same inline-script extraction technique standards-sync-automerge-arm.test.cjs uses.
function extractWaitScript() {
  assert.notEqual(waitStepIndex, -1, "merge-queue wait step must exist");
  const scriptIndex = workflowLines.findIndex(
    (line, index) => index > waitStepIndex && /^ {10}script: \|$/u.test(line),
  );
  assert.notEqual(scriptIndex, -1, "merge-queue wait script block must exist");
  const body = [];
  for (let index = scriptIndex + 1; index < workflowLines.length; index += 1) {
    const line = workflowLines[index];
    if (line.length > 0 && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return body.join("\n");
}

const waitScript = extractWaitScript();

function stepIndex(name) {
  return workflowLines.findIndex((line) => line.includes(`- name: ${name}`));
}

test("the wait runs before the target checkout, so a merged predecessor is the base", () => {
  const checkoutIndex = stepIndex("Check out target");
  assert.notEqual(checkoutIndex, -1);
  assert.ok(waitStepIndex < checkoutIndex);
});

test("the wait watches the same branch the PR step pushes", () => {
  const waitBranch = /BRANCH: (\S+)/u.exec(
    workflowLines.slice(waitStepIndex, waitStepIndex + 10).join("\n"),
  )?.[1];
  const prBranch = /branch: (\S+)/u.exec(
    workflowLines
      .slice(stepIndex("Open or update reviewed sync PR"))
      .join("\n"),
  )?.[1];
  assert.equal(waitBranch, "chore/standards-sync");
  assert.equal(prBranch, waitBranch);
});

test("the sync job timeout outlasts the whole wait budget", () => {
  const block = workflowLines
    .slice(waitStepIndex, waitStepIndex + 10)
    .join("\n");
  const maxPolls = Number(/MAX_POLLS: '(\d+)'/u.exec(block)?.[1]);
  const pollSeconds = Number(/POLL_SECONDS: '(\d+)'/u.exec(block)?.[1]);
  const syncJob = workflow.slice(workflow.indexOf("\n  sync:\n"));
  const timeoutMinutes = Number(
    /^ {4}timeout-minutes: (\d+)$/mu.exec(syncJob)?.[1],
  );
  assert.ok(maxPolls > 0 && pollSeconds > 0);
  // Ten minutes of headroom for token mint, checkout, apply, and the PR step.
  assert.ok(timeoutMinutes * 60 >= maxPolls * pollSeconds + 600);
});

test("the wait uses the target-scoped App token", () => {
  const block = workflowLines
    .slice(waitStepIndex, waitStepIndex + 12)
    .join("\n");
  assert.match(
    block,
    /github-token: \$\{\{ steps\.token\.outputs\.token \}\}/u,
  );
});

async function runWait({ responses, maxPolls = "3", pollSeconds = "30" }) {
  const keys = ["OWNER", "REPO", "BRANCH", "MAX_POLLS", "POLL_SECONDS"];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    OWNER: "melodic-software",
    REPO: "claude-code-plugins",
    BRANCH: "chore/standards-sync",
    MAX_POLLS: maxPolls,
    POLL_SECONDS: pollSeconds,
  });
  const queries = [];
  const infos = [];
  const warnings = [];
  const failures = [];
  const delays = [];
  // Records each sleep instead of taking it, so the wait's cadence is asserted.
  const setTimeout = (resolve, milliseconds) => {
    delays.push(milliseconds);
    resolve();
  };
  try {
    const github = {
      graphql: async (query, variables) => {
        queries.push({ query, variables });
        const response =
          responses[Math.min(queries.length, responses.length) - 1];
        if (response instanceof Error) throw response;
        return { repository: { pullRequests: { nodes: response } } };
      },
    };
    const core = {
      info: (message) => infos.push(message),
      warning: (message) => warnings.push(message),
      setFailed: (message) => failures.push(message),
    };
    await new AsyncFunction("github", "core", "setTimeout", waitScript)(
      github,
      core,
      setTimeout,
    );
    return { queries, infos, warnings, failures, delays };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

const sameRepo = { headRepositoryOwner: { login: "melodic-software" } };
const queueEvents = (...types) => ({
  timelineItems: { nodes: types.map((__typename) => ({ __typename })) },
});
const queued = [{ number: 6383, isInMergeQueue: true, ...sameRepo }];
const open = [{ number: 6383, isInMergeQueue: false, ...sameRepo }];

test("the query reads the latest queue event, which pull-requests read access covers", () => {
  assert.match(
    waitScript,
    /timelineItems\(last: 1, itemTypes: \[ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT\]\)/u,
  );
});

test("a queued PR is detected from its queue event when isInMergeQueue reads false", async () => {
  const enqueued = [
    {
      number: 6383,
      isInMergeQueue: false,
      ...sameRepo,
      ...queueEvents("AddedToMergeQueueEvent"),
    },
  ];
  const { queries, failures } = await runWait({ responses: [enqueued, []] });
  assert.equal(queries.length, 2);
  assert.equal(failures.length, 0);
});

test("a PR whose latest queue event is a removal proceeds at once", async () => {
  const dequeued = [
    {
      number: 6383,
      isInMergeQueue: false,
      ...sameRepo,
      ...queueEvents("RemovedFromMergeQueueEvent"),
    },
  ];
  const { queries } = await runWait({ responses: [dequeued] });
  assert.equal(queries.length, 1);
});

test("no open sync PR proceeds after one query", async () => {
  const { queries, failures } = await runWait({ responses: [[]] });
  assert.equal(queries.length, 1);
  assert.equal(failures.length, 0);
  assert.equal(queries[0].variables.headRefName, "chore/standards-sync");
  assert.match(queries[0].query, /states: \[OPEN\]/u);
});

test("an open PR outside any merge queue proceeds at once (repos without a queue)", async () => {
  const { queries, failures } = await runWait({ responses: [open] });
  assert.equal(queries.length, 1);
  assert.equal(failures.length, 0);
});

test("a queued PR is polled until it merges, then the sync proceeds", async () => {
  const { queries, failures, infos, delays } = await runWait({
    responses: [queued, queued, []],
  });
  assert.equal(queries.length, 3);
  assert.equal(failures.length, 0);
  assert.deepEqual(delays, [30_000, 30_000]);
  assert.ok(infos.some((message) => message.includes("left the merge queue")));
});

test("a PR dequeued back to open lets the sync update it", async () => {
  const { queries, failures } = await runWait({ responses: [queued, open] });
  assert.equal(queries.length, 2);
  assert.equal(failures.length, 0);
});

test("a PR still queued after the budget fails the run instead of looping forever", async () => {
  const { queries, failures, delays } = await runWait({ responses: [queued] });
  assert.equal(queries.length, 4);
  assert.equal(delays.length, 3);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /#6383/u);
  assert.match(failures[0], /still in the merge queue/u);
});

test("an unreadable queue state warns and proceeds, as the sync did before the wait", async () => {
  const { failures, warnings } = await runWait({
    responses: [new Error("Something went wrong")],
  });
  assert.equal(failures.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not read the merge-queue state/u);
});

test("a queued fork PR that reuses the branch name is not waited on", async () => {
  const { queries, failures } = await runWait({
    responses: [
      [
        {
          number: 7000,
          isInMergeQueue: true,
          headRepositoryOwner: { login: "someone-else" },
        },
      ],
    ],
  });
  assert.equal(queries.length, 1);
  assert.equal(failures.length, 0);
});

test("a non-numeric or non-positive wait budget fails before any query", async () => {
  for (const [maxPolls, pollSeconds] of [
    ["x", "30"],
    ["", "30"],
    ["3", "0"],
    ["3", "x"],
  ]) {
    const { queries, failures } = await runWait({
      responses: [queued],
      maxPolls,
      pollSeconds,
    });
    assert.equal(queries.length, 0, `${maxPolls}/${pollSeconds}`);
    assert.equal(failures.length, 1, `${maxPolls}/${pollSeconds}`);
  }
});
