"use strict";

// The floor labeler runs on the same `opened` event as the intake-triage
// lane. When it lands after the lane, the event payload is stale, so it must
// decide from the issue's live labels and never re-add a floor the lane
// removed. A rate-limited call waits once and retries, as gh-api.sh does
// (ci-workflows#855), and a limit it cannot wait out fails with the reset
// time.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(__dirname, "..", "workflows", "intake-label-needs-triage.yml"),
    "utf8",
  ),
);
const step = workflow.jobs["apply-label"].steps[0];
const script = step.with.script;

// An Octokit RequestError as github-script throws it: lower-case header keys.
function refusal(status, headers = {}, message = "Forbidden") {
  return Object.assign(new Error(message), {
    status,
    response: { status, headers, url: "https://api.github.com/repos/o/r/x" },
  });
}

// `failures` maps paginate, getLabel and addLabels to the errors each throws,
// in order, before it succeeds.
async function label(
  liveLabels,
  {
    failures = {},
    waitCap = "600",
    priorityField = "",
    fieldIds = [],
    fieldFails = false,
  } = {},
) {
  const env = {
    TARGET_LABEL: "needs-triage",
    LABEL_PREFIX: "priority:",
    HUMAN_LABEL: "needs-human",
    PRIORITY_FIELD_ID: priorityField,
    RATE_LIMIT_WAIT_SECONDS: waitCap,
  };
  const original = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  const added = [];
  const failed = [];
  const warnings = [];
  const waits = [];
  const pending = Object.fromEntries(
    Object.entries(failures).map(([name, errors]) => [name, [...errors]]),
  );
  const answer = (name, value) => {
    const error = pending[name]?.shift();
    if (error) throw error;
    return value();
  };
  let thrown = null;
  try {
    const github = {
      hook: { after: () => {}, error: () => {} },
      request: async () => {
        if (fieldFails) throw new Error("field read failed");
        return { data: fieldIds.map((id) => ({ issue_field_id: id })) };
      },
      paginate: async () =>
        answer("paginate", () => {
          if (liveLabels === null) throw new Error("socket hang up");
          return liveLabels.map((name) => ({ name }));
        }),
      rest: {
        issues: {
          listLabelsOnIssue: () => {},
          getLabel: async () => answer("getLabel", () => ({})),
          addLabels: async (request) =>
            answer("addLabels", () => added.push(...request.labels)),
        },
      },
    };
    const core = {
      info: () => {},
      warning: (message) => warnings.push(message),
      setFailed: (message) => failed.push(message),
    };
    // A wait is recorded, never slept.
    const setTimeout = (resolve, ms) => {
      waits.push(ms);
      resolve();
    };
    // The payload is the `opened` snapshot: no labels yet.
    const context = {
      repo: { owner: "o", repo: "r" },
      payload: { issue: { number: 7, labels: [] } },
    };
    await new AsyncFunction(
      "require",
      "github",
      "context",
      "core",
      "process",
      "setTimeout",
      script,
    )(require, github, context, core, process, setTimeout);
  } catch (error) {
    thrown = error;
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { added, failed, warnings, waits, thrown };
}

test("an untriaged issue gets the floor label", async () => {
  const { added, failed } = await label([]);
  assert.deepEqual(added, ["needs-triage"]);
  assert.deepEqual(failed, []);
});

test("an unreadable live label list falls back to the payload and adds the floor", async () => {
  const { added, failed } = await label(null);
  assert.deepEqual(added, ["needs-triage"]);
  assert.deepEqual(failed, []);
});

test("a late run skips an issue the lane already gave a priority", async () => {
  assert.deepEqual((await label(["priority: high"])).added, []);
});

test("a late run skips an issue the lane routed to a person", async () => {
  assert.deepEqual((await label(["needs-human"])).added, []);
});

test("an issue with a Priority field value skips the floor", async () => {
  const { added } = await label([], {
    priorityField: "49622037",
    fieldIds: [49622037],
  });
  assert.deepEqual(added, []);
});

test("another field's value does not skip the floor", async () => {
  const { added } = await label([], {
    priorityField: "49622037",
    fieldIds: [15462270],
  });
  assert.deepEqual(added, ["needs-triage"]);
});

test("an unreadable Priority field falls back to the labels", async () => {
  const withLabel = await label(["priority: high"], {
    priorityField: "49622037",
    fieldFails: true,
  });
  assert.deepEqual(withLabel.added, []);
  assert.equal(withLabel.warnings.length, 1);
  const without = await label([], {
    priorityField: "49622037",
    fieldFails: true,
  });
  assert.deepEqual(without.added, ["needs-triage"]);
});

test("a 429 with retry-after waits that many seconds, then adds the floor", async () => {
  const run = await label([], {
    failures: { addLabels: [refusal(429, { "retry-after": "7" })] },
  });
  assert.deepEqual(run.waits, [7000], "one wait of retry-after seconds");
  assert.deepEqual(run.added, ["needs-triage"], "the retry applies the floor");
  assert.deepEqual(run.failed, []);
  assert.equal(run.thrown, null);
});

test("a 403 with no requests left waits until the reset, then adds the floor", async () => {
  const reset = Math.floor(Date.now() / 1000) + 120;
  const run = await label([], {
    failures: {
      getLabel: [
        refusal(403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        }),
      ],
    },
  });
  assert.equal(run.waits.length, 1, "one wait");
  assert.ok(
    run.waits[0] >= 118000 && run.waits[0] <= 120000,
    `the wait runs to the reset 120 s away, not ${run.waits[0]} ms`,
  );
  assert.deepEqual(run.added, ["needs-triage"]);
  assert.deepEqual(run.failed, []);
});

test("a 403 whose message names a rate limit, with no headers, waits 60 s", async () => {
  const run = await label([], {
    failures: {
      addLabels: [refusal(403, {}, "You have exceeded a secondary rate limit")],
    },
  });
  assert.deepEqual(run.waits, [60000]);
  assert.deepEqual(run.added, ["needs-triage"]);
});

test("a permission 403 fails at once without waiting", async () => {
  const run = await label([], {
    failures: {
      addLabels: [refusal(403, {}, "Resource not accessible by integration")],
    },
  });
  assert.deepEqual(run.waits, [], "a refusal is not waited out");
  assert.deepEqual(run.added, []);
  assert.equal(run.thrown?.message, "Resource not accessible by integration");
});

test("a wait longer than the cap fails at once with the reset time", async () => {
  const run = await label([], {
    waitCap: "600",
    failures: {
      getLabel: [
        refusal(429, {
          "retry-after": "900",
          "x-ratelimit-reset": "1793865600",
        }),
      ],
    },
  });
  assert.deepEqual(run.waits, [], "no wait past the cap");
  assert.deepEqual(run.added, []);
  assert.deepEqual(run.failed, [
    "Reading label 'needs-triage' is rate limited (HTTP 429) and needs a 900s wait, more than the 600s left of 600s. The limit resets at 2026-11-05T08:00:00.000Z.",
  ]);
});

test("a second rate limit after the wait fails with the reset time", async () => {
  const limited = () =>
    refusal(429, { "retry-after": "5", "x-ratelimit-reset": "1793865600" });
  const run = await label([], {
    failures: { addLabels: [limited(), limited()] },
  });
  assert.deepEqual(run.waits, [5000], "only one wait");
  assert.deepEqual(run.added, []);
  assert.deepEqual(run.failed, [
    "Adding 'needs-triage' is rate limited (HTTP 429) again after one wait. The limit resets at 2026-11-05T08:00:00.000Z.",
  ]);
});

test("the waits of one step share the cap", async () => {
  const run = await label([], {
    waitCap: "10",
    failures: {
      getLabel: [refusal(429, { "retry-after": "6" })],
      addLabels: [refusal(429, { "retry-after": "6" })],
    },
  });
  assert.deepEqual(
    run.waits,
    [6000],
    "the second 6 s wait passes the 10 s cap",
  );
  assert.deepEqual(run.added, []);
  assert.match(
    run.failed[0] ?? "",
    /needs a 6s wait, more than the 4s left of 10s/u,
  );
});

test("a label list still rate limited after its wait falls back to the payload", async () => {
  const limited = () => refusal(429, { "retry-after": "1" });
  const run = await label(["priority: high"], {
    failures: { paginate: [limited(), limited()] },
  });
  assert.deepEqual(run.waits, [1000]);
  assert.deepEqual(
    run.added,
    ["needs-triage"],
    "the opened payload has no labels",
  );
  assert.deepEqual(run.failed, []);
});

test("the wait cap fits inside the step's timeout, and the step inside the job's", () => {
  const job = workflow.jobs["apply-label"];
  const cap = Number(step.env.RATE_LIMIT_WAIT_SECONDS);
  assert.ok(cap > 0, "a cap is set");
  assert.ok(cap < step["timeout-minutes"] * 60, "the cap fits the step");
  assert.ok(
    step["timeout-minutes"] < job["timeout-minutes"],
    "the step fits the job",
  );
});
