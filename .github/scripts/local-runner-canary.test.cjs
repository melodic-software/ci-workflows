"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
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
const rootCiPath = path.join(repositoryRoot, ".github", "workflows", "ci.yml");
const selectorConformancePath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "selector-conformance.yml",
);
const templateRoot = path.join(repositoryRoot, "templates", "ci-runner-canary");
const templateWorkflowPath = path.join(
  templateRoot,
  ".github",
  "workflows",
  "local-runner-canary.yml",
);
const templateLfsPath = path.join(
  templateRoot,
  "fixtures",
  "lfs",
  "canary.txt",
);
const templateBootstrapPath = path.join(templateRoot, "bootstrap.ps1");
const currentSelectorSha = "257f584ea24f65824acd17a8d9bbfbe650d24033";
const supersededSelectorShas = [
  "4943b1c4ff6ae9624736ac95622d7ab748132c8d",
  "d94877932012972391b98dcea5ce92b804b74418",
];

const workflow = fs.readFileSync(workflowPath, "utf8");
const parityScript = fs.readFileSync(scriptPath, "utf8");
const readme = fs.readFileSync(readmePath, "utf8");
const driftWorkflow = fs.readFileSync(driftWorkflowPath, "utf8");
const rootCi = fs.readFileSync(rootCiPath, "utf8");
const selectorConformance = fs.readFileSync(selectorConformancePath, "utf8");
const templateWorkflow = fs.readFileSync(templateWorkflowPath, "utf8");

const runnerAssertionScripts = [
  ...workflow.matchAll(
    /^ {6}- name: Assert managed self-hosted runner\n(?:^ {8}.*\n)*?^ {8}run: \|\n(?<script>(?:^ {10}.*(?:\n|$))+)/gmu,
  ),
].map((match) => match.groups.script.replace(/^ {10}/gmu, ""));

function runRunnerAssertion(runnerEnvironment, runnerName) {
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ci-runner-canary-assertion-"),
  );
  const outputPath = path.join(outputDirectory, "output");
  try {
    const result = spawnSync(
      process.env.BASH_PATH || "bash",
      ["-c", runnerAssertionScripts[0]],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          RUNNER_ENVIRONMENT: runnerEnvironment,
          RUNNER_NAME: runnerName,
        },
      },
    );
    return {
      ...result,
      output: fs.existsSync(outputPath)
        ? fs.readFileSync(outputPath, "utf8")
        : "",
    };
  } finally {
    fs.rmSync(outputDirectory, { force: true, recursive: true });
  }
}

function runTemplateBootstrap(remoteUrl) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ci-runner-canary-bootstrap-"),
  );
  const targetPath = path.join(temporaryRoot, "target");
  try {
    const initialize = spawnSync(
      "git",
      ["init", "--initial-branch=main", targetPath],
      { encoding: "utf8" },
    );
    assert.equal(initialize.status, 0, initialize.stderr);

    const addRemote = spawnSync(
      "git",
      ["-C", targetPath, "remote", "add", "origin", remoteUrl],
      { encoding: "utf8" },
    );
    assert.equal(addRemote.status, 0, addRemote.stderr);

    const result = spawnSync(
      process.env.PWSH_PATH || "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-File",
        templateBootstrapPath,
        "-TargetPath",
        targetPath,
      ],
      { encoding: "utf8" },
    );
    const status = spawnSync(
      "git",
      ["-C", targetPath, "status", "--porcelain=v1"],
      { encoding: "utf8" },
    );
    assert.equal(status.status, 0, status.stderr);

    return { result, status: status.stdout };
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

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
  assert.match(
    workflow,
    /EXPECTED_REPOSITORY: melodic-software\/ci-runner-canary/u,
  );
  assert.doesNotMatch(workflow, /runs-on: (?:self-hosted|melodic-canary-)/u);
  assert.doesNotMatch(workflow, /secrets:\s+inherit/u);
});

test("immutable canary owns selector policy and direct routing outputs", () => {
  assert.doesNotMatch(
    workflow,
    /^ {6}(?:expected-(?:repository|canary-label)|selected-(?:runner|route|reason|idle-runner-count)):/mu,
  );
  assert.match(
    workflow,
    new RegExp(
      `select-runner:[\\s\\S]*?needs: preflight[\\s\\S]*?uses: melodic-software/ci-workflows/\\.github/workflows/select-runner\\.yml@${currentSelectorSha}`,
      "u",
    ),
  );
  for (const supersededSelectorSha of supersededSelectorShas) {
    assert.doesNotMatch(workflow, new RegExp(supersededSelectorSha, "u"));
  }
  assert.match(
    workflow,
    /self-hosted-label: melodic-canary-ubuntu-24\.04-x64/u,
  );
  assert.match(workflow, /managed-runner-prefix: ci-runner-canary-/u);
  assert.match(
    workflow,
    /secrets:\n {6}observer-private-key: \$\{\{ secrets\.observer-private-key \}\}/u,
  );
  const preflight = workflow.slice(
    workflow.indexOf("  preflight:"),
    workflow.indexOf("  select-runner:"),
  );
  assert.doesNotMatch(preflight, /observer-private-key/u);
  assert.match(workflow, /\[\[ "\$SELECTED_ROUTE" = self-hosted \]\]/u);
  assert.match(workflow, /\[\[ "\$SELECTED_REASON" = idle \]\]/u);
  assert.match(
    workflow,
    /\[\[ "\$SELECTED_RUNNER" = melodic-canary-ubuntu-24\.04-x64 \]\]/u,
  );
  assert.match(
    workflow,
    /\[\[ "\$IDLE_RUNNER_COUNT" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/u,
  );
  assert.equal(
    [
      ...workflow.matchAll(
        /runs-on: \$\{\{ needs\.select-runner\.outputs\.runner \}\}/gu,
      ),
    ].length,
    5,
  );
});

test("every selected job rejects hosted and unmanaged runner identities", () => {
  assert.equal(runnerAssertionScripts.length, 5);
  assert.equal(new Set(runnerAssertionScripts).size, 1);

  const desktop = runRunnerAssertion(
    "self-hosted",
    "ci-runner-canary-melo-desk-001-job-123",
  );
  assert.equal(desktop.status, 0, desktop.stderr);
  assert.match(
    desktop.output,
    /^name=ci-runner-canary-melo-desk-001-job-123$/mu,
  );
  assert.match(desktop.output, /^host=melo-desk-001$/mu);

  const laptop = runRunnerAssertion(
    "self-hosted",
    "ci-runner-canary-melo-lap-001-job-456",
  );
  assert.equal(laptop.status, 0, laptop.stderr);
  assert.match(laptop.output, /^host=melo-lap-001$/mu);

  for (const [environment, name] of [
    ["github-hosted", "GitHub Actions 1000000000"],
    ["self-hosted", "melodic-canary-ubuntu-24.04-x64"],
    ["self-hosted", "ci-runner-melo-desk-001-job-789"],
  ]) {
    const rejected = runRunnerAssertion(environment, name);
    assert.notEqual(rejected.status, 0, `${environment}/${name} was accepted`);
  }
});

test("fresh-worker proof covers container identity and all ephemeral areas", () => {
  assert.match(workflow, /container-id=\$\(<\/etc\/hostname\)/u);
  assert.match(
    workflow,
    /test "\$current_container_id" != "\$FIRST_CONTAINER_ID"/u,
  );
  assert.match(
    workflow,
    /test "\$SECOND_RUNNER_HOST" = "\$FIRST_RUNNER_HOST"/u,
  );
  assert.match(
    workflow,
    /First runner: \$\{FIRST_RUNNER_NAME\} \(\$\{FIRST_RUNNER_HOST\}\)/u,
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
    /long-running-proof:[\s\S]*?needs: \[select-runner, hosted-verify\][\s\S]*?runs-on: \$\{\{ needs\.select-runner\.outputs\.runner \}\}/u,
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
    if (action.endsWith("/.github/workflows/select-runner.yml")) {
      assert.equal(comment, "governed selector review");
    } else {
      assert.match(
        comment ?? "",
        /^v\d+\.\d+\.\d+$/u,
        `${action} has no release comment`,
      );
    }
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

test("private caller documentation delegates selection and passes only the observer secret", () => {
  assert.match(readme, /CI_MANAGED_RUNNER_PREFIX/u);
  assert.match(readme, /ci-runner-canary-/u);
  assert.match(readme, /immutable reusable\s+workflow owns the selector/u);
  assert.match(
    readme,
    /observer-private-key: \$\{\{ secrets\.CI_RUNNER_OBSERVER_PRIVATE_KEY \}\}/u,
  );
  assert.doesNotMatch(readme, /^\s+secrets:\s+inherit\s*$/mu);
});

test("canonical private seed pins the corrected reusable contract", () => {
  const expectedReusableSha = "bb762391c41e9d12975fae25a06ac930050baba9";
  for (const source of [rootCi, selectorConformance]) {
    assert.match(source, /fetch-depth: 0[\s\S]*?lfs: true/u);
  }
  assert.match(templateWorkflow, /^ {2}workflow_dispatch:/mu);
  assert.doesNotMatch(templateWorkflow, /^ {2}(?:push|pull_request):/mu);
  assert.match(
    templateWorkflow,
    new RegExp(
      `uses: melodic-software/ci-workflows/\\.github/workflows/local-runner-canary\\.yml@${expectedReusableSha} # reviewed canary contract`,
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
  assert.doesNotMatch(templateWorkflow, /selected-(?:runner|route|reason)/u);
  assert.doesNotMatch(templateWorkflow, /<[^>]+>/u);
  const dependabot = fs.readFileSync(
    path.join(templateRoot, ".github", "dependabot.yml"),
    "utf8",
  );
  assert.match(dependabot, /package-ecosystem: github-actions/u);
  assert.match(dependabot, /interval: weekly/u);
  assert.match(dependabot, /cooldown:\n {6}default-days: 7/u);

  const pinned = spawnSync(
    "git",
    [
      "show",
      `${expectedReusableSha}:.github/workflows/local-runner-canary.yml`,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.match(
    pinned.stdout,
    /EXPECTED_REPOSITORY: melodic-software\/ci-runner-canary/u,
  );
  assert.match(
    pinned.stdout,
    /select-runner\.yml@4943b1c4ff6ae9624736ac95622d7ab748132c8d/u,
  );
  assert.doesNotMatch(pinned.stdout, /inputs\.selected-runner/u);
});

test("canonical seed carries a real reviewed Git LFS object and safe bootstrap", () => {
  const expectedDigest =
    "962ab05586b24dbc1c300c70385ead92d59393900fb9240f6d4d5cc949ec1cb2";
  const attributes = fs.readFileSync(
    path.join(templateRoot, ".gitattributes"),
    "utf8",
  );
  assert.match(
    attributes,
    /^fixtures\/lfs\/canary\.txt filter=lfs diff=lfs merge=lfs -text$/mu,
  );

  const materialized = fs.readFileSync(templateLfsPath);
  assert.equal(materialized.toString("utf8"), "ci-runner-canary-lfs-v1\n");
  assert.equal(
    createHash("sha256").update(materialized).digest("hex"),
    expectedDigest,
  );
  assert.match(
    rootCi,
    /selector-contract:[\s\S]*?uses: actions\/checkout@[0-9a-f]{40}[\s\S]*?lfs: true/u,
  );
  assert.match(
    selectorConformance,
    /selector-unit:[\s\S]*?uses: actions\/checkout@[0-9a-f]{40}[\s\S]*?lfs: true/u,
  );

  const indexed = spawnSync(
    "git",
    ["show", ":templates/ci-runner-canary/fixtures/lfs/canary.txt"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(
    indexed.status,
    0,
    "template LFS fixture must be staged or committed",
  );
  assert.equal(
    indexed.stdout,
    `version https://git-lfs.github.com/spec/v1\noid sha256:${expectedDigest}\nsize 24\n`,
  );

  const cacheFixture = fs.readFileSync(
    path.join(templateRoot, "fixtures", "cache", "canary.lock"),
    "utf8",
  );
  assert.equal(cacheFixture, "ci-runner-canary-cache-v1\n");

  const bootstrap = fs.readFileSync(
    path.join(templateRoot, "bootstrap.ps1"),
    "utf8",
  );
  assert.match(bootstrap, /melodic-software\/ci-runner-canary/u);
  assert.match(bootstrap, /'lfs', 'install', '--local'/u);
  assert.match(bootstrap, /'lfs', 'ls-files', '--name-only'/u);
  assert.match(bootstrap, /'show', ':fixtures\/lfs\/canary\.txt'/u);
  assert.doesNotMatch(bootstrap, /ArgumentList[^\n]*(?:'commit'|'push')/u);
});

test("bootstrap accepts only GitHub's canonical HTTPS and SSH origins", () => {
  const allowedOrigins = [
    "https://github.com/melodic-software/ci-runner-canary.git",
    "git@github.com:melodic-software/ci-runner-canary.git",
  ];

  for (const origin of allowedOrigins) {
    const { result, status } = runTemplateBootstrap(origin);
    assert.equal(
      result.status,
      0,
      `${origin}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(
      status,
      /^A {2}\.github\/workflows\/local-runner-canary\.yml$/mu,
    );
    assert.match(status, /^A {2}fixtures\/lfs\/canary\.txt$/mu);
  }
});

test("bootstrap rejects lookalike and noncanonical origins before staging", () => {
  const rejectedOrigins = [
    "https://evilgithub.com/melodic-software/ci-runner-canary.git",
    "https://github.com.evil.example/melodic-software/ci-runner-canary.git",
    "git@evilgithub.com:melodic-software/ci-runner-canary.git",
    "git@github.com:melodic-software/ci-runner-canary-evil.git",
    "https://github.com/melodic-software/ci-runner-canary",
  ];

  for (const origin of rejectedOrigins) {
    const { result, status } = runTemplateBootstrap(origin);
    assert.notEqual(result.status, 0, `${origin} unexpectedly passed`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /Target origin is not melodic-software\/ci-runner-canary/u,
    );
    assert.equal(status, "", `${origin} staged files before rejection`);
  }
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
