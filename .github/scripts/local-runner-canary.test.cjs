"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const workflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "local-runner-canary.yml",
);
const scriptPath = path.join(
  repositoryRoot,
  ".github",
  "scripts",
  "local-runner-parity.sh",
);
const readmePath = path.join(repositoryRoot, "README.md");
const driftWorkflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "tool-version-drift-check.yml",
);

const workflow = fs.readFileSync(workflowPath, "utf8");
const parityScript = fs.readFileSync(scriptPath, "utf8");
const readme = fs.readFileSync(readmePath, "utf8");
const driftWorkflow = fs.readFileSync(driftWorkflowPath, "utf8");

test("canary is reusable-only and cannot route a public repository locally", () => {
  assert.match(workflow, /^on:\n {2}workflow_call:/mu);
  assert.doesNotMatch(
    workflow,
    /^ {2}(push|pull_request|workflow_dispatch):/mu,
  );
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.match(workflow, /\[\[ "\$EVENT_NAME" = workflow_dispatch \]\]/u);
  assert.match(workflow, /\[\[ "\$REPOSITORY_PRIVATE" = true \]\]/u);
  assert.match(workflow, /\[\[ "\$SOURCE_REF" = refs\/heads\/main \]\]/u);
  assert.match(workflow, /\[\[ "\$RUN_ATTEMPT" = 1 \]\]/u);
  assert.doesNotMatch(workflow, /runs-on: (?:self-hosted|melodic-canary-)/u);
  assert.doesNotMatch(workflow, /secrets:\s+inherit/u);
});

test("preflight accepts only internally consistent selector proof outputs", () => {
  assert.match(workflow, /\[\[ "\$SELECTED_ROUTE" = self-hosted \]\]/u);
  assert.match(workflow, /\[\[ "\$SELECTED_REASON" = idle \]\]/u);
  assert.match(
    workflow,
    /\[\[ "\$SELECTED_RUNNER" = "\$EXPECTED_CANARY_LABEL" \]\]/u,
  );
  assert.match(
    workflow,
    /\[\[ "\$IDLE_RUNNER_COUNT" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/u,
  );
  assert.equal(
    [...workflow.matchAll(/runs-on: \$\{\{ inputs\.selected-runner \}\}/gu)]
      .length,
    5,
  );
  assert.match(
    workflow,
    /needs: preflight\n {4}runs-on: \$\{\{ inputs\.selected-runner \}\}/u,
  );
});

test("fresh-worker proof covers container identity and all ephemeral areas", () => {
  assert.match(workflow, /container-id=\$\(<\/etc\/hostname\)/u);
  assert.match(
    workflow,
    /test "\$current_container_id" != "\$FIRST_CONTAINER_ID"/u,
  );
  for (const area of [
    '"$HOME"',
    '"$work_root"',
    '"$RUNNER_TEMP"',
    '"$RUNNER_TOOL_CACHE"',
    "/tmp",
    "/usr/local/share",
  ]) {
    assert.ok(workflow.includes(area), `missing sentinel area ${area}`);
  }
});

test("hosted and self-hosted run one immutable compatibility implementation", () => {
  assert.equal(
    [
      ...workflow.matchAll(
        /repository: \$\{\{ steps\.contract\.outputs\.repository \}\}/gu,
      ),
    ].length,
    2,
  );
  assert.equal(
    [...workflow.matchAll(/ref: \$\{\{ steps\.contract\.outputs\.sha \}\}/gu)]
      .length,
    2,
  );
  assert.match(workflow, /\.workflow_repository/u);
  assert.match(workflow, /\.workflow_sha/u);
  assert.equal([...workflow.matchAll(/local-runner-parity\.sh/gu)].length, 2);
  assert.match(workflow, /lfs: true/u);
  assert.match(workflow, /actions\/setup-dotnet@/u);
  assert.match(workflow, /actions\/setup-node@/u);
  assert.match(workflow, /actions\/setup-python@/u);
  assert.match(parityScript, /git lfs ls-files --name-only/u);
  assert.match(parityScript, /pwsh -NoLogo/u);
  assert.match(parityScript, /sudo -n true/u);
  assert.match(parityScript, /update-ca-certificates/u);
  assert.match(parityScript, /ssl\.create_default_context\(\)\.get_ca_certs/u);
  assert.match(parityScript, /<PublishAot>true<\/PublishAot>/u);
  assert.match(parityScript, /--runtime linux-x64/u);
});

test("artifacts and nonsecret caches prove both transfer directions", () => {
  for (const action of [
    "actions/upload-artifact@",
    "actions/download-artifact@",
    "actions/cache/save@",
    "actions/cache/restore@",
  ]) {
    assert.ok(workflow.includes(action), `missing ${action}`);
  }
  for (const direction of ["hosted-to-self", "self-to-hosted"]) {
    assert.ok(workflow.includes(direction), `missing ${direction} proof`);
  }
  for (const keyPart of [
    "runner.os",
    "runner.arch",
    "inputs.dotnet-version",
    "hashFiles(inputs.cache-key-file)",
    "inputs.cache-epoch",
  ]) {
    assert.ok(workflow.includes(keyPart), `cache key omits ${keyPart}`);
  }
  assert.match(workflow, /diff --unified "\$HOSTED_RESULT" "\$SELF_RESULT"/u);
});

test("long proof is downstream and independently exceeds sixteen minutes", () => {
  assert.match(workflow, /long-proof-minutes:[\s\S]*?default: 16/u);
  assert.match(
    workflow,
    /long-running-proof:[\s\S]*?needs: hosted-verify[\s\S]*?runs-on: \$\{\{ inputs\.selected-runner \}\}/u,
  );
  assert.match(workflow, /sleep "\$\(\(PROOF_MINUTES \* 60\)\)"/u);
  assert.match(workflow, /test "\$elapsed" -ge "\$minimum"/u);
});

test("cancellation remains an explicit human observation with no replay", () => {
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /if: inputs\.mode == 'cancellation'/u);
  assert.match(workflow, /trap on_cancel INT TERM/u);
  assert.match(
    workflow,
    /Do not rerun this attempt; dispatch a new full canary afterward/u,
  );
  assert.doesNotMatch(workflow, /always\(\)/u);
  assert.doesNotMatch(workflow, /gh (?:api|run)/u);
  assert.doesNotMatch(workflow, /\/actions\/runs\/.*\/(?:cancel|rerun)/u);
});

test("every external action is pinned to a full SHA with a release comment", () => {
  const uses = [
    ...workflow.matchAll(/^\s+uses: ([^\s@]+)@([^\s]+)(?:\s+#\s+(.+))?$/gmu),
  ];
  assert.ok(uses.length > 0);
  for (const [, action, ref, comment] of uses) {
    assert.match(ref, /^[0-9a-f]{40}$/u, `${action} is not immutable`);
    assert.match(
      comment ?? "",
      /^v\d+\.\d+\.\d+$/u,
      `${action} has no release comment`,
    );
  }
});

test("daily drift evidence owns every exact canary runtime default", () => {
  assert.match(driftWorkflow, /\.github\/workflows\/local-runner-canary\.yml/u);
  for (const runtime of [
    "dotnet-version:dotnet:.NET SDK",
    "node-version:node:Node.js",
    "python-version:python:Python",
  ]) {
    assert.ok(
      driftWorkflow.includes(runtime),
      `missing drift owner for ${runtime}`,
    );
  }
  assert.match(driftWorkflow, /builds\.dotnet\.microsoft\.com/u);
  assert.match(driftWorkflow, /nodejs\.org\/dist\/index\.json/u);
  assert.match(
    driftWorkflow,
    /actions\/python-versions\/main\/versions-manifest\.json/u,
  );
  assert.match(driftWorkflow, /Never auto-merge these updates/u);
});

test("private caller documentation uses the selector and an explicit observer secret", () => {
  assert.match(readme, /CI_MANAGED_RUNNER_PREFIX/u);
  assert.match(readme, /ci-runner-canary-/u);
  assert.match(readme, /needs\.select-runner\.outputs\.runner/u);
  assert.match(readme, /needs\.select-runner\.outputs\.idle-runner-count/u);
  assert.match(
    readme,
    /observer-private-key: \$\{\{ secrets\.CI_RUNNER_OBSERVER_PRIVATE_KEY \}\}/u,
  );
  assert.doesNotMatch(readme, /^\s+secrets:\s+inherit\s*$/mu);
});

test("parity script rejects an incomplete invocation before side effects", () => {
  const bash = process.env.BASH_PATH || "bash";
  const result = spawnSync(bash, [scriptPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /^usage:/u);
});
