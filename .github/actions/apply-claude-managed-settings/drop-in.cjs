// The managed-settings drop-in apply-claude-managed-settings writes to
// /etc/claude-code/managed-settings.d/<name>.json: a JSON object holding only
// `pluginConfigs`, so a drop-in, which Claude Code merges over
// managed-settings.json, can never repoint a key that file pins
// (https://code.claude.com/docs/en/settings#settings-files).
//
// Run as a script, it checks DROP_IN_FILE and DROP_IN_NAME and prints the
// drop-in's JSON, or exits 1 with an error annotation.
"use strict";

const fs = require("node:fs");

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ALLOWED_KEYS = ["pluginConfigs"];

function readDropIn(file, name, { read = fs.readFileSync } = {}) {
  if (!NAME.test(name ?? "") || name.endsWith(".json")) {
    return { problem: `drop-in-name ${JSON.stringify(name)} is not a lowercase file name without .json` };
  }
  let settings;
  try {
    settings = JSON.parse(read(file, "utf8"));
  } catch (error) {
    return { problem: `drop-in-file ${file} is not readable JSON (${error.message})` };
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    return { problem: `drop-in-file ${file} is not a JSON object` };
  }
  const extra = Object.keys(settings).filter((key) => !ALLOWED_KEYS.includes(key));
  if (extra.length > 0) {
    return { problem: `drop-in-file ${file} sets ${extra.join(", ")}; a drop-in may set only ${ALLOWED_KEYS.join(", ")}` };
  }
  const configs = settings.pluginConfigs;
  if (configs === null || typeof configs !== "object" || Array.isArray(configs)) {
    return { problem: `drop-in-file ${file} has no pluginConfigs object` };
  }
  return { json: `${JSON.stringify(settings, null, 2)}\n` };
}

module.exports = { readDropIn };

if (require.main === module) {
  const verdict = readDropIn(process.env.DROP_IN_FILE, process.env.DROP_IN_NAME);
  if (verdict.problem) {
    process.stdout.write(`::error title=apply-claude-managed-settings::${verdict.problem}\n`);
    process.exit(1);
  }
  process.stdout.write(verdict.json);
}
