"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function occurrences(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

test("immutable release assets have a bounded exponential retry budget", () => {
  const zizmor = read(".github/workflows/zizmor.yml");
  const standards = read(".github/workflows/standards-sync.yml");

  for (const [name, content, expected] of [
    ["zizmor", zizmor, 1],
    ["standards sync", standards, 2],
  ]) {
    assert.equal(
      occurrences(content, /--connect-timeout 10 --max-time 120/gu),
      expected,
      name,
    );
    assert.equal(
      occurrences(content, /--retry 2 --retry-max-time 300/gu),
      expected,
      name,
    );
    assert.doesNotMatch(content, /--retry-all-errors/u, name);
    assert.doesNotMatch(content, /--retry-delay/u, name);
  }
});

test("small JSON and release-discovery reads use their class budgets", () => {
  const workflow = read(".github/workflows/tool-version-drift-check.yml");

  assert.match(workflow, /--connect-timeout 10 --max-time 30/u);
  assert.match(workflow, /--retry 2 --retry-max-time 90/u);
  assert.doesNotMatch(workflow, /--retry-delay/u);
  assert.equal(occurrences(workflow, /\bcurl_small_json (?:"?https:)/gu), 6);
  assert.match(
    workflow,
    /bounded_read 60 gh api repos\/google\/osv-scanner\/releases\/latest/u,
  );
  assert.match(
    workflow,
    /bounded_read\(\)[\s\S]*?>"\$output"[\s\S]*?cat -- "\$output"/u,
  );
  assert.match(
    workflow,
    /Find existing tracking issue[\s\S]*?set -euo pipefail[\s\S]*?matches="\$\(gh_read api --paginate/u,
  );
});

test("OSV native release downloads are bounded", () => {
  const workflow = read(".github/workflows/osv-scanner.yml");
  assert.equal(
    occurrences(workflow, /--connect-timeout 10 --max-time 180/gu),
    1,
  );
  assert.equal(occurrences(workflow, /--retry 2 --retry-max-time 360/gu), 1);
  assert.match(workflow, /download\(\)[\s\S]*?curl --fail/u);
  assert.doesNotMatch(workflow, /\bdocker\s+(?:run|pull|image|buildx)\b/iu);
});

test("Pulumi reads and stack export have explicit freshness boundaries", () => {
  const guard = read(".github/actions/pulumi-deploy-guard/guard.sh");
  const drift = read(".github/scripts/pulumi-version-drift.sh");

  assert.match(guard, /for attempt in 1 2/u);
  assert.match(
    guard,
    /timeout --signal=TERM --kill-after=5s 60s(?:[ \t]+|[ \t]*\\\r?\n[ \t]*)"\$pulumi_bin" api/u,
  );
  assert.match(
    guard,
    /timeout --signal=TERM --kill-after=5s 300s(?:[ \t]+|[ \t]*\\\r?\n[ \t]*)"\$pulumi_bin" stack export/u,
  );
  assert.match(drift, /gh_read\(\)[\s\S]*?for attempt in 1 2/u);
  assert.match(
    drift,
    /gh_mutate\(\)[\s\S]*?timeout --signal=TERM --kill-after=5s 60s gh/u,
  );
  assert.doesNotMatch(drift, /gh_mutate\(\)[\s\S]*?for attempt/u);
});

test("Octokit inventory pages time out without freshness retries", () => {
  const source = read(".github/scripts/production-ha-proof.cjs");

  assert.match(source, /const REQUEST_TIMEOUT_MILLISECONDS = 30_000;/u);
  assert.match(source, /request: \{ timeout: REQUEST_TIMEOUT_MILLISECONDS \}/u);
  assert.doesNotMatch(source, /retryCount|requestWithRetry|for \(.*retry/iu);
});

test("Standards App attestation uses bounded fresh API reads", () => {
  const workflow = read(".github/workflows/standards-sync.yml");

  assert.match(workflow, /const REQUEST_TIMEOUT_MILLISECONDS = 30_000;/u);
  assert.equal(
    occurrences(
      workflow,
      /request: \{ timeout: REQUEST_TIMEOUT_MILLISECONDS \}/gu,
    ),
    1,
  );
  assert.equal(
    occurrences(
      workflow,
      /AbortSignal\.timeout\(REQUEST_TIMEOUT_MILLISECONDS\)/gu,
    ),
    1,
  );
  assert.doesNotMatch(
    workflow,
    /attest:[\s\S]*?(?:retryCount|requestWithRetry)/iu,
  );
});
