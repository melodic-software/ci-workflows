"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// The reviewed production fleet labels. A relabel must change every site in the
// same reviewed commit; these tests turn a partial relabel from a silent
// org-wide routing kill into a red check (github-iac#89, landmine L2).
// GOVERNED_FLEET_LABEL is the always-on default tier the selector job itself
// runs on; REVIEW_FLEET_LABEL is the dedicated capped review tier that strict
// routing may return but the selector job must never run on.
const GOVERNED_FLEET_LABEL = "melodic-ubuntu-24.04-x64";
const REVIEW_FLEET_LABEL = "melodic-review-ubuntu-24.04-x64";

const scriptsRoot = __dirname;
const selectorSource = fs.readFileSync(
  path.join(scriptsRoot, "select-runner.cjs"),
  "utf8",
);
const selectorWorkflow = fs.readFileSync(
  path.join(scriptsRoot, "..", "workflows", "select-runner.yml"),
  "utf8",
);

test("the strict-policy allowlist admits exactly the governed fleet labels", () => {
  const match = selectorSource.match(
    /const SELF_HOSTED_ONLY_LABELS = new Set\(\[([\s\S]*?)\]\);/u,
  );
  assert.ok(match, "SELF_HOSTED_ONLY_LABELS set literal not found");
  const members = [...match[1].matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
  assert.deepEqual(members, [GOVERNED_FLEET_LABEL, REVIEW_FLEET_LABEL]);
});

test("the strict-policy selector job runs on the default fleet label, not the review tier", () => {
  const match = selectorWorkflow.match(
    /^ {4}runs-on: \$\{\{ inputs\.policy == 'self-hosted-only' && '([^']+)' \|\| '[^']+' \}\}$/mu,
  );
  assert.ok(match, "policy-conditional runs-on ternary not found");
  assert.equal(match[1], GOVERNED_FLEET_LABEL);
});

test("no governed fleet label enters the reserved-label denylist", () => {
  const match = selectorSource.match(
    /const RESERVED_SELF_HOSTED_LABELS = new Set\(\[([^\]]*)\]\);/u,
  );
  assert.ok(match, "RESERVED_SELF_HOSTED_LABELS set literal not found");
  const reserved = [...match[1].matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
  for (const label of [GOVERNED_FLEET_LABEL, REVIEW_FLEET_LABEL]) {
    assert.ok(
      !reserved.includes(label),
      `the governed fleet label ${label} is reserved and would be rejected`,
    );
  }
});
