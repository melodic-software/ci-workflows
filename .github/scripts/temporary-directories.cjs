"use strict";

// Temporary directories for node:test files. node:test skips `after` hooks
// when the run is interrupted, so removal hangs off process exit and the
// interrupt signals instead, and a cancelled run leaves nothing in os.tmpdir().

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const directories = [];

function removeTemporaryDirectories() {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

process.on("exit", removeTemporaryDirectories);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    removeTemporaryDirectories();
    process.kill(process.pid, signal);
  });
}

function makeTemporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

module.exports = { makeTemporaryDirectory };
