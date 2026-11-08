// The pre-upload leak scan for the review lanes' artifacts. It runs
// claude-code-plugins' lib/publish-gate.mjs scanLeak, the rule set every lane
// upload there runs, over each file an upload is about to send and its
// relative name. The gate comes from claude-code-plugins' default-branch tip
// at scan time, through an anonymous clone (no token, no REST request), never
// from a clone the model ran beside, and must import only node: builtins.
//
// A credential format or a hidden assignment withholds the upload; the broad
// assignment label only warns. A link, a non-regular file, a compressed file,
// a glob or `!` entry, a gate that cannot be fetched, or any other fault
// withholds it too. Nothing printed carries a matched value or a file name.
// Writes clean=true to GITHUB_OUTPUT only when every file was judged clean.
// Exit 0 clean, 1 withheld.
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SOURCE = "https://github.com/melodic-software/claude-code-plugins.git";
const COMPRESSED = [Buffer.from([0x1f, 0x8b]), Buffer.from("PK\x03\x04", "latin1"), Buffer.from("(\xb5/\xfd", "latin1")];
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

/** Every file under each of `entries`, judged by `scanLeak`: `{ withheld: {label, credential} | null, warned, files }`. */
function scanPaths(scanLeak, entries) {
  let warned = false;
  let files = 0;
  const judge = (bytes) => {
    const { block, credential, warn } = scanLeak(bytes);
    if (block) return { label: block, credential: Boolean(credential) };
    warned ||= Boolean(warn);
    return null;
  };
  const walk = (at, name) => {
    let stat;
    try {
      stat = fs.lstatSync(at);
    } catch {
      return { label: "a path the scan cannot read" };
    }
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
    return judge(Buffer.from(name, "utf8")) ?? judge(bytes);
  };
  for (const line of entries) {
    const entry = line.trim();
    if (entry === "") continue;
    if (entry.startsWith("!") || /[*?[\]{}]/u.test(entry)) {
      return { withheld: { label: "a glob or exclude pattern, which the scan cannot follow" }, warned, files };
    }
    // A missing path uploads nothing; the upload's if-no-files-found decides it.
    if (!fs.existsSync(entry) && !isLink(entry)) continue;
    const hit = walk(entry, isDirectory(entry) ? "" : path.basename(entry));
    if (hit) return { withheld: hit, warned, files };
  }
  return { withheld: null, warned, files };
}

const isLink = (at) => {
  try {
    return fs.lstatSync(at).isSymbolicLink();
  } catch {
    return false;
  }
};
const isDirectory = (at) => {
  try {
    return fs.lstatSync(at).isDirectory();
  } catch {
    return false;
  }
};

/** Scan `env.SCAN_PATHS` with the gate at `gatePath` (fetched when absent); returns the exit code. */
async function main(env = process.env, gatePath = null) {
  let result;
  try {
    const gate = gatePath ?? fetchGate(env.RUNNER_TEMP || require("node:os").tmpdir());
    const { scanLeak } = await import(pathToFileURL(gate).href);
    if (typeof scanLeak !== "function") throw new Error("the gate exports no scanLeak");
    result = scanPaths(scanLeak, String(env.SCAN_PATHS ?? "").split(/\r?\n/u));
  } catch (error) {
    result = { withheld: { label: `no finished scan (${error.name})`, credential: false }, warned: false, files: 0 };
  }
  const { withheld, warned, files } = result;
  if (withheld) {
    process.stdout.write(`::error::scan-upload: ${withheld.label}; nothing is uploaded${withheld.credential ? ". Rotate this credential" : ""}\n`);
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
