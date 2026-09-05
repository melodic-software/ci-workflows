"use strict";

// The `checks.yml` outcome join decides the consolidated lane's verdict. It is
// the one place where a bug is silently catastrophic rather than noisy: every
// composite runs under `continue-on-error: true`, so a join that forgot a
// composite reports success for a run in which that composite failed, and
// ci-status aggregates the green.
//
// The join is expression-free shell (env carries every `${{ }}` value), so this
// executes it against fixture outcomes rather than pattern-matching its text,
// and separately proves that every `continue-on-error` step in the workflow is
// wired into it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowPath = path.join(__dirname, "..", "workflows", "checks.yml");
const workflow = parseWorkflow(fs.readFileSync(workflowPath, "utf8"));
const steps = workflow.jobs.checks.steps;
const joinStep = steps.find((step) => step?.id === "outcome");
assert.ok(joinStep !== undefined, "checks.yml has no `outcome` join step");

// Every step the join owns: the composites, plus the input-combination guard
// that must go red rather than let an enabled toggle skip silently.
const joined = steps.filter(
  (step) => String(step?.["continue-on-error"] ?? "") === "true",
);
const composites = joined.filter((step) => step.uses !== undefined);

// Every joined step's outcome reaches the join under the env name the join
// reads, and the join reports it under that step's own (kebab-case) name.
const environment = Object.fromEntries(
  joined.map((step) => [
    step.id.toUpperCase(),
    `\${{ steps.${step.id}.outcome }}`,
  ]),
);

function runJoin(outcomes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "checks-outcome-"));
  try {
    const githubOutput = path.join(directory, "github-output");
    fs.writeFileSync(githubOutput, "");
    const result = spawnSync("bash", ["-c", joinStep.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.keys(environment).map((name) => [
            name,
            outcomes[name] ?? "success",
          ]),
        ),
        GITHUB_OUTPUT: githubOutput,
      },
    });
    return {
      status: result.status,
      stdout: `${result.stdout}${result.stderr}`,
      output: fs.readFileSync(githubOutput, "utf8"),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("the join reads every continue-on-error step", () => {
  assert.equal(
    composites.length,
    12,
    `expected the twelve hygiene composites, found ${composites.length}`,
  );
  for (const step of joined) {
    const name = step.id.replaceAll("_", "-");
    assert.equal(
      joinStep.env[step.id.toUpperCase()],
      `\${{ steps.${step.id}.outcome }}`,
      `step ${step.id} is continue-on-error but its outcome never reaches the join`,
    );
    assert.match(
      joinStep.run,
      new RegExp(`^ *report ${name} "\\$${step.id.toUpperCase()}"$`, "mu"),
      `step ${step.id} is never reported by the join`,
    );
  }
  for (const step of composites) {
    const name = step.id.replaceAll("_", "-");
    assert.match(
      String(step.uses ?? ""),
      new RegExp(
        `^melodic-software/ci-workflows/\\.github/actions/${name}@[0-9a-f]{40}$`,
        "u",
      ),
      // A relative `./` reference inside a CALLED workflow resolves against the
      // CALLER's checkout, so it would fail in every consumer.
      `step ${step.id} does not reference its composite by pinned full path`,
    );
  }
  // The join reports nothing the steps do not produce: an env name left behind
  // after a composite is removed would report a permanently empty outcome.
  assert.deepEqual(
    Object.keys(joinStep.env).sort(),
    Object.keys(environment).sort(),
  );
});

test("every composite green passes and records outcome=success", () => {
  const result = runJoin({});
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.output, /^outcome=success$/mu);
  assert.match(result.stdout, /^checks passed\.$/mu);
});

test("every composite skipped passes: nothing ran, nothing failed", () => {
  const skipped = Object.fromEntries(
    Object.keys(environment).map((name) => [name, "skipped"]),
  );
  const result = runJoin(skipped);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.output, /^outcome=success$/mu);
});

test("one failure fails the job and names the composite", () => {
  const result = runJoin({ MARKDOWN: "failure" });
  assert.equal(result.status, 1, result.stdout);
  // The verdict is written BEFORE the exit, so a caller reading the output on
  // the failure path sees `failure` rather than nothing.
  assert.match(result.output, /^outcome=failure$/mu);
  assert.match(
    result.stdout,
    /^::error::markdown failed \(outcome=failure\)\.$/mu,
  );
  assert.match(result.stdout, /^::error::checks failed: markdown\.$/mu);
});

test("two failures name the first in declaration order and count the rest", () => {
  const result = runJoin({ GITLEAKS: "failure", LYCHEE_OFFLINE: "failure" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.output, /^outcome=failure$/mu);
  assert.match(
    result.stdout,
    /^::error::checks failed: gitleaks \(and 1 more\)\.$/mu,
  );
  // Fail at the end, not at the first failure: the later composite still ran
  // and its failure is still annotated.
  assert.match(
    result.stdout,
    /^::error::lychee-offline failed \(outcome=failure\)\.$/mu,
  );
});

test("an enabled toggle with no configuration fails, it does not skip quietly", () => {
  // The guard step fires only when `check-jsonschema` is enabled with empty
  // `check-jsonschema-files`; the join is what turns it into the job's verdict,
  // so a silently skipped schema gate cannot report success.
  const guard = steps.find((step) => step?.id === "configuration");
  assert.ok(guard !== undefined, "checks.yml has no input-combination guard");
  assert.equal(
    guard.if,
    `\${{ inputs.check-jsonschema && inputs.check-jsonschema-files == '' }}`,
  );
  const result = runJoin({ CONFIGURATION: "failure" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.output, /^outcome=failure$/mu);
  assert.match(result.stdout, /^::error::checks failed: configuration\.$/mu);
});

test("a composite that never ran is reported, not treated as a failure", () => {
  const result = runJoin({ CHECK_JSONSCHEMA: "" });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^check-jsonschema: not-run$/mu);
});
