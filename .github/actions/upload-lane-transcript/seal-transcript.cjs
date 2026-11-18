// Seal one lane leg's transcript, gzipped, to the transcript public key as one
// record, written under RUNNER_TEMP for the upload step. The plaintext stays in
// memory: only the sealed record reaches disk, and nothing here prints it.
//
// A record is version (1) | key id (8) | ephemeral public key (32) | nonce (12)
// | ciphertext | tag (16). Each record gets its own ephemeral X25519 key and
// random nonce; the key comes from HKDF-SHA256 over the shared secret, and
// AES-256-GCM binds the header, the payload name, the run id and the job id.
// The format is claude-code-plugins' seal-lane-output; its open-lane-output
// opens these records, so a change here must keep them byte-compatible.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const VERSION = 1;
const PAYLOAD = "transcript.json.gz";
const TELEMETRY_PAYLOAD = "otel.jsonl.gz";
// The transcript puller skips a whole artifact over 64 MiB, transcript
// included (claude-code-plugins scripts/lane-transcripts/pull.mjs MAX_SEALED);
// 1 MiB stays free for the zip's own framing.
const MAX_ARTIFACT_BYTES = 63 * 1024 * 1024;
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const KEY_LINE = /^x25519 ([0-9a-f]{16}) ([A-Za-z0-9+/]{43}=)$/u;
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

class SealError extends Error {}

const keyIdOf = (raw) =>
  crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);

/** The one-line key `x25519 <key id> <base64 raw key>`; the id is the first 16 hex digits of the raw key's SHA-256. */
function parsePublicKey(text) {
  const match = KEY_LINE.exec(String(text).trim());
  const raw = match && Buffer.from(match[2], "base64");
  if (!match || raw.length !== 32 || keyIdOf(raw) !== match[1]) {
    throw new SealError(
      "the public key holds no x25519 key line with a matching key id",
    );
  }
  return {
    keyId: match[1],
    raw,
    key: crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    }),
  };
}

function sealRecord(recipient, name, data, runId, jobId) {
  if (!RUN_ID.test(String(runId))) {
    throw new SealError("GITHUB_RUN_ID is not a run id");
  }
  const bound = Buffer.from(
    `lane-output/v${VERSION}\0${name}\0${runId}\0${jobId}`,
  );
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const epk = ephemeral.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const nonce = crypto.randomBytes(12);
  const header = Buffer.concat([
    Buffer.from([VERSION]),
    Buffer.from(recipient.keyId, "hex"),
    epk,
    nonce,
  ]);
  const shared = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipient.key,
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
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.concat([header, bound]));
  return Buffer.concat([
    header,
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

/** True for a regular, non-empty file; a link or a missing path is not one. */
function hasContent(file) {
  try {
    const stat = file === "" ? undefined : fs.lstatSync(file);
    return stat?.isFile() === true && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Seal the leg's telemetry beside its sealed transcript, under its own payload
 * name and the same run and job binding. Runs after the transcript is on disk
 * and never touches it.
 */
function sealTelemetry(
  env = process.env,
  maxArtifactBytes = MAX_ARTIFACT_BYTES,
) {
  const file = env.OTEL_FILE ?? "";
  if (!hasContent(file)) return;
  const recipient = parsePublicKey(env.PUBLIC_KEY);
  const jobId = env.JOB_ID ?? "";
  if (!JOB_ID.test(jobId)) {
    throw new SealError("the job-id input is not a job key");
  }
  const directory = path.join(env.RUNNER_TEMP, "lane-transcript", jobId);
  const transcriptBytes = fs.statSync(
    path.join(directory, `${PAYLOAD}.sealed`),
  ).size;
  const record = sealRecord(
    recipient,
    TELEMETRY_PAYLOAD,
    zlib.gzipSync(fs.readFileSync(file)),
    env.GITHUB_RUN_ID,
    jobId,
  );
  if (transcriptBytes + record.length > maxArtifactBytes) {
    process.stdout.write(
      "::warning::upload-lane-transcript: the telemetry is left out: with it the artifact would pass the transcript puller's size limit\n",
    );
    return;
  }
  const sealed = path.join(directory, `${TELEMETRY_PAYLOAD}.sealed`);
  fs.writeFileSync(sealed, record, { flag: "wx" });
  fs.appendFileSync(env.GITHUB_OUTPUT, `file=${sealed}\n`);
}

function main(env = process.env) {
  if (String(env.PUBLIC_KEY ?? "").trim() === "") {
    process.stdout.write(
      "::notice::upload-lane-transcript: the public key input is empty, so this leg's transcript is not uploaded\n",
    );
    return;
  }
  // The key first: a malformed key fails whether or not a leg ran.
  const recipient = parsePublicKey(env.PUBLIC_KEY);
  const jobId = env.JOB_ID ?? "";
  if (!JOB_ID.test(jobId)) {
    throw new SealError("the job-id input is not a job key");
  }
  const file = env.EXECUTION_FILE ?? "";
  // No regular, non-empty file: no leg ran, so there is nothing to keep.
  if (!hasContent(file)) return;
  const record = sealRecord(
    recipient,
    PAYLOAD,
    zlib.gzipSync(fs.readFileSync(file)),
    env.GITHUB_RUN_ID,
    jobId,
  );
  const directory = path.join(env.RUNNER_TEMP, "lane-transcript", jobId);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sealed = path.join(directory, `${PAYLOAD}.sealed`);
  fs.writeFileSync(sealed, record, { flag: "wx" });
  fs.appendFileSync(env.GITHUB_OUTPUT, `file=${sealed}\n`);
}

module.exports = { main, sealTelemetry };

if (require.main === module && process.argv[2] === "telemetry") {
  // Telemetry is optional: a failure here warns and leaves the transcript's
  // upload to go ahead.
  try {
    sealTelemetry();
  } catch (error) {
    process.stdout.write(
      `::warning::upload-lane-transcript: the telemetry is left out: ${error instanceof SealError ? error.message : `it could not be sealed (${error.name})`}\n`,
    );
  }
} else if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stdout.write(
      `::error::upload-lane-transcript: ${error instanceof SealError ? error.message : `the transcript could not be sealed (${error.name})`}\n`,
    );
    process.exitCode = 1;
  }
}
