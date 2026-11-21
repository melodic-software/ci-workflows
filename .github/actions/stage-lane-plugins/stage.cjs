// stage-lane-plugins: copy trusted plugin directories into a read-only
// workspace tree for run-claude-cli (--plugin-dir / --add-dir).
//
// Security and reliability invariants:
//   - Fails closed when the staging root (for example `.lane`) already exists
//     on disk (file, directory, or dangling symlink) or is tracked in HEAD or
//     the Git index.
//   - Rejects symbolic links and special files anywhere under a staged plugin
//     before writing, and re-checks with lstat during copy so chmod cannot miss
//     a link target or follow an escape.
//   - Preserves executable bits on scripts while stripping all write bits
//     recursively bottom-up on the destination tree.
//   - Creates `{"mcpServers":{}}\n` as `.mcp.json` when absent so Claude Code's
//     bubblewrap sandbox does not fail trying to create `.mcp.json` inside a
//     read-only `--add-dir`, while preserving any shipped `.mcp.json`.
//   - Appends `/<root>/` to `.git/info/exclude` atomically when the workspace
//     is a Git checkout, skipping cleanly for non-Git workspaces.
//   - Compensates on any error by restoring write bits and removing the
//     staging root it created so no partial read-only tree is left behind.
"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const EMPTY_MCP_JSON = '{"mcpServers":{}}\n';
const GIT_SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];

class StageError extends Error {
  constructor(message) {
    super(message);
    this.name = "StageError";
  }
}

function lstatOrNull(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function parsePlugins(raw) {
  const seen = new Set();
  const list = [];
  for (const line of String(raw ?? "").split(/\r?\n/u)) {
    const name = line.trim();
    if (name === "") continue;
    if (!PLUGIN_NAME_PATTERN.test(name)) {
      throw new StageError(
        `plugin name ${JSON.stringify(name)} is not valid (expected letters, digits, '.', '_' or '-', starting with a letter or digit)`,
      );
    }
    if (!seen.has(name)) {
      seen.add(name);
      list.push(name);
    }
  }
  if (list.length === 0) {
    throw new StageError("plugins must name at least one plugin directory");
  }
  return list;
}

function parseDestination(raw) {
  const trimmed = String(raw ?? "").trim() || ".lane/plugins";
  if (
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.includes("\\")
  ) {
    throw new StageError(
      `destination ${JSON.stringify(trimmed)} must be a clean workspace-relative path`,
    );
  }
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      !PATH_SEGMENT_PATTERN.test(segment)
    ) {
      throw new StageError(
        `destination ${JSON.stringify(trimmed)} contains an invalid path segment ${JSON.stringify(segment)}`,
      );
    }
  }
  if (segments[0] === ".git") {
    throw new StageError("destination must not be inside .git");
  }
  return {
    destination: segments.join("/"),
    topSegment: segments[0],
  };
}

function gitEnv(baseEnv) {
  const env = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of GIT_SAFE_ENV_KEYS) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  return env;
}

function runGit(workspace, args, baseEnv) {
  return spawnSync("git", ["-C", workspace, ...args], {
    env: gitEnv(baseEnv),
    encoding: "utf8",
  });
}

// Resolves `.git/info/exclude` and verifies `topSegment` is not tracked in
// HEAD or the index when `workspace` is a Git checkout. Returns `null` when
// `workspace` has no `.git` entry.
function inspectGitWorkspace(workspace, topSegment, baseEnv) {
  const dotGit = lstatOrNull(path.join(workspace, ".git"));
  if (dotGit === null) return null;
  if (dotGit.isSymbolicLink()) {
    throw new StageError(".git in workspace must not be a symbolic link");
  }
  if (!dotGit.isDirectory() && !dotGit.isFile()) {
    throw new StageError(".git in workspace is neither a directory nor a file");
  }

  const excludeLookup = runGit(
    workspace,
    ["rev-parse", "--git-path", "info/exclude"],
    baseEnv,
  );
  if (excludeLookup.error) {
    throw new StageError(
      `git failed while inspecting workspace: ${excludeLookup.error.message}`,
    );
  }
  if (excludeLookup.status !== 0) {
    throw new StageError(
      `workspace holds .git but git rev-parse failed: ${(excludeLookup.stderr ?? "").trim()}`,
    );
  }
  const excludeRelOrAbs = excludeLookup.stdout.trim();
  if (excludeRelOrAbs === "") {
    throw new StageError("git rev-parse --git-path info/exclude returned empty");
  }
  const excludePath = path.resolve(workspace, excludeRelOrAbs);

  const headCheck = runGit(
    workspace,
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    baseEnv,
  );
  if (headCheck.status === 0) {
    const lsTree = runGit(
      workspace,
      ["ls-tree", "HEAD", "--", topSegment],
      baseEnv,
    );
    if (lsTree.status !== 0) {
      throw new StageError(
        `git ls-tree failed while checking ${topSegment}: ${(lsTree.stderr ?? "").trim()}`,
      );
    }
    if (lsTree.stdout.trim() !== "") {
      throw new StageError(
        `HEAD tracks ${JSON.stringify(topSegment)}, where stage-lane-plugins stages plugins`,
      );
    }
  }

  const lsFiles = runGit(workspace, ["ls-files", "--", topSegment], baseEnv);
  if (lsFiles.status !== 0) {
    throw new StageError(
      `git ls-files failed while checking ${topSegment}: ${(lsFiles.stderr ?? "").trim()}`,
    );
  }
  if (lsFiles.stdout.trim() !== "") {
    throw new StageError(
      `the Git index tracks ${JSON.stringify(topSegment)}, where stage-lane-plugins stages plugins`,
    );
  }

  return excludePath;
}

function validatePluginTree(pluginName, pluginSourceDir) {
  const rootStat = lstatOrNull(pluginSourceDir);
  if (rootStat === null) {
    throw new StageError(
      `plugin ${JSON.stringify(pluginName)} does not exist in source-dir`,
    );
  }
  if (rootStat.isSymbolicLink()) {
    throw new StageError(
      `plugin ${JSON.stringify(pluginName)} is a symbolic link`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new StageError(
      `plugin ${JSON.stringify(pluginName)} is not a directory`,
    );
  }

  const stack = [""];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const absDir = relDir === "" ? pluginSourceDir : path.join(pluginSourceDir, relDir);
    const entries = fs.readdirSync(absDir);
    for (const entry of entries) {
      const relPath = relDir === "" ? entry : `${relDir}/${entry}`;
      const absPath = path.join(absDir, entry);
      const stat = fs.lstatSync(absPath);
      if (stat.isSymbolicLink()) {
        throw new StageError(
          `plugin ${JSON.stringify(pluginName)} holds a symbolic link: ${relPath}`,
        );
      }
      if (stat.isDirectory()) {
        stack.push(relPath);
      } else if (!stat.isFile()) {
        throw new StageError(
          `plugin ${JSON.stringify(pluginName)} holds an unsupported file type: ${relPath}`,
        );
      }
    }
  }
}

// Copies `srcDir` into `dstDir`, re-verifying lstat on every entry so a
// concurrent swap to a symlink or special file fails closed. Directories are
// created writable so children and `.mcp.json` can be written before the
// read-only pass strips write bits bottom-up.
function copyPluginTree(pluginName, srcDir, dstDir) {
  const rootStat = fs.lstatSync(srcDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new StageError(
      `plugin ${JSON.stringify(pluginName)} must be a regular directory`,
    );
  }
  fs.mkdirSync(dstDir, {
    mode: (rootStat.mode & 0o777) | 0o700,
  });

  const stack = [""];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const absSrcDir = relDir === "" ? srcDir : path.join(srcDir, relDir);
    const absDstDir = relDir === "" ? dstDir : path.join(dstDir, relDir);
    for (const entry of fs.readdirSync(absSrcDir)) {
      const relPath = relDir === "" ? entry : `${relDir}/${entry}`;
      const absSrc = path.join(absSrcDir, entry);
      const absDst = path.join(absDstDir, entry);
      const stat = fs.lstatSync(absSrc);
      if (stat.isSymbolicLink()) {
        throw new StageError(
          `plugin ${JSON.stringify(pluginName)} holds a symbolic link: ${relPath}`,
        );
      }
      if (stat.isDirectory()) {
        fs.mkdirSync(absDst, {
          mode: (stat.mode & 0o777) | 0o700,
        });
        stack.push(relPath);
      } else if (stat.isFile()) {
        fs.copyFileSync(absSrc, absDst, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(absDst, (stat.mode & 0o777) | 0o200);
      } else {
        throw new StageError(
          `plugin ${JSON.stringify(pluginName)} holds an unsupported file type: ${relPath}`,
        );
      }
    }
  }
}

// Strips all write bits (a-w) bottom-up so directories stay writable until
// every child inside them has been locked.
function stripWriteBitsRecursive(targetPath) {
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    throw new StageError(`unexpected symbolic link in staged tree: ${targetPath}`);
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath)) {
      stripWriteBitsRecursive(path.join(targetPath, entry));
    }
  }
  fs.chmodSync(targetPath, stat.mode & 0o555);
}

// Restores owner write bits top-down so rollback can delete a partially locked
// staging tree cleanly.
function restoreWriteBitsRecursive(targetPath) {
  const stat = lstatOrNull(targetPath);
  if (stat === null || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    try {
      fs.chmodSync(targetPath, (stat.mode & 0o777) | 0o700);
    } catch {
      // Best-effort during cleanup.
    }
    for (const entry of fs.readdirSync(targetPath)) {
      restoreWriteBitsRecursive(path.join(targetPath, entry));
    }
  } else {
    try {
      fs.chmodSync(targetPath, (stat.mode & 0o777) | 0o600);
    } catch {
      // Best-effort during cleanup.
    }
  }
}

function removeStagedRoot(topPath) {
  if (lstatOrNull(topPath) === null) return;
  restoreWriteBitsRecursive(topPath);
  fs.rmSync(topPath, { recursive: true, force: true });
}

function ensureGitExclude(excludePath, topSegment) {
  const pattern = `/${topSegment}/`;
  const excludeDir = path.dirname(excludePath);
  fs.mkdirSync(excludeDir, { recursive: true });

  let existing = "";
  let existingMode = 0o644;
  const stat = lstatOrNull(excludePath);
  if (stat !== null) {
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new StageError(
        `git exclude path ${JSON.stringify(excludePath)} is not a regular file`,
      );
    }
    existing = fs.readFileSync(excludePath, "utf8");
    existingMode = stat.mode & 0o777;
  }

  const lines = existing.split(/\r?\n/u);
  if (lines.includes(pattern)) return false;

  const prefix =
    existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  const updated = `${prefix}${pattern}\n`;
  const tempPath = path.join(
    excludeDir,
    `.exclude-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, updated, { mode: existingMode });
    fs.renameSync(tempPath, excludePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup of temp exclude file.
    }
    throw error;
  }
  return true;
}

function stageLanePlugins(env) {
  const workspaceRaw = String(env.GITHUB_WORKSPACE ?? "").trim();
  if (workspaceRaw === "") {
    throw new StageError("GITHUB_WORKSPACE must be set");
  }
  let workspaceRoot;
  try {
    workspaceRoot = fs.realpathSync(workspaceRaw);
  } catch {
    throw new StageError(
      `GITHUB_WORKSPACE ${JSON.stringify(workspaceRaw)} does not exist`,
    );
  }
  if (!fs.statSync(workspaceRoot).isDirectory()) {
    throw new StageError(
      `GITHUB_WORKSPACE ${JSON.stringify(workspaceRaw)} is not a directory`,
    );
  }

  const sourceDirRaw = String(env.STAGE_SOURCE_DIR ?? "").trim();
  if (sourceDirRaw === "") {
    throw new StageError("source-dir must not be empty");
  }
  let sourceRoot;
  try {
    sourceRoot = fs.realpathSync(path.resolve(workspaceRoot, sourceDirRaw));
  } catch {
    throw new StageError(
      `source-dir ${JSON.stringify(sourceDirRaw)} does not exist`,
    );
  }
  if (!fs.statSync(sourceRoot).isDirectory()) {
    throw new StageError(
      `source-dir ${JSON.stringify(sourceDirRaw)} is not a directory`,
    );
  }

  const plugins = parsePlugins(env.STAGE_PLUGINS);
  const { destination, topSegment } = parseDestination(env.STAGE_DESTINATION);

  const topPath = path.join(workspaceRoot, topSegment);
  if (lstatOrNull(topPath) !== null) {
    throw new StageError(
      `${JSON.stringify(topSegment)} already exists in the workspace`,
    );
  }

  const excludePath = inspectGitWorkspace(workspaceRoot, topSegment, env);

  // Validate every requested plugin before creating any directory in workspace.
  for (const name of plugins) {
    validatePluginTree(name, path.join(sourceRoot, name));
  }

  const destPath = path.join(workspaceRoot, destination);
  const stagedDirs = [];
  let createdMcpCount = 0;

  try {
    fs.mkdirSync(destPath, { recursive: true, mode: 0o755 });
    for (const name of plugins) {
      const srcPlugin = path.join(sourceRoot, name);
      const dstPlugin = path.join(destPath, name);
      copyPluginTree(name, srcPlugin, dstPlugin);

      const mcpPath = path.join(dstPlugin, ".mcp.json");
      if (lstatOrNull(mcpPath) === null) {
        fs.writeFileSync(mcpPath, EMPTY_MCP_JSON, { mode: 0o644 });
        createdMcpCount += 1;
      }
      stagedDirs.push(`${destination}/${name}`);
    }

    stripWriteBitsRecursive(destPath);

    if (excludePath !== null) {
      ensureGitExclude(excludePath, topSegment);
    }
  } catch (error) {
    removeStagedRoot(topPath);
    throw error;
  }

  return {
    destination,
    topSegment,
    plugins,
    pluginDirs: stagedDirs,
    createdMcpCount,
    gitExcluded: excludePath !== null,
  };
}

function writeOutputs(outputs, outputPath) {
  if (!outputPath) {
    throw new StageError("GITHUB_OUTPUT must be set");
  }
  const chunks = [];
  for (const [key, value] of Object.entries(outputs)) {
    const text = String(value);
    if (!text.includes("\n") && !text.includes("\r")) {
      chunks.push(`${key}=${text}\n`);
    } else {
      const delimiter = `STAGE_EOF_${crypto.randomBytes(16).toString("hex")}`;
      chunks.push(`${key}<<${delimiter}\n${text}\n${delimiter}\n`);
    }
  }
  fs.appendFileSync(outputPath, chunks.join(""));
}

function sanitizeAnnotation(message) {
  return String(message)
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("::", ": :");
}

function main(env = process.env) {
  const result = stageLanePlugins(env);
  writeOutputs(
    { "plugin-dirs": result.pluginDirs.join("\n") },
    env.GITHUB_OUTPUT,
  );
  process.stdout.write(
    `stage-lane-plugins: staged ${result.plugins.length} plugin(s) into ${result.destination} (${result.plugins.join(", ")})\n`,
  );
  return result;
}

if (require.main === module) {
  try {
    main(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `::error::stage-lane-plugins: ${sanitizeAnnotation(message)}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  EMPTY_MCP_JSON,
  StageError,
  main,
  parseDestination,
  parsePlugins,
  stageLanePlugins,
  writeOutputs,
};
