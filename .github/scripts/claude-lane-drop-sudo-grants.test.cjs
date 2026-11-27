"use strict";

// drop-sudo-grants.sh runs as root inside install-subprocess-isolation's
// remove-sudo step. Here it runs against a stand-in for /etc, so each case
// shows which sudo rules it removes for one runner identity.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.join(
  __dirname,
  "..",
  "actions",
  "install-subprocess-isolation",
  "drop-sudo-grants.sh",
);

// The runner user of the official actions-runner image: uid 1001, in its own
// group, sudo (gid 27) and docker (gid 123).
const RUNNER = [
  "ALL",
  "runner",
  "#1001",
  "%runner",
  "%sudo",
  "%docker",
  "%#1001",
  "%#27",
  "%#123",
];

// The /etc/sudoers that actions/runner's images/Dockerfile writes.
const IMAGE_SUDOERS =
  '%sudo   ALL=(ALL:ALL) NOPASSWD:ALL\nDefaults env_keep += "DEBIAN_FRONTEND"\n';

// Ubuntu's stock /etc/sudoers, which reads /etc/sudoers.d.
const UBUNTU_SUDOERS = [
  "Defaults\tenv_reset",
  'Defaults\tsecure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"',
  "root\tALL=(ALL:ALL) ALL",
  "%admin ALL=(ALL) ALL",
  "%sudo\tALL=(ALL:ALL) ALL",
  "@includedir /etc/sudoers.d",
  "",
].join("\n");

function run({ sudoers, dropIns = {}, principals }) {
  const etc = fs.mkdtempSync(path.join(os.tmpdir(), "drop-sudo-grants-"));
  try {
    fs.writeFileSync(path.join(etc, "sudoers"), sudoers);
    fs.mkdirSync(path.join(etc, "sudoers.d"));
    for (const [name, body] of Object.entries(dropIns))
      fs.writeFileSync(path.join(etc, "sudoers.d", name), body);
    const result = spawnSync("bash", [script, etc, ...principals], {
      encoding: "utf8",
    });
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      sudoers: fs.readFileSync(path.join(etc, "sudoers"), "utf8"),
      dropIns: fs.readdirSync(path.join(etc, "sudoers.d")).sort(),
    };
  } finally {
    fs.rmSync(etc, { recursive: true, force: true });
  }
}

test("the image's %sudo rule is dropped and its Defaults line kept", () => {
  const r = run({ sudoers: IMAGE_SUDOERS, principals: RUNNER });
  assert.equal(r.status, 0, r.output);
  assert.equal(r.sudoers, 'Defaults env_keep += "DEBIAN_FRONTEND"\n');
});

test("a drop-in naming the runner is deleted and the stock sudoers left alone for a runner outside sudo and admin", () => {
  const r = run({
    sudoers: UBUNTU_SUDOERS,
    dropIns: {
      runner: "runner ALL=(ALL) NOPASSWD:ALL\n",
      "90-cloud-init-users": "ubuntu ALL=(ALL) NOPASSWD:ALL\n",
      README: "# Files in this directory are read by sudo.\n",
    },
    principals: ["ALL", "runner", "#1001", "%docker", "%#118"],
  });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.dropIns, ["90-cloud-init-users", "README"]);
  assert.equal(r.sudoers, UBUNTU_SUDOERS);
});

test("rules for a group, a uid, ALL or a user list holding the runner are dropped; a longer name is not the runner", () => {
  const r = run({
    sudoers: [
      "%#27 ALL=(ALL) ALL",
      "#1001 ALL=(ALL) ALL",
      "ALL ALL=(ALL) NOPASSWD: /usr/bin/apt-get",
      "alice,runner ALL=(ALL) ALL",
      "  runner\tALL=(ALL) ALL",
      "runner2 ALL=(ALL) ALL",
      "%sudoers ALL=(ALL) ALL",
      "",
    ].join("\n"),
    dropIns: {
      "50-group": "%docker ALL=(ALL) NOPASSWD:ALL\n",
      "60-other": "bob ALL=(ALL) ALL\n",
    },
    principals: RUNNER,
  });
  assert.equal(r.status, 0, r.output);
  assert.equal(r.sudoers, "runner2 ALL=(ALL) ALL\n%sudoers ALL=(ALL) ALL\n");
  assert.deepEqual(r.dropIns, ["60-other"]);
});
