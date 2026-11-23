"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const repositoryRoot = path.join(__dirname, "..", "..");
const workflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "pr-audit-workflows.yml"),
  "utf8",
);
const readme = fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8");

const pinnedVersion = "1.32.0";
const pinnedSha256 =
  "bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b";
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
  assert.equal(inputDefault("paths"), ".github/workflows .github/actions");
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

// Runs the real run-step script with fake curl, sha256sum and tar so the
// download path succeeds, and a fake zizmor that records its arguments.
function runLane({ dirs, paths, standardsCheckout = "", callerConfig = "" }) {
  const step = parseWorkflow(workflow).jobs.zizmor.steps.find(
    (entry) => entry?.id === "zizmor",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zizmor-lane-"));
  try {
    const bin = path.join(root, "bin");
    const workspace = path.join(root, "ws");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, "tmp"));
    for (const dir of dirs) {
      fs.mkdirSync(path.join(workspace, dir), { recursive: true });
    }
    fs.mkdirSync(workspace, { recursive: true });
    const argsFile = path.join(root, "zizmor-args");
    const script = (name, body) => {
      fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, {
        mode: 0o755,
      });
    };
    script(
      "curl",
      'while (($#)); do if [[ $1 == --output ]]; then : >"$2"; fi; shift; done',
    );
    script("sha256sum", "cat >/dev/null");
    script(
      "tar",
      [
        "while (($#)); do case $1 in --directory=*) d=$(cut -d= -f2 <<<$1) ;; esac; shift; done",
        'printf \'#!/usr/bin/env bash\\nif [[ $1 == --version ]]; then echo "zizmor 1.32.0"; exit 0; fi\\nprintf "%%s\\\\n" "$@" >"$ARGS_FILE"\\n\' >"$d/zizmor"',
        'chmod +x "$d/zizmor"',
      ].join("\n"),
    );
    const result = spawnSync("bash", ["-c", step.run], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        ARGS_FILE: argsFile,
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        RUNNER_TEMP: path.join(root, "tmp"),
        GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: path.join(root, "github-output"),
        PATHS: paths,
        REQUESTED_VERSION: `v${pinnedVersion}`,
        EXPECTED_SHA256: "0".repeat(64),
        ONLINE_AUDITS: "true",
        PERSONA: "regular",
        FAIL_ON_FINDINGS: "false",
        FAIL_ON_SEVERITY: "never",
        UPLOAD_SARIF: "false",
        ZIZMOR_TOKEN: "token",
        PINNED_VERSION: pinnedVersion,
        ASSET_NAME: assetName,
        STANDARDS_CHECKOUT: standardsCheckout,
        CALLER_CONFIG: callerConfig,
      },
    });
    const targets = fs.existsSync(argsFile)
      ? fs.readFileSync(argsFile, "utf8").trim().split("\n")
      : null;
    return { status: result.status, targets };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("default paths skip an absent .github/actions and pass it when present", () => {
  const defaultPaths = inputDefault("paths");

  const absent = runLane({ dirs: [".github/workflows"], paths: defaultPaths });
  assert.equal(absent.status, 0);
  assert.ok(absent.targets.includes(".github/workflows"));
  assert.ok(!absent.targets.includes(".github/actions"));

  const present = runLane({
    dirs: [".github/workflows", ".github/actions"],
    paths: defaultPaths,
  });
  assert.equal(present.status, 0);
  assert.ok(present.targets.includes(".github/workflows"));
  assert.ok(present.targets.includes(".github/actions"));
});

test("a caller-supplied path that does not exist still reaches zizmor", () => {
  // zizmor itself rejects a missing path, so the lane must not filter it out.
  const result = runLane({ dirs: [".github/workflows"], paths: "missing-dir" });
  assert.deepEqual(result.targets.slice(-1), ["missing-dir"]);
});

test("the caller's config found, else standards', reaches zizmor as --config", () => {
  const own = runLane({
    dirs: [".github/workflows"],
    paths: ".github/workflows",
    callerConfig: "/base/zizmor.yml",
  });
  assert.equal(own.status, 0);
  assert.ok(own.targets.includes("--config=/base/zizmor.yml"));

  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "zizmor-standards-"));
  try {
    fs.mkdirSync(path.join(checkout, ".github"));
    fs.writeFileSync(
      path.join(checkout, ".github", "zizmor.yml"),
      "rules: {}\n",
    );
    const fallback = runLane({
      dirs: [".github/workflows"],
      paths: ".github/workflows",
      standardsCheckout: checkout,
    });
    assert.equal(fallback.status, 0);
    assert.ok(
      fallback.targets.includes(
        `--config=${path.join(checkout, ".github", "zizmor.yml")}`,
      ),
    );

    fs.rmSync(path.join(checkout, ".github", "zizmor.yml"));
    const missing = runLane({
      dirs: [".github/workflows"],
      paths: ".github/workflows",
      standardsCheckout: checkout,
    });
    assert.equal(missing.status, 2);
    assert.equal(missing.targets, null);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("standards is checked out only when the caller's checkout has no zizmor config", () => {
  const steps = parseWorkflow(workflow).jobs.zizmor.steps;
  const find = steps.find((entry) => entry?.id === "config");
  for (const candidate of [
    ".github/zizmor.yml",
    ".github/zizmor.yaml",
    "zizmor.yml",
    "zizmor.yaml",
  ]) {
    assert.ok(find.run.includes(candidate), candidate);
  }
  const standards = steps.find((entry) => entry?.id === "standards");
  assert.equal(standards.uses, "$/.github/actions/download-standards");
  assert.equal(standards.if, `\${{ steps.config.outputs.file == '' }}`);
  assert.equal(find.env.BASE_SHA, `\${{ github.event.pull_request.base.sha }}`);
  const zizmor = steps.find((entry) => entry?.id === "zizmor");
  assert.equal(zizmor.env.CALLER_CONFIG, `\${{ steps.config.outputs.file }}`);
  assert.equal(
    zizmor.env.STANDARDS_CHECKOUT,
    `\${{ steps.standards.outputs.path }}`,
  );
  assert.ok(steps.indexOf(find) < steps.indexOf(standards));
  assert.ok(steps.indexOf(standards) < steps.indexOf(zizmor));
});

// Runs the real find-config step with a fake gh serving `base` (path to text,
// or a status) as the base commit's files, in a workspace holding `head`.
function findConfig({ baseSha, base = {}, head = {} }) {
  const step = parseWorkflow(workflow).jobs.zizmor.steps.find(
    (entry) => entry?.id === "config",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zizmor-config-"));
  try {
    const bin = path.join(root, "bin");
    const workspace = path.join(root, "ws");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, "tmp"));
    fs.mkdirSync(workspace);
    for (const [file, text] of Object.entries(head)) {
      fs.mkdirSync(path.dirname(path.join(workspace, file)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(workspace, file), text);
    }
    fs.writeFileSync(path.join(root, "base.json"), JSON.stringify(base));
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const base = require(${JSON.stringify(path.join(root, "base.json"))});
const url = process.argv[process.argv.length - 1];
const [, file, ref] = url.match(/contents\\/(.+)\\?ref=(.+)$/u);
if (ref !== ${JSON.stringify(baseSha ?? "")}) { console.error("wrong ref " + ref); process.exit(1); }
const entry = base[file];
if (entry === undefined) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
if (typeof entry === "number") { console.error("gh: Server Error (HTTP " + entry + ")"); process.exit(1); }
process.stdout.write(entry);
`,
      { mode: 0o755 },
    );
    const output = path.join(root, "github-output");
    fs.writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", step.run], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: path.join(root, "tmp"),
        GITHUB_OUTPUT: output,
        BASE_SHA: baseSha ?? "",
        REPOSITORY: "o/r",
        GH_TOKEN: "token",
      },
    });
    const file = fs.readFileSync(output, "utf8").match(/^file=(.*)$/mu)?.[1];
    const text = file
      ? fs.readFileSync(path.resolve(workspace, file), "utf8")
      : null;
    return {
      status: result.status,
      file,
      text,
      stderr: result.stderr + result.stdout,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a pull request's own config comes from its base, never its head", () => {
  const sha = "b".repeat(40);
  // A config the head adds is ignored: standards' applies.
  const added = findConfig({
    baseSha: sha,
    head: { ".github/zizmor.yml": "rules: {} # added by the head\n" },
  });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.file, "");

  // A config the base has is applied as the base has it, whatever the head says.
  const edited = findConfig({
    baseSha: sha,
    base: { "zizmor.yaml": "rules: base\n" },
    head: { "zizmor.yaml": "rules: head\n" },
  });
  assert.equal(edited.status, 0);
  assert.equal(edited.text, "rules: base\n");

  // A base read that fails other than 404 fails closed.
  const broken = findConfig({
    baseSha: sha,
    base: { ".github/zizmor.yml": 500 },
  });
  assert.equal(broken.status, 2);
});

test("outside a pull request the checkout's own config applies", () => {
  const own = findConfig({ head: { ".github/zizmor.yaml": "rules: own\n" } });
  assert.equal(own.status, 0);
  assert.equal(own.file, ".github/zizmor.yaml");
  assert.equal(findConfig({}).file, "");
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
  // Nine attempts under curl's exponential backoff, with --retry-all-errors covering the
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

  // --format=github requires zizmor >= 1.6.0 and --strict-collection >= 1.7.0;
  // a caller-pinned older version must be rejected before the download, not
  // left to fail argument parsing.
  assert.match(
    step,
    /IFS='\.' read -r zizmor_major zizmor_minor _ <<<"\$resolved_version"/u,
  );
  assert.match(
    step,
    /if \(\(zizmor_major < 1 \|\| \(zizmor_major == 1 && zizmor_minor < 7\)\)\); then/u,
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
  // An input zizmor cannot parse must fail the audit, not be skipped with a
  // warning; both passes collect the same inputs.
  assert.match(
    step,
    /\bargs=\(\n\s*--format=github\n\s*--strict-collection\n/u,
  );
  assert.match(
    step,
    /sarif_args=\(\n\s*--format=sarif\n\s*--strict-collection\n/u,
  );
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

test("the pr-require-checks.yml zizmor gate is as wide as the lane's audit scope", () => {
  const ci = fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "pr-require-checks.yml"),
    "utf8",
  );
  const filter = ci
    .slice(ci.indexOf("\n            zizmor:\n"))
    .split(/\n\n/u)[0];

  assert.match(
    ci,
    /uses: \$\/\.github\/workflows\/pr-audit-workflows\.yml\n {4}with:\n {6}paths: \.github\n/u,
    "the zizmor lane is expected to audit .github (fixtures/ fail --strict-collection)",
  );
  assert.match(
    filter,
    /^ {14}\*\*\/action\.yml$/mu,
    "the gate must cover every composite action the lane audits",
  );
});

test("documentation removes only the retired zizmor Docker exception", () => {
  const zizmorSection = readme.slice(
    readme.indexOf("- `.github/workflows/pr-audit-workflows.yml`"),
    readme.indexOf("- `.github/workflows/pr-scan-dependencies.yml`"),
  );
  assert.match(zizmorSection, /verifies its committed SHA-256/u);
  assert.match(zizmorSection, /without Docker/u);
  assert.match(zizmorSection, /governed\s+managed runner label/u);
  assert.match(zizmorSection, /upload-sarif: true/u);
  assert.match(zizmorSection, /security-events: write/u);
  assert.doesNotMatch(zizmorSection, /deferred opt-in/u);
  assert.doesNotMatch(readme, /#zizmor"\s*:\s*\{[\s\S]*?docker-socket/u);
  assert.doesNotMatch(
    readme,
    /#osv-scanner"[\s\S]*?"reason": "docker-socket"/u,
  );
});
