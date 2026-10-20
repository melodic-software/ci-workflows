// run-claude-cli leg logic. A fake `claude` stands in for the CLI: it records
// the credential variables it was started with and prints the stream-json
// lines the test gives it. The canned messages follow the Agent SDK
// reference's SDKResultMessage, SDKAssistantMessage and rate_limit_event
// shapes (code.claude.com/docs/en/agent-sdk/typescript); the credit-stop
// texts come from code.claude.com/docs/en/errors and
// platform.claude.com/docs/en/api/rate-limits. Which fields a real credit
// stop fills is not yet observed (see classify.cjs isCreditStop).
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  makeTemporaryDirectory,
} = require("../../scripts/temporary-directories.cjs");
const {
  CREDENTIAL_VARIABLES,
  FILE_COMMAND_VARIABLES,
  LaneError,
  MAX_LEG_STDOUT_BYTES,
  NPM_REGISTRY,
  cliArgs,
  holdsCredential,
  install,
  legEnv,
  readConfig,
  resolveCliVersion,
  run,
  runLeg,
  summaryTable,
  verifyEnvironment,
  verifyIsolation,
  verifyManagedSettings,
} = require("./lane.cjs");

const KEY = "key-value-for-tests-1234";
const TOKEN = "oauth-value-for-tests-5678";
const KEY_NAME = "AUTOMATIONS_CLAUDE_API_KEY";
const TOKEN_NAME = "AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN";

const root = makeTemporaryDirectory("run-claude-cli-");
const fakeCli = path.join(root, "claude");
fs.writeFileSync(
  fakeCli,
  `#!/usr/bin/env node
const fs = require("node:fs");
const leg = process.env.ANTHROPIC_API_KEY ? "KEY" : "SUB";
const seen = ${JSON.stringify(CREDENTIAL_VARIABLES)}.filter((n) => n in process.env);
const fileCommands = ${JSON.stringify(FILE_COMMAND_VARIABLES)}.filter((n) => n in process.env);
for (const file of (process.env.FAKE_APPEND ?? "").split(":").filter(Boolean)) {
  fs.appendFileSync(file, "PLANTED=1\\n");
}
const chmods = (process.env.FAKE_CHMOD ?? "").split(":").filter(Boolean).map((file) => {
  try {
    fs.chmodSync(file, 0o644);
    return "changed";
  } catch (error) {
    return error.code;
  }
});
const writes = (process.env.FAKE_WRITE ?? "").split(":").filter(Boolean).map((file) => {
  try {
    fs.appendFileSync(file, "PLANTED=1\\n");
    return "written";
  } catch (error) {
    return error.code;
  }
});
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ leg, seen, fileCommands, chmods, writes,
  scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
  watchdog: process.env.CLAUDE_CODE_RETRY_WATCHDOG,
  wait: process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS,
  args: process.argv.slice(2),
  stdin: fs.readFileSync(0, "utf8") }) + "\\n");
if (process.env["FAKE_" + leg + "_SLEEP"]) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  if (process.env.FAKE_SURVIVED) fs.writeFileSync(process.env.FAKE_SURVIVED, "");
}
process.stdout.write(fs.readFileSync(process.env["FAKE_" + leg], "utf8"));
process.exit(Number(process.env["FAKE_" + leg + "_EXIT"] ?? 0));
`,
);
fs.chmodSync(fakeCli, 0o755);

let caseNumber = 0;

// Runs what follows `--` when the leg asks for bwrap, so cases with a tree to
// protect test the mode lock on hosts without bubblewrap.
function withoutBwrap(command, args, options) {
  if (command !== "bwrap") return spawnSync(command, args, options);
  const rest = args.slice(args.indexOf("--") + 1);
  return spawnSync(rest[0], rest.slice(1), options);
}

const bwrapWorks =
  spawnSync("bwrap", ["--dev-bind", "/", "/", "--", "true"], {
    stdio: "ignore",
  }).status === 0;
const withBwrap = { skip: !bwrapWorks && "bwrap cannot run here" };

function result(fields) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    result: "model text that must stay out of the log",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 20 },
    modelUsage: { "claude-sonnet-5": {} },
    permission_denials: [],
    ...fields,
  };
}

const SUCCESS = [{ type: "system", subtype: "init" }, result({})];

const CREDIT_STOP = [
  { type: "system", subtype: "init" },
  {
    type: "assistant",
    error: "invalid_request",
    message: { content: [{ type: "text", text: "Credit balance is too low" }] },
  },
  result({
    is_error: true,
    num_turns: 0,
    result: "Credit balance is too low",
    api_error_status: 400,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
  }),
];

const TIER_CAP = [
  { type: "system", subtype: "init" },
  {
    type: "assistant",
    error: "rate_limit",
    message: {
      content: [
        {
          type: "text",
          text: "API Error: 429 You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-09-01 at 00:00 UTC.",
        },
      ],
    },
  },
  result({
    is_error: true,
    num_turns: 0,
    result:
      "API Error: 429 You have reached your API usage limits. You will regain access on 2026-09-01 at 00:00 UTC.",
    api_error_status: 429,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
  }),
];

const AUTH = [
  {
    type: "assistant",
    error: "authentication_failed",
    message: { content: [{ type: "text", text: "Invalid API key" }] },
  },
  result({
    is_error: true,
    num_turns: 0,
    result: "Invalid API key · Fix external API key",
    api_error_status: 401,
    usage: { input_tokens: 0, output_tokens: 0 },
  }),
];

const MAX_TURNS = [
  result({
    subtype: "error_max_turns",
    is_error: true,
    num_turns: 9,
    errors: [],
  }),
];

const SESSION_LIMIT = [
  {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      resetsAt: 1767225600,
      rateLimitType: "five_hour",
    },
  },
  {
    type: "assistant",
    error: "rate_limit",
    message: {
      content: [
        { type: "text", text: "You've hit your session limit · resets 3:45pm" },
      ],
    },
  },
  result({
    is_error: true,
    num_turns: 0,
    result: "You've hit your session limit · resets 3:45pm",
    api_error_status: 429,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
  }),
];

// Runs the one leg against the fake CLI. Set exactly one of `key` and `sub`,
// the message list that leg prints.
function runCase({
  key = null,
  sub = null,
  keyExit = 1,
  subExit = 1,
  keySleep = false,
  legTimeoutMs = 0,
  extraEnv = {},
  prepare = () => ({}),
  spawn = withoutBwrap,
}) {
  caseNumber += 1;
  const dir = path.join(root, `case-${caseNumber}`);
  fs.mkdirSync(dir);
  const calls = path.join(dir, "calls.jsonl");
  const baseEnv = {
    PATH: process.env.PATH,
    FAKE_CALLS: calls,
    // Inherited credentials the leg must never see.
    ANTHROPIC_AUTH_TOKEN: "inherited-auth-token",
    CLAUDE_CODE_ENTRYPOINT: "inherited-entrypoint",
    LANE_API_KEY: KEY,
    LANE_SUBSCRIPTION_TOKEN: TOKEN,
    ...extraEnv,
    ...prepare(dir),
  };
  for (const [leg, messages, exit] of [
    ["KEY", key, keyExit],
    ["SUB", sub, subExit],
  ]) {
    if (!messages) continue;
    const file = path.join(dir, `${leg}.jsonl`);
    fs.writeFileSync(file, messages.map((m) => JSON.stringify(m)).join("\n"));
    baseEnv[`FAKE_${leg}`] = file;
    baseEnv[`FAKE_${leg}_EXIT`] = String(messages === SUCCESS ? 0 : exit);
  }
  if (keySleep) baseEnv.FAKE_KEY_SLEEP = "1";
  const prompt = path.join(dir, "prompt.md");
  fs.writeFileSync(prompt, "Fix the failing check.\n");
  const config = {
    leg: key
      ? { leg: "api-key", name: KEY_NAME, value: KEY }
      : { leg: "subscription", name: TOKEN_NAME, value: TOKEN },
    lane: "fix-ci",
    role: "automations",
    model: "claude-sonnet-5",
    effort: "high",
    maxTurns: "8",
    permissionMode: "auto",
    watchdogMaxWaitMs: "1800000",
    legTimeoutMs,
    cliVersion: "2.1.302",
    cliPath: fakeCli,
    promptFile: prompt,
    preamble: "You run unattended.",
    allowedTools: ["Read", "Bash(git status:*)"],
    disallowedTools: ["WebFetch"],
    tools: ["Read", "Bash"],
    jsonSchema: '{"type":"object"}',
    workDir: dir,
    runId: "123",
  };
  const outcome = runLeg(config, { baseEnv, spawn });
  const callLines = fs.existsSync(calls)
    ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { ...outcome, calls: callLines.map((l) => JSON.parse(l)), config };
}

test("a key-leg credit stop ends the run with lane-class credit-stop and runs no second leg", () => {
  const { outputs, calls, records } = runCase({ key: CREDIT_STOP });
  assert.deepEqual(
    calls.map((c) => [c.leg, c.seen]),
    [["KEY", ["ANTHROPIC_API_KEY"]]],
  );
  assert.equal(outputs["lane-class"], "credit-stop");
  assert.equal(outputs.credential, KEY_NAME);
  assert.deepEqual(
    records.map((r) => [r.leg, r.secret, r.class, r.next]),
    [[1, KEY_NAME, "credit-stop", "subscription"]],
  );
});

test("a tier spend cap is a credit stop too, with its reset", () => {
  const { outputs, calls, records } = runCase({ key: TIER_CAP });
  assert.equal(calls.length, 1);
  assert.equal(records[0].class, "credit-stop");
  assert.equal(outputs["lane-class"], "credit-stop");
  assert.equal(outputs["lane-resets"], "2026-09-01T00:00:00Z");
});

test("a credit-stop-shaped failure on the subscription leg is never credit-stop", () => {
  const { outputs, calls } = runCase({ sub: CREDIT_STOP });
  assert.deepEqual(
    calls.map((c) => [c.leg, c.seen]),
    [["SUB", ["CLAUDE_CODE_OAUTH_TOKEN"]]],
  );
  assert.notEqual(outputs["lane-class"], "credit-stop");
  assert.notEqual(outputs["lane-class"], "");
  assert.equal(outputs.credential, TOKEN_NAME);
});

test("an auth failure on the key leg ends the run with its class", () => {
  const { outputs, calls } = runCase({ key: AUTH });
  assert.deepEqual(
    calls.map((c) => c.leg),
    ["KEY"],
  );
  assert.equal(outputs["lane-class"], "auth");
  assert.equal(outputs.credential, KEY_NAME);
});

test("max-turns and timeout on the key leg end the run with their class", () => {
  const maxTurns = runCase({ key: MAX_TURNS });
  assert.equal(maxTurns.calls.length, 1);
  assert.equal(maxTurns.outputs["lane-class"], "max-turns");
  const timedOut = runCase({
    key: SUCCESS,
    keySleep: true,
    legTimeoutMs: 300,
  });
  assert.equal(timedOut.outputs["lane-class"], "timeout");
  assert.equal(timedOut.records.length, 1);
});

test("a key-leg success writes the outputs from that leg", () => {
  const { outputs, calls } = runCase({ key: SUCCESS });
  assert.deepEqual(
    calls.map((c) => c.leg),
    ["KEY"],
  );
  assert.deepEqual(outputs, {
    "lane-class": "",
    "lane-resets": "",
    "lane-turns": "3",
    "lane-models": "claude-sonnet-5",
    credential: KEY_NAME,
    "execution-file": outputs["execution-file"],
  });
  const messages = JSON.parse(
    fs.readFileSync(outputs["execution-file"], "utf8"),
  );
  assert.equal(messages.at(-1).type, "result");
});

test("a subscription limit stop is rate-limit with the rejected window's reset", () => {
  const { outputs } = runCase({ sub: SESSION_LIMIT });
  assert.equal(outputs["lane-class"], "rate-limit");
  // resetsAt 1767225600 is 2026-01-01T00:00:00Z.
  assert.equal(outputs["lane-resets"], "2026-01-01T00:00:00Z");
  assert.equal(outputs.credential, TOKEN_NAME);
});

test("each leg gets the scrub, a bounded watchdog, the flags and the preamble", () => {
  const { calls } = runCase({ key: SUCCESS });
  const [call] = calls;
  assert.equal(call.scrub, "1");
  assert.equal(call.watchdog, "1");
  assert.equal(call.wait, "1800000");
  for (const flag of [
    "--restricted",
    "--strict-mcp-config",
    "--permission-prompts",
  ]) {
    assert.ok(call.args.includes(flag), flag);
  }
  assert.equal(call.args.includes("--setting-sources"), false);
  assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "auto");
  assert.equal(call.args[call.args.indexOf("--tools") + 1], "Read,Bash");
  assert.equal(
    call.args[call.args.indexOf("--json-schema") + 1],
    '{"type":"object"}',
  );
  assert.deepEqual(call.args.slice(-5), [
    "--disallowedTools",
    "WebFetch",
    "--allowedTools",
    "Read",
    "Bash(git status:*)",
  ]);
  assert.equal(call.stdin, "You run unattended.\n\nFix the failing check.\n");
});

test("legEnv removes every inherited credential and sets exactly one", () => {
  const base = Object.fromEntries(
    CREDENTIAL_VARIABLES.map((n) => [n, "inherited"]),
  );
  const config = { watchdogMaxWaitMs: "60000" };
  const key = legEnv(base, { leg: "api-key", value: KEY }, config);
  const sub = legEnv(base, { leg: "subscription", value: TOKEN }, config);
  assert.deepEqual(
    CREDENTIAL_VARIABLES.filter((n) => n in key),
    ["ANTHROPIC_API_KEY"],
  );
  assert.equal(key.ANTHROPIC_API_KEY, KEY);
  assert.deepEqual(
    CREDENTIAL_VARIABLES.filter((n) => n in sub),
    ["CLAUDE_CODE_OAUTH_TOKEN"],
  );
  assert.equal(sub.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(
    "CLAUDE_CODE_ENTRYPOINT" in key || "CLAUDE_CODE_ENTRYPOINT" in sub,
    false,
  );
});

test("legEnv removes every workflow file-command variable", () => {
  const base = Object.fromEntries(
    FILE_COMMAND_VARIABLES.map((n) => [n, `/runner/${n}`]),
  );
  const env = legEnv(base, { leg: "api-key", value: KEY }, {
    watchdogMaxWaitMs: "60000",
  });
  assert.deepEqual(
    FILE_COMMAND_VARIABLES.filter((n) => n in env),
    [],
  );
});

test("a leg sees no file-command path and what it appends to GITHUB_ENV or GITHUB_PATH is cut off", () => {
  const dir = path.join(root, "file-commands");
  fs.mkdirSync(dir);
  const envFile = path.join(dir, "env");
  const pathFile = path.join(dir, "path");
  fs.writeFileSync(envFile, "EARLIER=1\n");
  fs.writeFileSync(pathFile, "");
  const { calls } = runCase({
    key: SUCCESS,
    extraEnv: {
      GITHUB_ENV: envFile,
      GITHUB_PATH: pathFile,
      GITHUB_OUTPUT: path.join(dir, "output"),
      GITHUB_STATE: path.join(dir, "state"),
      GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
      FAKE_APPEND: `${envFile}:${pathFile}`,
    },
  });
  assert.deepEqual(
    calls.map((c) => c.fileCommands),
    [[]],
  );
  assert.equal(fs.readFileSync(envFile, "utf8"), "EARLIER=1\n");
  assert.equal(fs.readFileSync(pathFile, "utf8"), "");
});

test("what a leg appends to GITHUB_OUTPUT, GITHUB_STEP_SUMMARY or GITHUB_STATE is cut off", () => {
  const dir = path.join(root, "step-files");
  fs.mkdirSync(dir);
  const files = {
    GITHUB_OUTPUT: path.join(dir, "output"),
    GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
    GITHUB_STATE: path.join(dir, "state"),
  };
  fs.writeFileSync(files.GITHUB_OUTPUT, "cli-version=2.1.302\n");
  fs.writeFileSync(files.GITHUB_STEP_SUMMARY, "### earlier step\n");
  fs.writeFileSync(files.GITHUB_STATE, "");
  runCase({
    sub: SUCCESS,
    extraEnv: { ...files, FAKE_APPEND: Object.values(files).join(":") },
  });
  assert.equal(
    fs.readFileSync(files.GITHUB_OUTPUT, "utf8"),
    "cli-version=2.1.302\n",
  );
  assert.equal(
    fs.readFileSync(files.GITHUB_STEP_SUMMARY, "utf8"),
    "### earlier step\n",
  );
  assert.equal(fs.readFileSync(files.GITHUB_STATE, "utf8"), "");
});

// Write bits stop the runner user only when it is not root.
const asNonRoot = { skip: process.getuid?.() === 0 && "runs as root" };

function writableTree(dir) {
  const file = path.join(dir, "node_modules", "pkg", "cli.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "original\n");
  fs.chmodSync(file, 0o755);
  return file;
}

test("the leg finds the CLI install tree read-only, and its modes come back after", asNonRoot, () => {
  let installed;
  let added;
  const { calls } = runCase({
    sub: SUCCESS,
    prepare: (dir) => {
      installed = writableTree(path.join(dir, "cli"));
      added = path.join(dir, "cli", "node_modules", "pkg", "added.js");
      return { FAKE_WRITE: `${installed}:${added}` };
    },
  });
  assert.deepEqual(
    calls.map((c) => c.writes),
    [["EACCES", "EACCES"]],
  );
  assert.equal(fs.readFileSync(installed, "utf8"), "original\n");
  assert.equal(fs.existsSync(added), false);
  assert.equal(fs.statSync(installed).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.dirname(installed)).mode & 0o200, 0o200);
});

test("_work/_actions beside RUNNER_WORKSPACE is read-only during the leg and writable after", asNonRoot, () => {
  let action;
  const { calls } = runCase({
    key: SUCCESS,
    prepare: (dir) => {
      const work = path.join(dir, "_work");
      fs.mkdirSync(path.join(work, "repo"), { recursive: true });
      action = writableTree(path.join(work, "_actions", "owner", "action"));
      return { RUNNER_WORKSPACE: path.join(work, "repo"), FAKE_WRITE: action };
    },
  });
  assert.deepEqual(calls[0].writes, ["EACCES"]);
  assert.equal(fs.readFileSync(action, "utf8"), "original\n");
  fs.appendFileSync(action, "after\n");
});

function recordingSpawn(spawned) {
  return (command, args) => {
    spawned.push([command, args]);
    return {
      status: 0,
      signal: null,
      stdout: Buffer.from(SUCCESS.map((m) => JSON.stringify(m)).join("\n")),
    };
  };
}

test("with the install and action trees present, the leg runs the CLI under bwrap that binds both read-only after the root", () => {
  let cli;
  let actions;
  const spawned = [];
  const { config } = runCase({
    key: CREDIT_STOP,
    prepare: (dir) => {
      cli = path.join(dir, "cli");
      writableTree(cli);
      actions = path.join(dir, "_work", "_actions");
      fs.mkdirSync(actions, { recursive: true });
      fs.mkdirSync(path.join(dir, "_work", "repo"));
      return { RUNNER_WORKSPACE: path.join(dir, "_work", "repo") };
    },
    spawn: recordingSpawn(spawned),
  });
  assert.equal(spawned.length, 1);
  const [command, args] = spawned[0];
  assert.equal(command, "bwrap");
  assert.deepEqual(args.slice(0, args.indexOf("--") + 2), [
    "--die-with-parent",
    "--dev-bind",
    "/",
    "/",
    "--ro-bind",
    cli,
    cli,
    "--ro-bind",
    actions,
    actions,
    "--",
    fakeCli,
  ]);
  assert.deepEqual(args.slice(args.indexOf("--") + 2), cliArgs(config));
});

test("with neither tree present, the leg runs the CLI directly", () => {
  const spawned = [];
  const { config } = runCase({
    key: SUCCESS,
    spawn: recordingSpawn(spawned),
  });
  assert.deepEqual(spawned, [[fakeCli, cliArgs(config)]]);
});

test("under bwrap a leg cannot put the write bits back on the install tree", withBwrap, () => {
  let installed;
  const { calls } = runCase({
    key: SUCCESS,
    prepare: (dir) => {
      installed = writableTree(path.join(dir, "cli"));
      return { FAKE_CHMOD: installed, FAKE_WRITE: installed };
    },
    spawn: spawnSync,
  });
  assert.deepEqual(calls[0].chmods, ["EROFS"]);
  assert.notEqual(calls[0].writes[0], "written");
  assert.equal(fs.readFileSync(installed, "utf8"), "original\n");
  assert.equal(fs.statSync(installed).mode & 0o777, 0o755);
});

test("under bwrap a leg cannot put the write bits back on _work/_actions", withBwrap, () => {
  let action;
  const { calls } = runCase({
    key: SUCCESS,
    prepare: (dir) => {
      const work = path.join(dir, "_work");
      fs.mkdirSync(path.join(work, "repo"), { recursive: true });
      action = writableTree(path.join(work, "_actions", "owner", "action"));
      return {
        RUNNER_WORKSPACE: path.join(work, "repo"),
        FAKE_CHMOD: action,
        FAKE_WRITE: action,
      };
    },
    spawn: spawnSync,
  });
  assert.deepEqual(calls[0].chmods, ["EROFS"]);
  assert.notEqual(calls[0].writes[0], "written");
  assert.equal(fs.readFileSync(action, "utf8"), "original\n");
  assert.equal(fs.statSync(action).mode & 0o777, 0o755);
});

test("a CLI under bwrap does not outlive a timed-out leg", withBwrap, () => {
  let survived;
  const { outputs } = runCase({
    key: SUCCESS,
    keySleep: true,
    legTimeoutMs: 300,
    prepare: (dir) => {
      writableTree(path.join(dir, "cli"));
      survived = path.join(dir, "survived");
      return { FAKE_SURVIVED: survived };
    },
    spawn: spawnSync,
  });
  assert.equal(outputs["lane-class"], "timeout");
  // The fake CLI sleeps 5 seconds before it writes the marker.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
  assert.equal(fs.existsSync(survived), false);
});

test("the install tree is writable again when a leg throws", asNonRoot, () => {
  let installed;
  assert.throws(() =>
    runCase({
      key: SUCCESS,
      prepare: (dir) => {
        installed = writableTree(path.join(dir, "cli"));
        return {};
      },
      spawn: () => {
        throw new Error("spawn failed");
      },
    }),
  /spawn failed/u);
  assert.equal(fs.statSync(installed).mode & 0o777, 0o755);
});

test("a failed mode restore still cuts off what a leg appended to the step files", () => {
  const chmodSync = fs.chmodSync;
  let cli;
  let output;
  try {
    assert.throws(() =>
      runCase({
        key: SUCCESS,
        prepare: (dir) => {
          cli = path.join(dir, "cli");
          writableTree(cli);
          output = path.join(dir, "output");
          fs.writeFileSync(output, "cli-version=2.1.302\n");
          return { GITHUB_OUTPUT: output };
        },
        spawn: () => {
          fs.appendFileSync(output, "PLANTED=1\n");
          fs.chmodSync = () => {
            throw Object.assign(new Error("EIO: i/o error, chmod"), { code: "EIO" });
          };
          return {
            status: 0,
            signal: null,
            stdout: Buffer.from(SUCCESS.map((m) => JSON.stringify(m)).join("\n")),
          };
        },
      }),
    /EIO/u);
  } finally {
    fs.chmodSync = chmodSync;
  }
  assert.equal(fs.readFileSync(output, "utf8"), "cli-version=2.1.302\n");
  for (const entry of ["", "node_modules", path.join("node_modules", "pkg")]) {
    fs.chmodSync(path.join(cli, entry), 0o755);
  }
});

test("stdout is captured in memory and a maxBuffer overflow is class other", () => {
  const seen = [];
  const spawn = (command, args, options) => {
    seen.push(options);
    const overflow = new Error("spawnSync ENOBUFS");
    overflow.code = "ENOBUFS";
    return {
      status: null,
      signal: "SIGINT",
      error: overflow,
      stdout: Buffer.from(`${JSON.stringify({ type: "system" })}\n`),
    };
  };
  const { records, outputs, calls } = runCase({
    key: CREDIT_STOP,
    spawn,
  });
  assert.equal(calls.length, 0);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].stdio, ["pipe", "pipe", "inherit"]);
  assert.equal(seen[0].maxBuffer, MAX_LEG_STDOUT_BYTES);
  assert.equal(seen[0].killSignal, "SIGINT");
  assert.equal(outputs["lane-class"], "other");
  assert.equal(records[0].class, "other");
  assert.equal(records[0].next, null);
  assert.match(records[0].message, /stdout passed \d+ bytes/u);
  assert.equal(
    fs.readFileSync(outputs["execution-file"], "utf8"),
    '[{"type":"system"}]',
  );
});

test("the log has one object for the leg with the documented fields and no credential or model text", () => {
  const denied = result({
    permission_denials: [
      { tool_name: "Bash", tool_use_id: "a", tool_input: {} },
      { tool_name: "Bash", tool_use_id: "b", tool_input: {} },
      { tool_name: "WebFetch", tool_use_id: "c", tool_input: {} },
    ],
    duration_ms: 1200,
    total_cost_usd: 0.0033,
    modelUsage: {
      "claude-haiku-5-5": { costUSD: 0.0033, inputTokens: 2, outputTokens: 4 },
    },
  });
  const { records } = runCase({ sub: [denied] });
  const [stopped] = runCase({ key: CREDIT_STOP }).records;
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]), [
    "run_id",
    "lane",
    "role",
    "leg",
    "credential",
    "secret",
    "cli_version",
    "model",
    "permission_mode",
    "started_at",
    "ended_at",
    "duration_ms",
    "exit_code",
    "total_cost_usd",
    "models_used",
    "num_turns",
    "is_error",
    "class",
    "message",
    "resets",
    "usage",
    "denials",
    "next",
  ]);
  assert.equal(stopped.message, "Credit balance is too low");
  assert.equal(stopped.exit_code, 1);
  assert.equal(stopped.num_turns, 0);
  assert.equal(records[0].message, null);
  assert.equal(records[0].duration_ms, 1200);
  assert.equal(records[0].total_cost_usd, 0.0033);
  assert.deepEqual(records[0].models_used, {
    "claude-haiku-5-5": { cost_usd: 0.0033, input_tokens: 2, output_tokens: 4 },
  });
  assert.deepEqual(records[0].denials, {
    count: 3,
    tools: ["Bash", "WebFetch"],
  });
  const text = JSON.stringify([...records, stopped]);
  assert.equal(holdsCredential(text, [KEY, TOKEN]), false);
  assert.equal(text.includes("model text"), false);
});

test("holdsCredential finds a secret value or a key-shaped string", () => {
  assert.equal(holdsCredential(`x ${KEY} y`, [KEY]), true);
  assert.equal(holdsCredential("sk-ant-api03-abcdefghijkl", []), true);
  assert.equal(holdsCredential("FIXCI_CLAUDE_API_KEY", [KEY]), false);
});

test("cli-version latest resolves from npm view; exact versions pass; others fail", () => {
  assert.equal(
    resolveCliVersion("latest", () => "2.1.302\n"),
    "2.1.302",
  );
  assert.equal(
    resolveCliVersion("", () => "2.1.303"),
    "2.1.303",
  );
  assert.equal(
    resolveCliVersion("2.1.200", () => assert.fail("npm view must not run")),
    "2.1.200",
  );
  assert.throws(
    () => resolveCliVersion("2.1", () => ""),
    (error) =>
      error instanceof LaneError &&
      /exact major\.minor\.patch/u.test(error.message),
  );
  assert.throws(
    () => resolveCliVersion("latest", () => "next"),
    /exact major\.minor\.patch/u,
  );
  assert.throws(
    () => resolveCliVersion("latest", () => ""),
    /exact major\.minor\.patch/u,
  );
});

function configEnv(overrides = {}) {
  const prompt = path.join(root, "config-prompt.md");
  fs.writeFileSync(prompt, "Do the task.\n");
  return {
    LANE_NAME: "intake",
    LANE_ROLE: "automations",
    LANE_PROMPT_FILE: prompt,
    LANE_API_KEY: KEY,
    LANE_SUBSCRIPTION_TOKEN: "",
    LANE_MODEL: "sonnet",
    LANE_EFFORT: "medium",
    LANE_MAX_TURNS: "10",
    LANE_PERMISSION_MODE: "dontAsk",
    LANE_WATCHDOG_MAX_WAIT_MS: "1800000",
    LANE_CLI_VERSION: "2.1.302",
    LANE_CLI_PATH: fakeCli,
    LANE_WORK_DIR: root,
    ...overrides,
  };
}

test("readConfig takes exactly one credential, named after the role, never from input", () => {
  const key = readConfig(
    configEnv({
      LANE_ROLE: "issue-lane",
      LANE_API_KEY_NAME: "OTHER_SECRET",
    }),
  );
  assert.deepEqual(key.leg, {
    leg: "api-key",
    name: "ISSUE_LANE_CLAUDE_API_KEY",
    value: KEY,
  });
  const sub = readConfig(
    configEnv({
      LANE_ROLE: "issue-lane",
      LANE_API_KEY: "",
      LANE_SUBSCRIPTION_TOKEN: TOKEN,
      LANE_SUBSCRIPTION_TOKEN_NAME: "OTHER_TOKEN",
    }),
  );
  assert.deepEqual(sub.leg, {
    leg: "subscription",
    name: "ISSUE_LANE_CLAUDE_CODE_OAUTH_TOKEN",
    value: TOKEN,
  });
  assert.throws(
    () => readConfig(configEnv({ LANE_SUBSCRIPTION_TOKEN: TOKEN })),
    (error) =>
      error instanceof LaneError &&
      /^two credentials: set exactly one/u.test(error.message),
  );
  assert.throws(
    () => readConfig(configEnv({ LANE_API_KEY: "" })),
    (error) =>
      error instanceof LaneError &&
      /^no credential: set exactly one/u.test(error.message),
  );
});

test("readConfig refuses bypass and bad values", () => {
  assert.throws(
    () => readConfig(configEnv({ LANE_PERMISSION_MODE: "bypassPermissions" })),
    /permission-mode/u,
  );
  assert.throws(
    () => readConfig(configEnv({ LANE_MAX_TURNS: "0" })),
    /max-turns/u,
  );
  assert.throws(() => readConfig(configEnv({ LANE_MODEL: "a b" })), /model/u);
  assert.throws(() => readConfig(configEnv({ LANE_NAME: "" })), /lane/u);
  assert.throws(
    () => readConfig(configEnv({ LANE_ROLE: "Reviews" })),
    /role/u,
  );
  assert.throws(
    () =>
      readConfig(
        configEnv({
          LANE_ALLOWED_TOOLS: "Read\n--dangerously-skip-permissions",
        }),
      ),
    /allowed-tools/u,
  );
  assert.throws(
    () => readConfig(configEnv({ LANE_DISALLOWED_TOOLS: "-x" })),
    /disallowed-tools/u,
  );
  assert.throws(
    () => readConfig(configEnv({ LANE_JSON_SCHEMA_FILE: "/nonexistent.json" })),
    /json-schema-file/u,
  );
});

test("an empty effort leaves --effort out; an invalid one still fails", () => {
  const config = readConfig(configEnv({ LANE_EFFORT: "" }));
  assert.equal(config.effort, "");
  assert.equal(cliArgs(config).includes("--effort"), false);
  const set = cliArgs(readConfig(configEnv()));
  assert.equal(set[set.indexOf("--effort") + 1], "medium");
  assert.throws(
    () => readConfig(configEnv({ LANE_EFFORT: "High" })),
    /effort/u,
  );
});

test("plugin-dirs pass as --plugin-dir and --add-dir, add-dirs as --add-dir, resolved in the workspace", () => {
  const workspace = path.join(root, "workspace");
  for (const dir of ["plugins/review", "plugins/tidy", "docs"]) {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  }
  const config = readConfig(
    configEnv({
      GITHUB_WORKSPACE: workspace,
      LANE_PLUGIN_DIRS: "plugins/review\n\n  ./plugins/tidy  \n",
      LANE_ADD_DIRS: `${workspace}/docs`,
    }),
  );
  const review = path.join(workspace, "plugins", "review");
  const tidy = path.join(workspace, "plugins", "tidy");
  const docs = path.join(workspace, "docs");
  assert.deepEqual(config.pluginDirs, [review, tidy]);
  assert.deepEqual(config.addDirs, [docs]);
  const args = cliArgs(config);
  assert.ok(args.includes("--restricted"));
  const pairs = (flag) =>
    args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
  assert.deepEqual(pairs("--plugin-dir"), [review, tidy]);
  assert.deepEqual(pairs("--add-dir"), [review, tidy, docs]);
  const none = cliArgs(readConfig(configEnv()));
  assert.equal(none.includes("--plugin-dir"), false);
  assert.equal(none.includes("--add-dir"), false);
});

test("plugin-dirs and add-dirs refuse paths outside the workspace", () => {
  const workspace = path.join(root, "workspace-refusals");
  fs.mkdirSync(path.join(workspace, "plugin"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "file.md"), "");
  fs.symlinkSync(root, path.join(workspace, "escape"));
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  for (const [input, entry, refusal] of [
    ["LANE_PLUGIN_DIRS", "plugin/../plugin", /'\.\.'/u],
    ["LANE_ADD_DIRS", "../outside", /'\.\.'/u],
    ["LANE_ADD_DIRS", outside, /inside GITHUB_WORKSPACE/u],
    ["LANE_PLUGIN_DIRS", "escape", /inside GITHUB_WORKSPACE/u],
    ["LANE_ADD_DIRS", "absent", /existing directory/u],
    ["LANE_PLUGIN_DIRS", "file.md", /existing directory/u],
  ]) {
    assert.throws(
      () =>
        readConfig(configEnv({ GITHUB_WORKSPACE: workspace, [input]: entry })),
      (error) =>
        error instanceof LaneError &&
        error.message.startsWith(
          input === "LANE_PLUGIN_DIRS" ? "plugin-dirs" : "add-dirs",
        ) &&
        refusal.test(error.message),
      `${input}=${entry}`,
    );
  }
  assert.throws(
    () => readConfig(configEnv({ LANE_PLUGIN_DIRS: "plugin" })),
    /plugin-dirs.*GITHUB_WORKSPACE/u,
  );
});

function runEnv(dir, overrides) {
  fs.mkdirSync(dir);
  return {
    ...configEnv({ LANE_WORK_DIR: dir, ...overrides }),
    PATH: process.env.PATH,
    GITHUB_OUTPUT: path.join(dir, "output"),
    GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
    FAKE_CALLS: path.join(dir, "calls.jsonl"),
  };
}

function legFile(dir, name, messages) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, messages.map((m) => JSON.stringify(m)).join("\n"));
  return file;
}

function readOutputs(file) {
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split(/=(.*)/su).slice(0, 2)),
  );
}

test("run writes the outputs, the log and the summary, and fails on a lane class", () => {
  const dir = path.join(root, "run");
  const env = runEnv(dir, { LANE_API_KEY: "", LANE_SUBSCRIPTION_TOKEN: TOKEN });
  env.FAKE_SUB = legFile(dir, "sub.jsonl", SESSION_LIMIT);
  env.FAKE_SUB_EXIT = "1";
  assert.throws(
    () => run(env),
    /intake ended class=rate-limit on AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN/u,
  );
  const outputs = readOutputs(env.GITHUB_OUTPUT);
  assert.equal(outputs["lane-class"], "rate-limit");
  assert.equal(outputs.credential, TOKEN_NAME);
  const log = fs
    .readFileSync(outputs["log-file"], "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    log.map((r) => [r.class, r.secret]),
    [["rate-limit", TOKEN_NAME]],
  );
  assert.equal(log[0].message, "You've hit your session limit · resets 3:45pm");
  const summaryText = fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(
    summaryText,
    /\| 1 \| AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN \| rate-limit \| .* \| limit stop: rerun after the reset \|/u,
  );
  assert.equal(summaryText.includes("session limit"), false);
});

test("run on a key-leg credit stop sets lane-class credit-stop and starts no subscription leg", () => {
  const dir = path.join(root, "run-credit-stop");
  const env = runEnv(dir, {});
  env.FAKE_KEY = legFile(dir, "key.jsonl", CREDIT_STOP);
  env.FAKE_KEY_EXIT = "1";
  env.FAKE_SUB = legFile(dir, "sub.jsonl", SUCCESS);
  env.FAKE_SUB_EXIT = "0";
  assert.throws(
    () => run(env),
    /intake ended class=credit-stop on AUTOMATIONS_CLAUDE_API_KEY/u,
  );
  const outputs = readOutputs(env.GITHUB_OUTPUT);
  assert.equal(outputs["lane-class"], "credit-stop");
  const calls = fs.readFileSync(env.FAKE_CALLS, "utf8").trim().split("\n");
  assert.deepEqual(
    calls.map((l) => JSON.parse(l).leg),
    ["KEY"],
  );
  const summaryText = fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(
    summaryText,
    /\| 1 \| AUTOMATIONS_CLAUDE_API_KEY \| credit-stop \| .* \| subscription \| credit stop: add Console credit or raise the spend limit \|/u,
  );
  assert.equal(summaryText.includes("Credit balance"), false);
});

test("run refuses both credentials before any leg starts", () => {
  const dir = path.join(root, "run-two-credentials");
  const env = runEnv(dir, { LANE_SUBSCRIPTION_TOKEN: TOKEN });
  env.FAKE_KEY = legFile(dir, "key.jsonl", SUCCESS);
  env.FAKE_SUB = legFile(dir, "sub.jsonl", SUCCESS);
  assert.throws(() => run(env), /two credentials/u);
  assert.equal(fs.existsSync(env.FAKE_CALLS), false);
  assert.equal(fs.existsSync(env.GITHUB_OUTPUT), false);
});

test("the summary shows a closed token per class and never a record's message", () => {
  const record = (failureClass) => ({
    leg: 1,
    secret: KEY_NAME,
    class: failureClass,
    num_turns: 0,
    denials: { count: 0 },
    resets: null,
    next: null,
    message: "::error::planted CLI text",
  });
  const table = summaryTable(
    ["", "auth", "timeout", "max-turns", "overloaded", "other", "unknown"].map(
      record,
    ),
  );
  assert.equal(table.includes("planted"), false);
  assert.match(table, /\| success \| 0 \| 0 \|  \|  \|  \|$/mu);
  assert.match(table, /\| auth \| .* \| credential unusable: replace the secret \|/u);
  assert.match(table, /\| unknown \| .* \| see the step log \|/u);
});

test("run refuses a loader, TLS or proxy variable before any leg", () => {
  const dir = path.join(root, "run-unsafe");
  fs.mkdirSync(dir);
  const calls = path.join(dir, "calls.jsonl");
  assert.throws(
    () =>
      run({
        ...configEnv({ LANE_WORK_DIR: dir }),
        PATH: process.env.PATH,
        FAKE_CALLS: calls,
        NODE_OPTIONS: "--require /tmp/planted.js",
      }),
    /sets NODE_OPTIONS/u,
  );
  assert.equal(fs.existsSync(calls), false);
});

const PINNED = {
  apiKeyHelper: "",
  allowManagedHooksOnly: true,
  env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
  permissions: { disableBypassPermissionsMode: "disable" },
};

test("verifyManagedSettings needs a root-owned, pinned, non-writable file", () => {
  const file = path.join(root, "managed-settings.json");
  fs.writeFileSync(file, JSON.stringify(PINNED));
  const asRoot = (mode) => () => ({ uid: 0, mode });
  // The test runs as a normal user, so the real file is not root's.
  assert.throws(() => verifyManagedSettings(file), /not owned by root/u);
  assert.doesNotThrow(() =>
    verifyManagedSettings(file, { stat: asRoot(0o100644) }),
  );
  assert.throws(
    () => verifyManagedSettings(file, { stat: asRoot(0o100666) }),
    /writable/u,
  );
  assert.throws(
    () => verifyManagedSettings(path.join(root, "absent.json")),
    /missing/u,
  );
  for (const [settings, refusal] of [
    [{ ...PINNED, apiKeyHelper: undefined }, /does not pin apiKeyHelper/u],
    [{ ...PINNED, env: {} }, /env\.ANTHROPIC_BASE_URL/u],
    [
      { ...PINNED, env: { ANTHROPIC_BASE_URL: "https://proxy.example" } },
      /env\.ANTHROPIC_BASE_URL/u,
    ],
    [{ ...PINNED, permissions: undefined }, /disableBypassPermissionsMode/u],
    [
      { ...PINNED, permissions: { disableBypassPermissionsMode: "enable" } },
      /disableBypassPermissionsMode/u,
    ],
    [{ ...PINNED, allowManagedHooksOnly: undefined }, /allowManagedHooksOnly nor disableAllHooks/u],
    [{ ...PINNED, allowManagedHooksOnly: false }, /allowManagedHooksOnly nor disableAllHooks/u],
    [{ ...PINNED, allowManagedHooksOnly: "true" }, /allowManagedHooksOnly nor disableAllHooks/u],
    [
      { ...PINNED, allowManagedHooksOnly: undefined, disableAllHooks: false },
      /allowManagedHooksOnly nor disableAllHooks/u,
    ],
  ]) {
    fs.writeFileSync(file, JSON.stringify(settings));
    assert.throws(
      () => verifyManagedSettings(file, { stat: asRoot(0o100644) }),
      refusal,
    );
  }
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...PINNED,
      allowManagedHooksOnly: undefined,
      disableAllHooks: true,
    }),
  );
  assert.doesNotThrow(() =>
    verifyManagedSettings(file, { stat: asRoot(0o100644) }),
  );
});

test("apply-claude-managed-settings writes settings verifyManagedSettings accepts by default", () => {
  const { parseWorkflow } = require("../../scripts/workflow-yaml.cjs");
  const action = parseWorkflow(
    fs.readFileSync(
      path.join(__dirname, "..", "apply-claude-managed-settings", "action.yml"),
      "utf8",
    ),
  );
  const file = path.join(root, "default-managed-settings.json");
  fs.writeFileSync(file, action.inputs.settings.default);
  assert.doesNotThrow(() =>
    verifyManagedSettings(file, { stat: () => ({ uid: 0, mode: 0o100644 }) }),
  );
  // The action's own check runs the same rule before it writes.
  const check = /node -e '([^']*)'/u.exec(action.runs.steps[0].run)[1];
  const verdict = (settings) =>
    spawnSync(process.execPath, ["-e", check], {
      env: { SETTINGS: JSON.stringify(settings) },
    }).status;
  assert.equal(verdict(PINNED), 0);
  assert.notEqual(verdict({ ...PINNED, allowManagedHooksOnly: undefined }), 0);
});

test("verifyEnvironment refuses loader, TLS and proxy variables, NO_PROXY and empty values aside", () => {
  for (const name of [
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "BASH_ENV",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "FTP_PROXY",
  ]) {
    assert.throws(
      () => verifyEnvironment({ PATH: "/usr/bin", [name]: "x" }),
      (error) => error instanceof LaneError && error.message.includes(name),
      name,
    );
  }
  assert.doesNotThrow(() =>
    verifyEnvironment({
      PATH: "/usr/bin",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
      NODE_OPTIONS: "",
      HTTPS_PROXY: "",
      PROXY_HOST: "x",
    }),
  );
});

test("verifyIsolation probes a PID namespace and refuses an unsafe environment", () => {
  const file = path.join(root, "probe-settings.json");
  fs.writeFileSync(file, JSON.stringify(PINNED));
  const stat = () => ({ uid: 0, mode: 0o100644 });
  const dockerSocket = path.join(root, "absent-probe.sock");
  const probes = [];
  const answer = (bwrap) => (command, args) => {
    if (command === "sudo") return { status: 1 };
    probes.push(args);
    return bwrap;
  };
  assert.doesNotThrow(() =>
    verifyIsolation({
      managedSettings: file,
      env: {},
      dockerSocket,
      stat,
      spawn: answer({ status: 0 }),
    }),
  );
  assert.deepEqual(probes, [
    ["--unshare-pid", "--dev-bind", "/", "/", "true"],
  ]);
  assert.throws(
    () =>
      verifyIsolation({
        managedSettings: file,
        env: {},
        dockerSocket,
        stat,
        spawn: answer({ status: 1 }),
      }),
    /cannot create a PID namespace.*apparmor_restrict_unprivileged_userns=0/u,
  );
  const missing = Object.assign(new Error("spawnSync bwrap ENOENT"), {
    code: "ENOENT",
  });
  assert.throws(
    () =>
      verifyIsolation({
        managedSettings: file,
        env: {},
        dockerSocket,
        stat,
        spawn: answer({ status: null, error: missing }),
      }),
    /bubblewrap is missing/u,
  );
  assert.throws(
    () =>
      verifyIsolation({
        managedSettings: file,
        env: { LD_PRELOAD: "/tmp/planted.so" },
        dockerSocket,
        stat,
        spawn: answer({ status: 0 }),
      }),
    /sets LD_PRELOAD/u,
  );
});

test("verifyIsolation refuses a writable docker socket", () => {
  const file = path.join(root, "isolation-settings.json");
  fs.writeFileSync(file, JSON.stringify(PINNED));
  // sudo fails, bubblewrap answers.
  const spawn = (command) => ({ status: command === "sudo" ? 1 : 0 });
  const io = { stat: () => ({ uid: 0, mode: 0o100644 }), spawn, env: {} };
  const socket = path.join(root, "docker.sock");
  fs.writeFileSync(socket, "");
  assert.throws(
    () =>
      verifyIsolation({ managedSettings: file, dockerSocket: socket, ...io }),
    /docker\.sock is writable/u,
  );
  fs.chmodSync(socket, 0o444);
  assert.doesNotThrow(() =>
    verifyIsolation({ managedSettings: file, dockerSocket: socket, ...io }),
  );
  assert.doesNotThrow(() =>
    verifyIsolation({
      managedSettings: file,
      dockerSocket: path.join(root, "absent.sock"),
      ...io,
    }),
  );
});

test("install runs both npm calls in the work directory against the public registry", () => {
  const dir = path.join(root, "install");
  fs.mkdirSync(dir);
  const output = path.join(dir, "output");
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    return { status: 0, stdout: "2.1.400\n" };
  };
  install(
    { LANE_CLI_VERSION_INPUT: "latest", LANE_WORK_DIR: dir, GITHUB_OUTPUT: output },
    { spawn },
  );
  assert.deepEqual(
    calls.map((c) => [c.command, c.args[0]]),
    [
      ["npm", "view"],
      ["npm", "install"],
    ],
  );
  for (const call of calls) {
    assert.equal(call.cwd, dir);
    assert.ok(call.args.includes(`--registry=${NPM_REGISTRY}`), call.args[0]);
  }
  assert.equal(NPM_REGISTRY, "https://registry.npmjs.org/");
  assert.match(fs.readFileSync(output, "utf8"), /^cli-version=2\.1\.400$/mu);
});
