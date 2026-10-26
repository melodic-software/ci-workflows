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
  SIGNING_KEY_FINGERPRINT,
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
const FALLBACK_TOKEN = "fallback-value-for-tests-9012";
// The org secret the owner named for the central fallback subscription.
const FALLBACK_NAME = "FALLBACK_CLAUDE_CODE_OAUTH_TOKEN";

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
  try {
    fs.appendFileSync(file, "PLANTED=1\\n");
  } catch {}
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
// A process the leg leaves behind: after the leg ends it tries to put a
// forged lane-class into the step's output file.
if (process.env.FAKE_STRAGGLE) {
  require("node:child_process").spawn(process.execPath, ["-e", \`
    const fs = require("node:fs");
    setTimeout(() => {
      let outcome = "written";
      try { fs.chmodSync(process.env.FAKE_STRAGGLE, 0o644); } catch {}
      try { fs.appendFileSync(process.env.FAKE_STRAGGLE, "lane-class=credit-stop\\\\n"); }
      catch (error) { outcome = error.code; }
      fs.writeFileSync(process.env.FAKE_STRAGGLE_DONE, outcome);
    }, 1500);
  \`], { detached: true, stdio: "ignore" }).unref();
}
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

// Runs the one leg against the fake CLI. Set exactly one of `key`, `sub` and
// `fallback`, the message list that leg prints; `fallbackReady` is the
// fallback-ready input a token leg reads.
function runCase({
  key = null,
  sub = null,
  fallback = null,
  fallbackReady = false,
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
    ["SUB", sub ?? fallback, subExit],
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
      : fallback
        ? { leg: "fallback", name: FALLBACK_NAME, value: FALLBACK_TOKEN }
        : { leg: "subscription", name: TOKEN_NAME, value: TOKEN },
    fallbackReady,
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
  assert.equal(outputs.handoff, "true");
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

test("a rejected key hands off to the subscription job and keeps class auth", () => {
  const { outputs, calls, records } = runCase({ key: AUTH });
  assert.deepEqual(
    calls.map((c) => c.leg),
    ["KEY"],
  );
  assert.equal(outputs["lane-class"], "auth");
  assert.equal(outputs.handoff, "true");
  assert.equal(outputs.credential, KEY_NAME);
  assert.deepEqual(
    records.map((r) => [r.class, r.next]),
    [["auth", "subscription"]],
  );
});

// An auth leg with the given numeric status, or none, errors[] entries and
// the CLI's result text. The 402 and 403 bodies follow the published error
// table (platform.claude.com/docs/en/api/errors): billing_error and
// permission_error.
function authLeg({ status, errors, text = "API Error", outputTokens = 0 }) {
  return [
    result({
      ...(errors ? { subtype: "error_during_execution", errors } : {}),
      is_error: true,
      num_turns: 0,
      result: text,
      ...(status === undefined ? {} : { api_error_status: status }),
      usage: { input_tokens: 0, output_tokens: outputTokens },
    }),
  ];
}

// A 403 in the published error shape (platform.claude.com/docs/en/api/errors:
// error.type and request_id), with an error.details.error_code as the tier
// spend-cap body carries one. The code and the low-entropy request id are
// made up, so the secret scan does not read them as a key.
const REQUEST_ID = "req_fake0000000000000000";
const PERMISSION_TEXT =
  'API Error: 403 {"type":"error","error":{"type":"permission_error",' +
  '"message":"not permitted","details":{"error_code":"workspace_access_denied"}},' +
  `"request_id":"${REQUEST_ID}"}`;

test("a key refused with 401 or 402 hands off and keeps class auth", () => {
  for (const status of [401, 402]) {
    const { outputs, records } = runCase({ key: authLeg({ status }) });
    assert.equal(outputs["lane-class"], "auth", String(status));
    assert.equal(outputs.handoff, "true", String(status));
    assert.equal(records[0].next, "subscription", String(status));
  }
});

test("a 403 does not hand off and records its error type, code and request id", () => {
  const { outputs, records } = runCase({
    key: authLeg({ status: 403, text: PERMISSION_TEXT }),
  });
  assert.equal(outputs["lane-class"], "auth");
  assert.equal(outputs.handoff, "false");
  const [record] = records;
  assert.equal(record.next, null);
  assert.deepEqual(
    [
      record.api_error_status,
      record.error_type,
      record.error_code,
      record.request_id,
    ],
    [403, "permission_error", "workspace_access_denied", REQUEST_ID],
  );
});

test("a 403 with credit-stop text and SDK error is not a credit stop and does not hand off", () => {
  for (const error of ["billing_error", "invalid_request"]) {
    const { outputs, records } = runCase({
      key: [
        {
          type: "assistant",
          error,
          api_error_status: 403,
          message: {
            content: [{ type: "text", text: "Your credit balance is too low" }],
          },
        },
        ...authLeg({
          status: 403,
          text: `Your credit balance is too low. ${PERMISSION_TEXT}`,
        }),
      ],
    });
    assert.equal(outputs["lane-class"], "auth", error);
    assert.equal(outputs.handoff, "false", error);
    assert.equal(records[0].next, null, error);
    assert.deepEqual(
      [records[0].api_error_status, records[0].error_type, records[0].request_id],
      [403, "permission_error", REQUEST_ID],
      error,
    );
  }
});

test("a 403 with model output records no error facts from its text", () => {
  const { records } = runCase({
    key: authLeg({ status: 403, text: PERMISSION_TEXT, outputTokens: 5 }),
  });
  assert.deepEqual(
    [records[0].error_type, records[0].error_code, records[0].request_id],
    [null, null, null],
  );
});

test("a 403 whose errors[] text names authentication_error still does not hand off", () => {
  const { outputs } = runCase({
    key: authLeg({
      status: 403,
      errors: ['{"type":"error","error":{"type":"authentication_error"}}'],
    }),
  });
  assert.equal(outputs["lane-class"], "auth");
  assert.equal(outputs.handoff, "false");
});

test("a 401 whose errors[] text names another type still hands off by its status", () => {
  const { outputs } = runCase({
    key: authLeg({
      status: 401,
      errors: ['{"type":"error","error":{"type":"permission_error"}}'],
    }),
  });
  assert.equal(outputs["lane-class"], "auth");
  assert.equal(outputs.handoff, "true");
});

test("permission_error in errors[] text alone, with no numeric status, does not hand off", () => {
  const { outputs, records } = runCase({
    key: authLeg({
      errors: [
        'model text: {"type":"error","error":{"type":"permission_error"}}',
      ],
    }),
  });
  assert.equal(outputs["lane-class"], "auth");
  assert.equal(outputs.handoff, "false");
  assert.equal(records[0].next, null);
});

test("a rejected subscription token, the last leg, hands off nothing", () => {
  const { outputs, records } = runCase({ sub: AUTH });
  assert.equal(outputs["lane-class"], "auth");
  assert.equal(outputs.handoff, "false");
  assert.equal(records[0].next, null);
});

test("a key leg hands off on no other failure class", () => {
  for (const [name, key, extra] of [
    ["max-turns", MAX_TURNS, {}],
    ["rate-limit", SESSION_LIMIT, {}],
    ["timeout", SUCCESS, { keySleep: true, legTimeoutMs: 300 }],
  ]) {
    const { outputs, records } = runCase({ key, ...extra });
    assert.equal(outputs["lane-class"], name, name);
    assert.equal(outputs.handoff, "false", name);
    assert.equal(records[0].next, null, name);
  }
});

test("a key leg's handoff names its reason: credit-stop or auth", () => {
  assert.equal(runCase({ key: CREDIT_STOP }).outputs["handoff-reason"], "credit-stop");
  assert.equal(runCase({ key: AUTH }).outputs["handoff-reason"], "auth");
  assert.equal(runCase({ key: SESSION_LIMIT }).outputs["handoff-reason"], "");
});

// A 429 with no rejected rate_limit_event: a throttle, not a usage limit.
const THROTTLE = SESSION_LIMIT.filter((m) => m.type !== "rate_limit_event");
const WARNED_THROTTLE = [
  {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed_warning", resetsAt: 1767225600, rateLimitType: "five_hour" },
  },
  ...THROTTLE,
];

test("with a fallback ready, a subscription leg hands off on a limit stop, a credit stop or a 401 or 402", () => {
  for (const [name, sub, reason, laneClass] of [
    ["limit stop", SESSION_LIMIT, "limit-stop", "rate-limit"],
    ["credit stop", CREDIT_STOP, "credit-stop", "other"],
    ["401", authLeg({ status: 401 }), "auth", "auth"],
    ["402", authLeg({ status: 402 }), "auth", "auth"],
  ]) {
    const { outputs, records } = runCase({ sub, fallbackReady: true });
    assert.equal(outputs.handoff, "true", name);
    assert.equal(outputs["handoff-reason"], reason, name);
    assert.equal(outputs["lane-class"], laneClass, name);
    assert.equal(outputs.credential, TOKEN_NAME, name);
    assert.equal(records[0].next, "fallback", name);
  }
});

test("with a fallback ready, a subscription leg hands off on no other stop", () => {
  for (const [name, sub, extra] of [
    ["403", authLeg({ status: 403, text: PERMISSION_TEXT }), {}],
    ["throttle", THROTTLE, {}],
    ["warning only", WARNED_THROTTLE, {}],
    ["max-turns", MAX_TURNS, {}],
    ["success", SUCCESS, {}],
  ]) {
    const { outputs, records } = runCase({ sub, fallbackReady: true, ...extra });
    assert.equal(outputs.handoff, "false", name);
    assert.equal(outputs["handoff-reason"], "", name);
    assert.equal(records[0].next, null, name);
  }
});

test("a key leg hands off only to the subscription job, fallback ready or not", () => {
  for (const [name, key, reason] of [
    ["limit stop", SESSION_LIMIT, ""],
    ["credit stop", CREDIT_STOP, "credit-stop"],
    ["401", AUTH, "auth"],
  ]) {
    const { outputs, records } = runCase({ key, fallbackReady: true });
    assert.equal(outputs["handoff-reason"], reason, name);
    assert.equal(records[0].next, reason === "" ? null : "subscription", name);
  }
});

test("with no fallback ready, a subscription leg stops as before", () => {
  for (const [name, sub, laneClass] of [
    ["limit stop", SESSION_LIMIT, "rate-limit"],
    ["credit stop", CREDIT_STOP, "other"],
    ["401", AUTH, "auth"],
  ]) {
    const { outputs, records } = runCase({ sub });
    assert.equal(outputs.handoff, "false", name);
    assert.equal(outputs["handoff-reason"], "", name);
    assert.equal(outputs["lane-class"], laneClass, name);
    assert.equal(records[0].next, null, name);
  }
});

test("the fallback leg runs on the fallback secret and never hands off", () => {
  for (const fallback of [SESSION_LIMIT, AUTH, CREDIT_STOP]) {
    const { outputs, records, calls } = runCase({ fallback, fallbackReady: true });
    assert.deepEqual(calls.map((c) => c.seen), [["CLAUDE_CODE_OAUTH_TOKEN"]]);
    assert.equal(outputs.handoff, "false");
    assert.equal(outputs["handoff-reason"], "");
    assert.equal(outputs.credential, FALLBACK_NAME);
    assert.deepEqual(
      [records[0].credential, records[0].secret, records[0].next],
      ["fallback", FALLBACK_NAME, null],
    );
  }
  assert.equal(runCase({ fallback: SUCCESS }).outputs["lane-class"], "");
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
    handoff: "false",
    "lane-resets": "",
    "lane-turns": "3",
    "lane-models": "claude-sonnet-5",
    credential: KEY_NAME,
    "handoff-reason": "",
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
  const fallback = legEnv(
    { LANE_FALLBACK_TOKEN: FALLBACK_TOKEN, LANE_SUBSCRIPTION_TOKEN: TOKEN },
    { leg: "fallback", value: FALLBACK_TOKEN },
    config,
  );
  assert.equal(fallback.CLAUDE_CODE_OAUTH_TOKEN, FALLBACK_TOKEN);
  assert.equal("LANE_FALLBACK_TOKEN" in fallback, false);
  assert.equal("LANE_SUBSCRIPTION_TOKEN" in fallback, false);
  assert.equal("ANTHROPIC_API_KEY" in fallback, false);
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
          // A leg that got its write bit back before the restore failed.
          fs.chmodSync(output, 0o644);
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

test("a same-size rewrite of a step file is put back byte for byte", () => {
  let output;
  const original = "cli-version=2.1.302\n";
  const forged = "lane-class=credit-s\n";
  assert.equal(forged.length, original.length);
  runCase({
    key: SUCCESS,
    prepare: (dir) => {
      output = path.join(dir, "output");
      fs.writeFileSync(output, original);
      return { GITHUB_OUTPUT: output };
    },
    spawn: () => {
      fs.chmodSync(output, 0o644);
      fs.writeFileSync(output, forged);
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from(SUCCESS.map((m) => JSON.stringify(m)).join("\n")),
      };
    },
  });
  assert.equal(fs.readFileSync(output, "utf8"), original);
});

test("a process the leg leaves behind cannot add a lane-class after the launcher writes its own", withBwrap, () => {
  const dir = path.join(root, "run-straggler");
  const env = runEnv(dir, {});
  fs.writeFileSync(env.GITHUB_OUTPUT, "");
  env.FAKE_KEY = legFile(dir, "key.jsonl", SUCCESS);
  env.FAKE_KEY_EXIT = "0";
  env.FAKE_STRAGGLE = env.GITHUB_OUTPUT;
  env.FAKE_STRAGGLE_DONE = path.join(dir, "straggler-done");
  run(env);
  // The straggler waits 1.5 seconds after the leg starts, then tries.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  assert.equal(fs.readFileSync(env.FAKE_STRAGGLE_DONE, "utf8"), "EROFS");
  const lines = fs.readFileSync(env.GITHUB_OUTPUT, "utf8").trim().split("\n");
  assert.deepEqual(
    lines.filter((line) => line.startsWith("lane-class=")),
    ["lane-class="],
  );
  assert.equal(lines.at(-1), "structured-output-file=");
});

test("stdout is captured in memory and a maxBuffer overflow is class other", () => {
  const seen = [];
  const spawn = (_command, _args, options) => {
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
    "api_error_status",
    "error_type",
    "error_code",
    "request_id",
    "message",
    "resets",
    "usage",
    "rate_limits",
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

test("the action's cli-version default resolves the newest release from npm view", () => {
  const { parseWorkflow } = require("../../scripts/workflow-yaml.cjs");
  const action = parseWorkflow(
    fs.readFileSync(path.join(__dirname, "action.yml"), "utf8"),
  );
  let viewed = 0;
  const version = resolveCliVersion(action.inputs["cli-version"].default, () => {
    viewed += 1;
    return "2.1.999\n";
  });
  assert.equal(version, "2.1.999");
  assert.equal(viewed, 1);
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
      /^2 credentials: set exactly one/u.test(error.message),
  );
  assert.throws(
    () => readConfig(configEnv({ LANE_API_KEY: "" })),
    (error) =>
      error instanceof LaneError &&
      /^no credential: set exactly one/u.test(error.message),
  );
});

test("readConfig takes the fallback token under its fixed name, one credential of three, and a closed fallback-ready", () => {
  const fallback = readConfig(
    configEnv({ LANE_ROLE: "issue-lane", LANE_API_KEY: "", LANE_FALLBACK_TOKEN: FALLBACK_TOKEN }),
  );
  assert.deepEqual(fallback.leg, { leg: "fallback", name: FALLBACK_NAME, value: FALLBACK_TOKEN });
  for (const [overrides, count] of [
    [{ LANE_FALLBACK_TOKEN: FALLBACK_TOKEN }, 2],
    [{ LANE_API_KEY: "", LANE_SUBSCRIPTION_TOKEN: TOKEN, LANE_FALLBACK_TOKEN: FALLBACK_TOKEN }, 2],
    [{ LANE_SUBSCRIPTION_TOKEN: TOKEN, LANE_FALLBACK_TOKEN: FALLBACK_TOKEN }, 3],
  ]) {
    assert.throws(
      () => readConfig(configEnv(overrides)),
      (error) =>
        error instanceof LaneError &&
        error.message.startsWith(`${count} credentials: set exactly one`),
    );
  }
  assert.equal(readConfig(configEnv()).fallbackReady, false);
  assert.equal(readConfig(configEnv({ LANE_FALLBACK_READY: "false" })).fallbackReady, false);
  assert.equal(readConfig(configEnv({ LANE_FALLBACK_READY: "true" })).fallbackReady, true);
  for (const value of ["True", "1", "yes"]) {
    assert.throws(
      () => readConfig(configEnv({ LANE_FALLBACK_READY: value })),
      (error) => error instanceof LaneError && /fallback-ready/u.test(error.message),
      JSON.stringify(value),
    );
  }
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
    /\| 1 \| AUTOMATIONS_CLAUDE_API_KEY \| credit-stop \| .* \| subscription \| credits used up: the subscription job runs; the owner rotates a key by hand when needed \|/u,
  );
  assert.equal(summaryText.includes("Credit balance"), false);
  assert.equal(readOutputs(env.GITHUB_OUTPUT).handoff, "true");
});

test("run on a rejected key sets handoff and a summary row that names the dead key", () => {
  const dir = path.join(root, "run-auth");
  const env = runEnv(dir, {});
  env.FAKE_KEY = legFile(dir, "key.jsonl", AUTH);
  env.FAKE_KEY_EXIT = "1";
  assert.throws(
    () => run(env),
    /intake ended class=auth on AUTOMATIONS_CLAUDE_API_KEY/u,
  );
  const outputs = readOutputs(env.GITHUB_OUTPUT);
  assert.equal(outputs["lane-class"], "auth");
  assert.equal(outputs.handoff, "true");
  const summaryText = fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(
    summaryText,
    /\| 1 \| AUTOMATIONS_CLAUDE_API_KEY \| auth \| .* \| subscription \| credential unusable: 401 or 402 hands off to the subscription job, 403 \(permission\) stops the run; the owner fixes the key by hand \|/u,
  );
  const [record] = fs
    .readFileSync(outputs["log-file"], "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual([record.class, record.next], ["auth", "subscription"]);
});

test("run on a 403 key stops with no handoff and names the error in the log, summary and record", () => {
  const dir = path.join(root, "run-permission");
  const env = runEnv(dir, {});
  env.FAKE_KEY = legFile(
    dir,
    "key.jsonl",
    authLeg({ status: 403, text: PERMISSION_TEXT }),
  );
  env.FAKE_KEY_EXIT = "1";
  const facts = `api_error_status=403 error_type=permission_error error_code=workspace_access_denied request_id=${REQUEST_ID}`;
  assert.throws(
    () => run(env),
    (error) =>
      error.message ===
      `intake ended class=auth on AUTOMATIONS_CLAUDE_API_KEY ${facts}`,
  );
  const outputs = readOutputs(env.GITHUB_OUTPUT);
  assert.equal(outputs["lane-class"], "auth");
  assert.equal(outputs.handoff, "false");
  const summaryText = fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
  assert.equal(summaryText.includes(`| auth | ${facts} |`), true);
  assert.equal(summaryText.includes("not permitted"), false);
  const [record] = fs
    .readFileSync(outputs["log-file"], "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    [record.class, record.next, record.request_id],
    ["auth", null, REQUEST_ID],
  );
});

function structuredRun(name, messages, exit, overrides = {}) {
  const dir = path.join(root, name);
  const schema = path.join(root, `${name}-schema.json`);
  fs.writeFileSync(schema, '{"type":"object"}');
  const env = runEnv(dir, { LANE_JSON_SCHEMA_FILE: schema, ...overrides });
  env.FAKE_KEY = legFile(dir, "key.jsonl", messages);
  env.FAKE_KEY_EXIT = String(exit);
  return env;
}

const FINDINGS = { findings: 2, summary: "Two findings.", comments: [] };

test("a successful leg with json-schema-file writes the structured output to its own file", () => {
  const env = structuredRun(
    "run-structured",
    [
      { type: "system", subtype: "init" },
      result({ structured_output: FINDINGS }),
    ],
    0,
  );
  run(env);
  const outputs = readOutputs(env.GITHUB_OUTPUT);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(outputs["structured-output-file"], "utf8")),
    FINDINGS,
  );
  assert.notEqual(outputs["log-file"], "");
});

test("no structured-output-file without json-schema-file, on a failed leg, or with no object", () => {
  const maxTurns = result({
    subtype: "error_max_turns",
    is_error: true,
    structured_output: FINDINGS,
  });
  for (const [name, messages, exit, overrides] of [
    [
      "run-structured-no-schema",
      [result({ structured_output: FINDINGS })],
      0,
      { LANE_JSON_SCHEMA_FILE: "" },
    ],
    ["run-structured-max-turns", [maxTurns], 1, {}],
    [
      "run-structured-string",
      [result({ structured_output: "not an object" })],
      0,
      {},
    ],
  ]) {
    const env = structuredRun(name, messages, exit, overrides);
    try {
      run(env);
    } catch (error) {
      assert.equal(name, "run-structured-max-turns", error.message);
    }
    const outputs = readOutputs(env.GITHUB_OUTPUT);
    assert.equal(outputs["structured-output-file"], "", name);
    assert.equal(
      fs.existsSync(path.join(env.LANE_WORK_DIR, "structured-output.json")),
      false,
      name,
    );
  }
});

test("a structured output holding the credential or a key shape is not written and fails the step", () => {
  for (const planted of [KEY, "sk-ant-api03-abcdefghijkl"]) {
    const env = structuredRun(
      `run-structured-leak-${planted.length}`,
      [
        result({
          structured_output: { ...FINDINGS, summary: `see ${planted}` },
        }),
      ],
      0,
    );
    assert.throws(
      () => run(env),
      /the structured output held a credential and was not written/u,
    );
    const outputs = readOutputs(env.GITHUB_OUTPUT);
    assert.equal(outputs["structured-output-file"], "");
    assert.equal(
      fs.existsSync(path.join(env.LANE_WORK_DIR, "structured-output.json")),
      false,
    );
    assert.notEqual(outputs["log-file"], "");
  }
});

test("run refuses both credentials before any leg starts", () => {
  const dir = path.join(root, "run-two-credentials");
  const env = runEnv(dir, { LANE_SUBSCRIPTION_TOKEN: TOKEN });
  env.FAKE_KEY = legFile(dir, "key.jsonl", SUCCESS);
  env.FAKE_SUB = legFile(dir, "sub.jsonl", SUCCESS);
  assert.throws(() => run(env), /2 credentials/u);
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
  const classes = [
    "",
    "credit-stop",
    "auth",
    "rate-limit",
    "timeout",
    "max-turns",
    "overloaded",
    "other",
    "unknown",
    "constructor",
  ];
  const table = summaryTable(classes.map(record));
  assert.equal(table.includes("planted"), false);
  assert.match(table, /\| success \|  \| 0 \| 0 \|  \|  \|  \|$/mu);
  assert.match(
    table,
    /\| auth \| .* \| credential unusable: 401 or 402 hands off to the subscription job, 403 \(permission\) stops the run; the owner fixes the key by hand \|/u,
  );
  assert.match(table, /\| unknown \| .* \| see the step log \|/u);
  assert.match(table, /\| constructor \| .* \| see the step log \|/u);
  // No note tells the owner to raise a spend limit: the owner runs none.
  assert.doesNotMatch(table, /spend limit/iu);
});

test("a handoff to the fallback job says the fallback job runs instead, whatever the class", () => {
  const record = (failureClass, next) => ({
    leg: 1,
    secret: TOKEN_NAME,
    class: failureClass,
    num_turns: 0,
    denials: { count: 0 },
    resets: null,
    next,
  });
  // A subscription credit stop keeps class other; only the reason names it.
  for (const [failureClass, reason, note] of [
    ["auth", "auth", "credential refused: the fallback job runs instead; the owner replaces the secret"],
    ["other", "credit-stop", "credits used up: the fallback job runs instead"],
    ["rate-limit", "limit-stop", "limit stop: the fallback job runs instead"],
  ]) {
    const table = summaryTable([record(failureClass, "fallback")], reason);
    assert.match(table, new RegExp(`\\| fallback \\| ${note} \\|$`, "mu"), reason);
  }
  // With no handoff to the fallback job the class note stands.
  assert.match(
    summaryTable([record("rate-limit", null)], ""),
    /\| rate-limit \| .* \| limit stop: rerun after the reset \|$/mu,
  );
  assert.match(
    summaryTable([record("auth", "subscription")], "auth"),
    /\| subscription \| credential unusable: 401 or 402 hands off to the subscription job/u,
  );
});

test("run on a refused subscription token with a fallback ready warns the owner once, after the stop-commands block", () => {
  const dir = path.join(root, "run-fallback-auth");
  const env = runEnv(dir, {
    LANE_API_KEY: "",
    LANE_SUBSCRIPTION_TOKEN: TOKEN,
    LANE_FALLBACK_READY: "true",
  });
  env.FAKE_SUB = legFile(dir, "sub.jsonl", AUTH);
  env.FAKE_SUB_EXIT = "1";
  const lines = captureStdout(() => run(env));
  const opened = lines.findIndex((l) => l.startsWith("::stop-commands::"));
  const closed = lines.indexOf(`::${lines[opened].slice("::stop-commands::".length)}::`);
  const warnings = lines
    .map((l, i) => [l, i])
    .filter(([l]) => l.startsWith("::warning") && l.includes("class=auth"));
  assert.deepEqual(
    warnings.map(([l]) => l),
    [
      "::warning title=run-claude-cli credential::class=auth: the API refused AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN; the owner must replace the secret. The fallback job runs instead.",
    ],
  );
  assert.ok(warnings[0][1] > closed);
  assert.equal(readOutputs(env.GITHUB_OUTPUT)["handoff-reason"], "auth");
  assert.match(
    fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"),
    /\| fallback \| credential refused: the fallback job runs instead; the owner replaces the secret \|/u,
  );
});

test("no refused-credential warning without an auth handoff to the fallback job", () => {
  for (const [name, overrides, leg, messages] of [
    ["key auth", {}, "KEY", AUTH],
    ["no fallback", { LANE_API_KEY: "", LANE_SUBSCRIPTION_TOKEN: TOKEN }, "SUB", AUTH],
    [
      "limit stop",
      { LANE_API_KEY: "", LANE_SUBSCRIPTION_TOKEN: TOKEN, LANE_FALLBACK_READY: "true" },
      "SUB",
      SESSION_LIMIT,
    ],
  ]) {
    const dir = path.join(root, `run-no-auth-warning-${name.replace(" ", "-")}`);
    const env = runEnv(dir, overrides);
    env[`FAKE_${leg}`] = legFile(dir, "leg.jsonl", messages);
    env[`FAKE_${leg}_EXIT`] = "1";
    const lines = captureStdout(() => run(env));
    assert.equal(lines.some((l) => l.includes("run-claude-cli credential")), false, name);
  }
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
    /cannot create a PID namespace.*Docker's default seccomp profile.*apparmor_restrict_unprivileged_userns=0/u,
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

// A stub npm, curl, gpg and CLI for install(). The npm install writes the
// tree the real one leaves; each option breaks one piece of it.
const NATIVE = "native claude binary\n";
const sha256 = (text) =>
  require("node:crypto").createHash("sha256").update(text).digest("hex");
const AUDIT_OK =
  "audited 2 packages in 1s\n\n2 packages have verified registry signatures\n\n";
const GPG_OK = [
  "[GNUPG:] NEWSIG",
  `[GNUPG:] GOODSIG BAA929FF1A7ECACE Anthropic Claude Code Release Signing <security@anthropic.com>`,
  `[GNUPG:] VALIDSIG ${SIGNING_KEY_FINGERPRINT} 2026-10-19 1792434757 0 4 0 1 10 00 ${SIGNING_KEY_FINGERPRINT}`,
  "",
].join("\n");

let installCount = 0;
function installWorld(options = {}) {
  const {
    input = "2.1.400",
    installed = NATIVE,
    manifest = (version) => ({
      version,
      platforms: {
        "linux-x64": { binary: "claude", checksum: sha256(NATIVE) },
      },
    }),
    gpgVerify = { status: 0, stdout: GPG_OK },
    audit = { status: 0, stdout: AUDIT_OK },
    cliVersion = { status: 0, stdout: "2.1.400 (Claude Code)\n" },
    extraPackage = false,
    missing = [],
  } = options;
  installCount += 1;
  const dir = path.join(root, `install-${installCount}`);
  fs.mkdirSync(dir);
  const output = path.join(dir, "output");
  const calls = [];
  const spawn = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    if (missing.includes(command)) {
      return {
        status: null,
        error: Object.assign(new Error("spawn"), { code: "ENOENT" }),
      };
    }
    if (command === "npm" && args[0] === "--version")
      return { status: 0, stdout: "10.9.9\n" };
    if (command === "npm" && args[0] === "view")
      return { status: 0, stdout: "2.1.400\n" };
    if (command === "npm" && args[0] === "install") {
      const modules = path.join(
        args[args.indexOf("--prefix") + 1],
        "node_modules",
      );
      const version = args.at(-1).split("@").at(-1);
      for (const name of [
        "claude-code",
        "claude-code-linux-x64",
        ...(extraPackage ? ["other"] : []),
      ]) {
        const pkg = path.join(modules, "@anthropic-ai", name);
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(
          path.join(pkg, "package.json"),
          JSON.stringify({ version }),
        );
      }
      const bin = path.join(modules, "@anthropic-ai", "claude-code", "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "claude.exe"), installed, {
        mode: 0o755,
      });
      fs.mkdirSync(path.join(modules, ".bin"));
      fs.symlinkSync(
        "../@anthropic-ai/claude-code/bin/claude.exe",
        path.join(modules, ".bin", "claude"),
      );
      return { status: 0 };
    }
    if (command === "npm" && args[0] === "audit") return audit;
    if (command === "curl") {
      const file = args[args.indexOf("-o") + 1];
      const url = args.at(-1);
      const version = url.split("/").at(-2);
      const body = url.endsWith("manifest.json")
        ? JSON.stringify(manifest(version))
        : "data";
      fs.writeFileSync(file, body);
      return { status: 0 };
    }
    if (command === "gpg" && args.includes("--import")) return { status: 0 };
    if (command === "gpg" && args.includes("--verify")) return gpgVerify;
    if (command.endsWith("/.bin/claude")) return cliVersion;
    throw new Error(`unexpected spawn ${command} ${args.join(" ")}`);
  };
  const env = {
    LANE_CLI_VERSION_INPUT: input,
    LANE_WORK_DIR: dir,
    GITHUB_OUTPUT: output,
  };
  return {
    dir,
    calls,
    output,
    run: () => install(env, { spawn, platform: "linux-x64" }),
  };
}

test("install verifies both packages and the signed binary, then writes the outputs", () => {
  const world = installWorld({ input: "latest" });
  world.run();
  const npm = world.calls.filter((c) => c.command === "npm");
  assert.deepEqual(
    npm.map((c) => c.args[0]),
    ["--version", "view", "install", "audit"],
  );
  for (const call of world.calls)
    assert.equal(call.cwd.startsWith(world.dir), true);
  for (const call of npm.slice(1)) {
    assert.ok(call.args.includes(`--registry=${NPM_REGISTRY}`), call.args[0]);
  }
  const installArgs = npm[2].args;
  assert.ok(installArgs.includes("--save-exact"));
  assert.ok(!installArgs.includes("--no-save"));
  assert.ok(!installArgs.includes("--ignore-scripts"));
  const audit = npm[3].args;
  assert.deepEqual(audit.slice(0, 2), ["audit", "signatures"]);
  assert.equal(
    audit[audit.indexOf("--prefix") + 1],
    installArgs[installArgs.indexOf("--prefix") + 1],
  );
  assert.equal(NPM_REGISTRY, "https://registry.npmjs.org/");
  assert.deepEqual(
    world.calls.filter((c) => c.command === "curl").map((c) => c.args.at(-1)),
    [
      "https://downloads.claude.ai/keys/claude-code.asc",
      "https://downloads.claude.ai/claude-code-releases/2.1.400/manifest.json",
      "https://downloads.claude.ai/claude-code-releases/2.1.400/manifest.json.sig",
    ],
  );
  assert.equal(
    SIGNING_KEY_FINGERPRINT,
    "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE",
  );
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(world.dir, "cli", "package.json"), "utf8"),
    ),
    { allowScripts: { "@anthropic-ai/claude-code@2.1.400": true } },
  );
  const cliPath = path.join(world.dir, "cli", "node_modules", ".bin", "claude");
  assert.deepEqual(world.calls.at(-1), {
    command: cliPath,
    args: ["--version"],
    cwd: world.dir,
  });
  const out = fs.readFileSync(world.output, "utf8");
  assert.match(out, /^cli-version=2\.1\.400$/mu);
  assert.ok(out.includes(`cli-path=${cliPath}\n`));
});

test("install with an exact cli-version installs that version and asks npm view nothing", () => {
  const world = installWorld({ input: "2.1.305" });
  world.run();
  const npm = world.calls.filter((c) => c.command === "npm");
  assert.deepEqual(
    npm.map((c) => c.args[0]),
    ["--version", "install", "audit"],
  );
  assert.equal(npm[1].args.at(-1), "@anthropic-ai/claude-code@2.1.305");
  assert.ok(
    world.calls.some(
      (c) =>
        c.command === "curl" &&
        c.args.at(-1) ===
          "https://downloads.claude.ai/claude-code-releases/2.1.305/manifest.json",
    ),
  );
  assert.match(fs.readFileSync(world.output, "utf8"), /^cli-version=2\.1\.305$/mu);
});

// Each case fails the install step, so no output is written and the run step,
// which runs the leg, never starts.
for (const [name, options, pattern] of [
  [
    "a tampered binary",
    { installed: "tampered\n" },
    /does not match the signed 2\.1\.400 manifest/u,
  ],
  [
    "the postinstall's stub left in place",
    { installed: "#!/bin/sh\nexit 1\n" },
    /does not match/u,
  ],
  [
    "a bad manifest signature",
    {
      gpgVerify: { status: 1, stdout: "[GNUPG:] BADSIG BAA929FF1A7ECACE x\n" },
    },
    /gpg --verify of the release manifest failed/u,
  ],
  [
    "a good signature from another key",
    {
      gpgVerify: {
        status: 0,
        stdout: GPG_OK.replaceAll(SIGNING_KEY_FINGERPRINT, "A".repeat(40)),
      },
    },
    /not signed by key/u,
  ],
  [
    "a manifest with no linux-x64 entry",
    {
      manifest: (version) => ({
        version,
        platforms: { "darwin-arm64": { checksum: sha256(NATIVE) } },
      }),
    },
    /no linux-x64 checksum/u,
  ],
  [
    "a signed manifest for another version",
    {
      manifest: () => ({
        version: "2.1.399",
        platforms: { "linux-x64": { checksum: sha256(NATIVE) } },
      }),
    },
    /for "2\.1\.399", not 2\.1\.400/u,
  ],
  [
    "an audit that verified one package, exit 0",
    {
      audit: {
        status: 0,
        stdout:
          "audited 1 package in 0s\n\n1 package has a verified registry signature\n",
      },
    },
    /did not verify both/u,
  ],
  [
    "an audit that verified no signature, exit 0",
    { audit: { status: 0, stdout: "audited 2 packages in 0s\n\n" } },
    /did not verify both/u,
  ],
  [
    "an audit that exits non-zero",
    {
      audit: {
        status: 1,
        stdout:
          "audited 2 packages in 0s\n\n2 packages have verified registry signatures\n",
      },
    },
    /npm audit signatures failed \(exit 1\)/u,
  ],
  ["a third installed package", { extraPackage: true }, /not exactly/u],
  [
    "a CLI whose --version fails",
    { cliVersion: { status: 1, stdout: "" } },
    /--version failed/u,
  ],
  [
    "no gpg on the runner",
    { missing: ["gpg"] },
    /gpg --import failed \(ENOENT\)/u,
  ],
  [
    "no curl on the runner",
    { missing: ["curl"] },
    /download .* failed \(ENOENT\)/u,
  ],
]) {
  test(`install fails closed on ${name}`, () => {
    const world = installWorld(options);
    assert.throws(
      world.run,
      (error) => error instanceof LaneError && pattern.test(error.message),
    );
    assert.equal(fs.existsSync(world.output), false);
  });
}

// Subscription headroom (code.claude.com/docs/en/agent-sdk/typescript.md,
// SDKRateLimitEvent; python.md, RateLimitInfo).
const { usageWarning } = require("./lane.cjs");

const limitEvent = (status, rateLimitType, utilization, resetsAt = 1767225600) => ({
  type: "rate_limit_event",
  rate_limit_info: { status, resetsAt, rateLimitType, utilization },
});

const WARNED = [
  { type: "system", subtype: "init" },
  limitEvent("allowed", "five_hour", 0.61),
  limitEvent("allowed_warning", "five_hour", 0.8249),
  limitEvent("allowed", "seven_day", 0.3, 1767830400),
  result({
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 2_500_000,
      cache_creation_input_tokens: 400,
    },
  }),
];

test("the log records each window's max utilization, reset and last status, and the leg's tokens", () => {
  const [record] = runCase({ sub: WARNED }).records;
  assert.deepEqual(record.rate_limits, {
    five_hour: { utilization: 0.82, resets_at: "2026-01-01T00:00:00Z", status: "allowed_warning" },
    seven_day: { utilization: 0.3, resets_at: "2026-01-08T00:00:00Z", status: "allowed" },
  });
  assert.deepEqual(record.usage, {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 2_500_000,
    cache_creation_input_tokens: 400,
  });
  assert.deepEqual(runCase({ key: SUCCESS }).records[0].rate_limits, {});
});

test("usageWarning names the secret and every window at a warning or at 0.70 or more", () => {
  const record = (rateLimits) => ({ secret: TOKEN_NAME, rate_limits: rateLimits });
  const at = "2026-01-01T00:00:00Z";
  assert.equal(
    usageWarning(
      record({
        five_hour: { utilization: 0.5, resets_at: at, status: "allowed_warning" },
        seven_day: { utilization: 0.7, resets_at: "2026-01-08T00:00:00Z", status: "allowed" },
        seven_day_opus: { utilization: 0.69, resets_at: at, status: "allowed" },
        overage: { utilization: null, resets_at: null, status: "rejected" },
      }),
    ),
    "::warning title=run-claude-cli usage::AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN is near a subscription usage limit: " +
      "window=five_hour utilization=0.5 status=allowed_warning resets=2026-01-01T00:00:00Z; " +
      "window=seven_day utilization=0.7 status=allowed resets=2026-01-08T00:00:00Z; " +
      "window=overage status=rejected",
  );
  assert.equal(
    usageWarning(record({ five_hour: { utilization: 0.69, resets_at: at, status: "allowed" } })),
    null,
  );
  assert.equal(usageWarning(record({})), null);
});

function captureStdout(action) {
  const written = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    action();
  } catch {
    // A lane class throws; the lines before it are what is checked.
  } finally {
    process.stdout.write = write;
  }
  return written.join("").split("\n");
}

test("run writes one usage warning after the stop-commands block ends, on a stop too", () => {
  for (const [name, messages, exit] of [
    ["run-warned", WARNED, "0"],
    ["run-warned-stop", [limitEvent("allowed_warning", "five_hour", 0.9), ...SESSION_LIMIT], "1"],
  ]) {
    const dir = path.join(root, name);
    const env = runEnv(dir, { LANE_API_KEY: "", LANE_SUBSCRIPTION_TOKEN: TOKEN });
    env.FAKE_SUB = legFile(dir, "sub.jsonl", messages);
    env.FAKE_SUB_EXIT = exit;
    const lines = captureStdout(() => run(env));
    const opened = lines.findIndex((l) => l.startsWith("::stop-commands::"));
    const token = lines[opened].slice("::stop-commands::".length);
    const closed = lines.indexOf(`::${token}::`);
    const warnings = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith("::warning title=run-claude-cli usage::"));
    assert.equal(warnings.length, 1, name);
    assert.ok(closed > opened && warnings[0][1] > closed, name);
    assert.match(warnings[0][0], /AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN .* window=five_hour /u, name);
    assert.equal(holdsCredential(warnings[0][0], [TOKEN]), false);
  }
});

test("a rejected window below 0.70 still gets the warning line", () => {
  assert.equal(
    usageWarning({
      secret: TOKEN_NAME,
      rate_limits: {
        seven_day: { utilization: 0.5, resets_at: "2026-01-08T00:00:00Z", status: "rejected" },
      },
    }),
    "::warning title=run-claude-cli usage::AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN is near a subscription usage limit: " +
      "window=seven_day utilization=0.5 status=rejected resets=2026-01-08T00:00:00Z",
  );
});
