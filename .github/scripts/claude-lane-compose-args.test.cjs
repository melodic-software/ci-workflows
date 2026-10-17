"use strict";

// Both Claude lanes grant the inline-comment MCP tool in a compose step that
// appends it AFTER the caller's claude-args, so a caller replacing the
// caller-facing default wholesale cannot silently drop the grant — which
// would not merely un-grant the tool: the action derives which MCP servers
// to install from these args, so the server would never be installed. These
// tests pin the drop-proof shape in BOTH lanes.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const INLINE_COMMENT_GRANT =
  "--allowedTools mcp__github_inline_comment__create_inline_comment";
const COMPOSED_ARGS = `\${{ steps.compose-args.outputs.args }}`;

const workflowsDirectory = path.join(__dirname, "..", "workflows");

// The compose run block is expression-free shell (env carries the ${{ }}
// values), so the append contract is executed here rather than
// pattern-matched.
function runCompose(script, env) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "compose-args-"));
  try {
    const githubOutput = path.join(directory, "github-output");
    fs.writeFileSync(githubOutput, "");
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL: "sonnet",
        EFFORT: "high",
        MODEL_ARGS: "",
        HAS_FALLBACK: "false",
        ...env,
        GITHUB_OUTPUT: githubOutput,
      },
    });
    return { result, output: fs.readFileSync(githubOutput, "utf8") };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function composeArgs(script, baseArgs, pluginCommand, env = {}) {
  const { result, output } = runCompose(script, {
    BASE_ARGS: baseArgs,
    PLUGIN_COMMAND: pluginCommand,
    ...env,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const match =
    /^args<<(?<delimiter>\S+)\n(?<value>[\s\S]*?)\n\k<delimiter>\n/mu.exec(
      output,
    );
  assert.ok(match, `no heredoc args output in: ${output}`);
  return match.groups.value;
}

for (const fileName of ["pr-review.yml", "pr-review-security.yml"]) {
  const workflow = parseWorkflow(
    fs.readFileSync(path.join(workflowsDirectory, fileName), "utf8"),
  );
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const claudeArgsInput = workflow.on.workflow_call.inputs["claude-args"];
  const composeStep = steps.find((step) => step?.id === "compose-args");
  const pluginCommand =
    workflow.on.workflow_call.inputs["plugin-command"].default;
  // The review lane also reads the PR body and its closing issue; the
  // security lane stays on the diff alone.
  const defaultBaseArgs =
    fileName === "pr-review.yml"
      ? '--max-turns 75 --allowedTools "Bash(gh pr diff:*)" "Bash(gh pr view:*)" "Bash(gh issue view:*)"'
      : '--max-turns 75 --allowedTools "Bash(gh pr diff:*)"';

  test(`${fileName}: both Claude attempts consume the composed args`, () => {
    const invocations = steps.filter((step) =>
      String(step?.uses ?? "").startsWith("anthropics/claude-code-action@"),
    );
    assert.deepEqual(
      invocations.map((step) => step.id),
      ["claude-review", "claude-review-fallback"],
    );
    for (const invocation of invocations) {
      assert.equal(
        invocation.with.claude_args,
        COMPOSED_ARGS,
        "claude_args must come from the compose step, or the appended inline-comment grant never reaches the action",
      );
    }
  });

  test(`${fileName}: the model and effort inputs follow the caller's args, so they win over a --model there`, () => {
    assert.equal(composeStep.env.MODEL, `\${{ inputs.model }}`);
    assert.equal(composeStep.env.EFFORT, `\${{ inputs.effort }}`);
    const args = composeArgs(
      composeStep.run,
      "--model claude-opus-5 --max-turns 5",
      pluginCommand,
      { MODEL: "claude-sonnet-5-5[1m]", EFFORT: "xhigh" },
    );
    assert.ok(
      args.startsWith(
        "--model claude-opus-5 --max-turns 5 --model claude-sonnet-5-5[1m] --effort xhigh --json-schema ",
      ),
      args,
    );
  });

  test(`${fileName}: a model or effort that is not a plain value stops the job before Claude runs`, () => {
    for (const env of [
      { MODEL: "sonnet --dangerously-skip-permissions" },
      { MODEL: "" },
      { MODEL: "sonnet;id" },
      { EFFORT: "extreme" },
      { EFFORT: "" },
    ]) {
      const { result, output } = runCompose(composeStep.run, {
        BASE_ARGS: "--max-turns 5",
        PLUGIN_COMMAND: pluginCommand,
        ...env,
      });
      assert.equal(result.status, 1, JSON.stringify(env));
      assert.match(
        result.stdout,
        /^::error::The (model|effort) input must be/mu,
      );
      assert.equal(output, "", "no args may be written for a rejected value");
    }
  });

  test(`${fileName}: with no model-args the defaults compose today's model, effort, turns and tools`, () => {
    const modelArgsInput = workflow.on.workflow_call.inputs["model-args"];
    assert.equal(modelArgsInput.default, "");
    assert.equal(composeStep.env.MODEL_ARGS, `\${{ inputs.model-args }}`);
    const args = composeArgs(
      composeStep.run,
      claudeArgsInput.default,
      pluginCommand,
      {
        MODEL: workflow.on.workflow_call.inputs.model.default,
        EFFORT: workflow.on.workflow_call.inputs.effort.default,
      },
    );
    assert.ok(
      args.startsWith(
        `${defaultBaseArgs} --model sonnet --effort high --json-schema `,
      ),
      args,
    );
  });

  test(`${fileName}: model-args replaces the model and effort inputs after the caller's args`, () => {
    for (const modelArgs of [
      "--model sonnet --max-turns 75 --effort high",
      "--max-turns 60",
      "--model opus --max-turns 30",
    ]) {
      const args = composeArgs(
        composeStep.run,
        claudeArgsInput.default,
        pluginCommand,
        { MODEL: "haiku", EFFORT: "low", MODEL_ARGS: modelArgs },
      );
      assert.ok(
        args.startsWith(
          `${defaultBaseArgs} ${modelArgs} --json-schema `,
        ),
        args,
      );
      assert.doesNotMatch(args, /haiku|--effort low/u);
    }
  });

  test(`${fileName}: a model-args value outside resolve-config's shape stops the job before Claude runs`, () => {
    for (const modelArgs of [
      "--model sonnet --max-turns 75; id",
      '--max-turns 75 --allowedTools "Bash(*)"',
      "--model sonnet --max-turns 75 --effort high --dangerously-skip-permissions",
      "--model sonnet --max-turns 75\n--allowedTools Bash",
      "--model sonnet",
      "--max-turns 0",
      "--model Sonnet --max-turns 75",
      "--max-turns 75 ",
      "$(id) --max-turns 75",
    ]) {
      const { result, output } = runCompose(composeStep.run, {
        BASE_ARGS: "--max-turns 5",
        PLUGIN_COMMAND: pluginCommand,
        MODEL_ARGS: modelArgs,
      });
      assert.equal(result.status, 1, modelArgs);
      assert.match(result.stdout, /^::error::The model-args input must be/mu);
      assert.equal(output, "", "no args may be written for a rejected value");
    }
  });

  test(`${fileName}: the compose step reports whether the caller passed a fallback token`, () => {
    assert.equal(
      composeStep.env.HAS_FALLBACK,
      `\${{ secrets.fallback-claude-code-oauth-token != '' }}`,
    );
    for (const value of ["true", "false"]) {
      const { output } = runCompose(composeStep.run, {
        BASE_ARGS: "--max-turns 5",
        PLUGIN_COMMAND: pluginCommand,
        HAS_FALLBACK: value,
      });
      assert.match(output, new RegExp(`^fallback=${value}$`, "mu"));
    }
  });

  test(`${fileName}: the caller-replaceable default carries no inline-comment grant`, () => {
    // The grant's only home is the compose step: in the default it would sit
    // in the one place a caller's value replaces wholesale.
    assert.doesNotMatch(claudeArgsInput.default, /inline_comment/u);
    assert.match(claudeArgsInput.default, /Bash\(gh pr diff:\*\)/u);
  });

  test(`${fileName}: the compose step appends both grants to any caller value`, () => {
    assert.ok(composeStep, "compose-args step not found");
    assert.doesNotMatch(
      composeStep.run,
      /\$\{\{/u,
      "the compose run block interpolates a github expression, so executing it here would not match CI",
    );
    for (const baseArgs of [
      claudeArgsInput.default.trim(),
      // A caller replacing the default wholesale, with no inline-comment
      // grant of its own.
      '--model claude-opus-5 --allowedTools "Bash(git log:*)"',
      // Multiline caller args are the reason for the heredoc output form: a
      // single-line $GITHUB_OUTPUT write corrupts on any embedded newline.
      "--model claude-opus-5\n--max-turns 5",
    ]) {
      const args = composeArgs(composeStep.run, baseArgs, pluginCommand);
      assert.ok(
        args.startsWith(baseArgs),
        `the caller's own args must survive composition: ${args}`,
      );
      assert.ok(
        args.endsWith(
          `${INLINE_COMMENT_GRANT} --allowedTools "Skill(${pluginCommand.slice(1)})"`,
        ),
        `both grants must be appended after the caller's args: ${args}`,
      );
    }
  });

  test(`${fileName}: the Skill grant follows the plugin-command input`, () => {
    // Without it the headless session is denied the command it is told to
    // run and falls back to an unscripted pass (claude-code-plugins#4306).
    assert.equal(
      composeStep.env.PLUGIN_COMMAND,
      `\${{ inputs.plugin-command }}`,
    );
    for (const [command, grant] of [
      ["/review:code-review", "Skill(review:code-review)"],
      ["/other:lane --flag", "Skill(other:lane)"],
    ]) {
      const args = composeArgs(composeStep.run, "--max-turns 5", command);
      assert.ok(args.endsWith(`--allowedTools "${grant}"`), args);
    }
  });
}
