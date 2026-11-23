// The pre-upload leak scan for lane artifacts. It runs claude-code-plugins'
// lib/publish-gate.mjs scanLeak, the rule set every lane upload there runs,
// over each file an upload is about to send and its relative name. The gate is
// SCAN_GATE, a path the caller trusts (a checkout of its default branch), or
// else claude-code-plugins' default-branch tip at scan time, through an
// anonymous clone (no token, no REST request), never a clone the model ran
// beside. Either way it must import only node: builtins.
//
// A credential format or a hidden assignment withholds the upload; the broad
// assignment label only warns. A link, a non-regular file, a compressed file,
// a glob or `!` entry, a gate that cannot be read, or any other fault
// withholds it too. Nothing printed carries a matched value or a file name.
// SCAN_WITHHOLDS, a fixed text from a caller whose hit keeps part of its upload,
// replaces "nothing is uploaded" in the error line. On a pattern block, a gate
// that exports hitFingerprint writes the hit's fingerprint (rule, file name or
// a fixed placeholder, line; none of the match) to GITHUB_STEP_SUMMARY.
// SCAN_TELEMETRY=true reads a file's R2 key pair block again with its 32-hex
// trace ids hidden, since OpenTelemetry trace ids match that rule.
// Writes clean=true to GITHUB_OUTPUT only when every file was judged clean.
// Exit 0 clean, 1 withheld.
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SOURCE = "https://github.com/melodic-software/claude-code-plugins.git";
const COMPRESSED = [Buffer.from([0x1f, 0x8b]), Buffer.from("PK\x03\x04", "latin1"), Buffer.from("(\xb5/\xfd", "latin1")];
const R2 = "R2 key pair";
const TRACE_ID = /(\\?"trace_?id\\?"\s*:\s*\\?")[0-9a-f]{32}(?=\\?")/giu;
const hideTraceIds = (bytes) =>
  Buffer.from(bytes.toString("latin1").replace(TRACE_ID, (_, key) => `${key}${"x".repeat(32)}`), "latin1");
const IMPORTS = /\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]?([^'")]*)/gmu;

/** lib/publish-gate.mjs from the default-branch tip, written into a fresh directory under `temp`; returns its path. */
function fetchGate(temp) {
  const clone = fs.mkdtempSync(path.join(temp, "claude-code-plugins-"));
  const home = fs.mkdtempSync(path.join(temp, "scan-upload-home-"));
  // /usr/bin/git with no system or global config and a minimal env, so no
  // config, hook or credential helper a model step could have left applies.
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (...args) =>
    childProcess.execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  git("clone", "--quiet", "--depth=1", "--filter=blob:none", "--no-checkout", SOURCE, clone);
  const tip = git("-C", clone, "rev-parse", "HEAD").trim();
  if (!/^[0-9a-f]{40}$/u.test(tip)) throw new Error("no default branch tip");
  const text = git("-C", clone, "show", `${tip}:lib/publish-gate.mjs`);
  checkImports(text);
  const directory = fs.mkdtempSync(path.join(temp, "publish-gate-"));
  const gate = path.join(directory, "publish-gate.mjs");
  fs.writeFileSync(gate, text);
  process.stdout.write(`scan-upload: publish gate from claude-code-plugins@${tip}\n`);
  return gate;
}

function checkImports(text) {
  const specifiers = [...text.matchAll(IMPORTS)].map((match) => match[1] ?? match[2] ?? match[3]);
  if (specifiers.some((name) => !name.startsWith("node:"))) throw new Error("the gate imports more than node builtins");
}

/**
 * The caller's gate at `gatePath`, read once, held to node: builtins like a
 * fetched one, and written into a fresh directory under `temp`, so the file
 * imported is the one checked; returns the copy's path.
 */
function callerGate(gatePath, temp) {
  const text = fs.readFileSync(path.resolve(gatePath), "utf8");
  checkImports(text);
  const gate = path.join(fs.mkdtempSync(path.join(temp, "publish-gate-")), "publish-gate.mjs");
  fs.writeFileSync(gate, text, { flag: "wx", mode: 0o444 });
  return gate;
}

/**
 * Every file under each of `entries`, judged by the gate's `scanLeak`:
 * `{ withheld: {label, credential, fingerprint} | null, warned, files }`,
 * fingerprint the summary line for a pattern block when the gate exports
 * hitFingerprint. `telemetry` reads an R2 key pair block again with the trace ids hidden.
 */
function scanPaths({ scanLeak, hitFingerprint }, entries, { telemetry = false } = {}) {
  let warned = false;
  let files = 0;
  const judge = (bytes, where, content = false) => {
    let result = scanLeak(bytes);
    if (telemetry && content && result.block === R2) {
      bytes = hideTraceIds(bytes);
      result = scanLeak(bytes);
    }
    const { block, credential, warn } = result;
    if (block) {
      let fingerprint = null;
      try {
        if (typeof hitFingerprint === "function") fingerprint = hitFingerprint(bytes, block, where);
      } catch {}
      return { label: block, credential: Boolean(credential), fingerprint };
    }
    warned ||= Boolean(warn);
    return null;
  };
  const walk = (at, name) => {
    const stat = lstatOrNull(at);
    if (!stat) return { label: "a path the scan cannot read" };
    if (stat.isSymbolicLink()) return { label: "a link, which the upload would follow" };
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(at).sort()) {
        const hit = walk(path.join(at, child), name ? `${name}/${child}` : child);
        if (hit) return hit;
      }
      return null;
    }
    if (!stat.isFile()) return { label: "a file that is not a regular file" };
    files += 1;
    const bytes = fs.readFileSync(at);
    if (COMPRESSED.some((magic) => bytes.subarray(0, magic.length).equals(magic))) {
      return { label: "a compressed file, whose bytes the scan cannot read" };
    }
    return judge(Buffer.from(name, "utf8"), "a file name") ?? judge(bytes, name, true);
  };
  for (const line of entries) {
    const entry = line.trim();
    if (entry === "") continue;
    if (entry.startsWith("!") || /[*?[\]{}]/u.test(entry)) {
      return { withheld: { label: "a glob or exclude pattern, which the scan cannot follow" }, warned, files };
    }
    // A missing path uploads nothing; the upload's if-no-files-found decides it.
    if (!fs.existsSync(entry) && !lstatOrNull(entry)?.isSymbolicLink()) continue;
    const hit = walk(entry, lstatOrNull(entry)?.isDirectory() ? "" : path.basename(entry));
    if (hit) return { withheld: hit, warned, files };
  }
  return { withheld: null, warned, files };
}

function lstatOrNull(at) {
  try {
    return fs.lstatSync(at);
  } catch {
    return null;
  }
}

/** Scan `env.SCAN_PATHS` with the gate at `gatePath`, else env.SCAN_GATE, else a fetched one; returns the exit code. */
async function main(env = process.env, gatePath = null) {
  let result;
  try {
    const temp = env.RUNNER_TEMP || os.tmpdir();
    const gate = gatePath ?? (env.SCAN_GATE ? callerGate(env.SCAN_GATE, temp) : fetchGate(temp));
    const gateModule = await import(pathToFileURL(gate).href);
    if (typeof gateModule.scanLeak !== "function") throw new Error("the gate exports no scanLeak");
    result = scanPaths(gateModule, String(env.SCAN_PATHS ?? "").split(/\r?\n/u), { telemetry: env.SCAN_TELEMETRY === "true" });
  } catch (error) {
    result = { withheld: { label: `no finished scan (${error.name})`, credential: false }, warned: false, files: 0 };
  }
  const { withheld, warned, files } = result;
  if (withheld) {
    if (withheld.fingerprint && env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(
          env.GITHUB_STEP_SUMMARY,
          `### scan-upload ${env.SCAN_WITHHOLDS ? `hit: ${env.SCAN_WITHHOLDS}` : "withheld the upload"}\n\n${withheld.fingerprint}\n`,
        );
      } catch {}
    }
    process.stdout.write(`::error::scan-upload: ${withheld.label}; ${env.SCAN_WITHHOLDS || "nothing is uploaded"}${withheld.credential ? ". Rotate this credential" : ""}\n`);
    return 1;
  }
  if (warned) process.stdout.write("::warning::scan-upload: a password or secret assignment in an upload file; not blocking, check it is no real credential\n");
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, "clean=true\n");
  process.stdout.write(`scan-upload: ${files} file(s) clean\n`);
  return 0;
}

module.exports = { checkImports, main, scanPaths };

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
