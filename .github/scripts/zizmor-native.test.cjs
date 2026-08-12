"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.join(__dirname, "..", "..");
const workflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "zizmor.yml"),
  "utf8",
);
const readme = fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8");

const pinnedVersion = "1.29.0";
const pinnedSha256 =
  "dd96df044a6e8538d5f423790f453bdd03d49e5b2bcc38214acc41a2f1297839";
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

test("native zizmor preserves the reusable interface and read-only default", () => {
  assert.equal(inputDefault("runner"), "ubuntu-24.04");
  assert.equal(inputDefault("paths"), ".github/workflows");
  assert.equal(inputDefault("version"), `v${pinnedVersion}`);
  assert.equal(inputDefault("sha256"), pinnedSha256);
  assert.equal(inputDefault("online-audits"), "true");
  assert.equal(inputDefault("persona"), "regular");
  assert.equal(inputDefault("fail-on-severity"), "never");
  assert.equal(inputDefault("fail-on-findings"), "false");
  assert.equal(inputDefault("upload-sarif"), "false");

  for (const existingInput of [
    "paths",
    "version",
    "online-audits",
    "persona",
    "fail-on-severity",
    "fail-on-findings",
    "upload-sarif",
  ]) {
    assert.match(workflow, new RegExp(`^ {6}${existingInput}:$`, "mu"));
  }

  // Workflow-level default stays contents: read. Job grants security-events:
  // write statically (expressions are invalid in this permissions scope);
  // the upload step remains gated on upload-sarif.
  assert.match(workflow, /^permissions:\n {2}contents: read\n\njobs:/mu);
  assert.match(
    workflow,
    /^ {4}permissions:\n {6}contents: read\n(?: {6}#.*\n)* {6}security-events: write$/mu,
  );
  assert.doesNotMatch(
    workflow,
    /^permissions:\n(?: {2}.+\n)* {2}security-events:/mu,
  );
  assert.match(workflow, /^ {4}runs-on: \$\{\{ inputs\.runner \}\}$/mu);
  // The exact SHA and version tag move with Dependabot bumps; only the
  // SHA-pinned-with-a-version-comment shape is the invariant under test.
  assert.match(
    workflow,
    /uses: actions\/checkout@[0-9a-f]{40} # v\d+\.\d+\.\d+/u,
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
  // Widened for the 2026-08-12 release-asset outage (#444): nine attempts
  // under curl's exponential backoff, with --retry-all-errors covering the
  // connection-died class (curl exit 56) that the default transient-only
  // classification never retries. --retry-delay stays banned so the backoff
  // remains exponential rather than fixed-interval.
  assert.match(step, /--retry 8 --retry-all-errors --retry-max-time 300/u);
  assert.doesNotMatch(step, /--retry-delay/u);
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

  // --format=github requires zizmor >= 1.6.0; a caller-pinned older version
  // must be rejected before the download, not left to fail argument parsing.
  assert.match(
    step,
    /IFS='\.' read -r zizmor_major zizmor_minor _ <<<"\$resolved_version"/u,
  );
  assert.match(
    step,
    /if \(\(zizmor_major < 1 \|\| \(zizmor_major == 1 && zizmor_minor < 6\)\)\); then/u,
  );
  const versionGuard = step.indexOf("zizmor_major < 1");
  const download = step.indexOf("curl --fail");
  assert.ok(
    versionGuard >= 0 && versionGuard < download,
    "minimum-version guard must precede the download",
  );
});

test("native zizmor limits token exposure and fails closed outside findings", () => {
  const step = runStep();
  const unsetToken = step.indexOf("unset ZIZMOR_TOKEN");
  const download = step.indexOf("curl --fail");
  const verifiedExecution = step.indexOf('GH_TOKEN="$token" "$binary"');
  assert.ok(unsetToken >= 0 && unsetToken < download);
  assert.ok(download < verifiedExecution);

  assert.match(step, /--format=github/u);
  assert.match(step, /--cache-dir=\$work_dir\/cache/u);
  assert.match(step, /args\+=\(--no-online-audits\)/u);
  // zizmor's --format=github renderer emits annotations to stdout; the run
  // must stream through tee (not a redirect) so the runner still parses them
  // as workflow commands, with a captured copy for the summary count.
  assert.match(
    step,
    /GH_TOKEN="\$token" "\$binary" "\$\{args\[@\]\}" -- "\$\{targets\[@\]\}" \| tee -- "\$annotations"/u,
  );
  assert.match(step, /status=\$\{PIPESTATUS\[0\]\}/u);
  assert.doesNotMatch(step, /"\$binary"[^\n]*--output/u);
  assert.doesNotMatch(step, /continue-on-error/u);

  // zizmor's own graduated exit codes (11-14) drive gating directly from the
  // --format=github run; no jq, no hand-rolled parser.
  assert.match(step, /case "\$status" in/u);
  assert.match(step, /0 \| 11 \| 12 \| 13 \| 14\) ;;/u);
  assert.doesNotMatch(step, /\bjq\b/u);

  // fail-on-severity wins above 'never'; fail-on-findings is the legacy alias
  // that resolves to the 'low' threshold.
  assert.match(step, /if \[\[ "\$FAIL_ON_SEVERITY" != never \]\]; then/u);
  assert.match(step, /effective_severity=\$FAIL_ON_SEVERITY/u);
  assert.match(
    step,
    /elif \[\[ "\$FAIL_ON_FINDINGS" == true \]\]; then\s*\n\s*effective_severity=low/u,
  );

  // 'low' blocks on any finding (status >= 11), preserving the legacy
  // fail-on-findings alias contract; 'medium' blocks at 13+, 'high' at 14.
  assert.match(step, /if \(\(status >= 11\)\); then blocking=true; fi/u);
  assert.match(step, /if \(\(status >= 13\)\); then blocking=true; fi/u);
  assert.match(step, /if \(\(status == 14\)\); then blocking=true; fi/u);
});

test("opt-in upload-sarif generates SARIF without replacing github gating", () => {
  const step = runStep();

  assert.match(step, /UPLOAD_SARIF: \$\{\{ inputs\.upload-sarif \}\}/u);
  assert.match(
    step,
    /case "\$ONLINE_AUDITS:\$FAIL_ON_FINDINGS:\$UPLOAD_SARIF" in/u,
  );

  // SARIF generation is gated on the opt-in input and writes outside work_dir
  // so the EXIT trap cannot remove it before the upload step.
  assert.match(step, /if \[\[ "\$UPLOAD_SARIF" == true \]\]; then/u);
  assert.match(step, /--format=sarif/u);
  assert.match(
    step,
    /GH_TOKEN="\$token" "\$binary" "\$\{sarif_args\[@\]\}" -- "\$\{targets\[@\]\}" >"\$sarif_path"/u,
  );
  assert.match(step, /sarif_path="\$\{GITHUB_WORKSPACE:\?\}\/zizmor\.sarif"/u);
  assert.match(step, /echo "sarif-file=zizmor\.sarif" >>"\$GITHUB_OUTPUT"/u);
  assert.match(step, /if \(\(sarif_status != 0\)\); then[\s\S]*exit 2/u);

  // Gating still keys off the --format=github status, not the SARIF run.
  // Use RegExp (not a quoted `${...}` literal) so biome's
  // noTemplateCurlyInString --error-on-warnings gate stays green.
  const githubTee = step.search(
    /GH_TOKEN="\$token" "\$binary" "\$\{args\[@\]\}" -- "\$\{targets\[@\]\}" \| tee -- "\$annotations"/u,
  );
  const sarifRedirect = step.search(
    /GH_TOKEN="\$token" "\$binary" "\$\{sarif_args\[@\]\}" -- "\$\{targets\[@\]\}" >"\$sarif_path"/u,
  );
  const blockingCheck = step.indexOf(
    "if ((status >= 11)); then blocking=true; fi",
  );
  const unsetToken = step.indexOf("unset token", sarifRedirect);
  assert.ok(githubTee >= 0 && sarifRedirect > githubTee);
  assert.ok(blockingCheck > sarifRedirect);
  // Token must stay set through the SARIF pass; hoisting unset above it
  // would silently run --format=sarif with an empty GH_TOKEN.
  assert.ok(unsetToken > sarifRedirect);

  // Upload step: SHA-pinned upload-sarif, only when the run step produced a
  // SARIF file (so a failed download/generation does not attempt upload).
  assert.match(
    workflow,
    /uses: github\/codeql-action\/upload-sarif@[0-9a-f]{40} # v\d+\.\d+\.\d+/u,
  );
  assert.match(
    workflow,
    /if: \$\{\{ always\(\) && !cancelled\(\) && inputs\.upload-sarif && steps\.zizmor\.outputs\.sarif-file != '' \}\}/u,
  );
  assert.match(
    workflow,
    /sarif_file: \$\{\{ steps\.zizmor\.outputs\.sarif-file \}\}/u,
  );
  assert.match(workflow, /^ {10}category: zizmor$/mu);
});

test("zizmor no longer bundles a generated SARIF guard", () => {
  assert.doesNotMatch(workflow, /BEGIN GENERATED ZIZMOR SARIF GUARD/u);
  assert.doesNotMatch(workflow, /zizmor-sarif-guard\.sh/u);
  assert.equal(
    fs.existsSync(path.join(__dirname, "zizmor-sarif-guard.sh")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(__dirname, "render-zizmor-sarif-guard.cjs")),
    false,
  );
});

test("the ci.yml zizmor gate is as wide as the lane's audit scope", () => {
  const ci = fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const filter = ci
    .slice(ci.indexOf("\n            zizmor:\n"))
    .split(/\n\n/u)[0];

  assert.match(
    ci,
    /uses: \.\/\.github\/workflows\/zizmor\.yml\n {4}with:\n {6}paths: \./u,
    "the zizmor lane is expected to audit repo-wide (paths: .)",
  );
  assert.match(
    filter,
    /^ {14}\*\*\/action\.yml$/mu,
    "a repo-wide audit needs a repo-wide gate: a composite action added " +
      "outside .github/ must not skip the lane that audits it",
  );
});

test("documentation removes only the retired zizmor Docker exception", () => {
  const zizmorSection = readme.slice(
    readme.indexOf("- `.github/workflows/zizmor.yml`"),
    readme.indexOf("- `.github/workflows/osv-scanner.yml`"),
  );
  assert.match(zizmorSection, /verifies its committed SHA-256/u);
  assert.match(zizmorSection, /without Docker/u);
  assert.match(zizmorSection, /approved selector output/u);
  assert.match(zizmorSection, /upload-sarif: true/u);
  assert.match(zizmorSection, /security-events: write/u);
  assert.doesNotMatch(zizmorSection, /deferred opt-in/u);
  assert.doesNotMatch(readme, /#zizmor"\s*:\s*\{[\s\S]*?docker-socket/u);
  assert.doesNotMatch(
    readme,
    /#osv-scanner"[\s\S]*?"reason": "docker-socket"/u,
  );
});
