"use strict";

// Lints this repository with the kjanat/actionlint fork and the pinned rhysd
// baseline, then groups the fork's findings for the #788 soak tally.
// Usage: node actionlint-kjanat-soak.cjs <fork-binary> <rhysd-binary>
// Findings alone exit 0. Exit 1 when a binary fails (exit 2 or higher, or
// output that is not JSON), or when the fork rejects `$/` or `queue`.
//
// ShellCheck and pyflakes are off for both binaries: both run the same external
// tools, and the gating actionlint lane already runs the pinned ShellCheck.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG = ".github/actionlint.yaml";
const PROBE = "fixtures/actionlint-kjanat-soak/support-probe.yml";
// The two workaround ignores phase 2 deletes. The fork's config is the repo
// config without exactly these lines, so any other ignore still applies.
const WORKAROUND_IGNORES = [
  `      - 'specifying action "\\$/[^"]+" in invalid format because ref is missing'`,
  `      - 'unexpected key "queue" for "concurrency" section'`,
];
const CACHE_RULES = new Set([
  "cache-call-unrestricted",
  "cache-operation",
  "cache-write-untrusted",
]);
const REJECTS_REF =
  /^specifying action "\$\/[^"]*" in invalid format because ref is missing/u;
const REJECTS_QUEUE = /^unexpected key "queue" for "concurrency" section/u;
const MENTIONS_SUPPORT = /"\$\/|\bqueue\b/u;

const [forkBinary, rhysdBinary] = process.argv.slice(2);
if (forkBinary === undefined || rhysdBinary === undefined) {
  console.error(
    "usage: actionlint-kjanat-soak.cjs <fork-binary> <rhysd-binary>",
  );
  process.exit(2);
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function version(binary) {
  const run = spawnSync(binary, ["-version"], { encoding: "utf8" });
  if (run.status !== 0) fail(`${binary} -version exited ${run.status}`);
  return run.stdout.split("\n")[0];
}

function lint(binary, args) {
  const run = spawnSync(
    binary,
    ["-shellcheck=", "-pyflakes=", "-format", "{{json .}}", ...args],
    { encoding: "utf8" },
  );
  if (run.error !== undefined) fail(`${binary}: ${run.error.message}`);
  // actionlint exits 1 on findings; 2 is a bad flag or config, 3 a fatal error.
  if (run.status !== 0 && run.status !== 1) {
    fail(`${binary} exited ${run.status}: ${run.stderr}${run.stdout}`);
  }
  try {
    return JSON.parse(run.stdout.trim() || "[]") ?? [];
  } catch {
    fail(`${binary} printed output that is not JSON: ${run.stdout}`);
  }
}

const where = (finding) =>
  `${finding.filepath}:${finding.line}:${finding.column}`;
const line = (finding) =>
  `- \`${where(finding)}\` [${finding.kind}] ${finding.message}`;

const configText = fs.readFileSync(CONFIG, "utf8");
const configLines = configText.split("\n");
const forkLines = configLines.filter((l) => !WORKAROUND_IGNORES.includes(l));
if (configLines.length - forkLines.length !== WORKAROUND_IGNORES.length) {
  fail(`${CONFIG} no longer holds both workaround ignores; update the soak`);
}
const scratch = fs.mkdtempSync(
  path.join(process.env.RUNNER_TEMP || os.tmpdir(), "actionlint-kjanat-soak-"),
);
const forkConfig = path.join(scratch, "actionlint.yaml");
fs.writeFileSync(forkConfig, forkLines.join("\n"));

const fork = lint(forkBinary, ["-config-file", forkConfig]);
const baseline = new Set(
  lint(rhysdBinary, ["-config-file", CONFIG]).map(where),
);
const probe = lint(forkBinary, ["-config-file", forkConfig, PROBE]);

const buckets = { cache: [], support: [], new: [], shared: [] };
for (const finding of fork) {
  if (CACHE_RULES.has(finding.kind)) buckets.cache.push(finding);
  else if (MENTIONS_SUPPORT.test(finding.message))
    buckets.support.push(finding);
  else if (baseline.has(where(finding))) buckets.shared.push(finding);
  else buckets.new.push(finding);
}
const rejected = (finding) =>
  REJECTS_REF.test(finding.message) || REJECTS_QUEUE.test(finding.message);
const regressions = fork.filter(rejected);
const probePassed =
  probe.length === 1 &&
  probe[0].kind === "action" &&
  probe[0].message.startsWith('input "no-such-input" is not defined');

const workflows = fs
  .readdirSync(".github/workflows")
  .filter((name) => /\.ya?ml$/u.test(name))
  .map((name) => fs.readFileSync(path.join(".github/workflows", name), "utf8"))
  .join("\n");
const dollarRefs = workflows.match(/^\s*(?:-\s+)?uses:\s+\$\//gmu)?.length ?? 0;
const queueKeys = workflows.match(/^\s+queue:/gmu)?.length ?? 0;

const section = (title, findings, empty) => [
  `### ${title}: ${findings.length}`,
  "",
  ...(findings.length > 0 ? findings.map(line) : [empty]),
  "",
];
const report = [
  "## kjanat/actionlint soak (#788)",
  "",
  `- Fork: ${version(forkBinary)}, linted with ${CONFIG} minus the \`$/\` and \`queue\` ignores.`,
  `- Baseline: rhysd/actionlint ${version(rhysdBinary)}, linted with ${CONFIG} as the gating lane uses it.`,
  "- ShellCheck and pyflakes are off for both; the gating actionlint lane runs them.",
  "- Classify every finding below for the #788 tally as a true positive, a false positive or a cache-safety-policy finding.",
  "",
  ...section(
    "1. v1.17 cache-safety policies, on by default",
    buckets.cache,
    "None.",
  ),
  `### 2. \`$/\` and \`queue\` support: ${buckets.support.length}`,
  "",
  `- Repository: ${dollarRefs} \`uses: $/\` references and ${queueKeys} \`queue:\` keys linted; ${regressions.length} \`ref is missing\` or \`unexpected key "queue"\` findings.`,
  `- Probe \`${PROBE}\` (the only \`queue\` evidence while this repository has no \`queue:\` key): ${probePassed ? "pass, `queue` and `$/` accepted and the `$/` action's inputs validated" : "FAIL"}.`,
  ...probe.map((finding) => `  ${line(finding)}`),
  ...buckets.support.map(line),
  "",
  ...section(
    "3. New by default: the fork reports it, rhysd 1.7.12 does not",
    buckets.new,
    "None.",
  ),
  ...section(
    "4. Also reported by rhysd 1.7.12 (the gating lane owns these)",
    buckets.shared,
    "None.",
  ),
].join("\n");

console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}
fs.rmSync(scratch, { recursive: true, force: true });
if (regressions.length > 0) fail("the fork rejected `$/` or `queue`");
if (!probePassed) fail(`the support probe ${PROBE} did not pass`);
