// upload-lane-transcript: the sealed record and the step's contract. The opener
// here reads the record layout seal-transcript.cjs's header states, as
// claude-code-plugins' open-lane-output does, with no code from the sealer.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  makeTemporaryDirectory,
} = require("../../scripts/temporary-directories.cjs");
const { parseWorkflow } = require("../../scripts/workflow-yaml.cjs");

const ACTION = parseWorkflow(
  fs.readFileSync(path.join(__dirname, "action.yml"), "utf8"),
);
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const MARKER = "plaintext-marker-7f3c";
const TRANSCRIPT = JSON.stringify([
  { type: "assistant", message: { content: [{ type: "text", text: MARKER }] } },
]);
const JOB = "code-review-key-2";

function generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyId = crypto
    .createHash("sha256")
    .update(raw)
    .digest("hex")
    .slice(0, 16);
  return {
    keyId,
    raw,
    privateKey,
    line: `x25519 ${keyId} ${raw.toString("base64")}`,
  };
}

function open(recipient, record, runId = "42", jobId = JOB) {
  const header = record.subarray(0, 53);
  const epk = header.subarray(9, 41);
  const bound = Buffer.from(
    `lane-output/v1\0transcript.json.gz\0${runId}\0${jobId}`,
  );
  const shared = crypto.diffieHellman({
    privateKey: recipient.privateKey,
    publicKey: crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, epk]),
      format: "der",
      type: "spki",
    }),
  });
  const key = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      shared,
      Buffer.concat([epk, recipient.raw]),
      Buffer.concat([bound, Buffer.from([0]), header]),
      32,
    ),
  );
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    header.subarray(41),
  );
  decipher.setAAD(Buffer.concat([header, bound]));
  decipher.setAuthTag(record.subarray(record.length - 16));
  return zlib
    .gunzipSync(
      Buffer.concat([
        decipher.update(record.subarray(53, record.length - 16)),
        decipher.final(),
      ]),
    )
    .toString("utf8");
}

function workspace() {
  const dir = makeTemporaryDirectory("lane-transcript-");
  const file = path.join(dir, "execution.json");
  fs.writeFileSync(file, TRANSCRIPT);
  return { dir, file };
}

function run(dir, { key, file = "", jobId = JOB }) {
  const output = path.join(dir, "github-output");
  fs.writeFileSync(output, "");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "seal-transcript.cjs")],
    {
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: dir,
        GITHUB_RUN_ID: "42",
        PUBLIC_KEY: key,
        EXECUTION_FILE: file,
        JOB_ID: jobId,
      },
      encoding: "utf8",
    },
  );
  return { ...result, output: fs.readFileSync(output, "utf8") };
}

const sealedPath = (result) => result.output.trim().replace(/^file=/u, "");
const nothingSealed = (dir) =>
  assert.equal(fs.existsSync(path.join(dir, "lane-transcript")), false);

test("a transcript seals to the public key and opens, gunzipped, to the same bytes", () => {
  const { dir, file } = workspace();
  const recipient = generate();
  const result = run(dir, { key: recipient.line, file });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sealedFile = sealedPath(result);
  assert.equal(
    sealedFile,
    path.join(dir, "lane-transcript", JOB, "transcript.json.gz.sealed"),
  );
  const sealed = fs.readFileSync(sealedFile);
  assert.equal(sealed[0], 1, "the record's version");
  assert.equal(sealed.subarray(1, 9).toString("hex"), recipient.keyId);
  assert.equal(sealed.includes(Buffer.from(MARKER)), false);
  assert.equal(open(recipient, sealed), TRANSCRIPT);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(MARKER, "u"));
});

test("the record opens only for its own key, run and job", () => {
  const { dir, file } = workspace();
  const recipient = generate();
  const sealed = fs.readFileSync(
    sealedPath(run(dir, { key: recipient.line, file })),
  );
  assert.throws(() => open(recipient, sealed, "43"));
  assert.throws(() => open(recipient, sealed, "42", "code-review-key-3"));
  assert.throws(() => open(generate(), sealed));
});

test("an empty key passes with a notice and seals nothing", () => {
  const { dir, file } = workspace();
  for (const key of ["", "  "]) {
    const result = run(dir, { key, file });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^::notice::upload-lane-transcript: /mu);
    assert.equal(result.output, "");
    nothingSealed(dir);
  }
});

test("a malformed key fails the step and seals nothing, even with no transcript", () => {
  const { dir, file } = workspace();
  const [, id, key] = generate().line.split(" ");
  const otherId = id.replace(/^./u, id[0] === "0" ? "1" : "0");
  for (const [bad, source] of [
    ["x25519 0000000000000000 REPLACE_WITH_PUBLIC_KEY", file],
    [`x25519 ${otherId} ${key}`, file],
    ["-----BEGIN PUBLIC KEY-----", ""],
  ]) {
    const result = run(dir, { key: bad, file: source });
    assert.equal(result.status, 1, bad);
    assert.match(result.stdout, /^::error::upload-lane-transcript: /mu, bad);
    assert.equal(result.output, "", bad);
    assert.equal(result.stdout.includes(key), false, "the key is not printed");
    nothingSealed(dir);
  }
});

test("a missing, empty or linked transcript seals nothing; a bad job id fails", () => {
  const { dir, file } = workspace();
  const { line } = generate();
  const empty = path.join(dir, "empty.json");
  const linked = path.join(dir, "linked.json");
  fs.writeFileSync(empty, "");
  fs.symlinkSync(file, linked);
  for (const source of ["", path.join(dir, "absent.json"), empty, linked]) {
    const result = run(dir, { key: line, file: source });
    assert.equal(result.status, 0, source);
    assert.equal(result.output, "", source);
  }
  nothingSealed(dir);
  for (const jobId of ["", "1st", "has space", "a.b"]) {
    const result = run(dir, { key: line, file, jobId });
    assert.equal(result.status, 1, jobId);
    nothingSealed(dir);
  }
});

test("an empty key skips the scan, and a scan that is not clean withholds the seal", () => {
  const [scan, seal] = ACTION.runs.steps;
  assert.match(scan.run, /\/\.\.\/scan-upload\/scan\.cjs"$/u);
  assert.equal(scan.env.SCAN_PATHS, `\${{ inputs.execution-file }}`);
  assert.equal(scan.if, "inputs.public-key != ''");
  assert.equal(
    seal.if,
    "inputs.public-key == '' || steps.scan.outputs.clean == 'true'",
  );
});

test("the upload keeps only the sealed file, for 7 days, named by job and attempt", () => {
  const upload = ACTION.runs.steps.at(-1);
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/u);
  assert.equal(upload.if, "steps.seal.outputs.file != ''");
  assert.equal(
    upload.with.name,
    `lane-transcript-\${{ inputs.job-id }}-\${{ github.run_attempt }}`,
  );
  assert.equal(upload.with.path, `\${{ steps.seal.outputs.file }}`);
  assert.equal(upload.with["retention-days"], 7);
  assert.equal(upload.with.overwrite, false);
});
