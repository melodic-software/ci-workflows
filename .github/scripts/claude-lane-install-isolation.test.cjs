"use strict";

// Every Claude lane installs bubblewrap and socat through one composite,
// .github/actions/install-subprocess-isolation, so a fix lands in every lane
// at once. The script's behaviour is run here against stand-ins for sudo and
// apt-get, on a PATH that holds no real bwrap or socat.

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsDir = path.join(__dirname, "..", "workflows");
const actionDir = path.join(__dirname, "..", "actions", "install-subprocess-isolation");
const COMPOSITE = "$/.github/actions/install-subprocess-isolation";
const FAIL_CLOSED =
  "::error::bubblewrap or socat is not installed; Claude Code cannot scrub its subprocess environment";

const steps = (file) =>
  Object.values(
    parseWorkflow(fs.readFileSync(path.join(workflowsDir, file), "utf8")).jobs,
  ).flatMap((job) => job.steps ?? []);

const isolationSteps = (file) => steps(file).filter((step) => step.uses === COMPOSITE);

test("both review lanes run the same subprocess isolation step", () => {
  const [review] = isolationSteps("pr-review.yml");
  const [security] = isolationSteps("pr-review-security.yml");
  assert.deepEqual(review, security);
  assert.equal(review.name, "Install subprocess isolation");
});

// Each lane job that runs Claude under the scrub installs through the composite,
// and the lanes that remove sudo in the same step still do.
test("every lane job installs through the composite", () => {
  const expected = {
    "pr-review.yml": [1, undefined],
    "pr-review-security.yml": [1, undefined],
    "intake-triage.yml": [3, "true"],
    "pr-review-cli.yml": [3, "true"],
  };
  for (const [file, [count, removeSudo]] of Object.entries(expected)) {
    const found = isolationSteps(file);
    assert.equal(found.length, count, file);
    for (const step of found) assert.equal(step.with?.["remove-sudo"], removeSudo, `${file}: ${step.name}`);
  }
});

const INLINE_APT = /apt[-_]get[^\n]*install[^\n]*\b(bubblewrap|socat)\b/;

test("the inline-apt pattern matches the install lines the lanes used to carry", () => {
  assert.match("if ! apt_get install -y --no-install-recommends bubblewrap socat; then", INLINE_APT);
  assert.match("sudo apt-get install -y socat", INLINE_APT);
});

test("no workflow installs bubblewrap or socat with its own apt-get line", () => {
  const inline = fs
    .readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/.test(file))
    .filter((file) => INLINE_APT.test(fs.readFileSync(path.join(workflowsDir, file), "utf8")));
  assert.deepEqual(inline, []);
});

// Repairs and backoffs share the budget, so only the last call's 2 s kill
// grace runs past it; 10 s covers that and process start-up.
test("every isolation step's limit holds the whole apt budget", () => {
  const action = fs.readFileSync(path.join(actionDir, "action.yml"), "utf8");
  const budget = Number(/budget-seconds:[\s\S]*?default: "(\d+)"/.exec(action)?.[1]);
  assert.ok(budget > 0, "action.yml declares a budget");
  for (const file of ["pr-review.yml", "pr-review-security.yml", "intake-triage.yml", "pr-review-cli.yml"]) {
    for (const step of isolationSteps(file)) {
      const budgetUsed = Number(step.with?.["budget-seconds"] ?? budget);
      assert.ok(budgetUsed + 10 <= step["timeout-minutes"] * 60, `${file}: ${step.name}`);
    }
  }
});

const sh = (body) => `#!/bin/bash\n${body}\n`;

// apt-get stand-in. FAKE_APT: `down` fails every call; `lists` installs without
// an index refresh; `stale` installs only after `update`. Installing writes bwrap
// and socat into the PATH directory.
const APT_GET = sh(`
echo "apt-get $*" >>"$FAKE_LOG"
args=" $* "
if [ "$FAKE_APT" = down ]; then
  exit 100
elif [[ $args == *" update "* ]]; then
  touch "$FAKE_STATE/updated"; exit 0
elif [ "$FAKE_APT" = stale ] && [ ! -e "$FAKE_STATE/updated" ]; then
  exit 100
fi
for tool in bwrap socat; do printf '#!/bin/bash\\n' >"$FAKE_BIN/$tool"; chmod +x "$FAKE_BIN/$tool"; done
`);

const TOOLS = ["bash", "timeout", "touch", "chmod", "date"];

function run({ apt, preinstalled = [], budget = "540" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-isolation-"));
  try {
    const bin = path.join(root, "bin");
    const state = path.join(root, "state");
    fs.mkdirSync(bin);
    fs.mkdirSync(state);
    for (const tool of TOOLS) {
      const real = execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
      fs.symlinkSync(real, path.join(bin, tool));
    }
    const stubs = { sudo: sh('exec "$@"'), sleep: sh(":"), sysctl: sh(":"), dpkg: sh(`echo "dpkg $*" >>"$FAKE_LOG"`), "apt-get": APT_GET };
    for (const tool of preinstalled) stubs[tool] = sh(":");
    for (const [name, body] of Object.entries(stubs)) {
      fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
    }
    const log = path.join(root, "log");
    fs.writeFileSync(log, "");
    const result = spawnSync(path.join(bin, "bash"), [path.join(actionDir, "install.sh")], {
      encoding: "utf8",
      env: { PATH: bin, BUDGET_SECONDS: budget, FAKE_LOG: log, FAKE_BIN: bin, FAKE_STATE: state, FAKE_APT: apt },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      calls: fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      installed: fs.existsSync(path.join(bin, "bwrap")) && fs.existsSync(path.join(bin, "socat")),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const aptCalls = (calls) => calls.filter((c) => c.startsWith("apt-get "));
const updates = (calls) => calls.filter((c) => / update /.test(` ${c} `)).length;

test("fresh image lists install without an index refresh", () => {
  const r = run({ apt: "lists" });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.installed, true);
  assert.equal(aptCalls(r.calls).length, 1, `one apt-get call, got: ${r.calls}`);
  assert.equal(updates(r.calls), 0);
});

test("stale image lists fall back to update and install, repairing dpkg once", () => {
  const r = run({ apt: "stale" });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.installed, true);
  assert.deepEqual(
    r.calls.map((c) => c.split(" ").find((w) => ["install", "update", "--configure"].includes(w))),
    ["install", "--configure", "update", "install"],
  );
});

test("no Acquire override shadows the image's mirror failover settings", () => {
  const r = run({ apt: "stale" });
  assert.ok(!r.calls.some((c) => /Acquire::/.test(c)), `got: ${r.calls}`);
});

test("both tools already present make no apt call", () => {
  const r = run({ apt: "down", preinstalled: ["bwrap", "socat"] });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.calls, []);
});

test("a mirror that never answers fails closed after three refresh attempts", () => {
  const r = run({ apt: "down" });
  assert.equal(r.status, 1);
  assert.equal(r.installed, false);
  assert.equal(updates(r.calls), 3, `three update attempts, got: ${r.calls}`);
  assert.ok(r.stdout.includes(FAIL_CLOSED), r.stdout);
});

test("a spent budget makes no apt-get or dpkg call and fails closed", () => {
  const r = run({ apt: "down", budget: "0" });
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, []);
  assert.ok(r.stdout.includes(FAIL_CLOSED), r.stdout);
});

test("bubblewrap present but socat missing fails closed", () => {
  const r = run({ apt: "down", preinstalled: ["bwrap"] });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(FAIL_CLOSED), r.stdout);
});
