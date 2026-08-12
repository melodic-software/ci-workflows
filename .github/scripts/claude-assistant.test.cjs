"use strict";

// Contract for the org @claude mention-responder (ci-workflows#255):
// V1 answer/re-review only — reusable + self caller, tool-allowlist floor,
// empty allowed-bots default, never allowed_non_write_users, self-trigger ban.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const repositoryRoot = path.join(__dirname, "..", "..");
const reusablePath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "claude-assistant.yml",
);
const callerPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "claude-assistant-self.yml",
);
const adrPath = path.join(
  repositoryRoot,
  "docs",
  "topics",
  "claude-review-lanes",
  "claude-assistant-ADR.md",
);

const reusableSource = fs.readFileSync(reusablePath, "utf8");
const callerSource = fs.readFileSync(callerPath, "utf8");
const reusable = parseWorkflow(reusableSource);
const caller = parseWorkflow(callerSource);

const TOOL_FLOOR_FRAGMENTS = [
  "--allowedTools Read,Grep,Glob",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh issue view:*)",
  "mcp__github_inline_comment__create_inline_comment",
];

function composeArgs(script, baseArgs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-compose-"));
  try {
    const githubOutput = path.join(directory, "github-output");
    fs.writeFileSync(githubOutput, "");
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_ARGS: baseArgs,
        GITHUB_OUTPUT: githubOutput,
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = fs.readFileSync(githubOutput, "utf8");
    const match =
      /^args<<(?<delimiter>\S+)\n(?<value>[\s\S]*?)\n\k<delimiter>\n/mu.exec(
        output,
      );
    assert.ok(match, `no heredoc args output in: ${output}`);
    return match.groups.value;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("ADR exists and locks V1 answer/re-review", () => {
  const adr = fs.readFileSync(adrPath, "utf8");
  assert.match(adr, /#255/u);
  assert.match(adr, /answer\s*\/\s*re-review/iu);
  assert.match(adr, /allowed_non_write_users/u);
  assert.match(adr, /never ['`]\*['`]/iu);
});

test("canonical caller owns mention + dispatch triggers and @claude guards", () => {
  assert.deepEqual(caller.on.issue_comment.types, ["created"]);
  assert.deepEqual(caller.on.pull_request_review_comment.types, ["created"]);
  assert.ok(caller.on.workflow_dispatch);
  assert.equal(caller.on.workflow_dispatch.inputs.prompt.required, true);
  assert.match(
    callerSource,
    /contains\(github\.event\.comment\.body, '@claude'\)/u,
  );
  assert.equal(caller.jobs.assist.permissions.contents, "read");
  assert.equal(caller.jobs.assist.permissions["pull-requests"], "write");
  assert.equal(caller.jobs.assist.permissions.issues, "write");
  assert.equal(caller.jobs.assist.permissions["id-token"], "write");
  assert.match(
    callerSource,
    /uses: \.\/\.github\/workflows\/claude-assistant\.yml/u,
  );
  assert.match(
    callerSource,
    /CLAUDE_CODE_OAUTH_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/u,
  );
});

test("reusable is workflow_call-only with V1 inputs and OAuth secret", () => {
  assert.ok(reusable.on.workflow_call);
  assert.equal(Object.keys(reusable.on).join(","), "workflow_call");
  const inputs = reusable.on.workflow_call.inputs;
  assert.equal(inputs["allowed-bots"].default, "");
  assert.equal(inputs["allowed-authors"].default, "");
  assert.equal(inputs["timeout-minutes"].default, 15);
  assert.match(inputs["skip-actors"].default, /claude\[bot\]/u);
  assert.match(inputs["skip-actors"].default, /melodic-ai\[bot\]/u);
  assert.equal(
    reusable.on.workflow_call.secrets.CLAUDE_CODE_OAUTH_TOKEN.required,
    true,
  );
});

test("reusable job gates kill-switches, skip-actors, and allowed-authors", () => {
  const jobIf = reusable.jobs.assist.if;
  assert.match(String(jobIf), /CLAUDE_LANES_DISABLED/u);
  assert.match(String(jobIf), /CLAUDE_ASSISTANT_DISABLED/u);
  assert.match(String(jobIf), /skip-actors/u);
  assert.match(String(jobIf), /allowed-authors/u);
});

test("reusable never passes allowed_non_write_users and keeps contents:read", () => {
  const assist = reusable.jobs.assist.steps.find(
    (step) => step?.id === "claude-assist",
  );
  assert.ok(assist);
  assert.ok(!("allowed_non_write_users" in (assist.with ?? {})));
  // Mentions in comments are fine; the action input key must never appear as a
  // with: mapping (strip comment lines before scanning).
  const withoutComments = reusableSource
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
  assert.doesNotMatch(withoutComments, /^\s*allowed_non_write_users\s*:/mu);
  assert.equal(reusable.jobs.assist.permissions.contents, "read");
  assert.notEqual(reusable.jobs.assist.permissions.contents, "write");
});

test("reusable rejects privileged triggers and allowed-bots wildcard", () => {
  assert.match(reusableSource, /Reject privileged triggers/u);
  assert.match(reusableSource, /pull_request_target/u);
  assert.match(reusableSource, /Reject allowed-bots wildcard/u);
  assert.match(reusableSource, /Reject write-capable Claude tool grants/u);
});

test("compose step appends the V1 tool-allowlist floor", () => {
  const steps = reusable.jobs.assist.steps;
  const compose = steps.find((step) => step?.id === "compose-args");
  assert.ok(compose, "compose-args step required");
  assert.doesNotMatch(
    compose.run,
    /\$\{\{/u,
    "compose run must be expression-free shell for local execution",
  );
  const claudeArgsDefault =
    reusable.on.workflow_call.inputs["claude-args"].default;
  assert.doesNotMatch(claudeArgsDefault, /\b(Edit|Write)\b/u);
  assert.doesNotMatch(claudeArgsDefault, /Bash\(git /u);

  const cases = [
    claudeArgsDefault.trim(),
    '--model claude-sonnet-5 --max-turns 10',
    "--model claude-sonnet-5\n--max-turns 5",
  ];
  for (const baseArgs of cases) {
    const args = composeArgs(compose.run, baseArgs);
    assert.ok(args.startsWith(baseArgs), `caller args must survive: ${args}`);
    for (const fragment of TOOL_FLOOR_FRAGMENTS) {
      assert.ok(
        args.includes(fragment),
        `floor fragment missing (${fragment}): ${args}`,
      );
    }
    assert.doesNotMatch(args, /\b(Edit|Write|NotebookEdit)\b/u);
    assert.doesNotMatch(args, /Bash\(git (commit|push)/u);
  }
});

test("Claude action pin and advisory continue-on-error", () => {
  const steps = reusable.jobs.assist.steps;
  const assist = steps.find((step) => step?.id === "claude-assist");
  assert.ok(assist);
  assert.equal(assist["continue-on-error"], true);
  assert.match(
    String(assist.uses),
    /^anthropics\/claude-code-action@[0-9a-f]{40}$/u,
  );
  assert.equal(
    assist.with.claude_args,
    "${{ steps.compose-args.outputs.args }}",
  );
  assert.equal(
    assist.with.claude_code_oauth_token,
    "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
  );
  assert.equal(assist.with.allowed_bots, "${{ inputs.allowed-bots }}");
  assert.ok(!("allowed_non_write_users" in (assist.with ?? {})));
  assert.ok(!("use_commit_signing" in (assist.with ?? {})));
});

test("per-entity concurrency and credential strip are present", () => {
  assert.match(
    String(reusable.jobs.assist.concurrency.group),
    /claude-assistant-/u,
  );
  assert.equal(reusable.jobs.assist.concurrency["cancel-in-progress"], true);
  assert.match(reusableSource, /Strip persisted git credentials/u);
});
