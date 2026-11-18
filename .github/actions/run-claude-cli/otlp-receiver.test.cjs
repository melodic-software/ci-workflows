// The opt-in telemetry receiver: on its own, and through a leg run against a
// fake `claude` that exports to the endpoint it is given. OTLP shapes follow
// https://opentelemetry.io/docs/specs/otlp/#otlphttp.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  makeTemporaryDirectory,
} = require("../../scripts/temporary-directories.cjs");
const { legEnv, readConfig, runLeg } = require("./lane.cjs");
const {
  HOST,
  MAX_TELEMETRY_BYTES,
  startOtlpReceiver,
} = require("./otlp-receiver.cjs");

const KEY = "key-value-for-tests-1234";
const MARKER = "telemetry-marker-5f1c";
const TRACE_ID = "33284f6935ab289df17507682acc6c66";
const SPAN_ID = "f2dbb4000de882fa";
const PARENT_ID = "0123456789abcdef";
const SPANS = JSON.stringify({
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            {
              traceId: TRACE_ID,
              spanId: SPAN_ID,
              parentSpanId: PARENT_ID,
              name: MARKER,
            },
          ],
        },
      ],
    },
  ],
});
const LOGS = JSON.stringify({
  resourceLogs: [{ scopeLogs: [{ logRecords: [{ traceId: TRACE_ID }] }] }],
});

const root = makeTemporaryDirectory("otlp-receiver-");
const fakeCli = path.join(root, "claude");
fs.writeFileSync(
  fakeCli,
  `#!/usr/bin/env node
const fs = require("node:fs");
(async () => {
  fs.readFileSync(0);
  fs.writeFileSync(process.env.FAKE_ENV, JSON.stringify(process.env));
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint !== undefined && process.env.FAKE_BODY !== undefined) {
    await fetch(endpoint + "/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: process.env.FAKE_BODY,
    });
  }
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: process.env.FAKE_EXIT === "1",
    num_turns: 1, usage: {}, modelUsage: {}, permission_denials: [],
  }) + "\\n");
  if (process.env.FAKE_HANG) await new Promise((done) => setTimeout(done, 5000));
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
})();
`,
);
fs.chmodSync(fakeCli, 0o755);

let caseNumber = 0;

function post(endpoint, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${endpoint}${urlPath}`,
      {
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            type: response.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

// True once nothing listens on the endpoint's port.
function refused(endpoint) {
  const { hostname, port } = new URL(endpoint);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), hostname);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED"));
  });
}

function legCase({ otelReceiver, extraEnv = {}, legTimeoutMs = 0 } = {}) {
  caseNumber += 1;
  const dir = path.join(root, `case-${caseNumber}`);
  fs.mkdirSync(dir);
  const prompt = path.join(dir, "prompt.md");
  fs.writeFileSync(prompt, "Fix the failing check.\n");
  const envFile = path.join(dir, "env.json");
  return {
    dir,
    seenEnv: () => JSON.parse(fs.readFileSync(envFile, "utf8")),
    baseEnv: { PATH: process.env.PATH, FAKE_ENV: envFile, ...extraEnv },
    config: {
      leg: { leg: "api-key", name: "AUTOMATIONS_CLAUDE_API_KEY", value: KEY },
      fallbackReady: false,
      handoffOnly: false,
      lane: "fix-ci",
      role: "automations",
      model: "claude-sonnet-5",
      effort: "",
      maxTurns: "8",
      permissionMode: "auto",
      watchdogMaxWaitMs: "1800000",
      legTimeoutMs,
      cliVersion: "2.1.302",
      cliPath: fakeCli,
      promptFile: prompt,
      preamble: "",
      allowedTools: [],
      disallowedTools: [],
      tools: [],
      jsonSchema: "",
      workDir: dir,
      runId: "123",
      liveLog: false,
      ...(otelReceiver === undefined ? {} : { otelReceiver }),
    },
  };
}

// A receiver whose endpoint the test can check after the leg.
function tracked() {
  const seen = [];
  return {
    seen,
    startReceiver: async () => {
      const receiver = await startOtlpReceiver();
      seen.push(receiver.endpoint);
      return receiver;
    },
  };
}

const CONFIG_ENV = {
  LANE_ROLE: "automations",
  LANE_API_KEY: KEY,
  LANE_PERMISSION_MODE: "auto",
  LANE_NAME: "fix-ci",
  LANE_MODEL: "sonnet",
  LANE_MAX_TURNS: "8",
  LANE_WATCHDOG_MAX_WAIT_MS: "1800000",
  LANE_CLI_VERSION: "2.1.302",
  LANE_CLI_PATH: "/opt/claude",
  LANE_WORK_DIR: "/tmp/work",
};

function configEnv(extra) {
  const prompt = path.join(root, "config-prompt.md");
  fs.writeFileSync(prompt, "Fix it.\n");
  return { ...CONFIG_ENV, LANE_PROMPT_FILE: prompt, ...extra };
}

test("the action's otel-receiver input defaults to false and reaches the launcher", () => {
  const action = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
  assert.match(
    action,
    /\n {2}otel-receiver:\n[\s\S]*?\n {4}default: "false"\n {2}plugin-dirs:/u,
  );
  assert.match(
    action,
    /LANE_OTEL_RECEIVER: \$\{\{ inputs\.otel-receiver \}\}/u,
  );
});

test("readConfig turns the receiver on only for true and refuses other values", () => {
  assert.equal(readConfig(configEnv({})).otelReceiver, false);
  for (const value of ["", " ", "false"]) {
    assert.equal(
      readConfig(configEnv({ LANE_OTEL_RECEIVER: value })).otelReceiver,
      false,
    );
  }
  assert.equal(
    readConfig(configEnv({ LANE_OTEL_RECEIVER: "true" })).otelReceiver,
    true,
  );
  assert.throws(
    () => readConfig(configEnv({ LANE_OTEL_RECEIVER: "yes" })),
    /otel-receiver "yes" is not true, false or empty/u,
  );
});

test("a caller who sets nothing gets no receiver, process, file, output or environment change", async () => {
  const inherited = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid:4318",
    OTEL_LOG_USER_PROMPTS: "1",
    BETA_TRACING_ENDPOINT: "http://beta.invalid",
  };
  const leg = legCase({ extraEnv: inherited });
  let started = 0;
  let spawned = 0;
  const { spawn } = require("node:child_process");
  const outcome = await runLeg(leg.config, {
    baseEnv: leg.baseEnv,
    write: () => {},
    startReceiver: async () => {
      started += 1;
      throw new Error("must not start");
    },
    spawn: (...args) => {
      spawned += 1;
      return spawn(...args);
    },
  });
  assert.equal(started, 0);
  assert.equal(spawned, 1, "the CLI is the only process started");
  assert.equal("otel-file" in outcome.outputs, false);
  assert.equal("telemetryWarning" in outcome, false);
  assert.equal(fs.existsSync(path.join(leg.dir, "otel.jsonl")), false);
  const seen = leg.seenEnv();
  for (const [name, value] of Object.entries(inherited)) {
    assert.equal(seen[name], value, `${name} passes through unchanged`);
  }
  for (const name of [
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
    "OTEL_TRACES_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
  ]) {
    assert.equal(name in seen, false, name);
  }
});

test("legEnv with no endpoint is the environment the leg had before", () => {
  const base = { PATH: "/bin", OTEL_LOGS_EXPORTER: "console" };
  const leg = { leg: "api-key", name: "A_CLAUDE_API_KEY", value: KEY };
  const config = { watchdogMaxWaitMs: "60000", lane: "intake" };
  assert.deepEqual(legEnv(base, leg, config, null), legEnv(base, leg, config));
  assert.equal(legEnv(base, leg, config).OTEL_LOGS_EXPORTER, "console");
});

test("legEnv with an endpoint exports only to it, as OTLP/HTTP JSON, with content redacted", () => {
  const env = legEnv(
    {
      PATH: "/bin",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://elsewhere.invalid/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer inherited",
      OTEL_LOG_USER_PROMPTS: "1",
      OTEL_LOG_TOOL_DETAILS: "1",
      OTEL_LOG_TOOL_CONTENT: "1",
      OTEL_LOG_RAW_API_BODIES: "1",
      BETA_TRACING_ENDPOINT: "http://beta.invalid",
      ENABLE_BETA_TRACING_DETAILED: "1",
    },
    { leg: "api-key", name: "A_CLAUDE_API_KEY", value: KEY },
    { watchdogMaxWaitMs: "60000", lane: "intake" },
    "http://127.0.0.1:4318",
  );
  const telemetry = Object.fromEntries(
    Object.entries(env).filter(([name]) => /OTEL_|TELEMETRY|BETA/u.test(name)),
  );
  assert.deepEqual(telemetry, {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
  });
});

test("the receiver binds 127.0.0.1 only", async (t) => {
  const listens = [];
  const receiver = await startOtlpReceiver({
    createServer: (handler) => {
      const server = http.createServer(handler);
      const listen = server.listen.bind(server);
      server.listen = (...args) => {
        listens.push(args.slice(0, 2));
        return listen(...args);
      };
      t.after(() => server.closeAllConnections());
      return server;
    },
  });
  t.after(() => receiver.stop());
  assert.equal(HOST, "127.0.0.1");
  assert.deepEqual(listens, [[0, "127.0.0.1"]]);
  const { hostname, port } = new URL(receiver.endpoint);
  assert.equal(hostname, "127.0.0.1");
  const outside = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => !entry.internal && entry.family === "IPv4");
  for (const { address } of outside) {
    assert.equal(
      await refused(`http://${address}:${port}`),
      true,
      "no other interface accepts a connection",
    );
  }
});

test("the receiver refuses to run on any address but loopback", async () => {
  await assert.rejects(
    startOtlpReceiver({
      createServer: (handler) => {
        const server = http.createServer(handler);
        const listen = server.listen.bind(server);
        server.listen = (port, _host, done) => listen(port, "::1", done);
        return server;
      },
    }),
    /not on the loopback address/u,
  );
});

test("the receiver keeps each export request as one line, ids exactly as sent", async () => {
  const receiver = await startOtlpReceiver();
  const pretty = JSON.stringify(JSON.parse(LOGS), null, 2);
  const traces = await post(receiver.endpoint, "/v1/traces", SPANS);
  assert.deepEqual(
    { status: traces.status, type: traces.type, body: traces.body },
    { status: 200, type: "application/json", body: "{}" },
  );
  assert.equal((await post(receiver.endpoint, "/v1/logs", pretty)).status, 200);
  const { text, dropped } = await receiver.stop();
  const lines = text.trimEnd().split("\n");
  assert.equal(dropped, 0);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], SPANS);
  const span = JSON.parse(lines[0]).resourceSpans[0].scopeSpans[0].spans[0];
  assert.deepEqual(
    [span.traceId, span.spanId, span.parentSpanId],
    [TRACE_ID, SPAN_ID, PARENT_ID],
  );
  assert.deepEqual(JSON.parse(lines[1]), JSON.parse(LOGS));
});

test("the receiver keeps large integers exactly as sent", async () => {
  const receiver = await startOtlpReceiver();
  const body = '{"resourceLogs":[{"timeUnixNano":1581452773000000789}]}';
  await post(receiver.endpoint, "/v1/logs", body);
  const { text } = await receiver.stop();
  assert.equal(text, `${body}\n`);
});

test("the receiver accepts a gzip body", async () => {
  const receiver = await startOtlpReceiver();
  const response = await post(
    receiver.endpoint,
    "/v1/traces",
    zlib.gzipSync(SPANS),
    { "content-encoding": "gzip" },
  );
  assert.equal(response.status, 200);
  assert.equal((await receiver.stop()).text, `${SPANS}\n`);
});

test("the receiver answers an empty request with success and keeps nothing", async () => {
  const receiver = await startOtlpReceiver();
  for (const body of ["{}", '{"resourceSpans":[]}']) {
    assert.equal(
      (await post(receiver.endpoint, "/v1/traces", body)).status,
      200,
    );
  }
  assert.equal((await receiver.stop()).text, "");
});

test("the receiver refuses what it cannot take, with no request content in the reply", async (t) => {
  const receiver = await startOtlpReceiver();
  t.after(() => receiver.stop());
  const cases = [
    ["/v1/metrics", SPANS, {}, 404],
    ["/v1/traces", MARKER, {}, 400],
    ["/v1/traces", `[${JSON.stringify(MARKER)}]`, {}, 400],
    ["/v1/traces", `{"resourceSpans":"${MARKER}"}`, {}, 400],
    ["/v1/traces", SPANS, { "content-type": "application/x-protobuf" }, 415],
    ["/v1/traces", SPANS, { "content-encoding": "br" }, 415],
    ["/v1/traces", MARKER, { "content-encoding": "gzip" }, 400],
  ];
  for (const [urlPath, body, headers, status] of cases) {
    const response = await post(receiver.endpoint, urlPath, body, headers);
    assert.equal(
      response.status,
      status,
      `${urlPath} ${JSON.stringify(headers)}`,
    );
    assert.equal(response.body.includes(MARKER), false);
  }
  assert.equal((await receiver.stop()).text, "");
});

test("the receiver answers 413 past the limit and counts what it dropped", async () => {
  const receiver = await startOtlpReceiver();
  const filler = "x".repeat(MAX_TELEMETRY_BYTES);
  const plain = `{"resourceLogs":[{"body":"${filler}"}]}`;
  assert.equal((await post(receiver.endpoint, "/v1/logs", plain)).status, 413);
  const bomb = await post(
    receiver.endpoint,
    "/v1/logs",
    zlib.gzipSync(Buffer.from(plain)),
    { "content-encoding": "gzip" },
  );
  assert.equal(bomb.status, 413);
  const half = `{"resourceLogs":[{"body":"${"y".repeat(MAX_TELEMETRY_BYTES / 2)}"}]}`;
  assert.equal((await post(receiver.endpoint, "/v1/logs", half)).status, 200);
  assert.equal((await post(receiver.endpoint, "/v1/logs", half)).status, 413);
  const { text, dropped } = await receiver.stop();
  assert.equal(dropped, 3);
  assert.equal(text, `${half}\n`);
});

test("stop ends a connection a client keeps open, and stops only once", async () => {
  const receiver = await startOtlpReceiver({ graceMs: 50 });
  const { hostname, port } = new URL(receiver.endpoint);
  const held = net.connect(Number(port), hostname);
  await new Promise((done) => held.once("connect", done));
  // Headers and no body: the request stays in flight until stop ends it.
  held.write(
    "POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n",
  );
  held.on("error", () => {});
  held.resume();
  const closed = new Promise((done) => held.once("close", done));
  const [first, second] = await Promise.all([receiver.stop(), receiver.stop()]);
  await closed;
  assert.deepEqual(first, second);
  assert.equal(await refused(receiver.endpoint), true);
});

test("a leg with the receiver on keeps the telemetry the CLI exported", async () => {
  const leg = legCase({
    otelReceiver: true,
    extraEnv: { FAKE_BODY: SPANS },
  });
  const printed = [];
  const outcome = await runLeg(leg.config, {
    baseEnv: leg.baseEnv,
    write: (text) => printed.push(text),
  });
  const file = outcome.outputs["otel-file"];
  assert.equal(file, path.join(leg.dir, "otel.jsonl"));
  assert.equal(fs.readFileSync(file, "utf8"), `${SPANS}\n`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(outcome.telemetryWarning, "");
  assert.equal(outcome.outputs["lane-class"], "");
  assert.equal(printed.join("").includes(MARKER), false);
  assert.match(
    leg.seenEnv().OTEL_EXPORTER_OTLP_ENDPOINT,
    /^http:\/\/127\.0\.0\.1:\d+$/u,
  );
});

test("the receiver stops on a success, a failed leg, a timeout and a spawn failure", async () => {
  const paths = [
    { name: "success", extraEnv: {} },
    { name: "failed leg", extraEnv: { FAKE_EXIT: "1" } },
    { name: "timeout", extraEnv: { FAKE_HANG: "1" }, legTimeoutMs: 200 },
  ];
  for (const { name, extraEnv, legTimeoutMs } of paths) {
    const leg = legCase({ otelReceiver: true, extraEnv, legTimeoutMs });
    const { seen, startReceiver } = tracked();
    await runLeg(leg.config, {
      baseEnv: leg.baseEnv,
      write: () => {},
      startReceiver,
    });
    assert.equal(seen.length, 1, name);
    assert.equal(await refused(seen[0]), true, name);
  }
  const leg = legCase({ otelReceiver: true });
  const { seen, startReceiver } = tracked();
  await assert.rejects(
    runLeg(leg.config, {
      baseEnv: leg.baseEnv,
      write: () => {},
      startReceiver,
      spawn: () => {
        throw new Error("spawn failed");
      },
    }),
    /spawn failed/u,
  );
  assert.equal(await refused(seen[0]), true, "spawn failure");
});

test("a failed leg keeps its telemetry and its own class", async () => {
  const leg = legCase({
    otelReceiver: true,
    extraEnv: { FAKE_BODY: SPANS, FAKE_EXIT: "1" },
  });
  const outcome = await runLeg(leg.config, {
    baseEnv: leg.baseEnv,
    write: () => {},
  });
  assert.notEqual(outcome.outputs["lane-class"], "");
  assert.equal(
    fs.readFileSync(outcome.outputs["otel-file"], "utf8"),
    `${SPANS}\n`,
  );
});

test("a receiver that cannot start warns and leaves the leg to run without telemetry", async () => {
  const leg = legCase({ otelReceiver: true });
  const outcome = await runLeg(leg.config, {
    baseEnv: leg.baseEnv,
    write: () => {},
    startReceiver: () => Promise.reject(new Error("EADDRNOTAVAIL")),
  });
  assert.equal(outcome.outputs["lane-class"], "");
  assert.equal(outcome.outputs["otel-file"], "");
  assert.match(outcome.telemetryWarning, /did not start/u);
  assert.equal("OTEL_EXPORTER_OTLP_ENDPOINT" in leg.seenEnv(), false);
  assert.equal("CLAUDE_CODE_ENABLE_TELEMETRY" in leg.seenEnv(), false);
});

test("a receiver that fails to stop warns and leaves the leg's outcome alone", async () => {
  const leg = legCase({ otelReceiver: true });
  const outcome = await runLeg(leg.config, {
    baseEnv: leg.baseEnv,
    write: () => {},
    startReceiver: async () => ({
      endpoint: "http://127.0.0.1:9",
      stop: () => Promise.reject(new Error("stop failed")),
    }),
  });
  assert.equal(outcome.outputs["lane-class"], "");
  assert.equal(outcome.outputs["otel-file"], "");
  assert.match(outcome.telemetryWarning, /could not be kept/u);
});

test("telemetry holding the leg's credential is never written", async () => {
  const leg = legCase({
    otelReceiver: true,
    extraEnv: {
      FAKE_BODY: JSON.stringify({ resourceSpans: [{ note: KEY }] }),
    },
  });
  const outcome = await runLeg(leg.config, {
    baseEnv: leg.baseEnv,
    write: () => {},
  });
  assert.equal(outcome.outputs["otel-file"], "");
  assert.match(outcome.telemetryWarning, /held a credential/u);
  assert.equal(fs.existsSync(path.join(leg.dir, "otel.jsonl")), false);
});

test("a path the leg planted is not followed", async () => {
  const leg = legCase({
    otelReceiver: true,
    extraEnv: { FAKE_BODY: SPANS },
  });
  const target = path.join(leg.dir, "target.txt");
  fs.writeFileSync(target, "untouched");
  fs.symlinkSync(target, path.join(leg.dir, "otel.jsonl"));
  const outcome = await runLeg(leg.config, {
    baseEnv: leg.baseEnv,
    write: () => {},
  });
  assert.equal(outcome.outputs["otel-file"], "");
  assert.match(outcome.telemetryWarning, /could not be kept/u);
  assert.equal(fs.readFileSync(target, "utf8"), "untouched");
});

test("a leg that exports nothing warns and sets no file", async () => {
  const leg = legCase({ otelReceiver: true });
  const outcome = await runLeg(leg.config, {
    baseEnv: leg.baseEnv,
    write: () => {},
  });
  assert.equal(outcome.outputs["otel-file"], "");
  assert.match(outcome.telemetryWarning, /got nothing/u);
  assert.equal(fs.existsSync(path.join(leg.dir, "otel.jsonl")), false);
});

test("the step never prints telemetry, and its warning reaches the runner", () => {
  const leg = legCase();
  const outputFile = path.join(leg.dir, "github-output");
  const summaryFile = path.join(leg.dir, "github-summary");
  fs.writeFileSync(outputFile, "");
  fs.writeFileSync(summaryFile, "");
  const env = {
    ...leg.baseEnv,
    ...CONFIG_ENV,
    LANE_PROMPT_FILE: leg.config.promptFile,
    LANE_CLI_PATH: fakeCli,
    LANE_WORK_DIR: leg.dir,
    LANE_OTEL_RECEIVER: "true",
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    // Holds the leg's key, so the step warns after its stop-commands block.
    FAKE_BODY: JSON.stringify({
      resourceSpans: [{ note: `${MARKER} ${KEY}` }],
    }),
  };
  const step = spawnSync(
    process.execPath,
    [path.join(__dirname, "lane.cjs"), "run"],
    { env, encoding: "utf8" },
  );
  assert.equal(step.status, 0, step.stderr);
  const printed = `${step.stdout}${step.stderr}`;
  assert.equal(printed.includes(MARKER), false);
  assert.equal(printed.includes(KEY), false);
  const [, token] = /^::stop-commands::([0-9a-f]+)$/mu.exec(step.stdout);
  const resumed = step.stdout.indexOf(`\n::${token}::\n`);
  const warning = step.stdout.indexOf(
    "::warning title=run-claude-cli telemetry::",
  );
  assert.ok(resumed !== -1, "the stop-commands block ends");
  assert.ok(warning > resumed, "the warning follows the stop-commands block");
  assert.match(fs.readFileSync(outputFile, "utf8"), /^otel-file=$/mu);
});
