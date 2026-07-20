"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const workflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "zizmor.yml"),
  "utf8",
);
const readme = fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8");

const pinnedVersion = "1.27.0";
const pinnedSha256 =
  "277f2bd8fd37cf60c42ab7afca6faa884e65440fa31e02b44bdaae60f62a358f";
const assetName = "zizmor-x86_64-unknown-linux-gnu.tar.gz";

function inputDefault(inputName) {
  const lines = workflow.split(/\r?\n/u);
  const inputStart = lines.indexOf(`      ${inputName}:`);
  assert.notEqual(inputStart, -1, `missing input ${inputName}`);

  for (let index = inputStart + 1; index < lines.length; index += 1) {
    if (/^ {6}\S/u.test(lines[index])) {
      break;
    }
    const match = lines[index].match(/^ {8}default: (.+)$/u);
    if (match) {
      return match[1].trim();
    }
  }

  assert.fail(`missing inputs.${inputName}.default`);
}

function runStep() {
  const start = workflow.indexOf("      - name: Run zizmor");
  assert.notEqual(start, -1, "missing native zizmor run step");
  return workflow.slice(start);
}

test("native zizmor preserves the reusable interface and read-only boundary", () => {
  assert.equal(inputDefault("runner"), "ubuntu-24.04");
  assert.equal(inputDefault("paths"), ".github/workflows");
  assert.equal(inputDefault("version"), `v${pinnedVersion}`);
  assert.equal(inputDefault("sha256"), pinnedSha256);
  assert.equal(inputDefault("online-audits"), "true");
  assert.equal(inputDefault("persona"), "regular");
  assert.equal(inputDefault("fail-on-severity"), "never");
  assert.equal(inputDefault("fail-on-findings"), "false");

  for (const existingInput of [
    "paths",
    "version",
    "online-audits",
    "persona",
    "fail-on-severity",
    "fail-on-findings",
  ]) {
    assert.match(workflow, new RegExp(`^ {6}${existingInput}:$`, "mu"));
  }

  assert.match(workflow, /^permissions:\n {2}contents: read\n\njobs:/mu);
  assert.doesNotMatch(workflow, /(?:permissions:|^ {2,})[^\n]*write/mu);
  assert.match(workflow, /^ {4}runs-on: \$\{\{ inputs\.runner \}\}$/mu);
  assert.match(
    workflow,
    /uses: actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7\.0\.0/u,
  );
  assert.match(workflow, /persist-credentials: false/u);
});

test("native zizmor verifies the exact release before executing it", () => {
  const step = runStep();
  assert.match(step, new RegExp(`PINNED_VERSION: ${pinnedVersion}`, "u"));
  assert.match(step, new RegExp(`ASSET_NAME: ${assetName}`, "u"));
  assert.match(step, /EXPECTED_SHA256: \$\{\{ inputs\.sha256 \}\}/u);
  assert.match(step, /latest\) resolved_version=\$PINNED_VERSION/u);
  assert.match(
    step,
    /url="https:\/\/github\.com\/zizmorcore\/zizmor\/releases\/download\/v\$\{resolved_version\}\/\$\{ASSET_NAME\}"/u,
  );
  assert.match(step, /--proto '=https'/u);
  assert.match(step, /--proto-redir '=https' --tlsv1\.2/u);
  assert.match(step, /--connect-timeout 10 --max-time 120/u);
  assert.match(step, /--retry 2 --retry-max-time 300/u);
  assert.doesNotMatch(step, /--retry-delay/u);
  assert.doesNotMatch(step, /--retry-all-errors/u);
  assert.match(step, /sha256sum --check --strict -/u);
  assert.match(step, /--no-same-owner zizmor/u);
  assert.match(step, /mkdir -- "\$work_dir\/cache"/u);
  assert.match(step, /version_output=\$\("\$binary" --version\)/u);
  assert.match(step, /"\$actual_version" != "\$resolved_version"/u);

  const checksum = step.indexOf("sha256sum --check --strict -");
  const extract = step.indexOf("tar --extract --gzip");
  const execute = step.indexOf('GH_TOKEN="$token" "$binary"');
  assert.ok(
    checksum >= 0 && checksum < extract,
    "checksum must precede extraction",
  );
  assert.ok(extract < execute, "verified extraction must precede execution");

  assert.doesNotMatch(step, /zizmorcore\/zizmor-action/u);
  assert.doesNotMatch(step, /\bdocker\b/iu);
  assert.doesNotMatch(step, /\bsudo\b/u);
  assert.doesNotMatch(step, /releases\/latest/u);
});

test("native zizmor limits token exposure and fails closed outside findings", () => {
  const step = runStep();
  const unsetToken = step.indexOf("unset ZIZMOR_TOKEN");
  const download = step.indexOf("curl --fail");
  const verifiedExecution = step.indexOf('GH_TOKEN="$token" "$binary"');
  assert.ok(unsetToken >= 0 && unsetToken < download);
  assert.ok(download < verifiedExecution);

  assert.match(step, /--format=sarif/u);
  assert.doesNotMatch(step, /--format=github/u);
  assert.match(step, /--cache-dir=\$work_dir\/cache/u);
  assert.match(step, /args\+=\(--no-online-audits\)/u);
  // zizmor writes SARIF to stdout (no --output flag); the report is redirected
  // to a file for the guard to validate.
  assert.match(
    step,
    /GH_TOKEN="\$token" "\$binary" "\$\{args\[@\]\}" -- "\$\{targets\[@\]\}" >"\$sarif"/u,
  );
  assert.doesNotMatch(step, /"\$binary"[^\n]*--output/u);
  assert.doesNotMatch(
    step,
    /^\s*"\$binary" "\$\{args\[@\]\}" -- "\$\{targets\[@\]\}"$/mu,
  );
  assert.doesNotMatch(step, /continue-on-error/u);
  assert.doesNotMatch(step, /11\|12\|13\|14/u);

  // fail-on-severity wins above 'never'; fail-on-findings is the legacy alias
  // that resolves to the 'low' threshold.
  assert.match(step, /if \[\[ "\$FAIL_ON_SEVERITY" != never \]\]; then/u);
  assert.match(step, /effective_severity=\$FAIL_ON_SEVERITY/u);
  assert.match(
    step,
    /elif \[\[ "\$FAIL_ON_FINDINGS" == true \]\]; then\s*\n\s*effective_severity=low/u,
  );
  assert.match(step, /ZIZMOR_EXIT_CODE=\$status/u);
  assert.match(step, /ZIZMOR_SARIF=\$sarif/u);
  assert.match(step, /ZIZMOR_VERSION=\$resolved_version/u);
  assert.match(step, /FAIL_ON_SEVERITY=\$effective_severity/u);
});

test("zizmor result handling is generated from the tested SARIF guard", () => {
  const renderer = path.join(__dirname, "render-zizmor-sarif-guard.cjs");
  const result = spawnSync(process.execPath, [renderer, "--check"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  assert.match(
    workflow,
    /# BEGIN GENERATED ZIZMOR SARIF GUARD - DO NOT EDIT/u,
  );
  assert.match(workflow, /# END GENERATED ZIZMOR SARIF GUARD/u);
  assert.equal(
    workflow.match(/Source: \.github\/scripts\/zizmor-sarif-guard\.sh/gu)
      ?.length,
    1,
  );
  assert.match(workflow, /in SARIF mode; results are not trusted/u);
  assert.match(workflow, /at or above severity \$FAIL_ON_SEVERITY/u);
});

test("documentation removes only the retired zizmor Docker exception", () => {
  const zizmorSection = readme.slice(
    readme.indexOf("- `.github/workflows/zizmor.yml`"),
    readme.indexOf("- `.github/workflows/osv-scanner.yml`"),
  );
  assert.match(zizmorSection, /verifies its committed SHA-256/u);
  assert.match(zizmorSection, /without Docker/u);
  assert.match(zizmorSection, /approved selector output/u);
  assert.doesNotMatch(readme, /#zizmor"\s*:\s*\{[\s\S]*?docker-socket/u);
  assert.doesNotMatch(
    readme,
    /#osv-scanner"[\s\S]*?"reason": "docker-socket"/u,
  );
});
