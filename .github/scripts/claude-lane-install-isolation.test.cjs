"use strict";

// Both Claude lanes install bubblewrap with their own copy of the same step.
// The copies must not drift: a fix to one that misses the other leaves one
// lane without the isolation the other has.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsDir = path.join(__dirname, "..", "workflows");
const stepName = "Install subprocess isolation";

const installStep = (file) => {
  const workflow = parseWorkflow(
    fs.readFileSync(path.join(workflowsDir, file), "utf8"),
  );
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const matches = steps.filter((step) => step.name === stepName);
  assert.equal(matches.length, 1, `${file} has one "${stepName}" step`);
  assert.equal(typeof matches[0].run, "string", file);
  return matches[0];
};

test("both lanes run the same subprocess isolation install script", () => {
  assert.equal(
    installStep("pr-review.yml").run,
    installStep("pr-review-security.yml").run,
  );
});

// A slow mirror once held one unbounded apt-get attempt past the step limit,
// so the lane timed out instead of failing with a named cause.
test("every apt-get call ends before its step limit", () => {
  const steps = [
    "pr-review.yml",
    "pr-review-security.yml",
    "intake-triage.yml",
  ].flatMap((file) => {
    const workflow = parseWorkflow(
      fs.readFileSync(path.join(workflowsDir, file), "utf8"),
    );
    return Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => /\bapt-get\b/.test(step.run ?? ""))
      .map((step) => ({ file, step }));
  });
  assert.equal(steps.length, 5, "two lane steps and three intake-triage steps");
  for (const { file, step } of steps) {
    const label = `${file}: ${step.name}`;
    const unbounded = step.run
      .split("\n")
      .filter((line) => /\bsudo\b.*\bapt-get\b/.test(line))
      .filter((line) => !/\bsudo timeout -k \d+ "\$left" apt-get\b/.test(line));
    assert.deepEqual(
      unbounded,
      [],
      `${label} runs apt-get only under the deadline`,
    );
    const deadline = Number(
      /deadline=\$\(\(SECONDS \+ (\d+)\)\)/.exec(step.run)?.[1],
    );
    const kill = Number(/timeout -k (\d+)/.exec(step.run)?.[1]);
    assert.ok(
      deadline + kill < step["timeout-minutes"] * 60,
      `${label} deadline fits`,
    );
    // The skip needs both tools, so the final check must too.
    assert.match(
      step.run,
      /if ! \{ command -v bwrap && command -v socat; \} >\/dev\/null; then\n\s*echo "::error::[^\n]*"\n\s*exit 1/,
      `${label} fails without bwrap or socat`,
    );
  }
});

// With the scrub env set and sandbox.enabled unset, Claude Code runs a
// scrub-only sandbox that passes bwrap --disable-userns and dies on a
// read-only /proc/sys (#938). Every review attempt turns on the full sandbox
// with no unsandboxed retry and network to the two GitHub hosts only.
test("every review attempt runs Bash under the full sandbox", () => {
  for (const file of ["pr-review.yml", "pr-review-security.yml"]) {
    const workflow = parseWorkflow(
      fs.readFileSync(path.join(workflowsDir, file), "utf8"),
    );
    const reviews = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) =>
        /^anthropics\/claude-code-action@/u.test(step.uses ?? ""),
      );
    assert.equal(reviews.length, 2, `${file} has two review attempts`);
    for (const step of reviews) {
      const label = `${file}: ${step.name}`;
      assert.deepEqual(
        JSON.parse(step.with.settings),
        {
          sandbox: {
            enabled: true,
            allowUnsandboxedCommands: false,
            network: { allowedDomains: ["github.com", "api.github.com"] },
          },
        },
        label,
      );
      assert.equal(step.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1", label);
    }
  }
});
