"use strict";

// The org switch and the repository switch each proceed only on exactly
// `false`. Unset, empty and every other value stop the lane (fail closed).

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");

function checkKillSwitch(value, repoValue) {
  return value === "false" && repoValue === "false"
    ? { proceed: "true", reason: "ok", cause: "ok" }
    : { proceed: "false", reason: "kill-switch", cause: "switch" };
}

// Every value is written in the delimited form, so no value can start a
// second output line.
function writeOutputs(outputs, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is not set");
  let text = "";
  for (const [name, value] of Object.entries(outputs)) {
    const delimiter = `ghadelimiter_${randomUUID()}`;
    const body = String(value);
    if (body.includes(delimiter)) {
      throw new Error(`output ${name} contains its delimiter`);
    }
    text += `${name}<<${delimiter}\n${body}\n${delimiter}\n`;
  }
  fs.appendFileSync(outputPath, text);
}

function main(env = process.env, log = (line) => console.log(line)) {
  const result = checkKillSwitch(env.KILL_SWITCH_VALUE, env.REPO_KILL_SWITCH_VALUE);
  writeOutputs(result, env.GITHUB_OUTPUT);
  log(`check-kill-switch: proceed=${result.proceed} reason=${result.reason} cause=${result.cause}`);
}

if (require.main === module) {
  main();
}

module.exports = { checkKillSwitch, main, writeOutputs };
