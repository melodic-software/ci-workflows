"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const actionDir = path.join(__dirname, "..", "actions", "check-managed-files");
const verifySyncCommits = require(path.join(actionDir, "sync-commits.cjs"));

const BOT = "melodic-standards-sync[bot]";
const STANDARDS_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const SUBJECT = `chore: sync standards components (${STANDARDS_SHA})`;

// --- commit checks ---------------------------------------------------------

function commit(sha, { login = BOT, verified = true, message = SUBJECT } = {}) {
  return {
    sha,
    author: login === null ? null : { login },
    commit: { message, verification: { verified } },
  };
}

// The fake compare answers only for the basehead it is given, so a request
// for the wrong range fails like an unknown ref would.
function fakeGithub({ commits, compares = {}, listError } = {}) {
  return {
    rest: {
      pulls: { listCommits: "pulls.listCommits" },
      repos: {
        compareCommitsWithBasehead: async ({ owner, repo, basehead }) => {
          const data = compares[`${owner}/${repo}:${basehead}`];
          if (!data) throw new Error("Not Found");
          return { data };
        },
      },
    },
    paginate: async (method, params) => {
      assert.equal(method, "pulls.listCommits");
      assert.equal(params.pull_number, 7);
      if (listError) throw listError;
      return commits;
    },
  };
}

const REACHABLE = {
  [`melodic-software/standards:${STANDARDS_SHA}...main`]: {
    status: "ahead",
    merge_base_commit: { sha: STANDARDS_SHA },
  },
};

async function runCommits(github) {
  const core = {
    errors: [],
    failed: undefined,
    outputs: {},
    error(message) {
      this.errors.push(message);
    },
    setFailed(message) {
      this.failed = message;
    },
    setOutput(name, value) {
      this.outputs[name] = value;
    },
  };
  await verifySyncCommits({
    github,
    core,
    owner: "melodic-software",
    repo: "claude-code-plugins",
    pullNumber: 7,
    headSha: HEAD_SHA,
  });
  return core;
}

test("a faithful sync's commits pass and output the synced SHA", async () => {
  const core = await runCommits(
    fakeGithub({ commits: [commit(HEAD_SHA)], compares: REACHABLE }),
  );
  assert.equal(core.failed, undefined);
  assert.deepEqual(core.errors, []);
  assert.deepEqual(core.outputs, { sha: STANDARDS_SHA });
});

test("a SHA identical to standards main passes", async () => {
  const core = await runCommits(
    fakeGithub({
      commits: [commit(HEAD_SHA)],
      compares: {
        [`melodic-software/standards:${STANDARDS_SHA}...main`]: {
          status: "identical",
          merge_base_commit: { sha: STANDARDS_SHA },
        },
      },
    }),
  );
  assert.deepEqual(core.outputs, { sha: STANDARDS_SHA });
});

function assertFailed(core, ...fragments) {
  assert.deepEqual(core.outputs, {});
  assert.match(core.failed, /Re-run the standards sync/u);
  assert.match(core.failed, /do not hand-edit/u);
  const all = core.errors.join("\n");
  for (const fragment of fragments) assert.ok(all.includes(fragment), all);
}

test("a commit authored by anyone but the sync App fails, named", async () => {
  const other = "1111111111111111111111111111111111111111";
  const core = await runCommits(
    fakeGithub({
      commits: [
        commit(other, { login: "some-contributor", message: "tweak" }),
        commit(HEAD_SHA),
      ],
      compares: REACHABLE,
    }),
  );
  assertFailed(core, `commit ${other}: author some-contributor`);
  assert.match(core.failed, new RegExp(`standards@${STANDARDS_SHA}`, "u"));
});

test("a commit with no linked GitHub account fails", async () => {
  const core = await runCommits(
    fakeGithub({
      commits: [commit(HEAD_SHA, { login: null })],
      compares: REACHABLE,
    }),
  );
  assertFailed(core, `commit ${HEAD_SHA}: author (no GitHub account)`);
});

test("an unverified sync-App commit fails, named", async () => {
  const core = await runCommits(
    fakeGithub({
      commits: [commit(HEAD_SHA, { verified: false })],
      compares: REACHABLE,
    }),
  );
  assertFailed(core, `commit ${HEAD_SHA}: author ${BOT}, signature unverified`);
});

test("a head subject without a 40-hex SHA fails", async () => {
  const core = await runCommits(
    fakeGithub({
      commits: [
        commit(HEAD_SHA, {
          message: `chore: sync standards components (${STANDARDS_SHA.slice(0, 39)})`,
        }),
      ],
      compares: REACHABLE,
    }),
  );
  assertFailed(
    core,
    `head commit ${HEAD_SHA} subject names no 40-hex standards SHA`,
  );
});

test("a SHA that diverged from standards main fails", async () => {
  const core = await runCommits(
    fakeGithub({
      commits: [commit(HEAD_SHA)],
      compares: {
        [`melodic-software/standards:${STANDARDS_SHA}...main`]: {
          status: "diverged",
          merge_base_commit: {
            sha: "2222222222222222222222222222222222222222",
          },
        },
      },
    }),
  );
  assertFailed(
    core,
    `standards@${STANDARDS_SHA} is not reachable from standards main`,
  );
});

test("a SHA standards does not know fails", async () => {
  const core = await runCommits(fakeGithub({ commits: [commit(HEAD_SHA)] }));
  assertFailed(
    core,
    `could not compare standards@${STANDARDS_SHA}`,
    "Not Found",
  );
});

test("a listed head other than the checked head fails", async () => {
  const moved = "3333333333333333333333333333333333333333";
  const core = await runCommits(
    fakeGithub({ commits: [commit(moved)], compares: REACHABLE }),
  );
  assertFailed(
    core,
    `the last listed commit ${moved} is not the checked head ${HEAD_SHA}`,
  );
});

test("an empty or capped commit list fails", async () => {
  assertFailed(
    await runCommits(fakeGithub({ commits: [] })),
    "the PR lists no commits",
  );
  const many = Array.from({ length: 249 }, (_, i) =>
    commit(i.toString(16).padStart(40, "0")),
  );
  assertFailed(
    await runCommits(
      fakeGithub({ commits: [...many, commit(HEAD_SHA)], compares: REACHABLE }),
    ),
    "the PR lists 250 commits",
  );
});

test("an unreadable commit list fails", async () => {
  const core = await runCommits(
    fakeGithub({ listError: new Error("Resource not accessible") }),
  );
  assertFailed(
    core,
    "could not list the PR's commits: Resource not accessible",
  );
});

// --- content checks --------------------------------------------------------

const TARGET = "melodic-software/target";

// Stands in for standards' sync-manifest.sh: dest-paths lists the target's
// destinations and apply copies each source with its Git index mode, which is
// the engine contract verify-sync.sh relies on.
const STUB_ENGINE = `#!/usr/bin/env bash
set -euo pipefail
command=$1
shift
while (($#)); do
  case $1 in
    --source-root) source_root=$2 ;;
    --target) target=$2 ;;
    --target-root) target_root=$2 ;;
    *) exit 2 ;;
  esac
  shift 2
done
while IFS=$'\\t' read -r t source dest; do
  [[ $t == "$target" ]] || continue
  case $command in
    dest-paths) printf '%s\\n' "$dest" ;;
    apply)
      mkdir -p "$(dirname "$target_root/$dest")"
      cp "$source_root/$source" "$target_root/$dest"
      if [[ $(git -C "$source_root" ls-files -s -- "$source") == 100755* ]]; then
        chmod 755 "$target_root/$dest"
      else
        chmod 644 "$target_root/$dest"
      fi
      ;;
  esac
done <"$source_root/fixture-map.tsv"
`;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
  }).trim();
}

function write(root, file, content, mode = 0o644) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  fs.chmodSync(full, mode);
}

// Standards holds two managed sources for TARGET; the target's base has older
// copies, and its head is the faithful sync unless `mutateHead` changes it.
function fixture({ mutateHead = () => {}, mutateStandards = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-files-sync-"));
  const standards = path.join(dir, "standards");
  const target = path.join(dir, "target");
  fs.mkdirSync(standards);
  fs.mkdirSync(target);

  git(standards, "init", "--quiet", "--initial-branch=main");
  write(standards, "distribution/sync-manifest.mjs", "// engine marker\n");
  write(standards, "distribution/sync-manifest.sh", STUB_ENGINE, 0o755);
  write(
    standards,
    "fixture-map.tsv",
    `${TARGET}\tsrc/config.txt\tmanaged/config.txt\n${TARGET}\tsrc/tool.sh\tmanaged/tool.sh\n`,
  );
  write(standards, "src/config.txt", "config v2\n");
  write(standards, "src/tool.sh", "#!/bin/sh\necho v2\n", 0o755);
  mutateStandards(standards);
  git(standards, "add", "--all");
  git(standards, "commit", "--quiet", "--message", "standards");

  git(target, "init", "--quiet", "--initial-branch=main");
  write(target, "README.md", "target\n");
  write(target, "managed/config.txt", "config v1\n");
  write(target, "managed/tool.sh", "#!/bin/sh\necho v1\n", 0o755);
  git(target, "add", "--all");
  git(target, "commit", "--quiet", "--message", "base");
  const base = git(target, "rev-parse", "HEAD");
  write(target, "managed/config.txt", "config v2\n");
  write(target, "managed/tool.sh", "#!/bin/sh\necho v2\n", 0o755);
  mutateHead(target);
  git(target, "add", "--all");
  git(target, "commit", "--quiet", "--allow-empty", "--message", SUBJECT);

  return {
    dir,
    standards,
    target,
    base,
    head: git(target, "rev-parse", "HEAD"),
    sha: git(standards, "rev-parse", "HEAD"),
  };
}

function verify(fx, overrides = {}) {
  try {
    const result = spawnSync("bash", [path.join(actionDir, "verify-sync.sh")], {
      cwd: fx.target,
      env: {
        ...gitEnv,
        REPOSITORY: TARGET,
        BASE_REF: fx.base,
        HEAD_REF: fx.head,
        STANDARDS_ROOT: fx.standards,
        SYNC_SHA: fx.sha,
        ...overrides,
      },
      encoding: "utf8",
    });
    return { ...result, worktrees: git(fx.target, "worktree", "list") };
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
}

function assertRejected(result, sha, ...paths) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes(`standards@${sha}`), result.stderr);
  assert.match(result.stderr, /Re-run the standards sync/u);
  assert.match(result.stderr, /do not hand-edit/u);
  for (const p of paths) assert.ok(result.stderr.includes(p), result.stderr);
}

test("a faithful sync's content passes and leaves no scratch worktree", () => {
  const fx = fixture();
  const result = verify(fx);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`matches standards@${fx.sha}`, "u"));
  assert.equal(result.worktrees.split("\n").length, 1, result.worktrees);
});

test("a changed path outside the managed destinations fails, named", () => {
  const fx = fixture({
    mutateHead: (t) => {
      write(t, "README.md", "edited\n");
      write(t, "extra/new.txt", "new\n");
    },
  });
  assertRejected(
    verify(fx),
    fx.sha,
    `README.md: not a managed destination for ${TARGET}`,
    `extra/new.txt: not a managed destination for ${TARGET}`,
  );
});

test("a deletion fails, named", () => {
  const fx = fixture({
    mutateHead: (t) => fs.rmSync(path.join(t, "README.md")),
  });
  assertRejected(verify(fx), fx.sha, "README.md: deleted; sync never deletes");
});

test("a rename fails, named", () => {
  const fx = fixture({
    mutateHead: (t) =>
      fs.renameSync(path.join(t, "README.md"), path.join(t, "docs.md")),
  });
  assertRejected(
    verify(fx),
    fx.sha,
    "README.md -> docs.md: change type R100; sync never renames or copies",
  );
});

test("managed bytes that differ from apply fail, named", () => {
  const fx = fixture({
    mutateHead: (t) => write(t, "managed/config.txt", "config v2 tampered\n"),
  });
  assertRejected(
    verify(fx),
    fx.sha,
    `managed/config.txt: bytes or mode differ from apply at ${fx.sha}`,
  );
});

test("a managed mode that differs from apply fails, named", () => {
  const fx = fixture({
    mutateHead: (t) => fs.chmodSync(path.join(t, "managed/tool.sh"), 0o644),
  });
  assertRejected(
    verify(fx),
    fx.sha,
    `managed/tool.sh: bytes or mode differ from apply at ${fx.sha}`,
  );
});

test("a standards SHA without the Node engine fails", () => {
  const fx = fixture({
    mutateStandards: (s) =>
      fs.rmSync(path.join(s, "distribution/sync-manifest.mjs")),
  });
  assertRejected(verify(fx), fx.sha, "predates the Node sync engine");
});

test("a standards checkout at another commit than the synced SHA fails", () => {
  const fx = fixture();
  const other = "4444444444444444444444444444444444444444";
  assertRejected(verify(fx, { SYNC_SHA: other }), other, `not ${other}`);
});

test("a missing synced SHA fails", () => {
  const fx = fixture();
  assertRejected(
    verify(fx, { SYNC_SHA: "" }),
    "unknown",
    "no verified 40-hex standards SHA",
  );
});

test("a target the manifest does not manage at the SHA fails", () => {
  const fx = fixture();
  assertRejected(
    verify(fx, { REPOSITORY: "melodic-software/other" }),
    fx.sha,
    "melodic-software/other is not a sync-manifest target at this SHA",
  );
});
