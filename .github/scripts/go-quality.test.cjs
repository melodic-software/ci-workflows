"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");
const workflow = read(".github/workflows/pr-run-checks-go.yml");
const ciWorkflow = read(".github/workflows/pr-require-checks.yml");
const windowsFixtureTest = read(
  "fixtures/go/windows-race/windows_race_test.go",
);
const guard = read(".github/scripts/govulncheck-sarif-guard.sh");

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test("Go quality exposes only the consumer-owned path contract", () => {
  assert.match(workflow, /^on:\n {2}workflow_call:/mu);
  assert.doesNotMatch(
    workflow,
    /^ {2}(push|pull_request|schedule|workflow_dispatch):/mu,
  );
  assert.match(workflow, /^permissions:\n {2}contents: read$/mu);
  assert.match(
    workflow,
    /^ {6}config:\n {8}description:[^\n]+\n {8}required: true\n {8}type: string$/mu,
  );
  assert.match(workflow, /^ {6}working-directory:[\s\S]*?default: '\.'/mu);
  assert.match(workflow, /^ {6}go-version-file:[\s\S]*?default: go\.mod/mu);
  assert.doesNotMatch(
    workflow,
    /^ {6}(runner|go-version|golangci-version|govulncheck-version|fail-on-findings):/mu,
  );
});

test("native Linux and Windows analyzer lanes use immutable verified binaries", () => {
  assert.match(workflow, /^ {2}check-linux:[\s\S]*?runs-on: ubuntu-24\.04/mu);
  assert.match(workflow, /^ {2}check-windows:[\s\S]*?runs-on: windows-2025/mu);
  assert.equal(occurrences(workflow, /timeout-minutes: 30/gu), 3);

  // The exact SHA and version tag move with Dependabot bumps; the invariant
  // under test is that all three job definitions pin the same SHA, so a
  // partial bump that leaves one job definition behind is still caught.
  const setupGoShas = [
    ...workflow.matchAll(/actions\/setup-go@([0-9a-f]{40}) # v\d+\.\d+\.\d+/gu),
  ].map((match) => match[1]);
  assert.equal(setupGoShas.length, 3);
  assert.equal(
    new Set(setupGoShas).size,
    1,
    "all actions/setup-go pins must share the same SHA",
  );
  // The version and digests move with the version-bump bot
  // (.github/version-bump/policy.yaml); the invariant is that both jobs pin
  // one exact release, each to its own platform asset's SHA-256.
  const golangciVersions = [
    ...workflow.matchAll(/^ {6}GOLANGCI_LINT_VERSION: (\S+)$/gmu),
  ].map((match) => match[1]);
  assert.equal(golangciVersions.length, 2);
  assert.match(golangciVersions[0], /^\d+\.\d+\.\d+$/u);
  assert.equal(golangciVersions[1], golangciVersions[0]);
  const golangciSums = [
    ...workflow.matchAll(/^ {6}GOLANGCI_LINT_SHA256: (\S+)$/gmu),
  ].map((match) => match[1]);
  assert.equal(golangciSums.length, 2);
  for (const sum of golangciSums) assert.match(sum, /^[0-9a-f]{64}$/u);
  assert.notEqual(golangciSums[0], golangciSums[1]);
  assert.match(workflow, /golangci-lint-\$\{version\}-linux-amd64\.tar\.gz/u);
  assert.match(workflow, /golangci-lint-\$version-windows-amd64\.zip/u);
  assert.match(workflow, /sha256sum --check --strict/u);
  assert.match(workflow, /Get-FileHash[^\n]+SHA256/u);
  assert.equal(occurrences(workflow, /version --short/gu), 2);
  assert.equal(occurrences(workflow, /config verify --config/gu), 2);
  assert.equal(occurrences(workflow, /--issues-exit-code=42/gu), 2);
  assert.equal(occurrences(workflow, /--max-issues-per-linter=0/gu), 2);
  assert.equal(occurrences(workflow, /--max-same-issues=0/gu), 2);
  assert.doesNotMatch(workflow, /\bstaticcheck\b/iu);
  assert.doesNotMatch(workflow, /continue-on-error|@(?:main|master|v\d+)\b/u);
});

test("approved native tests and module hygiene stay blocking", () => {
  assert.match(workflow, /gofmt -l/u);
  assert.match(
    workflow,
    /go\.sum must be a regular reviewed file when present/u,
  );
  assert.match(workflow, /GOWORK=off go mod tidy -diff/u);
  assert.match(
    workflow,
    /go mod tidy -diff execution failed with status \$status/u,
  );
  assert.doesNotMatch(workflow, /-modfile="\$alternate_mod"/u);
  assert.match(workflow, /go mod verify/u);
  assert.equal(
    occurrences(workflow, /go test -race -count=1 -timeout=10m \.\/\.\.\./gu),
    2,
  );
  assert.match(workflow, /--print-file-name libsynchronization\.a/u);
  assert.match(workflow, /CC: gcc/u);
  assert.match(workflow, /CGO_ENABLED: '1'/u);
  assert.doesNotMatch(workflow, /go test -count=1/u);
});

test("this exact workflow head is behaviorally dogfooded on native Windows", () => {
  assert.match(
    ciWorkflow,
    /^ {2}pr-run-checks-go:[\s\S]*?uses: \$\/\.github\/workflows\/pr-run-checks-go\.yml[\s\S]*?working-directory: fixtures\/go\/windows-race/mu,
  );
  assert.match(ciWorkflow, /^ {4}needs: \[[^\n]*pr-run-checks-go[^\n]*\]$/mu);
  assert.match(
    ciWorkflow,
    /^ {10}results: [^\n]*\$\{\{ needs\.pr-run-checks-go\.result \}\}[^\n]*$/mu,
  );
  assert.match(windowsFixtureTest, /^\/\/go:build windows$/mu);
  assert.match(windowsFixtureTest, /if !raceDetectorEnabled/u);
});

test("govulncheck is authenticated, bounded, structured, and separate", () => {
  assert.match(workflow, /^ {2}govulncheck:/mu);
  assert.match(workflow, /GOVULNCHECK_VERSION: 1\.7\.0/u);
  assert.match(
    workflow,
    /GOVULNCHECK_MODULE_SUM: h1:4MQBuhmXbz2uepNJrf3v\+aaZLGDqw1JluwYboegA1qg=/u,
  );
  assert.match(workflow, /GOPROXY: https:\/\/proxy\.golang\.org/u);
  assert.match(workflow, /GOSUMDB: sum\.golang\.org/u);
  assert.match(workflow, /go mod download -json/u);
  assert.match(
    workflow,
    /go install "\$\{module\}\/cmd\/govulncheck@\$\{version\}"/u,
  );
  assert.match(workflow, /go version -m "\$binary"/u);
  assert.match(workflow, /timeout --signal=TERM --kill-after=30s 10m/u);
  assert.match(
    workflow,
    /-db=https:\/\/vuln\.go\.dev -format=sarif \.\/\.\.\./u,
  );
});

test("generated govulncheck guard matches the behavioral source", () => {
  const indentation = "          ";
  const begin = `${indentation}# BEGIN GENERATED: govulncheck-sarif-guard.sh\n`;
  const end = `${indentation}# END GENERATED: govulncheck-sarif-guard.sh`;
  const start = workflow.indexOf(begin);
  const finish = workflow.indexOf(end);
  assert.ok(
    start >= 0 && finish > start,
    "missing generated govulncheck guard",
  );

  const embedded = workflow
    .slice(start + begin.length, finish)
    .split("\n")
    .map((line) => {
      assert.ok(
        line === "" || line.startsWith(indentation),
        `generated line lost indentation: ${line}`,
      );
      return line.slice(indentation.length);
    })
    .join("\n");
  const source = guard.replace(/^#!\/usr\/bin\/env bash\r?\n/u, "");
  assert.equal(embedded, source);
});
