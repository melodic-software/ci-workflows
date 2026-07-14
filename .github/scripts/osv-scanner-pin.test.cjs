"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const pin = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, ".github", "osv-scanner-pin.json"),
    "utf8",
  ),
);
const workflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "osv-scanner.yml"),
  "utf8",
);
const driftWorkflow = fs.readFileSync(
  path.join(
    repositoryRoot,
    ".github",
    "workflows",
    "tool-version-drift-check.yml",
  ),
  "utf8",
);

test("OSV pin is a complete native release and provenance contract", () => {
  assert.equal(pin.schemaVersion, 2);
  assert.equal(pin.component, "google/osv-scanner");
  assert.match(pin.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(pin.releaseUrl, `${pin.sourceUrl}/releases/tag/v${pin.version}`);
  assert.deepEqual(pin.binary, {
    asset: "osv-scanner_linux_amd64",
    platform: "linux/amd64",
    sha256: pin.binary.sha256,
  });
  assert.match(pin.binary.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(pin.provenance.asset, "multiple.intoto.jsonl");
  assert.match(pin.provenance.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(pin.provenance.sourceUri, "github.com/google/osv-scanner");
  assert.equal(pin.provenance.sourceTag, `v${pin.version}`);
  assert.equal(pin.verifier.repository, "slsa-framework/slsa-verifier");
  assert.match(pin.verifier.sha256, /^[0-9a-f]{64}$/u);
});

test("workflow runs the native binary on a caller-selected runner and verifies SLSA", () => {
  assert.match(workflow, /runner:\n\s+description: Runner label selected/u);
  assert.match(workflow, /runner:\n[\s\S]*?required: true/u);
  assert.doesNotMatch(workflow, /runner:\n[\s\S]*?default: ubuntu-24\.04/u);
  assert.match(workflow, /runs-on: \$\{\{ inputs\.runner \}\}/u);
  assert.match(workflow, new RegExp(`OSV_VERSION: ${pin.version}`, "u"));
  assert.match(workflow, new RegExp(`OSV_ASSET: ${pin.binary.asset}`, "u"));
  assert.match(workflow, new RegExp(`OSV_SHA256: ${pin.binary.sha256}`, "u"));
  assert.match(
    workflow,
    new RegExp(`OSV_PROVENANCE_SHA256: ${pin.provenance.sha256}`, "u"),
  );
  assert.match(
    workflow,
    new RegExp(`SLSA_VERIFIER_VERSION: ${pin.verifier.version}`, "u"),
  );
  assert.match(
    workflow,
    new RegExp(`SLSA_VERIFIER_SHA256: ${pin.verifier.sha256}`, "u"),
  );
  assert.match(workflow, /verify-artifact "\$binary"/u);
  assert.match(workflow, /--source-uri github\.com\/google\/osv-scanner/u);
  assert.match(workflow, /--source-tag "v\$OSV_VERSION"/u);
  assert.match(workflow, /"\$OSV_BINARY" scan source/u);
  assert.match(workflow, /--format=sarif/u);
  assert.doesNotMatch(workflow, /\bdocker\s+(?:run|pull|image|buildx)\b/iu);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/u);
  assert.doesNotMatch(workflow, /continue-on-error/u);
});

test("OSV result handling is generated from the tested fail-closed guard", () => {
  const renderer = path.join(__dirname, "render-osv-scan-guard.cjs");
  const result = spawnSync(process.execPath, [renderer, "--check"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    workflow.match(/Source: \.github\/scripts\/osv-scan-guard\.sh/gu)?.length,
    1,
  );
  assert.match(
    workflow,
    /operationally \(exit \$SCAN_EXIT\); results are not trusted/u,
  );
  assert.match(
    workflow,
    /exit and result mismatch/u.test(workflow)
      ? /exit and result mismatch/u
      : /disagrees with SARIF finding count/u,
  );
  assert.doesNotMatch(workflow, /retention-days|Upload SARIF artifact/u);
});

test("scheduled drift check tracks the native release asset digest", () => {
  assert.match(driftWorkflow, /\.binary\.asset/u);
  assert.match(driftWorkflow, /\.binary\.sha256/u);
  assert.match(driftWorkflow, /releases\/latest/u);
  assert.doesNotMatch(driftWorkflow, /docker buildx imagetools inspect/u);
});
