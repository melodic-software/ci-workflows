"use strict";

// setup-lane-plugins stages trusted plugin copies into a read-only workspace
// directory for run-claude-cli, failing closed on pre-existing or tracked
// staging roots, symlinks, or invalid inputs, and rolling back on error.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  EMPTY_MCP_JSON,
  StageError,
  parseDestination,
  parsePlugins,
  stageLanePlugins,
} = require("../actions/setup-lane-plugins/stage.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const SCRIPT = path.join(
  __dirname,
  "..",
  "actions",
  "setup-lane-plugins",
  "stage.cjs",
);

const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    env: GIT_ENV,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout;
}

function readOutputs(text) {
  const outputs = {};
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "") continue;
    const heredoc = line.match(/^([^=<]+)<<(.+)$/u);
    if (heredoc) {
      const [, name, delimiter] = heredoc;
      const body = [];
      index += 1;
      while (index < lines.length && lines[index] !== delimiter) {
        body.push(lines[index]);
        index += 1;
      }
      if (index >= lines.length) throw new Error(`unterminated output ${name}`);
      outputs[name] = body.join("\n");
      continue;
    }
    const separator = line.indexOf("=");
    outputs[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return outputs;
}

function makeWritableRecursive(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(target, 0o755);
    for (const entry of fs.readdirSync(target)) {
      makeWritableRecursive(path.join(target, entry));
    }
  } else {
    fs.chmodSync(target, 0o644);
  }
}

function setupFixture(t, { initGit = true, commitHead = true } = {}) {
  const root = fs.realpathSync(makeTemporaryDirectory("setup-lane-plugins-"));
  t.after(() => {
    makeWritableRecursive(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "source-plugins");
  fs.mkdirSync(workspace);
  fs.mkdirSync(source);

  if (initGit) {
    git(workspace, "init", "-q");
    if (commitHead) {
      fs.writeFileSync(path.join(workspace, "README.md"), "hello\n");
      git(workspace, "add", "README.md");
      git(workspace, "commit", "-q", "-m", "init");
    }
  }

  return { root, workspace, source };
}

function writePlugin(sourceDir, name, files) {
  const pluginDir = path.join(sourceDir, name);
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const [relPath, spec] of Object.entries(files)) {
    const absPath = path.join(pluginDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    if (typeof spec === "string") {
      fs.writeFileSync(absPath, spec);
    } else {
      fs.writeFileSync(absPath, spec.content, { mode: spec.mode ?? 0o644 });
      if (spec.mode !== undefined) fs.chmodSync(absPath, spec.mode);
    }
  }
  return pluginDir;
}

function runCli(env) {
  const outputPath = path.join(
    makeTemporaryDirectory("setup-lane-plugins-out-"),
    "output",
  );
  fs.writeFileSync(outputPath, "");
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputPath, ...env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs: readOutputs(fs.readFileSync(outputPath, "utf8")),
  };
}

test("stages a single plugin read-only, writes empty .mcp.json, preserves exec bits, and excludes .lane in git", (t) => {
  const { workspace, source } = setupFixture(t);
  writePlugin(source, "review", {
    "plugin.json": '{"name":"review"}\n',
    "skills/code-review/SKILL.md": "# Review\n",
    "scripts/check.sh": {
      content: "#!/usr/bin/env bash\necho ok\n",
      mode: 0o755,
    },
  });

  const result = stageLanePlugins({
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: workspace,
    STAGE_SOURCE_DIR: source,
    STAGE_PLUGINS: "review",
  });

  assert.deepEqual(result.pluginDirs, [".lane/plugins/review"]);
  assert.equal(result.createdMcpCount, 1);
  assert.equal(result.gitExcluded, true);

  const staged = path.join(workspace, ".lane", "plugins", "review");
  assert.equal(
    fs.readFileSync(path.join(staged, ".mcp.json"), "utf8"),
    EMPTY_MCP_JSON,
  );
  assert.equal(
    fs.readFileSync(
      path.join(staged, "skills", "code-review", "SKILL.md"),
      "utf8",
    ),
    "# Review\n",
  );

  // Every directory and file under .lane/plugins has no write bits, while
  // executable scripts keep their execute bit.
  for (const rel of [
    ".lane/plugins",
    ".lane/plugins/review",
    ".lane/plugins/review/plugin.json",
    ".lane/plugins/review/.mcp.json",
    ".lane/plugins/review/skills/code-review/SKILL.md",
    ".lane/plugins/review/scripts/check.sh",
  ]) {
    const mode = fs.lstatSync(path.join(workspace, rel)).mode & 0o777;
    assert.equal(
      mode & 0o222,
      0,
      `${rel} must have no write bits (got ${mode.toString(8)})`,
    );
  }
  const scriptMode =
    fs.lstatSync(path.join(staged, "scripts", "check.sh")).mode & 0o777;
  assert.notEqual(scriptMode & 0o111, 0, "executable bit must be preserved");

  const exclude = fs.readFileSync(
    path.join(workspace, ".git", "info", "exclude"),
    "utf8",
  );
  assert.ok(exclude.split("\n").includes("/.lane/"));
  assert.equal(git(workspace, "status", "--porcelain"), "");
});

test("stages multiple plugins in order, collapses duplicates, and preserves a shipped .mcp.json", (t) => {
  const { workspace, source } = setupFixture(t);
  const shippedMcp = '{"mcpServers":{"custom":{"command":"echo"}}}\n';
  writePlugin(source, "harness-ops", {
    "plugin.json": '{"name":"harness-ops"}\n',
    ".mcp.json": shippedMcp,
  });
  writePlugin(source, "planning", {
    "plugin.json": '{"name":"planning"}\n',
  });

  const cli = runCli({
    GITHUB_WORKSPACE: workspace,
    STAGE_SOURCE_DIR: source,
    STAGE_PLUGINS: "\n  harness-ops \nplanning\nharness-ops\n\n",
  });

  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(
    cli.outputs["plugin-dirs"],
    ".lane/plugins/harness-ops\n.lane/plugins/planning",
  );
  assert.equal(
    fs.readFileSync(
      path.join(workspace, ".lane", "plugins", "harness-ops", ".mcp.json"),
      "utf8",
    ),
    shippedMcp,
  );
  assert.equal(
    fs.readFileSync(
      path.join(workspace, ".lane", "plugins", "planning", ".mcp.json"),
      "utf8",
    ),
    EMPTY_MCP_JSON,
  );
});

test("supports a relative source-dir inside workspace and read-only source files", (t) => {
  const { workspace } = setupFixture(t);
  const basePlugins = path.join(workspace, ".base", "plugins");
  writePlugin(basePlugins, "review", {
    "plugin.json": { content: '{"name":"review"}\n', mode: 0o444 },
    "scripts/run.sh": { content: "#!/usr/bin/env bash\n", mode: 0o555 },
  });
  fs.chmodSync(path.join(basePlugins, "review", "scripts"), 0o555);
  fs.chmodSync(path.join(basePlugins, "review"), 0o555);

  const result = stageLanePlugins({
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: workspace,
    STAGE_SOURCE_DIR: ".base/plugins",
    STAGE_PLUGINS: "review",
  });

  assert.deepEqual(result.pluginDirs, [".lane/plugins/review"]);
  assert.equal(
    fs.readFileSync(
      path.join(workspace, ".lane", "plugins", "review", ".mcp.json"),
      "utf8",
    ),
    EMPTY_MCP_JSON,
  );
});

test("skips git checks and exclude cleanly in a non-git workspace", (t) => {
  const { workspace, source } = setupFixture(t, { initGit: false });
  writePlugin(source, "review", { "plugin.json": "{}\n" });

  const result = stageLanePlugins({
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: workspace,
    STAGE_SOURCE_DIR: source,
    STAGE_PLUGINS: "review",
  });

  assert.equal(result.gitExcluded, false);
  assert.equal(fs.existsSync(path.join(workspace, ".git")), false);
  assert.deepEqual(result.pluginDirs, [".lane/plugins/review"]);
});

test("handles a git repo with unborn HEAD and existing exclude without trailing newline", (t) => {
  const { workspace, source } = setupFixture(t, {
    initGit: true,
    commitHead: false,
  });
  writePlugin(source, "review", { "plugin.json": "{}\n" });
  const excludeFile = path.join(workspace, ".git", "info", "exclude");
  fs.writeFileSync(excludeFile, "*.log");

  stageLanePlugins({
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: workspace,
    STAGE_SOURCE_DIR: source,
    STAGE_PLUGINS: "review",
  });

  assert.equal(fs.readFileSync(excludeFile, "utf8"), "*.log\n/.lane/\n");
});

test("does not duplicate /.lane/ when already present in .git/info/exclude", (t) => {
  const { workspace, source } = setupFixture(t);
  writePlugin(source, "review", { "plugin.json": "{}\n" });
  const excludeFile = path.join(workspace, ".git", "info", "exclude");
  fs.writeFileSync(excludeFile, "# existing\n/.lane/\n");

  stageLanePlugins({
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: workspace,
    STAGE_SOURCE_DIR: source,
    STAGE_PLUGINS: "review",
  });

  assert.equal(fs.readFileSync(excludeFile, "utf8"), "# existing\n/.lane/\n");
});

test("supports a custom workspace-relative destination", (t) => {
  const { workspace, source } = setupFixture(t);
  writePlugin(source, "review", { "plugin.json": "{}\n" });

  const result = stageLanePlugins({
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: workspace,
    STAGE_SOURCE_DIR: source,
    STAGE_PLUGINS: "review",
    STAGE_DESTINATION: ".staged/custom-plugins",
  });

  assert.deepEqual(result.pluginDirs, [".staged/custom-plugins/review"]);
  const exclude = fs.readFileSync(
    path.join(workspace, ".git", "info", "exclude"),
    "utf8",
  );
  assert.ok(exclude.split("\n").includes("/.staged/"));
});

test("fails closed when .lane already exists as a directory, file, or dangling symlink", (t) => {
  for (const kind of ["dir", "file", "dangling-symlink"]) {
    const { workspace, source } = setupFixture(t);
    writePlugin(source, "review", { "plugin.json": "{}\n" });
    const lanePath = path.join(workspace, ".lane");
    if (kind === "dir") fs.mkdirSync(lanePath);
    if (kind === "file") fs.writeFileSync(lanePath, "trap\n");
    if (kind === "dangling-symlink") {
      fs.symlinkSync("/nonexistent-target", lanePath);
    }

    assert.throws(
      () =>
        stageLanePlugins({
          PATH: process.env.PATH,
          GITHUB_WORKSPACE: workspace,
          STAGE_SOURCE_DIR: source,
          STAGE_PLUGINS: "review",
        }),
      (error) =>
        error instanceof StageError && /already exists/u.test(error.message),
      kind,
    );
  }
});

test("fails closed when HEAD or the Git index tracks .lane even if removed from disk", (t) => {
  const { workspace, source } = setupFixture(t);
  writePlugin(source, "review", { "plugin.json": "{}\n" });
  fs.mkdirSync(path.join(workspace, ".lane"));
  fs.writeFileSync(path.join(workspace, ".lane", "evil.txt"), "evil\n");
  git(workspace, "add", ".lane/evil.txt");
  git(workspace, "commit", "-q", "-m", "track .lane");
  fs.rmSync(path.join(workspace, ".lane"), { recursive: true, force: true });

  assert.throws(
    () =>
      stageLanePlugins({
        PATH: process.env.PATH,
        GITHUB_WORKSPACE: workspace,
        STAGE_SOURCE_DIR: source,
        STAGE_PLUGINS: "review",
      }),
    (error) =>
      error instanceof StageError && /HEAD tracks/u.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(workspace, ".lane")), false);
});

test("fails closed when .lane is staged in the Git index but not on disk", (t) => {
  const { workspace, source } = setupFixture(t);
  writePlugin(source, "review", { "plugin.json": "{}\n" });
  fs.mkdirSync(path.join(workspace, ".lane"));
  fs.writeFileSync(path.join(workspace, ".lane", "staged.txt"), "staged\n");
  git(workspace, "add", ".lane/staged.txt");
  fs.rmSync(path.join(workspace, ".lane"), { recursive: true, force: true });

  assert.throws(
    () =>
      stageLanePlugins({
        PATH: process.env.PATH,
        GITHUB_WORKSPACE: workspace,
        STAGE_SOURCE_DIR: source,
        STAGE_PLUGINS: "review",
      }),
    (error) =>
      error instanceof StageError && /Git index tracks/u.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(workspace, ".lane")), false);
});

test("fails closed on any symlink (plugin root, internal, escaping, or dangling) and leaves no .lane", (t) => {
  for (const kind of ["root-link", "internal", "escaping", "dangling"]) {
    const { root, workspace, source } = setupFixture(t);
    writePlugin(source, "good", { "plugin.json": "{}\n" });

    if (kind === "root-link") {
      const outside = path.join(root, "outside-plugin");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "plugin.json"), "{}\n");
      fs.symlinkSync(outside, path.join(source, "bad"));
    } else {
      const badDir = writePlugin(source, "bad", { "plugin.json": "{}\n" });
      if (kind === "internal") {
        fs.symlinkSync("plugin.json", path.join(badDir, "link.json"));
      } else if (kind === "escaping") {
        fs.symlinkSync("/etc/hosts", path.join(badDir, "escape.txt"));
      } else if (kind === "dangling") {
        fs.symlinkSync("/does-not-exist", path.join(badDir, "broken"));
      }
    }

    assert.throws(
      () =>
        stageLanePlugins({
          PATH: process.env.PATH,
          GITHUB_WORKSPACE: workspace,
          STAGE_SOURCE_DIR: source,
          STAGE_PLUGINS: "good\nbad",
        }),
      (error) =>
        error instanceof StageError && /symbolic link/u.test(error.message),
      kind,
    );
    assert.equal(
      fs.existsSync(path.join(workspace, ".lane")),
      false,
      `${kind}: must not leave partial .lane behind`,
    );
  }
});

test("rolls back the staged tree when updating .git/info/exclude fails", (t) => {
  const { workspace, source } = setupFixture(t);
  writePlugin(source, "review", { "plugin.json": "{}\n" });
  const excludeFile = path.join(workspace, ".git", "info", "exclude");
  fs.rmSync(excludeFile, { force: true });
  fs.mkdirSync(excludeFile);

  assert.throws(
    () =>
      stageLanePlugins({
        PATH: process.env.PATH,
        GITHUB_WORKSPACE: workspace,
        STAGE_SOURCE_DIR: source,
        STAGE_PLUGINS: "review",
      }),
    (error) =>
      error instanceof StageError && /not a regular file/u.test(error.message),
  );
  assert.equal(
    fs.existsSync(path.join(workspace, ".lane")),
    false,
    "failed exclude update must roll back created .lane tree",
  );
});

test("rejects malformed plugin names, destinations, missing source plugins, and symlinked .git", (t) => {
  for (const bad of [
    "",
    "  \n  ",
    "../review",
    "a/b",
    ".hidden",
    "-flag",
    "bad name",
  ]) {
    assert.throws(() => parsePlugins(bad), StageError, JSON.stringify(bad));
  }
  for (const bad of [
    "/abs/path",
    "trailing/",
    "a/../b",
    "./lane",
    "a//b",
    "a\\b",
    ".git",
    ".git/hooks",
    "has space",
  ]) {
    assert.throws(() => parseDestination(bad), StageError, JSON.stringify(bad));
  }

  const { workspace, source } = setupFixture(t);
  fs.writeFileSync(path.join(source, "not-a-dir"), "x");
  assert.throws(
    () =>
      stageLanePlugins({
        PATH: process.env.PATH,
        GITHUB_WORKSPACE: workspace,
        STAGE_SOURCE_DIR: source,
        STAGE_PLUGINS: "missing",
      }),
    /does not exist/u,
  );
  assert.throws(
    () =>
      stageLanePlugins({
        PATH: process.env.PATH,
        GITHUB_WORKSPACE: workspace,
        STAGE_SOURCE_DIR: source,
        STAGE_PLUGINS: "not-a-dir",
      }),
    /not a directory/u,
  );
  assert.throws(
    () =>
      stageLanePlugins({
        PATH: process.env.PATH,
        GITHUB_WORKSPACE: workspace,
        STAGE_SOURCE_DIR: path.join(source, "missing-dir"),
        STAGE_PLUGINS: "review",
      }),
    /source-dir/u,
  );

  const nonGit = setupFixture(t, { initGit: false });
  writePlugin(nonGit.source, "review", { "plugin.json": "{}\n" });
  fs.symlinkSync(
    path.join(workspace, ".git"),
    path.join(nonGit.workspace, ".git"),
  );
  assert.throws(
    () =>
      stageLanePlugins({
        PATH: process.env.PATH,
        GITHUB_WORKSPACE: nonGit.workspace,
        STAGE_SOURCE_DIR: nonGit.source,
        STAGE_PLUGINS: "review",
      }),
    /\.git in workspace must not be a symbolic link/u,
  );
});

test("handles a git worktree checkout and a source-dir containing spaces", (t) => {
  const { root, workspace } = setupFixture(t);
  const worktree = path.join(root, "worktree-checkout");
  git(workspace, "worktree", "add", "-q", "-b", "wt-branch", worktree);
  const spacedSource = path.join(root, "source plugins dir");
  fs.mkdirSync(spacedSource);
  writePlugin(spacedSource, "review", { "plugin.json": "{}\n" });

  const result = stageLanePlugins({
    PATH: process.env.PATH,
    GITHUB_WORKSPACE: worktree,
    STAGE_SOURCE_DIR: spacedSource,
    STAGE_PLUGINS: "review",
  });

  assert.equal(result.gitExcluded, true);
  assert.deepEqual(result.pluginDirs, [".lane/plugins/review"]);
  const exclude = fs.readFileSync(
    path.join(workspace, ".git", "info", "exclude"),
    "utf8",
  );
  assert.ok(exclude.split("\n").includes("/.lane/"));
  assert.equal(git(worktree, "status", "--porcelain"), "");
});

test("CLI exits 1 with an error annotation on failure", (t) => {
  const { workspace, source } = setupFixture(t);
  const cli = runCli({
    GITHUB_WORKSPACE: workspace,
    STAGE_SOURCE_DIR: source,
    STAGE_PLUGINS: "does-not-exist",
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /^::error::setup-lane-plugins:/u);
});

test("action.yml wires inputs, default destination, script path, and plugin-dirs output", () => {
  const action = parseWorkflow(
    fs.readFileSync(path.join(path.dirname(SCRIPT), "action.yml"), "utf8"),
  );
  assert.equal(action.inputs["source-dir"].required, true);
  assert.equal(action.inputs.plugins.required, true);
  assert.equal(action.inputs.destination.required, false);
  assert.equal(action.inputs.destination.default, ".lane/plugins");
  assert.equal(
    action.outputs["plugin-dirs"].value,
    `\${{ steps.stage.outputs.plugin-dirs }}`,
  );
  const [step] = action.runs.steps;
  assert.equal(step.id, "stage");
  assert.equal(step.shell, "bash");
  assert.equal(step.env.STAGE_SOURCE_DIR, `\${{ inputs.source-dir }}`);
  assert.equal(step.env.STAGE_PLUGINS, `\${{ inputs.plugins }}`);
  assert.equal(step.env.STAGE_DESTINATION, `\${{ inputs.destination }}`);
  assert.equal(step.run, 'node "$GITHUB_ACTION_PATH/stage.cjs"');
});
