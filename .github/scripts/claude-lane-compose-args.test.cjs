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
// The shell assignment escapes the inner quotes; the composed string the
// action parses contains the quotes themselves. The code-review lane also
// grants the file tools the pinned Claude Code build still honors. LS is
// intentionally absent. The security lane quotes the same gh grant and does
// not add file tools.
const DISPATCH_GRANTS = {
  "claude-review.yml":
    'Bash(gh pr comment:*),Bash(gh pr review:*),Bash(gh pr diff:*),Read,Grep,Glob',
  "claude-security-review.yml":
    "Bash(gh pr comment:*),Bash(gh pr review:*),Bash(gh pr diff:*)",
};
const COMPOSED_ARGS = `\${{ steps.compose-args.outputs.args }}`;

// Quote-aware whitespace split, matching the contract the pinned action's
// shell-quote parse depends on: a quoted --allowedTools value is one token,
// and an unquoted multi-word value shatters on spaces. This is the regression
// for ci-workflows#573 — a regex over the source line would still pass if the
// quotes were eaten before the action saw them.
function tokenizeArgs(input) {
  const tokens = [];
  let current = "";
  let quote = "";
  for (const character of input) {
    if (quote !== "") {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quote !== "") {
    throw new Error(`unterminated ${quote} quote in composed args`);
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

// Mirrors the accumulating --allowedTools consumption in
// base-action/src/parse-sdk-options.ts at the pinned action SHA, then the
// comma split and dedupe that build the allowedTools array.
function allowedToolValues(args) {
  const tokens = tokenizeArgs(args);
  const values = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== "--allowedTools" && token !== "--allowed-tools") continue;
    while (index + 1 < tokens.length && !tokens[index + 1].startsWith("--")) {
      index += 1;
      values.push(tokens[index]);
    }
  }
  return values;
}

function splitAllowedTools(values) {
  const tools = [];
  const seen = new Set();
  for (const value of values) {
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (trimmed !== "" && !seen.has(trimmed)) {
        seen.add(trimmed);
        tools.push(trimmed);
      }
    }
  }
  return tools;
}

const workflowsDirectory = path.join(__dirname, "..", "workflows");

// The compose run block is expression-free shell (env carries the ${{ }}
// values), so the append contract is executed here rather than
// pattern-matched.
function composeArgs(
  script,
  baseArgs,
  standardsRef = "",
  eventName = "pull_request",
) {
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

  test(`${fileName}: workflow_dispatch compose keeps one allowedTools value (#254, #573)`, () => {
    const grant = DISPATCH_GRANTS[fileName];
    const quotedGrant = `--allowedTools "${grant}"`;
    const cases = [
      claudeArgsInput.default.trim(),
      // A caller that replaced the default wholesale, with no grant of its
      // own. The dispatch value still has to survive as one token.
      "--model claude-opus-5",
    ];
    for (const baseArgs of cases) {
      const args = composeArgs(composeStep.run, baseArgs, "", "workflow_dispatch");
      assert.ok(
        args.endsWith(quotedGrant),
        `dispatch must append one quoted gh grant, not inline MCP: ${args}`,
      );
      assert.doesNotMatch(args, /inline_comment/u);
      const values = allowedToolValues(args);
      assert.equal(
        values.at(-1),
        grant,
        `the dispatch grant must be one token, not whitespace-shattered: ${JSON.stringify(values)}`,
      );
      assert.deepEqual(splitAllowedTools([values.at(-1)]), grant.split(","));
      const tools = splitAllowedTools(values);
      for (const fragment of ["Bash(gh", "pr", "comment:*)", "review:*)", "diff:*)", "LS"]) {
        assert.equal(
          tools.includes(fragment),
          false,
          `shattered or dead tool ${fragment} in ${JSON.stringify(tools)}`,
        );
      }
    }
  });
}

test("the quote-aware tokenizer shatters the unquoted dispatch grant", () => {
  // Pins the oracle itself. The bug was invisible to a source-line regex and
  // visible only after this split; if the tokenizer stopped splitting on
  // spaces, the assertions above would go green on the old unquoted grant.
  const values = allowedToolValues(
    "--allowedTools Bash(gh pr comment:*),Bash(gh pr review:*),Bash(gh pr diff:*)",
  );
  assert.deepEqual(values, [
    "Bash(gh",
    "pr",
    "comment:*),Bash(gh",
    "pr",
    "review:*),Bash(gh",
    "pr",
    "diff:*)",
  ]);
  assert.ok(values.length > 1);
});
