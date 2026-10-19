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
  holdsCredential,
  install,
  legEnv,
  readConfig,
  resolveCliVersion,
  run,
  runLegs,
  skipWarnings,
  verifyIsolation,
  verifyManagedSettings,
} = require("./lane.cjs");

const KEY = "key-value-for-tests-1234";
const TOKEN = "oauth-value-for-tests-5678";
const KEY_NAME = "FIXCI_CLAUDE_API_KEY";
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
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ leg, seen, fileCommands,
  scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
  watchdog: process.env.CLAUDE_CODE_RETRY_WATCHDOG,
  wait: process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS,
  args: process.argv.slice(2),
  stdin: fs.readFileSync(0, "utf8") }) + "\\n");
if (process.env["FAKE_" + leg + "_SLEEP"]) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
process.stdout.write(fs.readFileSync(process.env["FAKE_" + leg], "utf8"));
process.exit(Number(process.env["FAKE_" + leg + "_EXIT"] ?? 0));
`,
);
fs.chmodSync(fakeCli, 0o755);

let caseNumber = 0;

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

// Runs the legs against the fake CLI. `key` and `sub` are the message lists
// each leg prints; null leaves that credential empty.
function runCase({
  key,
  sub,
  keyExit = 1,
  subExit = 1,
  keySleep = false,
  legTimeoutMs = 0,
  extraEnv = {},
  spawn,
}) {
  caseNumber += 1;
  const dir = path.join(root, `case-${caseNumber}`);
  fs.mkdirSync(dir);
  const calls = path.join(dir, "calls.jsonl");
  const baseEnv = {
    PATH: process.env.PATH,
    FAKE_CALLS: calls,
    // Inherited credentials the legs must never see.
    ANTHROPIC_AUTH_TOKEN: "inherited-auth-token",
    CLAUDE_CODE_ENTRYPOINT: "inherited-entrypoint",
    LANE_API_KEY: KEY,
    LANE_SUBSCRIPTION_TOKEN: TOKEN,
    ...extraEnv,
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
    legs: [
      {
        leg: "api-key",
        name: key ? KEY_NAME : "",
        value: key ? KEY : "",
        skipped: !key,
      },
      {
        leg: "subscription",
        name: sub ? TOKEN_NAME : "",
        value: sub ? TOKEN : "",
        skipped: !sub,
      },
    ],
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
  const outcome = runLegs(config, { baseEnv, ...(spawn ? { spawn } : {}) });
  const callLines = fs.existsSync(calls)
    ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { ...outcome, calls: callLines.map((l) => JSON.parse(l)), config };
}

test("a key-leg credit stop runs the subscription leg, one credential each", () => {
  const { outputs, calls, records } = runCase({
    key: CREDIT_STOP,
    sub: SUCCESS,
  });
  assert.deepEqual(
    calls.map((c) => [c.leg, c.seen]),
    [
      ["KEY", ["ANTHROPIC_API_KEY"]],
      ["SUB", ["CLAUDE_CODE_OAUTH_TOKEN"]],
    ],
  );
  assert.equal(outputs["lane-class"], "");
  assert.equal(outputs.credential, TOKEN_NAME);
  assert.deepEqual(
    records.map((r) => [r.leg, r.secret, r.class, r.next]),
    [
      [1, KEY_NAME, "credit-stop", "subscription"],
      [2, TOKEN_NAME, "", null],
    ],
  );
});

test("a tier spend cap is a credit stop too", () => {
  const { calls, records } = runCase({ key: TIER_CAP, sub: SUCCESS });
  assert.equal(calls.length, 2);
  assert.equal(records[0].class, "credit-stop");
});

test("an auth failure on the key leg ends the run without the subscription", () => {
  const { outputs, calls } = runCase({ key: AUTH, sub: SUCCESS });
  assert.deepEqual(
    calls.map((c) => c.leg),
    ["KEY"],
  );
  assert.equal(outputs["lane-class"], "auth");
  assert.equal(outputs.credential, KEY_NAME);
});

test("max-turns and timeout on the key leg do not fall back", () => {
  const maxTurns = runCase({ key: MAX_TURNS, sub: SUCCESS });
  assert.deepEqual(
    maxTurns.calls.map((c) => c.leg),
    ["KEY"],
  );
  assert.equal(maxTurns.outputs["lane-class"], "max-turns");
  const timedOut = runCase({
    key: SUCCESS,
    sub: SUCCESS,
    keySleep: true,
    legTimeoutMs: 300,
  });
  assert.equal(timedOut.outputs["lane-class"], "timeout");
  assert.equal(timedOut.records.length, 1);
});

test("a key-leg success never touches the subscription", () => {
  const { outputs, calls } = runCase({ key: SUCCESS, sub: SUCCESS });
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
  const { outputs } = runCase({ key: CREDIT_STOP, sub: SESSION_LIMIT });
  assert.equal(outputs["lane-class"], "rate-limit");
  // resetsAt 1767225600 is 2026-01-01T00:00:00Z.
  assert.equal(outputs["lane-resets"], "2026-01-01T00:00:00Z");
  assert.equal(outputs.credential, TOKEN_NAME);
});

test("a credit stop with no subscription is a limit stop for the reporters", () => {
  const { outputs, records } = runCase({ key: TIER_CAP, sub: null });
  assert.equal(outputs["lane-class"], "rate-limit");
  assert.equal(outputs["lane-resets"], "2026-09-01T00:00:00Z");
  assert.equal(records[0].class, "credit-stop");
  assert.equal(records[0].next, null);
});

test("an empty api-key skips the key leg with a visible warning", () => {
  const { calls, config, outputs } = runCase({ key: null, sub: SUCCESS });
  assert.deepEqual(
    calls.map((c) => c.leg),
    ["SUB"],
  );
  assert.deepEqual(skipWarnings(config), [
    "::warning::run-claude-cli: skipped=api-key (empty secret)",
  ]);
  assert.equal(outputs.credential, TOKEN_NAME);
});

test("each leg gets the scrub, a bounded watchdog, the flags and the preamble", () => {
  const { calls } = runCase({ key: SUCCESS, sub: null });
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
    key: CREDIT_STOP,
    sub: SUCCESS,
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
    [[], []],
  );
  assert.equal(fs.readFileSync(envFile, "utf8"), "EARLIER=1\n");
  assert.equal(fs.readFileSync(pathFile, "utf8"), "");
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
    sub: SUCCESS,
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

test("the log has one object per leg with the documented fields and no credential or model text", () => {
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
  const { records } = runCase({ key: CREDIT_STOP, sub: [denied] });
  assert.equal(records.length, 2);
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
  assert.equal(records[0].message, "Credit balance is too low");
  assert.equal(records[0].exit_code, 1);
  assert.equal(records[0].num_turns, 0);
  assert.equal(records[1].message, null);
  assert.equal(records[1].duration_ms, 1200);
  assert.equal(records[1].total_cost_usd, 0.0033);
  assert.deepEqual(records[1].models_used, {
    "claude-haiku-5-5": { cost_usd: 0.0033, input_tokens: 2, output_tokens: 4 },
  });
  assert.deepEqual(records[1].denials, {
    count: 3,
    tools: ["Bash", "WebFetch"],
  });
  const text = JSON.stringify(records);
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
    LANE_API_KEY_NAME: KEY_NAME,
    LANE_SUBSCRIPTION_TOKEN: "",
    LANE_SUBSCRIPTION_TOKEN_NAME: "",
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

test("readConfig names an unnamed secret after the role; an explicit name wins", () => {
  const derived = readConfig(
    configEnv({
      LANE_ROLE: "issue-lane",
      LANE_API_KEY_NAME: "",
      LANE_SUBSCRIPTION_TOKEN: TOKEN,
    }),
  );
  assert.deepEqual(
    derived.legs.map((leg) => leg.name),
    ["ISSUE_LANE_CLAUDE_API_KEY", "ISSUE_LANE_CLAUDE_CODE_OAUTH_TOKEN"],
  );
  assert.equal(readConfig(configEnv()).legs[0].name, KEY_NAME);
});

test("readConfig refuses bypass, badly named secrets, no credential and bad values", () => {
  assert.equal(readConfig(configEnv()).legs[1].skipped, true);
  assert.throws(
    () => readConfig(configEnv({ LANE_PERMISSION_MODE: "bypassPermissions" })),
    /permission-mode/u,
  );
  assert.throws(
    () => readConfig(configEnv({ LANE_API_KEY_NAME: "fixci_key" })),
    /secret name/u,
  );
  assert.throws(
    () => readConfig(configEnv({ LANE_API_KEY: "" })),
    /no credential/u,
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

test("run writes the outputs, the log and the summary, and fails on a lane class", () => {
  const dir = path.join(root, "run");
  fs.mkdirSync(dir);
  const output = path.join(dir, "output");
  const summary = path.join(dir, "summary");
  const sub = path.join(dir, "sub.jsonl");
  fs.writeFileSync(sub, SESSION_LIMIT.map((m) => JSON.stringify(m)).join("\n"));
  const key = path.join(dir, "key.jsonl");
  fs.writeFileSync(key, CREDIT_STOP.map((m) => JSON.stringify(m)).join("\n"));
  const env = {
    ...configEnv({
      LANE_SUBSCRIPTION_TOKEN: TOKEN,
      LANE_SUBSCRIPTION_TOKEN_NAME: TOKEN_NAME,
      LANE_WORK_DIR: dir,
    }),
    PATH: process.env.PATH,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    FAKE_CALLS: path.join(dir, "calls.jsonl"),
    FAKE_KEY: key,
    FAKE_KEY_EXIT: "1",
    FAKE_SUB: sub,
    FAKE_SUB_EXIT: "1",
  };
  assert.throws(
    () => run(env),
    /intake ended class=rate-limit on AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN/u,
  );
  const outputs = Object.fromEntries(
    fs
      .readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split(/=(.*)/su).slice(0, 2)),
  );
  assert.equal(outputs["lane-class"], "rate-limit");
  assert.equal(outputs.credential, TOKEN_NAME);
  const log = fs
    .readFileSync(outputs["log-file"], "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    log.map((r) => r.class),
    ["credit-stop", "rate-limit"],
  );
  assert.match(
    fs.readFileSync(summary, "utf8"),
    /\| 2 \| AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN \| rate-limit \|/u,
  );
});

const PINNED = {
  apiKeyHelper: "",
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
  ]) {
    fs.writeFileSync(file, JSON.stringify(settings));
    assert.throws(
      () => verifyManagedSettings(file, { stat: asRoot(0o100644) }),
      refusal,
    );
  }
});

test("verifyIsolation refuses a writable docker socket", () => {
  const file = path.join(root, "isolation-settings.json");
  fs.writeFileSync(file, JSON.stringify(PINNED));
  // sudo fails, bubblewrap answers.
  const spawn = (command) => ({ status: command === "sudo" ? 1 : 0 });
  const io = { stat: () => ({ uid: 0, mode: 0o100644 }), spawn };
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
