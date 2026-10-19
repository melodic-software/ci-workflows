// run-claude-cli: run one prompt with headless `claude -p`, API key first, then
// the lane's subscription token in the same run only after a credit stop.
//
// Subcommands (argv[2]):
//   verify-isolation  fail closed unless managed settings are root-owned and
//                     pinned, sudo and docker are gone, bubblewrap can create
//                     a PID namespace and no loader, TLS or proxy variable is
//                     set
//   install           resolve the CLI version and install it from the public
//                     registry, outside any checkout's .npmrc
//   run               run the legs and write the action's outputs
//
// Security contract:
//   - legEnv copies the step environment and removes every credential and
//     file-command VARIABLE, then sets this leg's one credential. That is a
//     denylist, not a sandbox: code a leg runs (a Bash tool call, a hook)
//     runs as the runner user.
//   - Every file-command file the step was given is cut back to its size
//     before the first leg once the last leg ends, and run writes the
//     action's own outputs and summary after that.
//   - The CLI install tree and _work/_actions have their write bits removed
//     before the first leg and restored after the last.
//   - Caller rule: a lane that gives the model unrestricted Bash, or any
//     code-running tool beyond fixed read-only command rules, runs this
//     action in a job that holds no other secret or write token, and does
//     its reporting and uploads in a downstream job that validates its
//     inputs. A lane whose Bash is limited to fixed read-only rules may stay
//     in one job.
//   - Input contract: no head code runs in the job before this action, and
//     the step environment holds no NODE_OPTIONS, LD_PRELOAD,
//     LD_LIBRARY_PATH, BASH_ENV, NODE_EXTRA_CA_CERTS,
//     NODE_TLS_REJECT_UNAUTHORIZED or *_PROXY other than NO_PROXY
//     (verifyEnvironment, checked before the install and again before the
//     first leg).
//   - The CLI runs in --restricted mode: code-running tools only when the
//     tools input names them, no user, project or local settings, file tools
//     confined to the working directories, no bypassPermissions.
//   - The subscription leg runs only when the key leg is a credit stop
//     (classify.cjs isCreditStop), judged from structured fields.
//   - Secret names are derived from the role and never taken from input.
//   - The CLI's stdout is captured in memory and written to files only after
//     the leg exits. Its stderr and closed-pattern tokens reach the job log,
//     inside ::stop-commands::; the job summary shows only closed tokens.
//   - The log file is written only after a scan finds no credential in it.
//     It alone keeps a CLI-authored error line.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  classifyExecutionFile,
  creditStopResetsAt,
  readMessages,
  readRunRecord,
} = require("../report-lane-outcome/classify.cjs");
const {
  resolveNpmToolVersion,
} = require("../../scripts/resolve-npm-tool-version.cjs");

const CLI_PACKAGE = "@anthropic-ai/claude-code";
const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/u;
const KEBAB_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;
const MODEL_PATTERN = /^[\w.:@[\]-]{1,100}$/u;
const EFFORT_PATTERN = /^[a-z]{1,20}$/u;
const TOOL_NAME_PATTERN = /^[\w.:-]{1,100}$/u;
const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
]);
// Every variable that selects or carries a credential. legEnv removes all of
// them, then sets exactly one.
const CREDENTIAL_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_ENTRYPOINT",
  "LANE_API_KEY",
  "LANE_SUBSCRIPTION_TOKEN",
];
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{8,}/u;
// Workflow file-command variables. legEnv removes them, so a leg cannot set
// environment, path, outputs, state or summary for later steps.
const FILE_COMMAND_VARIABLES = [
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_OUTPUT",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
];
// The most CLI stdout one leg may produce; past it the leg is killed and ends
// with class `other`.
const MAX_LEG_STDOUT_BYTES = 256 * 1024 * 1024;
const NPM_REGISTRY = "https://registry.npmjs.org/";
const PINNED_BASE_URL = "https://api.anthropic.com";
const DOCKER_SOCKET = "/var/run/docker.sock";
const BWRAP_PROBE = ["--unshare-pid", "--dev-bind", "/", "/", "true"];
// Variables that load code into node or bash, or redirect or weaken TLS, so
// head code that set them could read a leg's credential. Any name ending in
// _PROXY counts too, NO_PROXY excepted. The ubuntu-24.04 image sets none of
// them (images/ubuntu in actions/runner-images at ee1ff45: its environment
// tables and build scripts name no such variable), so any one set is the
// caller's.
const UNSAFE_VARIABLES = new Set([
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "BASH_ENV",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
]);
// The job summary's closed token per class: the named stop and its recovery.
const SUMMARY_NOTES = {
  "": "",
  "credit-stop": "credit stop: add Console credit or raise the spend limit",
  "rate-limit": "limit stop: rerun after the reset",
  auth: "credential unusable: replace the secret",
  overloaded: "API overloaded: rerun later",
  "max-turns": "turn cap: raise max-turns or narrow the task",
  timeout: "leg timeout: raise leg-timeout-minutes or narrow the task",
  other: "see the step log",
};

class LaneError extends Error {
  constructor(message) {
    super(message);
    this.name = "LaneError";
  }
}

function required(env, name, pattern, label) {
  const value = (env[name] ?? "").trim();
  if (!pattern.test(value)) {
    throw new LaneError(`${label} ${JSON.stringify(value)} is not valid`);
  }
  return value;
}

// The run's settings from the action's environment, each checked against a
// closed pattern, so nothing unchecked reaches the CLI's argv or the log.
function readConfig(env) {
  const role = required(env, "LANE_ROLE", KEBAB_PATTERN, "role");
  const legs = [];
  for (const [leg, valueVar, suffix] of [
    ["api-key", "LANE_API_KEY", "CLAUDE_API_KEY"],
    ["subscription", "LANE_SUBSCRIPTION_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  ]) {
    const value = env[valueVar] ?? "";
    // The role's name, `<ROLE>_<suffix>` with the role upper-snake, is the
    // only one. It is checked even for an empty secret, because skipWarnings
    // prints it into a workflow command.
    const name = `${role.toUpperCase().replaceAll("-", "_")}_${suffix}`;
    if (!NAME_PATTERN.test(name)) {
      throw new LaneError(
        `${leg} secret name ${JSON.stringify(name)} is not an upper-case secret name`,
      );
    }
    legs.push({ leg, name, value, skipped: value === "" });
  }
  if (legs.every((leg) => leg.skipped)) {
    throw new LaneError(
      "no credential: api-key and subscription-token are both empty",
    );
  }
  const permissionMode = (env.LANE_PERMISSION_MODE ?? "").trim();
  if (!PERMISSION_MODES.has(permissionMode)) {
    throw new LaneError(
      `permission-mode ${JSON.stringify(permissionMode)} is not one of ${[...PERMISSION_MODES].join(", ")}`,
    );
  }
  const legTimeout = (env.LANE_LEG_TIMEOUT_MINUTES ?? "").trim();
  if (legTimeout !== "" && !/^[1-9]\d{0,3}$/u.test(legTimeout)) {
    throw new LaneError(
      `leg-timeout-minutes ${JSON.stringify(legTimeout)} is not valid`,
    );
  }
  const promptFile = (env.LANE_PROMPT_FILE ?? "").trim();
  if (promptFile === "" || !fs.existsSync(promptFile)) {
    throw new LaneError(
      `prompt-file ${JSON.stringify(promptFile)} does not exist`,
    );
  }
  const allowedTools = toolLines(env.LANE_ALLOWED_TOOLS, "allowed-tools");
  const disallowedTools = toolLines(
    env.LANE_DISALLOWED_TOOLS,
    "disallowed-tools",
  );
  const tools = toolLines(env.LANE_TOOLS, "tools");
  const pluginDirs = dirLines(
    env.LANE_PLUGIN_DIRS,
    "plugin-dirs",
    env.GITHUB_WORKSPACE,
  );
  const addDirs = dirLines(env.LANE_ADD_DIRS, "add-dirs", env.GITHUB_WORKSPACE);
  const schemaFile = (env.LANE_JSON_SCHEMA_FILE ?? "").trim();
  let jsonSchema = "";
  if (schemaFile !== "") {
    try {
      jsonSchema = JSON.stringify(
        JSON.parse(fs.readFileSync(schemaFile, "utf8")),
      );
    } catch {
      throw new LaneError(
        `json-schema-file ${JSON.stringify(schemaFile)} is not a readable JSON file`,
      );
    }
  }
  return {
    legs,
    lane: required(env, "LANE_NAME", KEBAB_PATTERN, "lane"),
    role,
    model: required(env, "LANE_MODEL", MODEL_PATTERN, "model"),
    // Empty keeps the model's default effort.
    effort:
      (env.LANE_EFFORT ?? "").trim() === ""
        ? ""
        : required(env, "LANE_EFFORT", EFFORT_PATTERN, "effort"),
    maxTurns: required(env, "LANE_MAX_TURNS", /^[1-9]\d{0,5}$/u, "max-turns"),
    permissionMode,
    watchdogMaxWaitMs: required(
      env,
      "LANE_WATCHDOG_MAX_WAIT_MS",
      /^[1-9]\d{0,9}$/u,
      "watchdog-max-wait-ms",
    ),
    legTimeoutMs: legTimeout === "" ? 0 : Number(legTimeout) * 60_000,
    cliVersion: required(
      env,
      "LANE_CLI_VERSION",
      /^\d+\.\d+\.\d+$/u,
      "cli-version",
    ),
    cliPath: required(env, "LANE_CLI_PATH", /^\/.+/u, "cli path"),
    promptFile,
    preamble: env.LANE_PREAMBLE ?? "",
    allowedTools,
    disallowedTools,
    tools,
    pluginDirs,
    addDirs,
    jsonSchema,
    workDir: required(env, "LANE_WORK_DIR", /^\/.+/u, "work dir"),
    runId: (env.GITHUB_RUN_ID ?? "").trim(),
  };
}

// `latest` (the default) asks the registry for the newest release; anything
// else must be an exact version. Either way the value passes the shared
// exact-version check before it is installed.
function resolveCliVersion(input, npmView) {
  const wanted = (input ?? "").trim() || "latest";
  const candidate =
    wanted === "latest" ? String(npmView() ?? "").trim() : wanted;
  // An empty candidate would take the resolver's fallback; there is none here.
  let resolved;
  try {
    resolved = resolveNpmToolVersion({
      versionInput: candidate,
      fallbackVersion: "0.0.0",
      packageName: CLI_PACKAGE,
      packageJsonPath: "/nonexistent/package.json",
    });
  } catch (error) {
    throw new LaneError(`cli-version: ${error.message}`);
  }
  const { version, source } = resolved;
  if (source !== "input") {
    throw new LaneError(
      `cli-version must resolve to an exact major.minor.patch, got ${JSON.stringify(candidate)}`,
    );
  }
  return version;
}

// The CLI environment for one leg: every credential and file-command
// variable removed, then only this leg's credential set.
function legEnv(baseEnv, leg, config) {
  const env = { ...baseEnv };
  for (const name of CREDENTIAL_VARIABLES) delete env[name];
  for (const name of FILE_COMMAND_VARIABLES) delete env[name];
  if (leg.leg === "api-key") env.ANTHROPIC_API_KEY = leg.value;
  else env.CLAUDE_CODE_OAUTH_TOKEN = leg.value;
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  env.CLAUDE_CODE_RETRY_WATCHDOG = "1";
  env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = config.watchdogMaxWaitMs;
  return env;
}

function cliArgs(config) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    config.model,
    ...(config.effort === "" ? [] : ["--effort", config.effort]),
    "--max-turns",
    config.maxTurns,
    "--permission-mode",
    config.permissionMode,
    "--permission-prompts",
    "none",
    "--restricted",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  // Under --restricted a plugin's own files are readable only inside a
  // working directory, so each plugin directory is added as one too.
  const pluginDirs = config.pluginDirs ?? [];
  for (const dir of pluginDirs) args.push("--plugin-dir", dir);
  for (const dir of new Set([...pluginDirs, ...(config.addDirs ?? [])])) {
    args.push("--add-dir", dir);
  }
  if (config.tools.length > 0) args.push("--tools", config.tools.join(","));
  if (config.jsonSchema !== "") args.push("--json-schema", config.jsonSchema);
  if (config.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...config.disallowedTools);
  }
  if (config.allowedTools.length > 0) {
    args.push("--allowedTools", ...config.allowedTools);
  }
  return args;
}

function toolLines(text, label) {
  const rules = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (rules.some((rule) => rule.startsWith("-"))) {
    throw new LaneError(`${label} entries may not start with '-'`);
  }
  return rules;
}

// Directory lines, one per line, each resolved against GITHUB_WORKSPACE (an
// absolute one as written) and kept only when it has no `..` part and its
// real path is an existing directory inside the workspace's real path.
function dirLines(text, label, workspace) {
  const entries = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (entries.length === 0) return [];
  if ((workspace ?? "").trim() === "") {
    throw new LaneError(`${label} needs GITHUB_WORKSPACE to resolve against`);
  }
  const root = fs.realpathSync(workspace.trim());
  return entries.map((entry) => {
    if (entry.split(/[\\/]/u).includes("..")) {
      throw new LaneError(
        `${label} entry ${JSON.stringify(entry)} has a '..' part`,
      );
    }
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(root, entry));
    } catch {
      resolved = "";
    }
    if (resolved === "" || !fs.statSync(resolved).isDirectory()) {
      throw new LaneError(
        `${label} entry ${JSON.stringify(entry)} is not an existing directory`,
      );
    }
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new LaneError(
        `${label} entry ${JSON.stringify(entry)} must resolve inside GITHUB_WORKSPACE`,
      );
    }
    return resolved;
  });
}

function promptText(config) {
  const prompt = fs.readFileSync(config.promptFile, "utf8");
  if (prompt.trim() === "") throw new LaneError("prompt-file is empty");
  const preamble = config.preamble.trim();
  return preamble === "" ? prompt : `${preamble}\n\n${prompt}`;
}

// Stream JSON lines into the JSON array claude-code-action's execution_file
// holds, so classify.cjs reads both the same way. Unparsable lines drop.
function linesToMessages(text) {
  const messages = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // A non-JSON line (a stray warning) carries no structured fact.
    }
  }
  return messages;
}

// The CLI's first error line, only when classify proved it is the CLI's own
// text (a credit stop or a limit stop with no model output). Workflow
// commands are neutralized and the line is cut short. It goes to the scanned
// log only, never the job summary.
function cliMessage(messages, failureClass) {
  if (failureClass !== "credit-stop" && failureClass !== "rate-limit")
    return null;
  const result = messages.findLast((message) => message?.type === "result");
  const assistants = messages.filter((m) => m?.type === "assistant");
  const modelWrote =
    assistants.some((m) => typeof m.error !== "string") ||
    (result?.usage?.output_tokens ?? 0) !== 0;
  if (modelWrote || typeof result?.result !== "string") return null;
  const line = result.result.split("\n")[0].replaceAll("::", ": :").trim();
  return line === "" ? null : line.slice(0, 200);
}

function legRecord({
  config,
  leg,
  index,
  startedAt,
  endedAt,
  exitCode,
  messages,
  failureClass,
  resets,
  next,
  message = null,
}) {
  const result =
    messages.findLast((message) => message?.type === "result") ?? {};
  const denials = Array.isArray(result.permission_denials)
    ? result.permission_denials
    : [];
  const usage = result.usage ?? {};
  const count = (value) =>
    Number.isInteger(value) && value >= 0 ? value : null;
  const amount = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const modelUsage =
    result.modelUsage && typeof result.modelUsage === "object"
      ? result.modelUsage
      : {};
  return {
    run_id: config.runId,
    lane: config.lane,
    role: config.role,
    leg: index + 1,
    credential: leg.leg,
    secret: leg.name,
    cli_version: config.cliVersion,
    model: config.model,
    permission_mode: config.permissionMode,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: count(result.duration_ms),
    exit_code: exitCode,
    // The CLI's own list-price estimate; for attribution and trends, not billing.
    total_cost_usd: amount(result.total_cost_usd),
    models_used: Object.fromEntries(
      Object.entries(modelUsage).map(([name, u]) => [
        name,
        {
          cost_usd: amount(u?.costUSD),
          input_tokens: count(u?.inputTokens),
          output_tokens: count(u?.outputTokens),
        },
      ]),
    ),
    num_turns: count(result.num_turns),
    is_error: typeof result.is_error === "boolean" ? result.is_error : null,
    class: failureClass,
    message: message ?? cliMessage(messages, failureClass),
    resets,
    usage: {
      input_tokens: count(usage.input_tokens),
      output_tokens: count(usage.output_tokens),
      cache_read_input_tokens: count(usage.cache_read_input_tokens),
      cache_creation_input_tokens: count(usage.cache_creation_input_tokens),
    },
    denials: {
      count: denials.length,
      tools: [
        ...new Set(
          denials
            .map((d) => d?.tool_name)
            .filter((name) => TOOL_NAME_PATTERN.test(name ?? "")),
        ),
      ],
    },
    next,
  };
}

// True when the text holds any credential value or anything shaped like an
// Anthropic key.
function holdsCredential(text, secretValues) {
  if (KEY_SHAPE.test(text)) return true;
  return secretValues.some(
    (value) => value.length >= 8 && text.includes(value),
  );
}

// What one finished leg means for the run: success, stop with a class, or go
// on to the subscription leg. Only a credit stop on the key leg goes on.
function judgeLeg({ leg, executionFile, exitCode, timedOut, maxTurns }) {
  const messages = readMessages(executionFile) ?? [];
  const result = messages.findLast((message) => message?.type === "result");
  if (!timedOut && exitCode === 0 && result && result.is_error === false) {
    return { failureClass: "", resets: null, messages };
  }
  const { failureClass } = classifyExecutionFile(executionFile, {
    timedOut,
    maxTurns,
    detectCreditStop: leg.leg === "api-key",
    exitCode,
  });
  let resets = null;
  if (failureClass === "credit-stop") resets = creditStopResetsAt(messages);
  if (failureClass === "rate-limit")
    resets = readRunRecord(executionFile).resetsAt;
  return { failureClass, resets, messages };
}

// One warning per skipped leg, printed before ::stop-commands:: so the runner
// shows it as an annotation.
function skipWarnings(config) {
  return config.legs
    .filter((leg) => leg.skipped)
    .map(
      (leg) =>
        `::warning::run-claude-cli: skipped=${leg.name} (empty secret)`,
    );
}

// The byte size of each file-command file the step was given, so restoreFiles
// can cut off whatever a leg appends. run writes the action's own outputs and
// summary after the reset.
function fileSizes(baseEnv) {
  const sizes = [];
  for (const name of FILE_COMMAND_VARIABLES) {
    const file = (baseEnv[name] ?? "").trim();
    if (file === "" || !fs.existsSync(file)) continue;
    sizes.push({ file, size: fs.statSync(file).size });
  }
  return sizes;
}

function restoreFiles(sizes) {
  for (const { file, size } of sizes) {
    if (fs.existsSync(file) && fs.statSync(file).size !== size) {
      fs.truncateSync(file, size);
    }
  }
}

// The trees no leg may write: the CLI install under the work directory and
// the runner's action checkouts, `_work/_actions` beside RUNNER_WORKSPACE.
function readOnlyPaths(config, baseEnv) {
  const runnerWorkspace = (baseEnv.RUNNER_WORKSPACE ?? "").trim();
  return [
    path.join(config.workDir, "cli"),
    runnerWorkspace === ""
      ? ""
      : path.join(path.dirname(runnerWorkspace), "_actions"),
  ].filter((dir) => dir !== "" && fs.existsSync(dir));
}

// Removes every write bit under each tree, recording each mode it changes in
// `modes` first, so restoreModes can put them back even after a partial lock.
// Symbolic links are left alone.
function lockTrees(dirs, modes) {
  const walk = (entry) => {
    const info = fs.lstatSync(entry);
    if (info.isSymbolicLink()) return;
    modes.push({ entry, mode: info.mode & 0o7777 });
    fs.chmodSync(entry, info.mode & 0o7555);
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(entry)) walk(path.join(entry, name));
    }
  };
  for (const dir of dirs) walk(dir);
}

function restoreModes(modes) {
  for (const { entry, mode } of modes.toReversed()) {
    try {
      fs.chmodSync(entry, mode);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function runLegs(
  config,
  {
    baseEnv = process.env,
    spawn = spawnSync,
    now = () => new Date(),
  } = {},
) {
  const prompt = promptText(config);
  const active = config.legs.filter((leg) => !leg.skipped);
  const records = [];
  let final = null;
  const sizes = fileSizes(baseEnv);
  const modes = [];
  try {
    lockTrees(readOnlyPaths(config, baseEnv), modes);
    for (const [position, leg] of active.entries()) {
      const index = config.legs.indexOf(leg);
      const streamFile = path.join(config.workDir, `leg-${index + 1}.jsonl`);
      const executionFile = path.join(
        config.workDir,
        `leg-${index + 1}-execution.json`,
      );
      const startedAt = now().toISOString();
      const child = spawn(config.cliPath, cliArgs(config), {
        env: legEnv(baseEnv, leg, config),
        input: prompt,
        stdio: ["pipe", "pipe", "inherit"],
        maxBuffer: MAX_LEG_STDOUT_BYTES,
        timeout: config.legTimeoutMs || undefined,
        killSignal: "SIGINT",
      });
      const endedAt = now().toISOString();
      const timedOut = child.error?.code === "ETIMEDOUT";
      const overflowed = child.error?.code === "ENOBUFS";
      const exitCode = typeof child.status === "number" ? child.status : null;
      const stdout = child.stdout ?? Buffer.alloc(0);
      fs.writeFileSync(streamFile, stdout);
      fs.writeFileSync(
        executionFile,
        JSON.stringify(linesToMessages(stdout.toString("utf8"))),
      );
      let judged;
      let message = null;
      if (overflowed) {
        message = `CLI stdout passed ${MAX_LEG_STDOUT_BYTES} bytes; the leg was stopped`;
        judged = {
          failureClass: "other",
          resets: null,
          messages: readMessages(executionFile) ?? [],
        };
        process.stderr.write(`run-claude-cli: leg ${index + 1}: ${message}\n`);
      } else {
        judged = judgeLeg({
          leg,
          executionFile,
          exitCode,
          timedOut,
          maxTurns: config.maxTurns,
        });
      }
      const goesOn =
        judged.failureClass === "credit-stop" && position < active.length - 1;
      records.push(
        legRecord({
          config,
          leg,
          index,
          startedAt,
          endedAt,
          exitCode,
          messages: judged.messages,
          failureClass: judged.failureClass,
          resets: judged.resets,
          next: goesOn ? active[position + 1].leg : null,
          message,
        }),
      );
      final = { leg, executionFile, ...judged };
      if (!goesOn) break;
    }
  } finally {
    try {
      restoreModes(modes);
    } finally {
      restoreFiles(sizes);
    }
  }
  const record = readRunRecord(final.executionFile);
  // A credit stop with no leg left is a limit stop for the reporters, which
  // know rate-limit and not credit-stop.
  const laneClass =
    final.failureClass === "credit-stop" ? "rate-limit" : final.failureClass;
  return {
    records,
    outputs: {
      "lane-class": laneClass,
      "lane-resets": final.resets ?? "",
      "lane-turns": record.turns === null ? "" : String(record.turns),
      "lane-models": record.models.join(","),
      credential: final.leg.name,
      "execution-file": final.executionFile,
    },
  };
}

// Every cell is a closed token or a value lane.cjs checked; no CLI text.
function summaryTable(records) {
  const cell = (value) =>
    String(value ?? "")
      .replaceAll("|", "\\|")
      .replaceAll("`", "'");
  const note = (failureClass) =>
    SUMMARY_NOTES[failureClass] ?? SUMMARY_NOTES.other;
  const rows = records.map(
    (r) =>
      `| ${r.leg} | ${cell(r.secret)} | ${cell(r.class || "success")} | ${cell(r.num_turns)} | ${cell(r.denials.count)} | ${cell(r.resets)} | ${cell(r.next)} | ${cell(note(r.class))} |`,
  );
  return [
    "| Leg | Secret | Class | Turns | Denials | Resets | Next | Stop |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function writeOutputs(outputPath, outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => {
    if (String(value).includes("\n"))
      throw new LaneError(`output ${key} holds a newline`);
    return `${key}=${value}`;
  });
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`);
}

// Root-owned, not writable by group or others, pinning `apiKeyHelper` and
// `env.ANTHROPIC_BASE_URL` to the public API, and disabling bypassPermissions,
// so head code cannot repoint the credential through user settings.
function verifyManagedSettings(
  file,
  { stat = fs.statSync, read = fs.readFileSync } = {},
) {
  let info;
  try {
    info = stat(file);
  } catch {
    throw new LaneError(
      `${file} is missing: run the apply-claude-managed-settings action before runner isolation`,
    );
  }
  if (info.uid !== 0) throw new LaneError(`${file} is not owned by root`);
  if ((info.mode & 0o022) !== 0)
    throw new LaneError(`${file} is writable by group or others`);
  let settings;
  try {
    settings = JSON.parse(read(file, "utf8"));
  } catch {
    throw new LaneError(`${file} is not JSON`);
  }
  if (
    typeof settings !== "object" ||
    settings === null ||
    !Object.hasOwn(settings, "apiKeyHelper")
  ) {
    throw new LaneError(`${file} does not pin apiKeyHelper`);
  }
  if (settings.env?.ANTHROPIC_BASE_URL !== PINNED_BASE_URL) {
    throw new LaneError(
      `${file} does not pin env.ANTHROPIC_BASE_URL to ${PINNED_BASE_URL}`,
    );
  }
  if (settings.permissions?.disableBypassPermissionsMode !== "disable") {
    throw new LaneError(
      `${file} does not set permissions.disableBypassPermissionsMode to "disable"`,
    );
  }
}

// True when the runner user can still write the Docker socket, which is root
// on the host by another name.
function dockerReachable(socket, access = fs.accessSync) {
  if (!fs.existsSync(socket)) return false;
  try {
    access(socket, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Fail closed when the step environment sets a loader, TLS or proxy
// variable (UNSAFE_VARIABLES) to anything non-empty.
function verifyEnvironment(env) {
  const unsafe = Object.keys(env)
    .filter((name) => {
      const upper = name.toUpperCase();
      return (
        UNSAFE_VARIABLES.has(upper) ||
        (upper.endsWith("_PROXY") && upper !== "NO_PROXY")
      );
    })
    .filter((name) => (env[name] ?? "") !== "")
    .sort();
  if (unsafe.length > 0) {
    throw new LaneError(
      `the step environment sets ${unsafe.join(", ")}: no head code may run before run-claude-cli, and none of these may reach the CLI`,
    );
  }
}

function verifyIsolation({
  managedSettings,
  env = process.env,
  spawn = spawnSync,
  dockerSocket = DOCKER_SOCKET,
  ...io
}) {
  verifyEnvironment(env);
  verifyManagedSettings(managedSettings, io);
  if (spawn("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0) {
    throw new LaneError(
      "sudo still works: run runner isolation before run-claude-cli",
    );
  }
  if (dockerReachable(dockerSocket)) {
    throw new LaneError(
      `${dockerSocket} is writable: runner isolation must remove docker access`,
    );
  }
  // The scrub needs bubblewrap to create namespaces, not merely be installed.
  const probe = spawn("bwrap", BWRAP_PROBE, { stdio: "ignore" });
  if (probe.error?.code === "ENOENT") {
    throw new LaneError(
      "bubblewrap is missing: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB needs it",
    );
  }
  if (probe.status !== 0) {
    throw new LaneError(
      `bwrap ${BWRAP_PROBE.join(" ")} failed: bubblewrap cannot create a PID namespace. On Ubuntu 24.04 run \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\` in runner isolation, before sudo is removed (see pr-review.yml, "Install subprocess isolation")`,
    );
  }
}

// Both npm calls run in the work directory with the public registry named, so
// a checkout's .npmrc cannot steer them.
function install(env, { spawn = spawnSync } = {}) {
  const registry = `--registry=${NPM_REGISTRY}`;
  const version = resolveCliVersion(env.LANE_CLI_VERSION_INPUT, () => {
    const view = spawn("npm", ["view", registry, CLI_PACKAGE, "version"], {
      cwd: env.LANE_WORK_DIR,
      encoding: "utf8",
    });
    if (view.status !== 0)
      throw new LaneError(`npm view ${CLI_PACKAGE} version failed`);
    return view.stdout;
  });
  const prefix = path.join(env.LANE_WORK_DIR, "cli");
  const installed = spawn(
    "npm",
    [
      "install",
      registry,
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      `${CLI_PACKAGE}@${version}`,
    ],
    { cwd: env.LANE_WORK_DIR, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (installed.status !== 0)
    throw new LaneError(`npm install ${CLI_PACKAGE}@${version} failed`);
  process.stdout.write(`run-claude-cli: Claude Code CLI ${version}\n`);
  writeOutputs(env.GITHUB_OUTPUT, {
    "cli-version": version,
    "cli-path": path.join(prefix, "node_modules", ".bin", "claude"),
  });
}

function run(env) {
  verifyEnvironment(env);
  const config = readConfig(env);
  for (const line of skipWarnings(config)) process.stdout.write(`${line}\n`);
  const token = crypto.randomBytes(16).toString("hex");
  process.stdout.write(`::stop-commands::${token}\n`);
  let outcome;
  try {
    outcome = runLegs(config, { baseEnv: env });
  } finally {
    process.stdout.write(`::${token}::\n`);
  }
  const logFile = path.join(config.workDir, "run-claude-cli-log.jsonl");
  const logText = `${outcome.records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const secretValues = config.legs.map((leg) => leg.value).filter(Boolean);
  const clean = !holdsCredential(logText, secretValues);
  if (clean) fs.writeFileSync(logFile, logText);
  writeOutputs(env.GITHUB_OUTPUT, {
    ...outcome.outputs,
    "log-file": clean ? logFile : "",
  });
  if (env.GITHUB_STEP_SUMMARY && clean) {
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### run-claude-cli: ${config.lane} (${config.role})\n\n${summaryTable(outcome.records)}\n`,
    );
  }
  if (!clean) {
    throw new LaneError(
      "the execution log held a credential and was not written",
    );
  }
  const laneClass = outcome.outputs["lane-class"];
  if (laneClass !== "") {
    throw new LaneError(
      `${config.lane} ended class=${laneClass} on ${outcome.outputs.credential}`,
    );
  }
}

if (require.main === module) {
  try {
    const command = process.argv[2];
    if (command === "verify-isolation") {
      verifyIsolation({ managedSettings: process.env.LANE_MANAGED_SETTINGS });
    } else if (command === "install") {
      install(process.env);
    } else if (command === "run") {
      run(process.env);
    } else {
      throw new LaneError(`unknown command ${JSON.stringify(command)}`);
    }
  } catch (error) {
    const message =
      error instanceof LaneError
        ? error.message
        : "unexpected failure (see the step log)";
    if (!(error instanceof LaneError)) console.error(error);
    process.stdout.write(`::error title=run-claude-cli::${message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CREDENTIAL_VARIABLES,
  FILE_COMMAND_VARIABLES,
  LaneError,
  MAX_LEG_STDOUT_BYTES,
  NPM_REGISTRY,
  cliArgs,
  holdsCredential,
  install,
  judgeLeg,
  legEnv,
  legRecord,
  linesToMessages,
  readConfig,
  resolveCliVersion,
  run,
  runLegs,
  skipWarnings,
  summaryTable,
  verifyEnvironment,
  verifyIsolation,
  verifyManagedSettings,
};
