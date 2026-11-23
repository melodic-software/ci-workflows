// scan-upload: the caller's gate, the hit fingerprint in the job summary, the
// trace-id reading for telemetry, and how the inputs reach scan.cjs. The gate
// here is a stand-in with publish-gate.mjs's export shapes; the real rules are
// claude-code-plugins' own tests.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const SCRIPT = path.join(__dirname, "../actions/scan-upload/scan.cjs");
const readAction = (name) =>
  parseWorkflow(
    fs.readFileSync(
      path.join(__dirname, `../actions/${name}/action.yml`),
      "utf8",
    ),
  );
// Built at run time: a GitHub token prefix and 36 letters spelling FAKE, never
// a live token.
const PLANTED = ["gh", "p_", "FAKE".repeat(9)].join("");
const HEX32 = "c".repeat(32);
const HEX64 = "d".repeat(64);

// scanLeak blocks the planted token and, like publish-gate's R2 key pair rule,
// a 32-hex and a 64-hex word on one line; hitFingerprint gives the rule, path
// and line, as publish-gate's does.
const GATE = `
const hex = (n) => new RegExp(\`(?<![0-9a-f])[0-9a-f]{\${n}}(?![0-9a-f])\`, "i");
const r2 = (text) => text.split("\\n").some((line) => hex(32).test(line) && hex(64).test(line));
const rule = (text) => (text.includes("FAKE".repeat(9)) ? "GitHub token" : r2(text) ? "R2 key pair" : null);
export function scanLeak(bytes) {
  const block = rule(Buffer.from(bytes).toString("latin1"));
  return block ? { block, credential: true } : {};
}
`;
const FINGERPRINT = `
export function hitFingerprint(bytes, block, where) {
  const lines = Buffer.from(bytes).toString("latin1").split("\\n");
  const line = lines.findIndex((text) => scanLeak(Buffer.from(text)).block === block) + 1;
  return \`- rule \\\`\${block}\\\`, path \\\`\${where}\\\`, line \${line}\\n\`;
}
`;

function gateFile(dir, text = GATE + FINGERPRINT) {
  const file = path.join(dir, "publish-gate.mjs");
  fs.writeFileSync(file, text);
  return file;
}

function run(dir, paths, extra = {}) {
  const output = path.join(dir, "github-output");
  const summary = path.join(dir, "step-summary");
  fs.writeFileSync(output, "");
  fs.writeFileSync(summary, "");
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      SCAN_PATHS: paths,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      ...extra,
    },
    encoding: "utf8",
  });
  return {
    ...result,
    outputs: fs.readFileSync(output, "utf8"),
    summary: fs.readFileSync(summary, "utf8"),
  };
}

function withheld(result, label) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.outputs, "", "a withheld upload sets no clean output");
  assert.match(
    result.stdout,
    new RegExp(`::error::scan-upload: ${label}`, "u"),
  );
  assert.ok(
    !`${result.stdout}${result.stderr}${result.summary}`.includes(PLANTED),
    "the matched value is never printed",
  );
}

test("SCAN_GATE scans with the caller's gate, relative to the workspace, and fetches nothing", () => {
  const dir = makeTemporaryDirectory("scan-gate-");
  gateFile(dir);
  fs.writeFileSync(path.join(dir, "reply.txt"), "a clean reply\n");
  const result = run(dir, path.join(dir, "reply.txt"), {
    SCAN_GATE: "publish-gate.mjs",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.outputs, "clean=true\n");
  assert.equal(
    result.stdout,
    "scan-upload: 1 file(s) clean\n",
    "no fetched gate is announced",
  );
  fs.writeFileSync(path.join(dir, "handoff.json"), `{"review":"${PLANTED}"}\n`);
  withheld(
    run(dir, path.join(dir, "handoff.json"), { SCAN_GATE: "publish-gate.mjs" }),
    "GitHub token; nothing is uploaded. Rotate this credential",
  );
});

test("a caller's gate that imports more than node builtins, or is absent, withholds the upload", () => {
  const dir = makeTemporaryDirectory("scan-gate-imports-");
  gateFile(dir, `import "./elsewhere.mjs";\n${GATE}`);
  fs.writeFileSync(path.join(dir, "reply.txt"), "a clean reply\n");
  withheld(
    run(dir, path.join(dir, "reply.txt"), { SCAN_GATE: "publish-gate.mjs" }),
    "no finished scan \\(Error\\); nothing is uploaded",
  );
  withheld(
    run(dir, path.join(dir, "reply.txt"), { SCAN_GATE: "absent.mjs" }),
    "no finished scan \\(Error\\); nothing is uploaded",
  );
});

test("a block writes the gate's fingerprint to the summary, headed by what it withholds", () => {
  const dir = makeTemporaryDirectory("scan-fingerprint-");
  const gate = gateFile(dir);
  fs.mkdirSync(path.join(dir, "out", "nested"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "out", "nested", "handoff.json"),
    `{\n  "review": "${PLANTED}"\n}\n`,
  );
  const whole = run(dir, path.join(dir, "out"), { SCAN_GATE: gate });
  withheld(whole, "GitHub token");
  assert.equal(
    whole.summary,
    "### scan-upload withheld the upload\n\n- rule `GitHub token`, path `nested/handoff.json`, line 2\n\n",
  );
  const part = run(dir, path.join(dir, "out"), {
    SCAN_GATE: gate,
    SCAN_WITHHOLDS:
      "the telemetry is left out and the transcript still uploads",
  });
  withheld(
    part,
    "GitHub token; the telemetry is left out and the transcript still uploads",
  );
  assert.match(
    part.summary,
    /^### scan-upload hit: the telemetry is left out and the transcript still uploads\n\n- rule /u,
  );
});

test("a hit in a file name is fingerprinted as `a file name`, and a gate with no hitFingerprint writes no summary", () => {
  const dir = makeTemporaryDirectory("scan-name-");
  fs.mkdirSync(path.join(dir, "out"));
  fs.writeFileSync(path.join(dir, "out", `${PLANTED}.txt`), "clean bytes\n");
  const named = run(dir, path.join(dir, "out"), { SCAN_GATE: gateFile(dir) });
  withheld(named, "GitHub token");
  assert.equal(
    named.summary,
    "### scan-upload withheld the upload\n\n- rule `GitHub token`, path `a file name`, line 1\n\n",
  );
  const bare = run(dir, path.join(dir, "out"), {
    SCAN_GATE: gateFile(dir, GATE),
  });
  withheld(bare, "GitHub token");
  assert.equal(bare.summary, "");
});

const spanLine = (extra = "") =>
  `${JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: HEX32, attributes: [{ key: "digest", value: { stringValue: HEX64 } }] }] }] }] })}${extra}\n`;

test("with SCAN_TELEMETRY=true a trace id is not read as the R2 key pair's 32-hex half", () => {
  const dir = makeTemporaryDirectory("scan-telemetry-");
  const gate = gateFile(dir);
  const file = path.join(dir, "otel.jsonl");
  const logLine = JSON.stringify({
    resourceLogs: [
      { logRecords: [{ trace_id: HEX32.toUpperCase(), body: HEX64 }] },
    ],
  });
  fs.writeFileSync(
    file,
    `${spanLine()}${logLine}\n${JSON.stringify({ body: spanLine() })}\n`,
  );
  const result = run(dir, file, { SCAN_GATE: gate, SCAN_TELEMETRY: "true" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.outputs, "clean=true\n");
  assert.equal(result.summary, "");
});

test("with SCAN_TELEMETRY=true a 32-hex word that is no trace id, or any other rule, still withholds", () => {
  const dir = makeTemporaryDirectory("scan-telemetry-hit-");
  const env = { SCAN_GATE: gateFile(dir), SCAN_TELEMETRY: "true" };
  const bare = path.join(dir, "bare.jsonl");
  fs.writeFileSync(bare, `{"a": 1}\n${HEX32} ${HEX64}\n`);
  const result = run(dir, bare, env);
  withheld(result, "R2 key pair");
  assert.equal(
    result.summary,
    "### scan-upload withheld the upload\n\n- rule `R2 key pair`, path `bare.jsonl`, line 2\n\n",
  );
  const beside = path.join(dir, "beside.jsonl");
  fs.writeFileSync(beside, spanLine(` ${"f".repeat(32)}`));
  withheld(run(dir, beside, env), "R2 key pair");
  const token = path.join(dir, "token.jsonl");
  fs.writeFileSync(token, `${spanLine()}{"body":"${PLANTED}"}\n`);
  withheld(run(dir, token, env), "GitHub token");
});

test("without SCAN_TELEMETRY=true a trace id beside a 64-hex word withholds", () => {
  const dir = makeTemporaryDirectory("scan-telemetry-off-");
  const gate = gateFile(dir);
  const file = path.join(dir, "execution.json");
  fs.writeFileSync(file, spanLine());
  withheld(run(dir, file, { SCAN_GATE: gate }), "R2 key pair");
  withheld(
    run(dir, file, { SCAN_GATE: gate, SCAN_TELEMETRY: "1" }),
    "R2 key pair",
  );
  withheld(
    run(dir, file, { SCAN_GATE: gate, SCAN_TELEMETRY: "false" }),
    "R2 key pair",
  );
});

test("scan-upload passes gate-path and hide-trace-ids to scan.cjs, both off by default", () => {
  const action = readAction("scan-upload");
  assert.deepEqual(action.runs.steps[0].env, {
    SCAN_PATHS: `\${{ inputs.path }}`,
    SCAN_GATE: `\${{ inputs.gate-path }}`,
    SCAN_TELEMETRY: `\${{ inputs.hide-trace-ids }}`,
  });
  assert.equal(action.inputs["gate-path"].default, "");
  assert.equal(action.inputs["hide-trace-ids"].default, "false");
});

test("upload-lane-transcript passes gate-path to both scans and hide-trace-ids to the telemetry's alone", () => {
  const action = readAction("upload-lane-transcript");
  const steps = Object.fromEntries(
    action.runs.steps.map((step) => [step.id, step]),
  );
  assert.equal(steps.scan.env.SCAN_GATE, `\${{ inputs.gate-path }}`);
  assert.equal(steps["scan-otel"].env.SCAN_GATE, `\${{ inputs.gate-path }}`);
  assert.equal(
    steps["scan-otel"].env.SCAN_TELEMETRY,
    `\${{ inputs.hide-trace-ids }}`,
  );
  assert.equal("SCAN_TELEMETRY" in steps.scan.env, false);
  assert.equal(action.inputs["gate-path"].default, "");
  assert.equal(action.inputs["hide-trace-ids"].default, "false");
});
