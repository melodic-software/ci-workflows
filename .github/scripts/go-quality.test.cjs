"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");
const workflow = fs.readFileSync(
  path.join(root, ".github", "workflows", "go-quality.yml"),
  "utf8",
);
const guard = fs.readFileSync(
  path.join(root, ".github", "scripts", "govulncheck-sarif-guard.sh"),
  "utf8",
);
const tidyCheck = fs.readFileSync(
  path.join(root, ".github", "scripts", "go-mod-tidy-check.sh"),
  "utf8",
);
const drift = fs.readFileSync(
  path.join(root, ".github", "workflows", "tool-version-drift-check.yml"),
  "utf8",
);

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
  assert.match(workflow, /^ {2}linux:[\s\S]*?runs-on: ubuntu-24\.04/mu);
  assert.match(workflow, /^ {2}windows:[\s\S]*?runs-on: windows-2025/mu);
  assert.equal(occurrences(workflow, /timeout-minutes: 30/gu), 3);
  assert.equal(
    occurrences(
      workflow,
      /actions\/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16 # v6\.5\.0/gu,
    ),
    3,
  );
  assert.match(workflow, /GOLANGCI_LINT_VERSION: 2\.12\.2/u);
  assert.match(
    workflow,
    /GOLANGCI_LINT_SHA256: 8df580d2670fed8fa984aac0507099af8df275e665215f5c7a2ae3943893a553/u,
  );
  assert.match(
    workflow,
    /GOLANGCI_LINT_SHA256: bd42e3ebc8cb4ececb86941983baaf1dc221bbb04d838e94ce63b49cc91e02bb/u,
  );
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
  assert.match(workflow, /GOWORK=off go mod tidy -modfile="\$alternate_mod"/u);
  assert.match(workflow, /compare_snapshot go\.mod go\.mod/u);
  assert.match(workflow, /compare_snapshot go\.sum go\.sum/u);
  assert.doesNotMatch(workflow, /go mod tidy -diff/u);
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

test("generated tidy check matches the behavioral source", () => {
  const indentation = "          ";
  const begin = `${indentation}# BEGIN GENERATED: go-mod-tidy-check.sh\n`;
  const end = `${indentation}# END GENERATED: go-mod-tidy-check.sh`;
  const start = workflow.indexOf(begin);
  const finish = workflow.indexOf(end);
  assert.ok(start >= 0 && finish > start, "missing generated tidy check");

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
  const source = tidyCheck.replace(/^#!\/usr\/bin\/env bash\r?\n/u, "");
  assert.equal(embedded, source);
});

test("govulncheck is authenticated, bounded, structured, and separate", () => {
  assert.match(workflow, /^ {2}govulncheck:/mu);
  assert.match(workflow, /GOVULNCHECK_VERSION: 1\.6\.0/u);
  assert.match(
    workflow,
    /GOVULNCHECK_MODULE_SUM: h1:FeMO9Rm\/HwyduOztbvKcOw\+zvDEPr4I4aQNSfevFcKY=/u,
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

test("drift workflow tracks both Go quality tool pins", () => {
  assert.match(drift, /golangci\/golangci-lint\/releases\/latest/u);
  assert.match(drift, /proxy\.golang\.org\/golang\.org\/x\/vuln\/@latest/u);
  assert.match(drift, /GOLANGCI_LINT_VERSION/u);
  assert.match(drift, /GOVULNCHECK_VERSION/u);
});
