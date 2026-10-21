// run-claude-cli: run one prompt with headless `claude -p` on exactly one
// credential, the lane's API key or its subscription token, never both.
//
// Subcommands (argv[2]):
//   verify-isolation  fail closed unless managed settings are root-owned and
//                     pinned, sudo and docker are gone, bubblewrap can create
//                     a PID namespace and no loader, TLS or proxy variable is
//                     set
//   install           resolve the CLI version, install it from the public
//                     registry outside any checkout's .npmrc, and fail closed
//                     unless npm verifies both packages' registry signatures
//                     and the binary matches Anthropic's GPG-signed manifest
//   run               run the one leg and write the action's outputs
//
// Security contract:
//   - One leg per invocation: readConfig fails closed unless exactly one of
//     the two credentials is set. A caller that falls back to the
//     subscription after a key leg hands off (a credit stop, or class auth
//     with api_error_status 401 or 402, NEXT_STEPS) runs a second job, on a
//     fresh runner, gated on this one's handoff output being `true`. A 403
//     stops the run with its error type, error_code and request_id.
//   - legEnv copies the step environment and removes every credential and
//     file-command VARIABLE, then sets the leg's one credential. That is a
//     denylist, not a sandbox: code the leg runs (a Bash tool call, a hook)
//     runs as the runner user.
//   - Every file-command file the step was given is bound read-only for the
//     leg (and anything it leaves running), restored to its exact content
//     once the leg ends, and only then does run write the action's own
//     outputs, lane-class included, and summary.
//   - The CLI install tree and _work/_actions have their write bits removed
//     before the leg and restored after it.
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
//     leg).
//   - The CLI runs in --restricted mode: code-running tools only when the
//     tools input names them, no user, project or local settings, file tools
//     confined to the working directories, no bypassPermissions.
//   - Only the key leg can end in `credit-stop` (classify.cjs isCreditStop),
//     judged from structured fields.
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
  apiErrorFacts,
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
// them, then sets the leg's one.
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
// The most CLI stdout the leg may produce; past it the leg is killed and ends
// with class `other`.
const MAX_LEG_STDOUT_BYTES = 256 * 1024 * 1024;
const NPM_REGISTRY = "https://registry.npmjs.org/";
// Release manifest location and signing key, as
// https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing
// gives them. Releases from 2.1.89 on carry a signed manifest.
const RELEASES_URL = "https://downloads.claude.ai/claude-code-releases";
const SIGNING_KEY_URL = "https://downloads.claude.ai/keys/claude-code.asc";
const SIGNING_KEY_FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE"; // gitleaks:allow (public key fingerprint)
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
// What each class means for the run. `handoff`: a key leg that ends in it
// hands the run to the caller's subscription job; `statuses`, when set,
// narrows that to these numeric api_error_status values, never an error-type
// string, which errors[] text could carry. `note`: the job summary's closed
// token, the named stop and what happens next.
const NEXT_STEPS = {
  "": { handoff: false, note: "" },
  "credit-stop": {
    handoff: true,
    note: "credits used up: the subscription job runs; the owner rotates a key by hand when needed",
  },
  // 401 (key disabled or deleted) and 402 (billing) hand off. 403
  // (permission) does not: the key reached the API but may not use the
  // resource, a setting the owner fixes, and handing off would hide it. An
  // auth class with no numeric status does not hand off either.
  auth: {
    handoff: true,
    statuses: [401, 402],
    note: "credential unusable: 401 or 402 hands off to the subscription job, 403 (permission) stops the run; the owner fixes the key by hand",
  },
  "rate-limit": { handoff: false, note: "limit stop: rerun after the reset" },
  overloaded: { handoff: false, note: "API overloaded: rerun later" },
  "max-turns": {
    handoff: false,
    note: "turn cap: raise max-turns or narrow the task",
  },
  timeout: {
    handoff: false,
    note: "leg timeout: raise leg-timeout-minutes or narrow the task",
  },
  other: { handoff: false, note: "see the step log" },
};

function nextStep(failureClass) {
  return Object.hasOwn(NEXT_STEPS, failureClass)
    ? NEXT_STEPS[failureClass]
    : NEXT_STEPS.other;
}

// Only a key leg hands off: the subscription leg is the last one.
// `apiErrorStatus` is the last message's numeric api_error_status.
function handsOff(leg, failureClass, apiErrorStatus) {
  const step = nextStep(failureClass);
  if (leg.leg !== "api-key" || !step.handoff) return false;
  return step.statuses === undefined || step.statuses.includes(apiErrorStatus);
}

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
  const supplied = [
    ["api-key", env.LANE_API_KEY ?? "", "CLAUDE_API_KEY"],
    ["subscription", env.LANE_SUBSCRIPTION_TOKEN ?? "", "CLAUDE_CODE_OAUTH_TOKEN"],
  ].filter(([, value]) => value !== "");
  if (supplied.length !== 1) {
    throw new LaneError(
      `${supplied.length === 0 ? "no credential" : "two credentials"}: set exactly one of api-key and subscription-token, and run the subscription leg as its own job`,
    );
  }
  const [[legName, value, suffix]] = supplied;
  // The role's name, `<ROLE>_<suffix>` with the role upper-snake, is the only
  // one.
  const name = `${role.toUpperCase().replaceAll("-", "_")}_${suffix}`;
  if (!NAME_PATTERN.test(name)) {
    throw new LaneError(
      `${legName} secret name ${JSON.stringify(name)} is not an upper-case secret name`,
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
    leg: { leg: legName, name, value },
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

// `latest` asks the registry for the newest release; anything else must be an
// exact version. Either way the value passes the shared exact-version check before it is
// installed.
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

// The CLI environment for the leg: every credential and file-command
// variable removed, then only the leg's credential set.
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
  const status = messages.at(-1)?.api_error_status;
  const facts = failureClass === "" ? {} : apiErrorFacts(messages);
  return {
    run_id: config.runId,
    lane: config.lane,
    role: config.role,
    leg: 1,
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
    api_error_status: Number.isInteger(status) ? status : null,
    error_type: facts.errorType ?? null,
    error_code: facts.errorCode ?? null,
    request_id: facts.requestId ?? null,
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

// What the finished leg means for the run: success or a stop with a class.
// Only the key leg can end in a credit stop.
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

// The content of each file-command file the step was given, so restoreFiles
// can put back exactly what was there, whatever the leg appended or
// rewrote. run writes the action's own outputs and summary after the reset.
function snapshotFiles(baseEnv) {
  const snapshots = [];
  for (const name of FILE_COMMAND_VARIABLES) {
    const file = (baseEnv[name] ?? "").trim();
    if (file === "" || !fs.existsSync(file)) continue;
    snapshots.push({ file, content: fs.readFileSync(file) });
  }
  return snapshots;
}

function restoreFiles(snapshots) {
  for (const { file, content } of snapshots) {
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(content)) {
      fs.writeFileSync(file, content);
    }
  }
}

// What no leg may write: the CLI install under the work directory, the
// runner's action checkouts (`_work/_actions` beside RUNNER_WORKSPACE), and
// the step's file-command files. bwrap binds each read-only in the leg's mount
// namespace, which a process the leg leaves behind keeps after it ends.
function readOnlyPaths(config, baseEnv, files = []) {
  const runnerWorkspace = (baseEnv.RUNNER_WORKSPACE ?? "").trim();
  return [
    path.join(config.workDir, "cli"),
    runnerWorkspace === ""
      ? ""
      : path.join(path.dirname(runnerWorkspace), "_actions"),
    ...files,
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

// The command the leg runs. With trees to protect, bwrap binds each one
// read-only over a view of the whole filesystem, so the leg cannot restore the
// write bits lockTrees removed. --die-with-parent kills the CLI when a timeout
// or an overflow kills bwrap, which forwards no signal.
function legCommand(config, readOnly) {
  if (readOnly.length === 0) return [config.cliPath, cliArgs(config)];
  return [
    "bwrap",
    [
      "--die-with-parent",
      "--dev-bind",
      "/",
      "/",
      ...readOnly.flatMap((dir) => ["--ro-bind", dir, dir]),
      "--",
      config.cliPath,
      ...cliArgs(config),
    ],
  ];
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

function runLeg(
  config,
  {
    baseEnv = process.env,
    spawn = spawnSync,
    now = () => new Date(),
  } = {},
) {
  const prompt = promptText(config);
  const { leg } = config;
  const executionFile = path.join(config.workDir, "leg-1-execution.json");
  const snapshots = snapshotFiles(baseEnv);
  const modes = [];
  let record;
  let judged;
  let handoff = false;
  try {
    const readOnly = readOnlyPaths(
      config,
      baseEnv,
      snapshots.map(({ file }) => file),
    );
    lockTrees(readOnly, modes);
    const startedAt = now().toISOString();
    const child = spawn(...legCommand(config, readOnly), {
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
    fs.writeFileSync(path.join(config.workDir, "leg-1.jsonl"), stdout);
    fs.writeFileSync(
      executionFile,
      JSON.stringify(linesToMessages(stdout.toString("utf8"))),
    );
    let message = null;
    if (overflowed) {
      message = `CLI stdout passed ${MAX_LEG_STDOUT_BYTES} bytes; the leg was stopped`;
      judged = {
        failureClass: "other",
        resets: null,
        messages: readMessages(executionFile) ?? [],
      };
      process.stderr.write(`run-claude-cli: ${message}\n`);
    } else {
      judged = judgeLeg({
        leg,
        executionFile,
        exitCode,
        timedOut,
        maxTurns: config.maxTurns,
      });
    }
    // The same message classify.cjs reads its status from.
    const status = judged.messages.at(-1)?.api_error_status;
    handoff = handsOff(
      leg,
      judged.failureClass,
      Number.isInteger(status) ? status : null,
    );
    record = legRecord({
      config,
      leg,
      startedAt,
      endedAt,
      exitCode,
      messages: judged.messages,
      failureClass: judged.failureClass,
      resets: judged.resets,
      next: handoff ? "subscription" : null,
      message,
    });
  } finally {
    try {
      restoreModes(modes);
    } finally {
      restoreFiles(snapshots);
    }
  }
  const run = readRunRecord(executionFile);
  return {
    records: [record],
    outputs: {
      "lane-class": judged.failureClass,
      handoff: String(handoff),
      "lane-resets": judged.resets ?? "",
      "lane-turns": run.turns === null ? "" : String(run.turns),
      "lane-models": run.models.join(","),
      credential: leg.name,
      "execution-file": executionFile,
    },
  };
}

// The record's API error facts as `key=value` tokens, each a closed value.
function errorTokens(record) {
  return [
    ["api_error_status", record.api_error_status],
    ["error_type", record.error_type],
    ["error_code", record.error_code],
    ["request_id", record.request_id],
  ]
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

// Every cell is a closed token or a value lane.cjs checked; no CLI text.
function summaryTable(records) {
  const cell = (value) =>
    String(value ?? "")
      .replaceAll("|", "\\|")
      .replaceAll("`", "'");
  const rows = records.map(
    (r) =>
      `| ${r.leg} | ${cell(r.secret)} | ${cell(r.class || "success")} | ${cell(errorTokens(r))} | ${cell(r.num_turns)} | ${cell(r.denials.count)} | ${cell(r.resets)} | ${cell(r.next)} | ${cell(nextStep(r.class).note)} |`,
  );
  return [
    "| Leg | Secret | Class | Error | Turns | Denials | Resets | Next | Stop |",
    "|---|---|---|---|---|---|---|---|---|",
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
// `env.ANTHROPIC_BASE_URL` to the public API, disabling bypassPermissions, and
// keeping user, project and plugin hooks from loading (`allowManagedHooksOnly`
// or `disableAllHooks`), so head code cannot repoint the credential or run a
// hook through settings it writes.
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
  if (
    settings.allowManagedHooksOnly !== true &&
    settings.disableAllHooks !== true
  ) {
    throw new LaneError(
      `${file} sets neither allowManagedHooksOnly nor disableAllHooks to true`,
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

// Run a command and fail closed when it cannot start or exits non-zero.
function mustRun(spawn, what, command, args, options) {
  const result = spawn(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    const why = result.error
      ? (result.error.code ?? result.error.message)
      : `exit ${result.status}`;
    throw new LaneError(`${what} failed (${why})`);
  }
  return result;
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// The installed tree must hold exactly the wrapper and the platform package,
// both at the resolved version, so the audit's package count names them.
function verifyInstalledTree(prefix, version, platformPackage) {
  const modules = path.join(prefix, "node_modules");
  const allowed = new Set([".bin", ".package-lock.json", "@anthropic-ai"]);
  const extra = fs.readdirSync(modules).filter((name) => !allowed.has(name));
  const scoped = fs.readdirSync(path.join(modules, "@anthropic-ai")).sort();
  const expected = [CLI_PACKAGE, platformPackage]
    .map((name) => name.split("/")[1])
    .sort();
  if (extra.length > 0 || scoped.join(",") !== expected.join(",")) {
    throw new LaneError(
      `the install tree holds ${[...extra, ...scoped].join(", ")}, not exactly ${CLI_PACKAGE} and ${platformPackage}`,
    );
  }
  for (const name of [CLI_PACKAGE, platformPackage]) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(modules, name, "package.json"), "utf8"),
    );
    if (manifest.version !== version) {
      throw new LaneError(
        `${name} installed at ${manifest.version}, not ${version}`,
      );
    }
  }
}

// `npm audit signatures --json` lists only invalid and missing signatures,
// never the packages it verified (lib/utils/verify-signatures.js in
// npm/cli), and a registry that serves no keys is skipped with exit 0. So
// the text report must count both packages as audited and verified.
function auditSignatures(spawn, { cwd, prefix, registry }) {
  const audit = mustRun(
    spawn,
    "npm audit signatures",
    "npm",
    ["audit", "signatures", registry, "--color=false", "--prefix", prefix],
    { cwd },
  );
  const report = String(audit.stdout ?? "");
  if (
    !/^audited 2 packages in /mu.test(report) ||
    !/^2 packages have verified registry signatures$/mu.test(report)
  ) {
    throw new LaneError(
      `npm audit signatures did not verify both ${CLI_PACKAGE} packages: ${JSON.stringify(report.trim())}`,
    );
  }
  return report.match(/^audited .*$/mu)[0];
}

// Verify the release manifest's signature with the pinned key and return the
// platform's entry. GPG runs with its own home, so no runner keyring counts.
function signedManifestEntry(spawn, { dir, version, platform }) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    key: path.join(dir, "claude-code.asc"),
    manifest: path.join(dir, "manifest.json"),
    signature: path.join(dir, "manifest.json.sig"),
  };
  const urls = {
    key: SIGNING_KEY_URL,
    manifest: `${RELEASES_URL}/${version}/manifest.json`,
    signature: `${RELEASES_URL}/${version}/manifest.json.sig`,
  };
  for (const name of Object.keys(files)) {
    mustRun(
      spawn,
      `download ${urls[name]}`,
      "curl",
      ["--proto", "=https", "-fsSL", "-o", files[name], urls[name]],
      { cwd: dir },
    );
  }
  const home = fs.mkdtempSync(path.join(dir, "gnupg-"));
  fs.chmodSync(home, 0o700);
  const gpg = ["--batch", "--homedir", home];
  mustRun(spawn, "gpg --import", "gpg", [...gpg, "--import", files.key], {
    cwd: dir,
  });
  const verify = mustRun(
    spawn,
    "gpg --verify of the release manifest",
    "gpg",
    [...gpg, "--status-fd", "1", "--verify", files.signature, files.manifest],
    { cwd: dir },
  );
  const status = String(verify.stdout ?? "").split("\n");
  const goodSig = status.some((line) => line.startsWith("[GNUPG:] GOODSIG "));
  const signedBy = status
    .filter((line) => line.startsWith("[GNUPG:] VALIDSIG "))
    .map((line) => line.trim().split(" ").at(-1));
  if (
    !goodSig ||
    signedBy.length !== 1 ||
    signedBy[0] !== SIGNING_KEY_FINGERPRINT
  ) {
    throw new LaneError(
      `the ${version} release manifest is not signed by key ${SIGNING_KEY_FINGERPRINT}`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(files.manifest, "utf8"));
  } catch {
    throw new LaneError(`the ${version} release manifest is not JSON`);
  }
  if (manifest.version !== version) {
    throw new LaneError(
      `the signed manifest is for ${JSON.stringify(manifest.version)}, not ${version}`,
    );
  }
  const entry = manifest.platforms?.[platform];
  if (!/^[0-9a-f]{64}$/u.test(entry?.checksum ?? "")) {
    throw new LaneError(
      `the signed ${version} manifest has no ${platform} checksum`,
    );
  }
  return entry;
}

// Every npm call runs in the work directory with the public registry named,
// so a checkout's .npmrc cannot steer it. The install keeps scripts on: the
// wrapper's postinstall puts the platform binary in place of a stub.
function install(
  env,
  { spawn = spawnSync, platform = `${process.platform}-${process.arch}` } = {},
) {
  const registry = `--registry=${NPM_REGISTRY}`;
  const cwd = env.LANE_WORK_DIR;
  const npmVersion = mustRun(spawn, "npm --version", "npm", ["--version"], {
    cwd,
  });
  process.stdout.write(
    `run-claude-cli: npm ${String(npmVersion.stdout).trim()}\n`,
  );
  const version = resolveCliVersion(env.LANE_CLI_VERSION_INPUT, () => {
    const view = spawn("npm", ["view", registry, CLI_PACKAGE, "version"], {
      cwd,
      encoding: "utf8",
    });
    if (view.status !== 0)
      throw new LaneError(`npm view ${CLI_PACKAGE} version failed`);
    return view.stdout;
  });
  const platformPackage = `${CLI_PACKAGE}-${platform}`;
  const prefix = path.join(cwd, "cli");
  fs.mkdirSync(prefix, { recursive: true });
  // npm 12 blocks dependency install scripts unless the root package.json
  // allows them (npm 11 runs them with a notice); allow this one version.
  fs.writeFileSync(
    path.join(prefix, "package.json"),
    `${JSON.stringify({ allowScripts: { [`${CLI_PACKAGE}@${version}`]: true } }, null, 2)}\n`,
  );
  mustRun(
    spawn,
    `npm install ${CLI_PACKAGE}@${version}`,
    "npm",
    [
      "install",
      registry,
      "--save-exact",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      `${CLI_PACKAGE}@${version}`,
    ],
    { cwd, stdio: ["ignore", "ignore", "inherit"] },
  );
  process.stdout.write(`run-claude-cli: Claude Code CLI ${version}\n`);
  verifyInstalledTree(prefix, version, platformPackage);
  const audited = auditSignatures(spawn, { cwd, prefix, registry });
  process.stdout.write(
    `run-claude-cli: npm audit signatures: ${audited}, both verified\n`,
  );

  const entry = signedManifestEntry(spawn, {
    dir: path.join(cwd, "cli-manifest"),
    version,
    platform,
  });
  const cliPath = path.join(prefix, "node_modules", ".bin", "claude");
  const checksum = sha256File(fs.realpathSync(cliPath));
  process.stdout.write(
    `run-claude-cli: ${platform} binary sha256 ${checksum}, signed manifest ${entry.checksum}\n`,
  );
  if (checksum !== entry.checksum) {
    throw new LaneError(
      `the installed ${platform} binary does not match the signed ${version} manifest`,
    );
  }
  const reported = mustRun(
    spawn,
    `${cliPath} --version`,
    cliPath,
    ["--version"],
    { cwd },
  );
  process.stdout.write(`run-claude-cli: ${String(reported.stdout).trim()}\n`);
  writeOutputs(env.GITHUB_OUTPUT, {
    "cli-version": version,
    "cli-path": cliPath,
  });
}

function run(env) {
  verifyEnvironment(env);
  const config = readConfig(env);
  const token = crypto.randomBytes(16).toString("hex");
  process.stdout.write(`::stop-commands::${token}\n`);
  let outcome;
  try {
    outcome = runLeg(config, { baseEnv: env });
  } finally {
    process.stdout.write(`::${token}::\n`);
  }
  const logFile = path.join(config.workDir, "run-claude-cli-log.jsonl");
  const logText = `${outcome.records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const clean = !holdsCredential(logText, [config.leg.value]);
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
    const facts = errorTokens(outcome.records[0]);
    throw new LaneError(
      `${config.lane} ended class=${laneClass} on ${outcome.outputs.credential}${facts === "" ? "" : ` ${facts}`}`,
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
  SIGNING_KEY_FINGERPRINT,
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
  runLeg,
  summaryTable,
  verifyEnvironment,
  verifyIsolation,
  verifyManagedSettings,
};
