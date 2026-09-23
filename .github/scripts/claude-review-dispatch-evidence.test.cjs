"use strict";

// The dispatch delivery check is two pieces: a shell step that records ids,
// and claude-lane-outcome, which decides. These tests execute the shipped
// packer (the node program inside the collect step) and pin the gates, so a
// regex over a comment cannot be the only thing standing between a dispatched
// run and a green check that posted nothing.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  classifyDispatchDelivery,
} = require("../actions/claude-lane-outcome/dispatch-evidence.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const repositoryRoot = path.join(__dirname, "..", "..");
const workflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "claude-review.yml",
);
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = parseWorkflow(workflowText);
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

function stepByName(name) {
  const step = steps.find((candidate) => candidate?.name === name);
  assert.ok(step, `step not found: ${name}`);
  return step;
}

function stepSource(name) {
  const start = workflowText.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `step source not found: ${name}`);
  const rest = workflowText.slice(start + 1);
  const next = rest.indexOf("\n      - name: ");
  return next === -1 ? rest : rest.slice(0, next);
}

const OUTCOME_PIN = "57df82e37ff14b27c0b61825c16da02499082cf7";

test("dispatch delivery steps run only when a review was actually attempted", () => {
  const snapshot = stepSource("Snapshot dispatch delivery ids");
  const collect = stepSource("Collect dispatch delivery evidence");
  const outcome = stepSource("Report review outcome");

  assert.match(snapshot, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(snapshot, /steps\.freshness\.outputs\.superseded != 'true'/u);
  assert.match(snapshot, /steps\.review-count\.outputs\.capped != 'true'/u);
  assert.match(snapshot, /continue-on-error: true/u);
  assert.doesNotMatch(snapshot, /\.body/u);

  assert.match(collect, /github\.event_name == 'workflow_dispatch'/u);
  assert.match(collect, /!cancelled\(\)/u);
  assert.match(collect, /steps\.freshness\.outputs\.superseded != 'true'/u);
  assert.match(collect, /steps\.review-count\.outputs\.capped != 'true'/u);
  assert.match(collect, /steps\.attempt\.outputs\.outcome == 'success'/u);
  assert.doesNotMatch(collect, /\.body/u);

  // The outcome step keeps the superseded / cancelled / capped gate. The
  // delivery decision is inside the composite, behind review_ran.
  assert.match(
    outcome,
    /!cancelled\(\) && steps\.freshness\.outputs\.superseded != 'true' &&\n\s+steps\.review-count\.outputs\.capped != 'true'/u,
  );
  assert.match(outcome, new RegExp(`claude-lane-outcome@${OUTCOME_PIN}`));
  assert.match(outcome, /event-name: \$\{\{ github\.event_name \}\}/u);
  assert.match(
    outcome,
    /delivery-evidence: \$\{\{ steps\.collect-delivery\.outputs\.file \}\}/u,
  );
});

test("the infra marker does not claim a no-delivery miss is an outage", () => {
  const failure = stepSource("Comment on genuine review failure");
  assert.match(failure, /failure-class != 'no-delivery'/u);
});

test("the security lane does not take the dispatch delivery check", () => {
  const security = fs.readFileSync(
    path.join(
      repositoryRoot,
      ".github",
      "workflows",
      "claude-security-review.yml",
    ),
    "utf8",
  );
  assert.equal(security.includes("delivery-evidence"), false);
  assert.equal(security.includes("no-delivery"), false);
});

test("the outcome pin declares the delivery inputs", (t) => {
  let pinned;
  try {
    pinned = execFileSync(
      "git",
      [
        "-C",
        repositoryRoot,
        "show",
        `${OUTCOME_PIN}:.github/actions/claude-lane-outcome/action.yml`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    t.skip(`pinned revision ${OUTCOME_PIN} is not reachable in this clone`);
    return;
  }
  assert.match(pinned, /^ {2}event-name:/mu);
  assert.match(pinned, /^ {2}delivery-evidence:/mu);
  assert.match(pinned, /dispatch-evidence\.cjs/u);
});

function packerProgram() {
  const run = stepByName("Collect dispatch delivery evidence").run;
  const match =
    /node - <<'DISPATCH_EVIDENCE_NODE'\n([\s\S]*?)\nDISPATCH_EVIDENCE_NODE/u.exec(
      run,
    );
  assert.ok(
    match,
    "the collect step must ship the id packer as a quoted node heredoc",
  );
  return match[1];
}

function writeIds(directory, name, lines) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  return file;
}

function runPacker(files) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "dispatch-evidence-"),
  );
  const program = path.join(directory, "pack.js");
  const evidenceFile = path.join(directory, "evidence.json");
  fs.writeFileSync(program, packerProgram());
  const env = {
    ...process.env,
    REVIEW_IDS: writeIds(directory, "reviews.txt", files.reviews),
    COMMENT_IDS: writeIds(directory, "comments.txt", files.comments),
    BASELINE_REVIEW_IDS: writeIds(
      directory,
      "baseline-reviews.txt",
      files.baselineReviews,
    ),
    BASELINE_COMMENT_IDS: writeIds(
      directory,
      "baseline-comments.txt",
      files.baselineComments,
    ),
    EVIDENCE_FILE: evidenceFile,
  };
  const result = spawnSync(process.execPath, [program], {
    encoding: "utf8",
    env,
  });
  return { result, evidenceFile, directory };
}

test("the shipped packer feeds the classifier a new review or comment", () => {
  const { result, evidenceFile, directory } = runPacker({
    reviews: ["10", "11"],
    comments: ["20"],
    baselineReviews: ["10"],
    baselineComments: ["20"],
  });
  try {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout, "");
    const decision = classifyDispatchDelivery({
      eventName: "workflow_dispatch",
      reviewAttempted: true,
      evidenceText: fs.readFileSync(evidenceFile, "utf8"),
    });
    assert.equal(decision.delivered, true);
    assert.equal(decision.failureClass, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the shipped packer feeds the classifier a dispatch that posted nothing", () => {
  const { result, evidenceFile, directory } = runPacker({
    reviews: ["10"],
    comments: ["20"],
    baselineReviews: ["10"],
    baselineComments: ["20"],
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const decision = classifyDispatchDelivery({
      eventName: "workflow_dispatch",
      reviewAttempted: true,
      evidenceText: fs.readFileSync(evidenceFile, "utf8"),
    });
    assert.equal(decision.delivered, false);
    assert.equal(decision.failureClass, "no-delivery");
    assert.match(decision.detail, /new reviews: 0, new comments: 0/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the shipped packer refuses a non-numeric id without echoing it", () => {
  const canary = "canary-never-publish-this-body";
  const { result, directory } = runPacker({
    reviews: [`11 ${canary}`],
    comments: [],
    baselineReviews: [],
    baselineComments: [],
  });
  try {
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "non-numeric delivery id\n");
    assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeFakeGh(binDirectory, routes) {
  const file = path.join(binDirectory, "gh");
  const arms = Object.entries(routes)
    .map(([suffix, lines]) => {
      const body = `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")}`;
      return `*${suffix})\n${body}\n;;`;
    })
    .join("\n");
  fs.writeFileSync(
    file,
    `#!/bin/bash
url=""
for arg in "$@"; do
  case "$arg" in
    repos/*) url="$arg" ;;
  esac
done
case "$url" in
${arms}
*)
  printf '%s\\n' "unexpected endpoint: \${url}" >&2
  exit 1
  ;;
esac
`,
  );
  fs.chmodSync(file, 0o755);
}

function runShell(name, env, routes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-shell-"));
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  writeFakeGh(bin, routes);
  const script = path.join(directory, "step.sh");
  fs.writeFileSync(script, stepByName(name).run);
  const githubOutput = path.join(directory, "github-output");
  fs.writeFileSync(githubOutput, "");
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_REPOSITORY: "melodic-software/example",
      PR_NUMBER: "3939",
      ...env,
    },
  });
  return {
    result,
    directory,
    output: fs.readFileSync(githubOutput, "utf8"),
  };
}

test("the shipped shell records ids and the classifier sees a new review", () => {
  const snapshot = runShell(
    "Snapshot dispatch delivery ids",
    {},
    {
      "/pulls/3939/reviews": ["10"],
      "/issues/3939/comments": ["20"],
    },
  );
  assert.equal(
    snapshot.result.status,
    0,
    `${snapshot.result.stdout}\n${snapshot.result.stderr}`,
  );
  const reviewIds = /^review_ids=(?<file>.*)$/mu.exec(snapshot.output)?.groups
    .file;
  const commentIds = /^comment_ids=(?<file>.*)$/mu.exec(snapshot.output)?.groups
    .file;
  assert.ok(reviewIds && commentIds, snapshot.output);
  const collect = runShell(
    "Collect dispatch delivery evidence",
    {
      BASELINE_REVIEW_IDS: reviewIds,
      BASELINE_COMMENT_IDS: commentIds,
    },
    {
      "/pulls/3939/reviews": ["10", "11"],
      "/issues/3939/comments": ["20"],
    },
  );
  try {
    assert.equal(
      collect.result.status,
      0,
      `${collect.result.stdout}\n${collect.result.stderr}`,
    );
    assert.equal(collect.result.stdout.includes("10"), false);
    const evidenceFile = /^file=(?<file>.*)$/mu.exec(collect.output)?.groups
      .file;
    assert.ok(evidenceFile, collect.output);
    const decision = classifyDispatchDelivery({
      eventName: "workflow_dispatch",
      reviewAttempted: true,
      evidenceText: fs.readFileSync(evidenceFile, "utf8"),
    });
    assert.equal(decision.delivered, true);
    assert.equal(decision.detail, "");
  } finally {
    fs.rmSync(snapshot.directory, { recursive: true, force: true });
    fs.rmSync(collect.directory, { recursive: true, force: true });
  }
});

test("the shipped shell rejects a pull request number that is not an integer", () => {
  const snapshot = runShell(
    "Snapshot dispatch delivery ids",
    { PR_NUMBER: "12;rm" },
    { "/pulls/3939/reviews": ["10"], "/issues/3939/comments": ["20"] },
  );
  try {
    assert.notEqual(snapshot.result.status, 0);
    assert.match(snapshot.result.stdout, /positive integer/u);
    assert.equal(snapshot.output.includes("review_ids="), false);
  } finally {
    fs.rmSync(snapshot.directory, { recursive: true, force: true });
  }
});

test("the shipped shell fails closed when the baseline is missing", () => {
  const collect = runShell(
    "Collect dispatch delivery evidence",
    { BASELINE_REVIEW_IDS: "", BASELINE_COMMENT_IDS: "" },
    {
      "/pulls/3939/reviews": ["10"],
      "/issues/3939/comments": ["20"],
    },
  );
  try {
    assert.notEqual(collect.result.status, 0);
    assert.match(collect.result.stdout, /baseline is missing/u);
    assert.equal(collect.output.includes("file="), false);
  } finally {
    fs.rmSync(collect.directory, { recursive: true, force: true });
  }
});

test("pull_request delivery is not required by the classifier the step calls", () => {
  // The workflow always passes github.event_name through. A pull_request
  // value must not fail closed when no evidence file was collected.
  const decision = classifyDispatchDelivery({
    eventName: "pull_request",
    reviewAttempted: true,
    evidenceText: undefined,
  });
  assert.equal(decision.applies, false);
  assert.equal(decision.delivered, true);
});
