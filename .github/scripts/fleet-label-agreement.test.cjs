"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// The one reviewed production fleet label. A relabel must change every site in
// the same reviewed commit; these tests turn a partial relabel from a silent
// org-wide routing kill into a red check (github-iac#89, landmine L2).
const GOVERNED_FLEET_LABEL = "melodic-ubuntu-24.04-x64";

const scriptsRoot = __dirname;
const selectorSource = fs.readFileSync(
  path.join(scriptsRoot, "select-runner.cjs"),
  "utf8",
);
const selectorWorkflow = fs.readFileSync(
  path.join(scriptsRoot, "..", "workflows", "select-runner.yml"),
  "utf8",
);

test("the strict-policy allowlist admits exactly the governed fleet label", () => {
  const match = selectorSource.match(
    /^const SELF_HOSTED_ONLY_LABELS = new Set\(\[([^\]]*)\]\);$/mu,
  );
  assert.ok(match, "SELF_HOSTED_ONLY_LABELS set literal not found");
  const members = [...match[1].matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
  assert.deepEqual(members, [GOVERNED_FLEET_LABEL]);
});

test("the strict-policy selector job runs on the same governed label", () => {
  const match = selectorWorkflow.match(
    /^ {4}runs-on: \$\{\{ inputs\.policy == 'self-hosted-only' && '([^']+)' \|\| '[^']+' \}\}$/mu,
  );
  assert.ok(match, "policy-conditional runs-on ternary not found");
  assert.equal(match[1], GOVERNED_FLEET_LABEL);
});

test("the governed fleet label never enters the reserved-label denylist", () => {
  const match = selectorSource.match(
    /const RESERVED_SELF_HOSTED_LABELS = new Set\(\[([^\]]*)\]\);/u,
  );
  assert.ok(match, "RESERVED_SELF_HOSTED_LABELS set literal not found");
  const reserved = [...match[1].matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
  assert.ok(
    !reserved.includes(GOVERNED_FLEET_LABEL),
    "the governed fleet label is reserved and would be rejected",
  );
});
