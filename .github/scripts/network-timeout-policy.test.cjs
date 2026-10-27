"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

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
    ["zizmor", read(".github/workflows/pr-audit-workflows.yml"), 1],
    // The standards-sync reusables download no release asset; their npm
    // installs carry the equivalent fetch-retry budget, asserted below.
    [
      "standards sync",
      read(".github/workflows/maintenance-sync-standards.yml"),
      0,
    ],
    // Linux (bash) and Windows (pwsh) golangci-lint installs carry the same
    // budget, hence two occurrences.
    ["go quality", read(".github/workflows/pr-run-checks-go.yml"), 2],
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
    [
      "standards sync npm",
      read(".github/workflows/maintenance-sync-standards.yml"),
      2,
    ],
    [
      "managed-files-guard npm",
      read(".github/actions/check-managed-files/action.yml"),
      1,
    ],
    [
      "check-workflow-naming npm",
      read(".github/actions/check-workflow-naming/action.yml"),
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
    // Restore on every ref, save only from the default branch after a miss.
    // A pull-request or merge-group ref can restore the default branch's
    // caches but no other ref's, so an entry such a ref saves serves that ref
    // alone and only fills the repository's cache quota. A schedule run has
    // no webhook payload, so github.event.repository is not guaranteed there,
    // but its ref is always the default branch.
    const steps = parseWorkflow(content).runs.steps;
    assert.ok(
      steps.every(
        (step) => !String(step.uses ?? "").startsWith("actions/cache@"),
      ),
      `${dir}: the combined actions/cache step saves on every ref`,
    );
    for (const [pattern, kind] of [
      [
        /uses: actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0/gu,
        "restore",
      ],
      [
        /uses: actions\/cache\/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0/gu,
        "save",
      ],
    ]) {
      assert.equal(
        occurrences(content, pattern),
        installs,
        `${dir}: every cached install needs one pinned actions/cache/${kind} step`,
      );
    }
    steps.forEach((install, index) => {
      if (!/_shared\/install-release\.sh/u.test(String(install.run ?? ""))) {
        return;
      }
      const cacheDir = install.env.ASSET_CACHE_DIR;
      const restore = steps
        .slice(0, index)
        .find(
          (step) =>
            String(step.uses).startsWith("actions/cache/restore@") &&
            step.with.path === cacheDir,
        );
      assert.ok(restore, `${dir}: no restore before installing ${cacheDir}`);
      assert.match(
        restore.id ?? "",
        /^[a-z][a-z0-9-]*$/u,
        `${dir}: restore id`,
      );
      // The key must change whenever the pin changes, so a stale asset can
      // never be restored under a fresh pin (it would only cost a re-verify
      // and re-download anyway, but a keyed miss is cheaper and clearer).
      assert.match(
        restore.with.key,
        /^[a-z-]+-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ inputs\.[a-z-]*version \}\}-\$\{\{ inputs\.[a-z-]*sha256 \}\}$/u,
        `${dir}: every cache key must pin os, arch, version, and sha256`,
      );
      // The save follows the install directly, so a scan that fails the job
      // later still keeps the verified asset, and a failed install saves
      // nothing (a composite step's if carries an implicit success()).
      const save = steps[index + 1];
      assert.ok(
        String(save?.uses).startsWith("actions/cache/save@"),
        `${dir}: the save must directly follow the install of ${cacheDir}`,
      );
      assert.equal(save.with.path, cacheDir, `${dir}: save path`);
      assert.equal(
        save.with.key,
        `\${{ steps.${restore.id}.outputs.cache-primary-key }}`,
        `${dir}: save key`,
      );
      assert.equal(
        save.if,
        "(github.event_name == 'schedule' || " +
          "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)) && " +
          `steps.${restore.id}.outputs.cache-hit != 'true'`,
        `${dir}: save only from the default branch, and only after a miss`,
      );
    });
  }
  assert.deepEqual(cachedActions.sort(), [
    "actionlint",
    "editorconfig-checker",
    "gitleaks",
    "lychee-offline",
    "shellcheck",
    "shfmt",
    "typos",
  ]);
});

test("OSV native release downloads are bounded", () => {
  const workflow = read(".github/workflows/pr-scan-dependencies.yml");
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
  const guard = read(".github/actions/verify-pulumi-deploy-policy/guard.sh");

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
  const workflow = read(".github/workflows/maintenance-sync-standards.yml");

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
