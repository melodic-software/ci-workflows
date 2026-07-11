"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const pinPath = path.join(repositoryRoot, ".github", "osv-scanner-pin.json");
const workflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "osv-scanner.yml",
);
const driftWorkflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "tool-version-drift-check.yml",
);

const pin = JSON.parse(fs.readFileSync(pinPath, "utf8"));
const workflow = fs.readFileSync(workflowPath, "utf8");
const driftWorkflow = fs.readFileSync(driftWorkflowPath, "utf8");

test("OSV pin is a complete reviewed-release and exact-platform contract", () => {
  assert.equal(pin.schemaVersion, 1);
  assert.equal(pin.component, "google/osv-scanner-action");
  assert.match(pin.version, /^\d+\.\d+\.\d+$/u);
  const [major, minor] = pin.version.split(".").map(Number);
  assert.ok(
    major > 2 || (major === 2 && minor >= 4),
    "OSV pin must retain the v2.4 baseline",
  );
  assert.match(pin.sourceRevision, /^[0-9a-f]{40}$/u);
  assert.equal(pin.sourceUrl, "https://github.com/google/osv-scanner");
  assert.equal(pin.releaseUrl, `${pin.sourceUrl}/releases/tag/v${pin.version}`);
  assert.deepEqual(pin.image, {
    repository: "ghcr.io/google/osv-scanner-action",
    platform: "linux/amd64",
    digest: pin.image.digest,
  });
  assert.match(pin.image.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(pin.update, {
    releaseApi:
      "https://api.github.com/repos/google/osv-scanner/releases/latest",
    tagPrefix: "v",
    driftWorkflow: ".github/workflows/tool-version-drift-check.yml",
    automaticMerge: false,
  });
});

test("OSV workflow deploys only the manifest digest and verifies release labels", () => {
  const embedded = Object.fromEntries(
    [...workflow.matchAll(/^ {6}(OSV_[A-Z_]+): (.+)$/gmu)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  assert.deepEqual(embedded, {
    OSV_IMAGE_REPOSITORY: pin.image.repository,
    OSV_IMAGE_DIGEST: pin.image.digest,
    OSV_IMAGE_PLATFORM: pin.image.platform,
    OSV_VERSION: pin.version,
    OSV_SOURCE_REVISION: pin.sourceRevision,
  });
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(
    workflow,
    /docker pull --platform "\$OSV_IMAGE_PLATFORM" "\$image"/u,
  );
  assert.match(workflow, /org\.opencontainers\.image\.version/u);
  assert.match(workflow, /org\.opencontainers\.image\.revision/u);
  assert.match(workflow, /\{\{\.Os\}\}\/\{\{\.Architecture\}\}/u);
  assert.match(
    workflow,
    /image="\$\{OSV_IMAGE_REPOSITORY\}@\$\{OSV_IMAGE_DIGEST\}"/u,
  );
  assert.doesNotMatch(workflow, /uses:\s*google\/osv-scanner-action/u);
  assert.doesNotMatch(workflow, /ghcr\.io\/google\/osv-scanner-action:/u);
});

test("OSV workflow preserves one JSON scan, annotations, SARIF, and upload semantics", () => {
  const scannerStep = workflow.slice(
    workflow.indexOf("- name: Run OSV-Scanner"),
    workflow.indexOf("- name: Guard against an empty scan"),
  );
  const reporterStep = workflow.slice(
    workflow.indexOf("- name: Report findings"),
    workflow.indexOf("- name: Upload SARIF artifact"),
  );
  const sarifPolicyStep = workflow.slice(
    workflow.indexOf("- name: Verify SARIF artifact"),
    workflow.indexOf("- name: Upload SARIF artifact"),
  );
  assert.match(scannerStep, /--entrypoint \/root\/osv-scanner/u);
  assert.match(scannerStep, /--output-file=\/results\/results\.json/u);
  assert.match(workflow, /--format=json/u);
  assert.match(reporterStep, /--entrypoint \/root\/osv-reporter/u);
  assert.match(
    reporterStep,
    /if: \$\{\{ steps\.scan-policy\.outputs\.reportable == 'true' \}\}/u,
  );
  assert.match(
    reporterStep,
    /--output-files='sarif:\/results\/results\.sarif,gh-annotations:#stderr'/u,
  );
  assert.match(reporterStep, /--new=\/results\/results\.json/u);
  assert.match(workflow, /--fail-on-vuln="\$FAIL_ON_VULN"/u);
  assert.match(workflow, /uses: actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /results-dir \}\}\/results\.sarif/u);
  assert.match(sarifPolicyStep, /OSV_POLICY_PHASE: sarif/u);
  assert.match(
    workflow,
    /steps\.scan-policy\.outputs\.reportable == 'true' && steps\.sarif-policy\.outputs\.uploadable == 'true'/u,
  );
});

test("OSV containers receive minimum mounts, capabilities, network, and no host credentials", () => {
  const scannerStep = workflow.slice(
    workflow.indexOf("- name: Run OSV-Scanner"),
    workflow.indexOf("- name: Guard against an empty scan"),
  );
  const reporterStep = workflow.slice(
    workflow.indexOf("- name: Report findings"),
    workflow.indexOf("- name: Upload SARIF artifact"),
  );
  for (const step of [scannerStep, reporterStep]) {
    assert.match(step, /--platform "\$OSV_IMAGE_PLATFORM"/u);
    assert.match(step, /--user "0:\$\(id -g\)"/u);
    assert.match(step, /--cap-drop=ALL/u);
    assert.match(step, /--security-opt no-new-privileges/u);
    assert.doesNotMatch(
      step,
      /\/var\/run\/docker\.sock|--env(?:-file)?(?:\s|=)/u,
    );
  }
  assert.match(scannerStep, /\$GITHUB_WORKSPACE:\/github\/workspace:ro/u);
  assert.match(scannerStep, /\$OSV_RESULTS_DIR:\/results/u);
  assert.match(reporterStep, /--network none/u);
  assert.match(reporterStep, /\$OSV_RESULTS_DIR:\/results/u);
  assert.doesNotMatch(reporterStep, /GITHUB_WORKSPACE|github\/workspace/u);
});

test("generated scan-exit guard matches its tested shell source", () => {
  const renderer = path.join(__dirname, "render-osv-scan-guard.cjs");
  const result = spawnSync(process.execPath, [renderer, "--check"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    workflow,
    /SCAN_EXIT: \$\{\{ steps\.scan\.outputs\.exit-code \}\}/u,
  );
  assert.match(workflow, /0 \| 1\)/u);
  assert.match(workflow, / {2}128\)/u);
  assert.equal(
    workflow.match(/Source: \.github\/scripts\/osv-scan-guard\.sh/gu)?.length,
    2,
  );

  const behaviorTests = fs.readFileSync(
    path.join(__dirname, "osv-scan-guard.test.sh"),
    "utf8",
  );
  assert.match(
    behaviorTests,
    /"advisory operational error warns" 0 127 false false array false/u,
  );
  assert.match(
    behaviorTests,
    /"declared dependency-less scan accepts null results without reporting" 0 0 true true null false/u,
  );
});

test("scheduled drift check owns shell-embedded OSV version and digest updates", () => {
  assert.equal(
    pin.update.driftWorkflow,
    ".github/workflows/tool-version-drift-check.yml",
  );
  assert.match(driftWorkflow, /\.github\/osv-scanner-pin\.json/u);
  assert.match(driftWorkflow, /repos\/google\/osv-scanner\/releases\/latest/u);
  assert.match(driftWorkflow, /docker buildx imagetools inspect/u);
  assert.match(driftWorkflow, /\.image\.digest/u);
  assert.match(driftWorkflow, /\.platform\.architecture == \$architecture/u);
  assert.match(driftWorkflow, /OSV-Scanner action image/u);
});
