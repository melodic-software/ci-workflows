"use strict";

// The binary check behind pr-audit-workflows.yml's standards fallback: the
// lane's own run step, with the real pinned zizmor it downloads and verifies
// and the real melodic-software/standards .github/zizmor.yml at the commit
// download-standards resolves, fails a caller with no config of its own that
// plants a third-party tag ref, and passes the same caller with that ref
// SHA-pinned. Needs the network (the zizmor release and standards).

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const repositoryRoot = path.join(__dirname, "..", "..");
const document = parseWorkflow(
  fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "pr-audit-workflows.yml"),
    "utf8",
  ),
);
const inputs = document.on.workflow_call.inputs;
const step = document.jobs.zizmor.steps.find((entry) => entry?.id === "zizmor");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zizmor-standards-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.mkdirSync(path.join(root, "tmp"));

// One checkout of standards for the file, as the lane's checkout step makes.
const standardsCheckout = execFileSync(
  "bash",
  [
    path.join(
      repositoryRoot,
      ".github",
      "actions",
      "download-standards",
      "checkout.sh",
    ),
  ],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_TEMP: path.join(root, "tmp"),
      GITHUB_STEP_SUMMARY: "",
    },
    stdio: ["ignore", "pipe", "inherit"],
  },
).trim();

function audit(name, ref) {
  const workspace = path.join(root, name);
  fs.mkdirSync(path.join(workspace, ".github", "workflows"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(workspace, ".github", "workflows", "planted.yml"),
    `name: Planted
on:
  push:
permissions: {}
jobs:
  planted:
    runs-on: ubuntu-24.04
    steps:
      - uses: foo/bar@${ref}
`,
  );
  return spawnSync("bash", ["-c", step.run], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
      RUNNER_TEMP: path.join(root, "tmp"),
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: path.join(root, `${name}-output`),
      STANDARDS_CHECKOUT: standardsCheckout,
      PATHS: ".github/workflows",
      REQUESTED_VERSION: inputs.version.default,
      EXPECTED_SHA256: inputs.sha256.default,
      ONLINE_AUDITS: "false",
      PERSONA: "regular",
      FAIL_ON_FINDINGS: "false",
      // The highest threshold: the finding blocks at every one a caller can set.
      FAIL_ON_SEVERITY: "high",
      UPLOAD_SARIF: "false",
      // Online audits are off; zizmor still refuses an empty token.
      ZIZMOR_TOKEN: "unused-offline",
      PINNED_VERSION: step.env.PINNED_VERSION,
      ASSET_NAME: step.env.ASSET_NAME,
    },
  });
}

test("under standards' config a planted third-party tag fails the lane", () => {
  const result = audit("tag", "v1");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(
    output,
    /zizmor config: \.github\/zizmor\.yml from melodic-software\/standards at [0-9a-f]{40}/u,
  );
  assert.match(output, /unpinned-uses/u);
});

test("under standards' config the same ref SHA-pinned passes", () => {
  const result = audit("hash", "0123456789abcdef0123456789abcdef01234567");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
});
