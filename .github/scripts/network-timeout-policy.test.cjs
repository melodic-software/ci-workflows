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
  // Release-asset downloads must outlast a multi-minute upstream outage, not
  // just a packet-loss burst: nine attempts under curl's
  // exponential backoff span ~4-5 minutes, hard-capped by --retry-max-time,
  // and --retry-all-errors covers the connection-died class (curl exit 56)
  // that curl's default transient-only classification never retries.
  // --retry-delay stays banned: a fixed interval would replace the
  // exponential backoff rather than bound it.
  for (const [name, content, expected] of [
    ["zizmor", read(".github/workflows/zizmor.yml"), 1],
    // The standards-sync reusables download no release asset; their npm
    // installs carry the equivalent fetch-retry budget, asserted below.
    ["standards sync", read(".github/workflows/standards-sync.yml"), 0],
    // Linux (bash) and Windows (pwsh) golangci-lint installs carry the same
    // budget, hence two occurrences.
    ["go quality", read(".github/workflows/go-quality.yml"), 2],
    ["shared installer", read(".github/actions/_shared/install-release.sh"), 1],
  ]) {
    assert.equal(
      occurrences(content, /--connect-timeout 10 --max-time 120/gu),
      expected,
      name,
    );
    assert.equal(
      occurrences(
        content,
        /--retry 8 --retry-all-errors --retry-max-time 300/gu,
      ),
      expected,
      name,
    );
    assert.doesNotMatch(content, /--retry-delay/u, name);
  }

  // The standards-sync path's remaining network dependency is npm: every
  // engine-dependency install carries the equivalent bounded retry budget.
  for (const [name, content, expected] of [
    ["standards sync npm", read(".github/workflows/standards-sync.yml"), 2],
    [
      "managed-files-guard npm",
      read(".github/actions/managed-files-guard/action.yml"),
      1,
    ],
  ]) {
    assert.equal(
      occurrences(content, /--fetch-retries=8 --fetch-retry-mintimeout=1000/gu),
      expected,
      name,
    );
  }
});

test("every shared-installer consumer caches its verified release asset", () => {
  // The verified-asset cache is the primary defense against release-asset
  // outages: with a warm version+sha256 pin no job touches the network at
  // all. install-release.sh re-verifies the pinned SHA-256 on restore and
  // re-downloads on mismatch, so the cache key is never trusted by itself.
  const actionsRoot = path.join(root, ".github", "actions");
  const cachedActions = [];
  for (const dir of fs.readdirSync(actionsRoot)) {
    const file = path.join(actionsRoot, dir, "action.yml");
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    const installs = occurrences(
      content,
      /run: bash "\$GITHUB_ACTION_PATH\/\.\.\/_shared\/install-release\.sh"/gu,
    );
    if (installs === 0) continue;
    cachedActions.push(dir);
    assert.equal(
      occurrences(
        content,
        /ASSET_CACHE_DIR: \$\{\{ runner\.temp \}\}\/ci-workflows-release-cache\//gu,
      ),
      installs,
      `${dir}: every install-release.sh step must set ASSET_CACHE_DIR`,
    );
    assert.equal(
      occurrences(
        content,
        /uses: actions\/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0/gu,
      ),
      installs,
      `${dir}: every cached install needs a paired actions/cache step`,
    );
    // The key must change whenever the pin changes, so a stale asset can
    // never be restored under a fresh pin (it would only cost a re-verify
    // and re-download anyway, but a keyed miss is cheaper and clearer).
    assert.equal(
      occurrences(
        content,
        /key: [a-z-]+-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ inputs\.[a-z-]*version \}\}-\$\{\{ inputs\.[a-z-]*sha256 \}\}/gu,
      ),
      installs,
      `${dir}: every cache key must pin os, arch, version, and sha256`,
    );
  }
  assert.deepEqual(cachedActions.sort(), [
    "actionlint",
    "editorconfig",
    "gitleaks",
    "lychee-offline",
    "shellcheck",
    "shfmt",
    "typos",
  ]);
});

test("OSV native release downloads are bounded", () => {
  const workflow = read(".github/workflows/osv-scanner.yml");
  assert.equal(
    occurrences(workflow, /--connect-timeout 10 --max-time 180/gu),
    1,
  );
  assert.equal(
    occurrences(
      workflow,
      /--retry 8 --retry-all-errors --retry-max-time 360/gu,
    ),
    1,
  );
  assert.match(workflow, /download\(\)[\s\S]*?curl --fail/u);
  assert.doesNotMatch(workflow, /\bdocker\s+(?:run|pull|image|buildx)\b/iu);
});

test("Pulumi stack export has an explicit freshness boundary", () => {
  const guard = read(".github/actions/pulumi-deploy-guard/guard.sh");

  assert.match(guard, /for attempt in 1 2/u);
  assert.match(
    guard,
    /timeout --signal=TERM --kill-after=5s 60s(?:[ \t]+|[ \t]*\\\r?\n[ \t]*)"\$pulumi_bin" api/u,
  );
  assert.match(
    guard,
    /timeout --signal=TERM --kill-after=5s 300s(?:[ \t]+|[ \t]*\\\r?\n[ \t]*)"\$pulumi_bin" stack export/u,
  );
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
