"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const repositoryRoot = path.join(__dirname, "..", "..");
const workflowPath = path.join(
  __dirname,
  "..",
  "workflows",
  "claude-lane-incident-aggregator.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");

// Same inline-script extraction technique standards-sync-stuck-automerge-alert
// .test.cjs uses: pull the actions/github-script body out of the YAML by step
// name and execute it directly against mocks, so the shipped text is the text
// under test rather than a copy that can drift.
function extractStepScript(stepName) {
  const lines = workflow.split(/\r?\n/u);
  const stepIndex = lines.findIndex((line) =>
    line.includes(`- name: ${stepName}`),
  );
  assert.notEqual(stepIndex, -1, `step '${stepName}' must exist`);
  const scriptIndex = lines.findIndex(
    (line, index) => index > stepIndex && /^ {10}script: \|$/u.test(line),
  );
  assert.notEqual(scriptIndex, -1, `'${stepName}' script block must exist`);
  const body = [];
  for (let index = scriptIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 0 && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return body.join("\n");
}

function stepSource(stepName) {
  const stepIndex = workflow.indexOf(`- name: ${stepName}`);
  assert.ok(stepIndex >= 0, `step '${stepName}' is missing`);
  const nextStepOffset = workflow
    .slice(stepIndex + 1)
    .search(/\n\s*(?:#[^\n]*\n\s*)*- name:/u);
  return nextStepOffset >= 0
    ? workflow.slice(stepIndex, stepIndex + 1 + nextStepOffset)
    : workflow.slice(stepIndex);
}

// Every step in the `aggregate` job, by name. The partition tests below are only
// as complete as this enumerator, so it asserts that every step opens with
// `name:` — an anonymous step would be invisible to `stepSource` and would
// therefore skip both halves of the partition.
function aggregateStepNames() {
  const marker = "\n    steps:\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "the aggregate job must declare steps");
  const names = [];
  for (const line of workflow.slice(start + marker.length).split(/\r?\n/u)) {
    if (line.trim().length > 0 && !line.startsWith("      ")) break;
    const bullet = /^ {6}- (.*)$/u.exec(line);
    if (!bullet) continue;
    const named = /^name: (.+)$/u.exec(bullet[1]);
    assert.ok(named, `every step must open with 'name:'; found: ${bullet[1]}`);
    names.push(named[1]);
  }
  assert.ok(names.length > 0, "the aggregate job must declare at least one step");
  return names;
}

function permissionsBlock(indent) {
  const marker = `\n${" ".repeat(indent)}permissions:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `a permissions block at indent ${indent} is missing`);
  const scopes = {};
  for (const line of workflow.slice(start + marker.length).split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    if (!line.startsWith(" ".repeat(indent + 2))) break;
    if (line.trim().startsWith("#")) continue;
    const entry = /^\s*([a-z-]+): (read|write|none)$/u.exec(line);
    assert.ok(entry, `unparsable permissions entry: ${line}`);
    scopes[entry[1]] = entry[2];
  }
  return scopes;
}

// The one condition every writing step shares, verbatim.
const WRITE_GATE = "env.WRITES_ENABLED == 'true'";

// THE WRITER REGISTRY. Membership is the only sanctioned way for a step to
// mutate this repository, and the partition below makes it self-enforcing: a
// new write step that is not registered trips the no-mutation check, and one
// that is registered trips the gate check unless it carries the gate.
const WRITER_STEPS = [
  "Open or update the incident issue",
  "Close the recovered incident issue",
];

// Actions a non-writing step may delegate to. `github-script` is on the list
// despite being fully write-capable, because what it does is legible inline and
// the call scan below reads it; the point of the allowlist is that a step
// cannot smuggle write capability into an opaque third-party action.
const READ_ONLY_ACTIONS = new Set([
  "actions/checkout",
  "actions/create-github-app-token",
  "actions/github-script",
]);

// Write capability reaches GitHub through more than the three issue verbs this
// workflow happens to call, so the scan is written against the shapes rather
// than the endpoints: any mutating REST verb in any namespace, the raw
// request/GraphQL escape hatches that can name any route, the gh CLI, and a
// hand-rolled HTTP call.
const MUTATING_CALLS = [
  [
    /\.rest\.[A-Za-z]+\.(?:create|update|delete|add|remove|set|replace|merge|lock|unlock|transfer|convert)[A-Za-z]*\(/u,
    "a mutating Octokit REST verb",
  ],
  [
    /\b(?:github|octokit)\.(?:request|graphql)\(/u,
    "a raw request or GraphQL call, which can name any verb and any route",
  ],
  [
    /\bgh (?:api|issue|pr|release|label|repo|run|workflow|secret|variable|cache|project)\b/u,
    "a gh CLI subcommand",
  ],
  [/\bcurl\b[^\n]*(?:-X|--request)\b/u, "a curl carrying an explicit method"],
];

const laneAnnotation = (failureClass, status) =>
  `Claude review exited with: failure class=${failureClass} (infrastructure ` +
  `error, not a code-quality signal). Last SDK result: ` +
  `{"subtype":"success","is_error":true,"api_error_status":${status},` +
  `"class":"${failureClass}"}`;

function checkRun({
  id = 1,
  name = "review / review",
  annotationsCount = 0,
  status = "completed",
  conclusion = "success",
} = {}) {
  return {
    id,
    name,
    status,
    conclusion,
    output: { annotations_count: annotationsCount },
  };
}

/**
 * Execute the shipped poll script against a mock Octokit.
 *
 * `failFor` is a list of substrings; any read whose description contains one
 * throws, standing in for a 403 under a narrowed credential, a rate limit, or a
 * transient 5xx.
 */
async function runPoll({
  hasInstallation = false,
  installationRepositories = [],
  repositoriesOverride = "",
  pullsByRepo = {},
  checkRunsByPull = {},
  annotationsByCheckRun = {},
  failFor = [],
} = {}) {
  const keys = [
    "LOOKBACK_HOURS",
    "REPOSITORIES_OVERRIDE",
    "HAS_INSTALLATION",
    "GITHUB_WORKSPACE",
  ];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    LOOKBACK_HOURS: "24",
    REPOSITORIES_OVERRIDE: repositoriesOverride,
    HAS_INSTALLATION: String(hasInstallation),
    GITHUB_WORKSPACE: repositoryRoot,
  });

  const calls = [];
  const outputs = {};
  const warnings = [];
  try {
    const maybeFail = (label) => {
      if (failFor.some((fragment) => label.includes(fragment))) {
        throw new Error(`simulated read failure for ${label}`);
      }
    };
    // The poll reaches three endpoints through `paginate.iterator` and one
    // directly, so the mock routes by endpoint identity rather than by call
    // order. Each entry here RESOLVES a paginated endpoint — its call-record
    // shape, its failure label, and its full result set — without performing a
    // request; the requests are the pages the iterator below walks. Keeping
    // resolution and request separate is what makes `calls` a one-record-per-
    // HTTP-request ledger, and therefore a usable oracle for the `api-calls`
    // output. Recording once here AND once per page would double-count every
    // single-page read.
    const endpoints = {
      installation: () => ({
        record: { kind: "installation" },
        label: "installation",
        items: installationRepositories,
      }),
      checkRuns: ({ owner, repo, ref }) => ({
        record: { kind: "checks", repo: `${owner}/${repo}`, ref },
        label: `checks:${owner}/${repo}`,
        items: checkRunsByPull[ref] ?? [],
      }),
      annotations: ({ check_run_id: checkRunId }) => ({
        record: { kind: "annotations", checkRunId },
        label: `annotations:${checkRunId}`,
        items: annotationsByCheckRun[checkRunId] ?? [],
      }),
    };
    // Page-aware on purpose. A mock that hands back one flattened array cannot
    // tell "walked three pages" from "one call returned everything", which is
    // exactly how an unbounded walk and an undercounted API budget hide. This
    // chunks each endpoint's result into pages of PAGE_SIZE and records one
    // request per page — carrying that endpoint's own kind, so the per-endpoint
    // filters below keep working — leaving the poll's page cap and its reported
    // budget both observable.
    const PAGE_SIZE = 100;
    const github = {
      paginate: {
        iterator: (endpoint, params) => ({
          async *[Symbol.asyncIterator]() {
            const { record, label, items } = endpoint(params);
            const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
            for (let page = 0; page < pages; page += 1) {
              // Recorded BEFORE the failure check, matching the direct
              // `pulls.list` mock below: a request that 403s was still a
              // request, and a ledger that omitted it would understate the
              // budget exactly on the cycles that go wrong.
              calls.push({ ...record, page: page + 1 });
              maybeFail(label);
              yield {
                data: items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
              };
            }
          },
        }),
      },
      rest: {
        apps: { listReposAccessibleToInstallation: endpoints.installation },
        pulls: {
          list: async ({ owner, repo, page }) => {
            const label = `pulls:${owner}/${repo}`;
            calls.push({ kind: "pulls", repo: `${owner}/${repo}`, page });
            maybeFail(label);
            const pages = pullsByRepo[`${owner}/${repo}`] ?? [];
            return { data: pages[page - 1] ?? [] };
          },
        },
        checks: {
          listForRef: endpoints.checkRuns,
          listAnnotations: endpoints.annotations,
        },
      },
    };
    const core = {
      setOutput: (key, value) => (outputs[key] = value),
      setFailed: (message) => assert.fail(`unexpected setFailed: ${message}`),
      warning: (message) => warnings.push(message),
      info: () => {},
    };
    const context = {
      repo: { owner: "melodic-software", repo: "ci-workflows" },
    };
    const execute = new AsyncFunction(
      "github",
      "core",
      "context",
      "require",
      "process",
      extractStepScript("Poll consumer repositories for lane failure signals"),
    );
    await execute(github, core, context, require, process);
    return { calls, outputs, warnings, tally: JSON.parse(outputs.tally) };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

const recentPull = (number, sha, repository = "melodic-software/medley") => ({
  number,
  head: { sha, repo: { full_name: repository } },
  updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
});

const forkPull = (number, sha) => ({
  number,
  head: { sha, repo: { full_name: "outsider/medley" } },
  updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
});

// --- The write gate --------------------------------------------------------
//
// The incident issue lives in this repository, so the writes are same-repo and
// `issues: write` on the ambient token carries them. That ends the older
// guarantee that rested on the job holding no write scope at all. What replaces
// it is the partition these tests enforce: every step in the job is either a
// REGISTERED WRITER whose `if:` leads with the one shared gate, or a step with
// no mutating API surface and no action outside the read-only allowlist. Both
// halves are derived from the workflow text rather than hand-listed, so adding
// an ungated write step fails CI whichever way it is added.

test("the job's permission set is exactly one write scope — issues — and nothing else is widened", () => {
  assert.deepEqual(permissionsBlock(4), {
    checks: "read",
    contents: "read",
    issues: "write",
    "pull-requests": "read",
  });
  assert.deepEqual(permissionsBlock(0), { contents: "read" });
});

test("the write gate is defined once, from the dry-run input and nothing else", () => {
  assert.match(
    workflow,
    /^ {6}WRITES_ENABLED: \$\{\{ github\.event\.inputs\.dry-run != 'true' \}\}$/mu,
    "the gate must be a single job-level env expression over the dry-run input",
  );
  // Deriving it from the App token would rebuild the coupling this change
  // exists to break: writes must work with or without a credential.
  const definition = /^ {6}WRITES_ENABLED: .*$/mu.exec(workflow)[0];
  assert.doesNotMatch(definition, /credential|secrets\./u);
});

// Evaluate the SHIPPED gate expression rather than a restatement of it, so
// inverting the operator or renaming the input fails the table below.
function evaluateWriteGate(inputs) {
  const definition = /^ {6}WRITES_ENABLED: \$\{\{ (.+) \}\}$/mu.exec(workflow);
  assert.ok(definition, "the write gate must be one ${{ }} expression");
  const parsed = /^github\.event\.inputs\.([a-z-]+) (==|!=) '([^']*)'$/u.exec(
    definition[1],
  );
  assert.ok(parsed, `unsupported gate expression: ${definition[1]}`);
  const [, input, operator, literal] = parsed;
  const actual = inputs?.[input] ?? "";
  return operator === "==" ? actual === literal : actual !== literal;
}

test("the dry-run input suppresses writes, and every other event shape enables them", () => {
  assert.equal(
    evaluateWriteGate({ "dry-run": "true" }),
    false,
    "a dispatch asking for a dry run must not write",
  );
  assert.equal(evaluateWriteGate({ "dry-run": "false" }), true);
  // `github.event.inputs` is absent on `schedule`, and an absent input never
  // equals 'true' — so the hourly cycle writes.
  assert.equal(evaluateWriteGate(undefined), true);
});

test("every registered writer leads its condition with the shared gate and authors with the ambient token", () => {
  for (const name of WRITER_STEPS) {
    const step = stepSource(name);
    // Leading conjunct, not merely present: a gate reached through `||` is not
    // a gate, and one appended after another condition is easy to lose in a
    // later edit.
    assert.match(
      step,
      /^ {8}if: env\.WRITES_ENABLED == 'true'(?: &&|$)/mu,
      `'${name}' must open its 'if:' with ${WRITE_GATE}`,
    );
    assert.match(
      step,
      /(?:^|\W)(?:github-)?token: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/mu,
      `'${name}' must author with the ambient token`,
    );
    assert.doesNotMatch(
      step,
      /steps\.credential\.outputs\.token/u,
      `'${name}' must not depend on the App token — the write path has to work without one`,
    );
  }
});

test("every step is either a registered writer or provably incapable of writing", () => {
  const names = aggregateStepNames();
  for (const name of WRITER_STEPS) {
    assert.ok(names.includes(name), `registered writer '${name}' is not a step`);
  }
  for (const name of names) {
    if (WRITER_STEPS.includes(name)) continue;
    const step = stepSource(name);
    for (const [pattern, description] of MUTATING_CALLS) {
      assert.doesNotMatch(
        step,
        pattern,
        `'${name}' is not a registered writer but reaches ${description}`,
      );
    }
    for (const [, action] of step.matchAll(/^\s*uses: ([^@\s]+)@/gmu)) {
      assert.ok(
        READ_ONLY_ACTIONS.has(action),
        `'${name}' is not a registered writer but delegates to '${action}', which is not on the read-only allowlist`,
      );
    }
  }
});

test("the dry-run report is gated on the negation of the write gate", () => {
  // Mutually exclusive with the writers by construction, so no run can both
  // write the issue and print that it wrote nothing.
  assert.match(
    stepSource("Publish the dry-run report"),
    /^ {8}if: env\.WRITES_ENABLED != 'true'$/mu,
  );
});

test("the App credential is minted read-only, whenever its secret exists", () => {
  const step = stepSource("Mint the aggregator App token");
  // No dry-run term: the token only reads, so a dry run can hold one and render
  // the body a live run would have written against the full installation.
  assert.match(step, /^ {8}if: env\.HAS_APP_CREDENTIAL == 'true'$/mu);
  assert.match(step, /permission-checks: read/u);
  assert.match(step, /permission-pull-requests: read/u);
  assert.match(step, /permission-issues: read/u);
  assert.doesNotMatch(
    step,
    /permission-[a-z-]+: write/u,
    "the App token authors nothing, so it must request no write permission",
  );
  assert.match(
    workflow,
    /HAS_APP_CREDENTIAL: \$\{\{ secrets\.CLAUDE_LANE_INCIDENT_APP_PRIVATE_KEY != '' \}\}/u,
  );
});

test("the reading steps prefer the App token and fall back to the ambient one, so an App-less run still reads", () => {
  for (const name of [
    "Poll consumer repositories for lane failure signals",
    "Find the open incident issue",
  ]) {
    assert.match(
      stepSource(name),
      /github-token: \$\{\{ steps\.credential\.outputs\.token \|\| secrets\.GITHUB_TOKEN \}\}/u,
      `'${name}' must degrade to the ambient token when no App token was minted`,
    );
  }
});

test("the run logs the API-call count as an explicit deliverable line", () => {
  assert.match(
    workflow,
    /echo "claude-lane-incident: api-calls=\$\{api_calls\}[^"]*read-errors=\$\{READ_ERRORS\}/u,
  );
  // The total must cover every read the run made. The poll and the issue
  // lookup are the two reading steps, and both feed the sum.
  assert.match(
    workflow,
    /api_calls=\$\(\( POLL_API_CALLS \+ LOOKUP_API_CALLS \)\)/u,
  );
  assert.match(
    extractStepScript("Find the open incident issue"),
    /core\.setOutput\("api-calls"/u,
  );
});

test("the workflow is scheduled and dispatched only — no push trigger can consume a clean cycle", () => {
  const triggerBlock = workflow.slice(
    workflow.indexOf("\non:"),
    workflow.indexOf("\nconcurrency:"),
  );
  assert.doesNotMatch(triggerBlock, /^ {2}push:/mu);
  assert.match(triggerBlock, /^ {2}schedule:/mu);
  assert.match(triggerBlock, /^ {2}workflow_dispatch:/mu);
});

test("the issue lookup and close steps run on github-script, not the gh CLI", () => {
  for (const name of [
    "Find the open incident issue",
    "Close the recovered incident issue",
  ]) {
    const step = stepSource(name);
    assert.match(step, /uses: actions\/github-script@/u, name);
    assert.doesNotMatch(
      step.slice(step.indexOf("script: |")),
      /\bgh (api|issue|pr)\b/u,
      name,
    );
  }
});

test("the schedule and its serialization are declared", () => {
  assert.match(workflow, /- cron: '17 \* \* \* \*'/u);
  // Overlapping cycles would race on one issue body; queued-not-cancelled keeps
  // a long poll from being retired by the next hour's tick.
  assert.match(
    workflow,
    /group: claude-lane-incident-aggregator\n {2}cancel-in-progress: false/u,
  );
});

// --- Polling behavior ------------------------------------------------------

test("an uncredentialed run degrades to this repository alone and still classifies the cycle", async () => {
  // The App seam is optional by design. Without it the poll must narrow rather
  // than fail: no installation read it cannot perform, and a real verdict from
  // the one repository the ambient token can always reach.
  const { outputs, calls } = await runPoll({ hasInstallation: false });
  assert.equal(outputs.repositories, "1");
  assert.deepEqual(
    calls.filter((call) => call.kind === "pulls").map((call) => call.repo),
    ["melodic-software/ci-workflows"],
  );
  assert.equal(
    calls.some((call) => call.kind === "installation"),
    false,
    "an uncredentialed run must not attempt an installation read it cannot perform",
  );

  const detected = await runPoll({
    hasInstallation: false,
    pullsByRepo: {
      "melodic-software/ci-workflows": [
        [recentPull(12, "sha-a", "melodic-software/ci-workflows")],
      ],
    },
    checkRunsByPull: { "sha-a": [checkRun({ id: 90, annotationsCount: 1 })] },
    annotationsByCheckRun: { 90: [{ message: laneAnnotation("auth", 401) }] },
  });
  assert.equal(detected.outputs["read-errors"], "0");
  assert.equal(
    detected.outputs.cycle,
    "incident",
    "an App-less run must still detect an escalating class, not report indeterminate",
  );
});

test("a credentialed run polls exactly the installation's non-archived repositories", async () => {
  const { outputs, calls } = await runPoll({
    hasInstallation: true,
    installationRepositories: [
      { full_name: "melodic-software/medley", archived: false },
      { full_name: "melodic-software/dotfiles", archived: false },
      { full_name: "melodic-software/medley-archive", archived: true },
    ],
  });
  assert.equal(outputs.repositories, "2");
  assert.deepEqual(
    calls.filter((call) => call.kind === "pulls").map((call) => call.repo),
    ["melodic-software/medley", "melodic-software/dotfiles"],
  );
});

test("an explicit repository override wins over the installation", async () => {
  const { calls } = await runPoll({
    hasInstallation: true,
    installationRepositories: [{ full_name: "melodic-software/medley" }],
    repositoriesOverride:
      "melodic-software/dotfiles, melodic-software/github-iac",
  });
  assert.deepEqual(
    calls.filter((call) => call.kind === "pulls").map((call) => call.repo),
    ["melodic-software/dotfiles", "melodic-software/github-iac"],
  );
});

test("an escalating annotation on a green lane check run produces an incident cycle", async () => {
  const { outputs, tally } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: {
      "sha-a": [
        checkRun({ id: 90, annotationsCount: 1, conclusion: "success" }),
      ],
    },
    annotationsByCheckRun: { 90: [{ message: laneAnnotation("auth", 402) }] },
  });
  assert.equal(outputs.cycle, "incident");
  assert.deepEqual(tally.classCounts, { auth: 1 });
  assert.deepEqual(tally.statusCounts, { 402: 1 });
  assert.deepEqual(Object.keys(tally.repositories), [
    "melodic-software/medley",
  ]);
});

test("a transient class is counted but does not open an incident", async () => {
  const { outputs, tally } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: { "sha-a": [checkRun({ id: 90, annotationsCount: 1 })] },
    annotationsByCheckRun: {
      90: [{ message: laneAnnotation("rate-limit", 429) }],
    },
  });
  assert.equal(outputs.cycle, "clean");
  assert.deepEqual(tally.classCounts, { "rate-limit": 1 });
});

test("an unreadable repository is counted as a read error and never reported as clean", async () => {
  const { outputs, warnings } = await runPoll({
    repositoriesOverride: "melodic-software/medley,melodic-software/dotfiles",
    pullsByRepo: {
      "melodic-software/dotfiles": [
        [recentPull(3, "sha-b", "melodic-software/dotfiles")],
      ],
    },
    checkRunsByPull: { "sha-b": [checkRun({ id: 91 })] },
    failFor: ["pulls:melodic-software/medley"],
  });
  assert.equal(outputs["read-errors"], "1");
  assert.equal(
    outputs["lane-runs"],
    "1",
    "the readable repository was still scanned",
  );
  assert.equal(
    outputs.cycle,
    "indeterminate",
    "a partial poll must never advance the clean-cycle counter",
  );
  assert.equal(warnings.length, 1);
});

test("a read failure on one repository does not abort the scan of the others", async () => {
  const { calls } = await runPoll({
    repositoriesOverride: "melodic-software/medley,melodic-software/dotfiles",
    pullsByRepo: {
      "melodic-software/dotfiles": [
        [recentPull(3, "sha-b", "melodic-software/dotfiles")],
      ],
    },
    failFor: ["pulls:melodic-software/medley"],
  });
  assert.deepEqual(
    calls.filter((call) => call.kind === "pulls").map((call) => call.repo),
    ["melodic-software/medley", "melodic-software/dotfiles"],
  );
});

test("only lane check runs are counted, and only annotated ones cost an annotations call", async () => {
  const { outputs, calls } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: {
      "sha-a": [
        checkRun({ id: 90, name: "ci-status", annotationsCount: 4 }),
        checkRun({ id: 91, name: "review / review", annotationsCount: 0 }),
        checkRun({
          id: 92,
          name: "security-review / security-review",
          annotationsCount: 1,
        }),
      ],
    },
    annotationsByCheckRun: { 92: [{ message: laneAnnotation("auth", 401) }] },
  });
  assert.equal(outputs["lane-runs"], "2", "ci-status is not a lane check run");
  assert.deepEqual(
    calls
      .filter((call) => call.kind === "annotations")
      .map((call) => call.checkRunId),
    [92],
  );
  assert.equal(outputs.cycle, "incident");
});

test("a SKIPPED lane check run is not evidence that the lanes are running", async () => {
  // The kill-switch, a draft PR, and skip-actors all produce a name-stable
  // skipped lane job. Counting one as liveness is how flipping
  // CLAUDE_LANES_DISABLED during a credential outage would auto-close the very
  // incident tracking it, with nothing being reviewed.
  for (const shape of [
    { status: "completed", conclusion: "skipped" },
    { status: "completed", conclusion: "cancelled" },
    { status: "completed", conclusion: "neutral" },
    { status: "in_progress", conclusion: null },
  ]) {
    const { outputs } = await runPoll({
      repositoriesOverride: "melodic-software/medley",
      pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
      checkRunsByPull: { "sha-a": [checkRun({ id: 90, ...shape })] },
    });
    assert.equal(outputs["lane-runs"], "0", JSON.stringify(shape));
    assert.equal(outputs.cycle, "indeterminate", JSON.stringify(shape));
  }

  // The same head with one genuinely completed lane run IS evidence.
  const { outputs } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: {
      "sha-a": [
        checkRun({ id: 90, conclusion: "skipped" }),
        checkRun({ id: 91, name: "security-review / security-review" }),
      ],
    },
  });
  assert.equal(outputs["lane-runs"], "1");
  assert.equal(outputs.cycle, "clean");
});

test("a skipped lane check run still has its annotations read", async () => {
  // Liveness and detection are separate questions: the lane concludes green on
  // an infrastructure failure, so an annotation must never be filtered out by
  // the conclusion that hid the failure in the first place.
  const { outputs, tally } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: {
      "sha-a": [
        checkRun({ id: 90, conclusion: "skipped", annotationsCount: 1 }),
      ],
    },
    annotationsByCheckRun: { 90: [{ message: laneAnnotation("auth", 401) }] },
  });
  assert.equal(outputs["lane-runs"], "0");
  assert.equal(outputs.cycle, "incident");
  assert.deepEqual(tally.classCounts, { auth: 1 });
});

test("a fork pull request cannot vote on liveness or open an incident", async () => {
  // A fork head ships its own workflow files, so an outside contributor could
  // declare a job named `review` emitting any annotation they like. The lanes
  // do not review fork PRs at all, so a fork head is never this fleet's signal.
  const { outputs, tally, calls } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[forkPull(12, "sha-fork")]] },
    checkRunsByPull: {
      "sha-fork": [checkRun({ id: 90, annotationsCount: 1 })],
    },
    annotationsByCheckRun: { 90: [{ message: laneAnnotation("auth", 401) }] },
  });
  assert.equal(outputs.pulls, "0");
  assert.equal(outputs["lane-runs"], "0");
  assert.deepEqual(tally.classCounts, {});
  assert.equal(
    calls.some((call) => call.kind === "checks"),
    false,
    "a fork head must not even cost an API call",
  );
});

test("check runs and annotations are paginated, neither truncated at one page nor refused", async () => {
  // A busy consumer head already carries dozens of check runs. Reading one page
  // and dropping the rest loses lane runs silently; refusing to read past one
  // page instead makes that repository raise a read error every cycle forever,
  // pinning the whole fleet at `indeterminate` so no incident can ever
  // auto-close. Both are wrong — the poll paginates, as it already does for the
  // installation list and the open-issue lookup.
  const poll = extractStepScript(
    "Poll consumer repositories for lane failure signals",
  );
  // Pinned as "goes through the paginating helper", NOT as `github.paginate`.
  // The poll deliberately rejects that form: it returns one flattened array
  // that hides how many requests it made — which would silently undercount the
  // API budget this workflow's deliverable line reports — and it follows Link
  // headers to exhaustion, so a consumer publishing thousands of annotations
  // could walk the poll past its own job timeout. `readAll` walks the iterator
  // instead, counting and capping. So three things are pinned: the helper
  // paginates, both endpoints go through it, and neither is ever invoked
  // directly — a direct call is the single-page read this test exists to rule
  // out, and it would pass a check that only looked for the helper.
  assert.match(
    poll,
    /const readAll = async \([\s\S]*?github\.paginate\.iterator\(endpoint, params\)/u,
    "readAll must paginate, not issue a single request",
  );
  for (const endpoint of ["listForRef", "listAnnotations"]) {
    assert.match(
      poll,
      new RegExp(
        `await readAll\\(\\s*\`[^\`]*\`,\\s*github\\.rest\\.checks\\.${endpoint},`,
        "u",
      ),
      `checks.${endpoint} must be read through readAll`,
    );
    assert.doesNotMatch(
      poll,
      new RegExp(`github\\.rest\\.checks\\.${endpoint}\\(`, "u"),
      `checks.${endpoint} must never be invoked directly — that reads one page`,
    );
  }

  const { outputs } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: {
      "sha-a": Array.from({ length: 140 }, (_unused, index) =>
        checkRun({ id: index + 1, name: "ci-status" }),
      ).concat([checkRun({ id: 500, name: "review / review" })]),
    },
  });
  assert.equal(outputs["read-errors"], "0");
  assert.equal(
    outputs["lane-runs"],
    "1",
    "a lane run past the first page must still be seen",
  );
  assert.equal(outputs.cycle, "clean");
});

test("the ambient token is granted every read the poll makes, or an App-less run sees nothing", () => {
  // Declaring `permissions:` sets every unlisted scope to `none`. The check-run
  // and annotation endpoints require Checks:read with no public-repository
  // exemption, so omitting them 403s the first read of every uncredentialed run
  // and reports `indeterminate` forever — a workflow that ships doing nothing.
  const scopes = permissionsBlock(4);
  for (const scope of ["checks", "contents", "issues", "pull-requests"]) {
    assert.ok(
      scopes[scope] === "read" || scopes[scope] === "write",
      `the job must grant at least ${scope}: read`,
    );
  }
});

test("a bound that truncates the scan is reported as a read error, never as a silent trim", async () => {
  const { outputs } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: {
      "sha-a": Array.from({ length: 13 }, (_unused, index) =>
        checkRun({ id: index + 1, name: "review / review" }),
      ),
    },
  });
  assert.equal(outputs["read-errors"], "1");
  assert.equal(outputs.cycle, "indeterminate");
});

test("pagination stops at the lookback edge rather than walking history", async () => {
  const stale = {
    number: 99,
    head: { sha: "sha-old" },
    updated_at: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
  };
  const { calls, outputs } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: {
      "melodic-software/medley": [
        Array.from({ length: 99 }, (_unused, index) =>
          recentPull(index + 1, "sha-a"),
        ).concat([stale]),
        [recentPull(500, "sha-c")],
      ],
    },
    checkRunsByPull: { "sha-a": [] },
  });
  assert.equal(
    calls.filter((call) => call.kind === "pulls").length,
    1,
    "the second page must never be fetched once the lookback edge is crossed",
  );
  assert.equal(outputs.pulls, "99");
  assert.equal(outputs["read-errors"], "0");
});

test("the API-call count reported to the log is the number of reads actually attempted", async () => {
  const single = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: { "sha-a": [checkRun({ id: 90, annotationsCount: 1 })] },
    annotationsByCheckRun: { 90: [{ message: laneAnnotation("auth", 401) }] },
  });
  assert.equal(Number(single.outputs["api-calls"]), single.calls.length);

  // The single-page case above is satisfied by any accounting that happens to
  // land on the right total; only a MULTI-page read distinguishes "counts
  // requests" from "counts reads". Both paginated endpoints span two pages
  // here, so a helper that counted once per read rather than once per page
  // would undercount by two — which is precisely how the dominant
  // per-pull-request term of the reported budget would go silently wrong.
  const paged = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: {
      "sha-a": Array.from({ length: 140 }, (_unused, index) =>
        checkRun({ id: index + 1, name: "ci-status" }),
      ).concat([
        checkRun({ id: 500, name: "review / review", annotationsCount: 1 }),
      ]),
    },
    annotationsByCheckRun: {
      500: Array.from({ length: 150 }, () => ({
        message: laneAnnotation("auth", 401),
      })),
    },
  });
  assert.equal(Number(paged.outputs["api-calls"]), paged.calls.length);
  assert.equal(
    paged.calls.length,
    5,
    "one pulls page, two check-run pages, two annotation pages",
  );
});

test("a paginated read that fails still costs the request it made", async () => {
  // The read helpers count the request before they know it failed, so a 403
  // under a narrowed credential is visible in the budget rather than shrinking
  // it. Without this the accounting seam is only exercised on the happy path.
  const { outputs, calls } = await runPoll({
    repositoriesOverride: "melodic-software/medley",
    pullsByRepo: { "melodic-software/medley": [[recentPull(12, "sha-a")]] },
    checkRunsByPull: { "sha-a": [checkRun({ id: 90, annotationsCount: 1 })] },
    failFor: ["checks:melodic-software/medley"],
  });
  assert.equal(
    calls.filter((call) => call.kind === "checks").length,
    1,
    "the failed check-run read is still one request",
  );
  assert.equal(Number(outputs["api-calls"]), calls.length);
  assert.equal(outputs["read-errors"], "1");
  assert.equal(
    outputs.cycle,
    "indeterminate",
    "an unreadable head must never be reported clean",
  );
});

// --- Issue selection -------------------------------------------------------

async function runLookup(openIssues) {
  const keys = ["GITHUB_WORKSPACE"];
  const originalValues = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  process.env.GITHUB_WORKSPACE = repositoryRoot;
  const outputs = {};
  let failedWith = null;
  try {
    const github = {
      paginate: {
        iterator: () => ({
          async *[Symbol.asyncIterator]() {
            yield { data: openIssues };
          },
        }),
      },
      rest: { issues: { listForRepo: () => {} } },
    };
    const core = {
      setOutput: (key, value) => (outputs[key] = value),
      setFailed: (message) => (failedWith = message),
    };
    const context = {
      repo: { owner: "melodic-software", repo: "ci-workflows" },
    };
    const execute = new AsyncFunction(
      "github",
      "core",
      "context",
      "require",
      "process",
      extractStepScript("Find the open incident issue"),
    );
    await execute(github, core, context, require, process);
    return { outputs, failedWith };
  } finally {
    for (const key of keys) {
      if (originalValues[key] === undefined) delete process.env[key];
      else process.env[key] = originalValues[key];
    }
  }
}

const { SELECTOR_MARKER } = require("./claude-lane-incident.cjs");

test("the lookup adopts the bot-authored issue carrying the marker", async () => {
  const { outputs } = await runLookup([
    { number: 42, user: { type: "Bot" }, body: `${SELECTOR_MARKER}\nreport` },
  ]);
  assert.equal(outputs.number, "42");
  assert.match(outputs.body, /report/u);
});

test("a human-authored decoy carrying the public marker is never adopted", async () => {
  const { outputs, failedWith } = await runLookup([
    { number: 7, user: { type: "User" }, body: `${SELECTOR_MARKER}\ndecoy` },
    { number: 8, user: { type: "User" }, body: `${SELECTOR_MARKER}\ndecoy` },
  ]);
  assert.equal(failedWith, null, "decoys must not fail the lookup closed");
  assert.equal(outputs.number, "");
});

test("a pull request carrying the marker is not mistaken for the incident issue", async () => {
  const { outputs } = await runLookup([
    {
      number: 9,
      user: { type: "Bot" },
      pull_request: {},
      body: `${SELECTOR_MARKER}\nnot an issue`,
    },
  ]);
  assert.equal(outputs.number, "");
});

test("two genuine bot-authored incident issues fail the lookup closed", async () => {
  const { failedWith } = await runLookup([
    { number: 1, user: { type: "Bot" }, body: SELECTOR_MARKER },
    { number: 2, user: { type: "Bot" }, body: SELECTOR_MARKER },
  ]);
  assert.match(failedWith, /found 2 open issues carrying the incident marker/u);
});
