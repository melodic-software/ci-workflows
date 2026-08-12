"use strict";

// Both Claude lanes grant the inline-comment MCP tool in a compose step that
// appends it AFTER the caller's claude-args, so a caller replacing the
// caller-facing default wholesale cannot silently drop the grant — which
// would not merely un-grant the tool: the action derives which MCP servers
// to install from these args, so the server would never be installed. The
// lanes once diverged on this shape (ciw#382); these tests pin the
// drop-proof shape in BOTH lanes so the asymmetry class cannot return.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const INLINE_COMMENT_GRANT =
  "--allowedTools mcp__github_inline_comment__create_inline_comment";
const DISPATCH_GH_GRANT =
  "--allowedTools Bash(gh pr comment:*),Bash(gh pr review:*),Bash(gh pr diff:*)";
const COMPOSED_ARGS = `\${{ steps.compose-args.outputs.args }}`;

const workflowsDirectory = path.join(__dirname, "..", "workflows");

// The compose run block is expression-free shell (env carries the ${{ }}
// values), so the append contract is executed here rather than
// pattern-matched.
function composeArgs(script, baseArgs, standardsRef = "", eventName = "pull_request") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "compose-args-"));
  try {
    const githubOutput = path.join(directory, "github-output");
    fs.writeFileSync(githubOutput, "");
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_ARGS: baseArgs,
        STANDARDS_REF: standardsRef,
        MOUNT_PATH: standardsRef === "" ? "" : "/tmp/standards-ref",
        EVENT_NAME: eventName,
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

for (const fileName of ["claude-review.yml", "claude-security-review.yml"]) {
  const workflow = parseWorkflow(
    fs.readFileSync(path.join(workflowsDirectory, fileName), "utf8"),
  );
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const claudeArgsInput = workflow.on.workflow_call.inputs["claude-args"];
  const composeStep = steps.find((step) => step?.id === "compose-args");

  test(`${fileName}: every Claude invocation consumes the composed args`, () => {
    const invocations = steps.filter((step) =>
      String(step?.uses ?? "").startsWith("anthropics/claude-code-action@"),
    );
    assert.ok(
      invocations.length >= 2,
      "expected at least a first attempt and a retry",
    );
    for (const invocation of invocations) {
      assert.equal(
        invocation.with.claude_args,
        COMPOSED_ARGS,
        `${invocation.name} reads claude_args from somewhere other than the compose step, so the appended inline-comment grant would never reach it`,
      );
    }
  });

  test(`${fileName}: the caller-replaceable default carries no inline-comment grant`, () => {
    // The grant's only home is the compose step: in the default it would sit
    // in the one place a caller's value replaces wholesale.
    assert.doesNotMatch(claudeArgsInput.default, /inline_comment/u);
    assert.match(claudeArgsInput.default, /Bash\(gh pr diff:\*\)/u);
  });

  test(`${fileName}: the compose step appends the grant to any caller value`, () => {
    assert.ok(composeStep, "compose-args step not found");
    assert.doesNotMatch(
      composeStep.run,
      /\$\{\{/u,
      "the compose run block interpolates a github expression, so executing it here would not match CI",
    );
    const cases = [
      { baseArgs: claudeArgsInput.default.trim() },
      // A caller replacing the default wholesale, with no inline-comment
      // grant of its own — the ciw#382 shape.
      { baseArgs: '--model claude-opus-5 --allowedTools "Bash(git log:*)"' },
      // Multiline caller args are the reason for the heredoc output form: a
      // single-line $GITHUB_OUTPUT write corrupts on any embedded newline.
      { baseArgs: "--model claude-opus-5\n--max-turns 5" },
      // A standards mount must land between the caller's args and the grant,
      // never after it (the env is inert in a lane without a standards-ref
      // input).
      { baseArgs: claudeArgsInput.default.trim(), standardsRef: "main" },
    ];
    for (const { baseArgs, standardsRef = "" } of cases) {
      const args = composeArgs(composeStep.run, baseArgs, standardsRef);
      assert.ok(
        args.startsWith(baseArgs),
        `the caller's own args must survive composition: ${args}`,
      );
      assert.ok(
        args.endsWith(INLINE_COMMENT_GRANT),
        `the inline-comment grant must be appended after the caller's args: ${args}`,
      );
      if (standardsRef !== "" && fileName === "claude-review.yml") {
        assert.ok(
          args.includes("--add-dir /tmp/standards-ref"),
          `a standards ref must mount its directory: ${args}`,
        );
      }
    }
  });

  if (fileName === "claude-review.yml") {
    test(`${fileName}: workflow_dispatch compose grants gh delivery tools (#254)`, () => {
      const args = composeArgs(
        composeStep.run,
        claudeArgsInput.default.trim(),
        "",
        "workflow_dispatch",
      );
      assert.ok(
        args.endsWith(DISPATCH_GH_GRANT),
        `dispatch must append gh delivery tools, not inline MCP: ${args}`,
      );
      assert.doesNotMatch(args, /inline_comment/u);
    });
  }
}
