"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const actionDir = path.join(__dirname, "..", "actions", "check-managed-files");
const verifySyncCommits = require(path.join(actionDir, "sync-commits.cjs"));

// Identity fields of a real sync commit (ci-workflows#701).
const BOT = "melodic-standards-sync[bot]";
const BOT_EMAIL =
  "300666570+melodic-standards-sync[bot]@users.noreply.github.com";
const HEAD_SHA = "fedcba9876543210fedcba9876543210fedcba98";

// --- commit checks ---------------------------------------------------------

function commit(
  sha,
  {
    login = BOT,
    email = BOT_EMAIL,
    committer = "web-flow",
    verified = true,
    reason = "valid",
  } = {},
) {
  return {
    sha,
    author: login === null ? null : { login },
    committer: committer === null ? null : { login: committer },
    commit: {
      message: "chore: sync standards components",
      author: { email },
      verification: { verified, reason },
    },
  };
}

function fakeGithub({ commits, listError } = {}) {
  return {
    rest: { pulls: { listCommits: "pulls.listCommits" } },
    paginate: async (method, params) => {
      assert.equal(method, "pulls.listCommits");
      assert.equal(params.pull_number, 7);
      if (listError) throw listError;
      return commits;
    },
  };
}

async function runCommits(github) {
  const core = {
    errors: [],
    failed: undefined,
    error(message) {
      this.errors.push(message);
    },
    setFailed(message) {
      this.failed = message;
    },
  };
  const passed = await verifySyncCommits({
    github,
    core,
    owner: "melodic-software",
    repo: "claude-code-plugins",
    pullNumber: 7,
    headSha: HEAD_SHA,
  });
  return { core, passed };
}

function assertFailed({ core, passed }, ...fragments) {
  assert.equal(passed, false);
  assert.match(core.failed, /Re-run the standards sync/u);
  assert.match(core.failed, /do not hand-edit/u);
  const all = core.errors.join("\n");
  for (const fragment of fragments) assert.ok(all.includes(fragment), all);
}

test("a sync commit matching the live identity passes", async () => {
  const { core, passed } = await runCommits(
    fakeGithub({ commits: [commit(HEAD_SHA)] }),
  );
  assert.equal(passed, true);
  assert.equal(core.failed, undefined);
  assert.deepEqual(core.errors, []);
});

test("a commit authored by anyone but the sync App fails, named", async () => {
  const other = "1111111111111111111111111111111111111111";
  const result = await runCommits(
    fakeGithub({
      commits: [commit(other, { login: "some-contributor" }), commit(HEAD_SHA)],
    }),
  );
  assertFailed(result, `commit ${other}: author some-contributor`);
});

test("a commit with no linked GitHub account fails", async () => {
  assertFailed(
    await runCommits(
      fakeGithub({ commits: [commit(HEAD_SHA, { login: null })] }),
    ),
    `commit ${HEAD_SHA}: author (no GitHub account)`,
  );
});

test("the bot login with another author email fails", async () => {
  assertFailed(
    await runCommits(
      fakeGithub({
        commits: [commit(HEAD_SHA, { email: "someone@example.com" })],
      }),
    ),
    `commit ${HEAD_SHA}: author email someone@example.com`,
  );
});

// A user who pushes their own signed commit under the bot's author fields
// is the committer GitHub verified, so the committer must be web-flow.
test("a verified commit with a committer other than web-flow fails", async () => {
  assertFailed(
    await runCommits(
      fakeGithub({
        commits: [commit(HEAD_SHA, { committer: "some-contributor" })],
      }),
    ),
    `commit ${HEAD_SHA}: committer some-contributor, not web-flow`,
  );
});

test("an unverified commit fails, named", async () => {
  assertFailed(
    await runCommits(
      fakeGithub({
        commits: [commit(HEAD_SHA, { verified: false, reason: "unsigned" })],
      }),
    ),
    `commit ${HEAD_SHA}: signature verified=false, reason unsigned`,
  );
});

test("a verified commit whose reason is not valid fails", async () => {
  assertFailed(
    await runCommits(
      fakeGithub({ commits: [commit(HEAD_SHA, { reason: "unknown_key" })] }),
    ),
    `commit ${HEAD_SHA}: signature verified=true, reason unknown_key`,
  );
});

test("a listed head other than the checked head fails", async () => {
  const moved = "3333333333333333333333333333333333333333";
  assertFailed(
    await runCommits(fakeGithub({ commits: [commit(moved)] })),
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
    await runCommits(fakeGithub({ commits: [...many, commit(HEAD_SHA)] })),
    "the PR lists 250 commits",
  );
});

test("an unreadable commit list fails", async () => {
  assertFailed(
    await runCommits(
      fakeGithub({ listError: new Error("Resource not accessible") }),
    ),
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

// Standards main holds the managed sources for TARGET at its first commit;
// `mutateStandards` runs in a second commit, so main HEAD moves past the
// commit the head was synced from. The target's base has older copies, and
// its head is the faithful sync unless `mutateHead` changes it.
function fixture({
  mutateHead = () => {},
  mutateBase = () => {},
  mutateStandards,
} = {}) {
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
  git(standards, "add", "--all");
  git(standards, "commit", "--quiet", "--message", "standards");
  if (mutateStandards) {
    mutateStandards(standards);
    git(standards, "add", "--all");
    git(standards, "commit", "--quiet", "--message", "standards moved");
  }

  git(target, "init", "--quiet", "--initial-branch=main");
  write(target, "README.md", "target\n");
  write(target, "managed/config.txt", "config v1\n");
  write(target, "managed/tool.sh", "#!/bin/sh\necho v1\n", 0o755);
  mutateBase(target);
  git(target, "add", "--all");
  git(target, "commit", "--quiet", "--message", "base");
  const base = git(target, "rev-parse", "HEAD");
  write(target, "managed/config.txt", "config v2\n");
  write(target, "managed/tool.sh", "#!/bin/sh\necho v2\n", 0o755);
  mutateHead(target);
  git(target, "add", "--all");
  git(target, "commit", "--quiet", "--allow-empty", "--message", "sync");

  return {
    dir,
    standards,
    target,
    base,
    head: git(target, "rev-parse", "HEAD"),
    sha: git(standards, "rev-parse", "HEAD"),
  };
}

function runScript(script, fx, overrides = {}) {
  try {
    const result = spawnSync("bash", [path.join(actionDir, script)], {
      cwd: fx.target,
      env: {
        ...gitEnv,
        REPOSITORY: TARGET,
        BASE_REF: fx.base,
        HEAD_REF: fx.head,
        STANDARDS_ROOT: fx.standards,
        ...overrides,
      },
      encoding: "utf8",
    });
    return { ...result, worktrees: git(fx.target, "worktree", "list") };
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
}

const verify = (fx, overrides) => runScript("verify-sync.sh", fx, overrides);

function assertRejected(result, sha, ...fragments) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes(sha), result.stderr);
  assert.match(result.stderr, /Re-run the standards sync/u);
  assert.match(result.stderr, /do not hand-edit/u);
  for (const f of fragments)
    assert.ok(result.stderr.includes(f), result.stderr);
}

test("a faithful sync's content passes and leaves no scratch worktree", () => {
  const fx = fixture();
  const result = verify(fx);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`main@${fx.sha} exactly`, "u"));
  assert.equal(result.worktrees.split("\n").length, 1, result.worktrees);
});

test("a sync PR replaying older standards content than main fails", () => {
  const fx = fixture({
    mutateStandards: (s) => write(s, "src/config.txt", "config v3\n"),
  });
  assertRejected(
    verify(fx),
    fx.sha,
    `managed/config.txt: differs from apply at ${fx.sha}`,
  );
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
    `managed/config.txt: differs from apply at ${fx.sha}`,
  );
});

test("a managed mode that differs from apply fails, named", () => {
  const fx = fixture({
    mutateHead: (t) => fs.chmodSync(path.join(t, "managed/tool.sh"), 0o644),
  });
  assertRejected(
    verify(fx),
    fx.sha,
    `managed/tool.sh: differs from apply at ${fx.sha}`,
  );
});

test("a managed file the head omits under a gitignore rule fails", () => {
  const fx = fixture({
    mutateBase: (t) => write(t, ".gitignore", "managed/new.txt\n"),
    mutateStandards: (s) => {
      write(s, "src/new.txt", "new\n");
      fs.appendFileSync(
        path.join(s, "fixture-map.tsv"),
        `${TARGET}\tsrc/new.txt\tmanaged/new.txt\n`,
      );
    },
  });
  assertRejected(
    verify(fx),
    fx.sha,
    `managed/new.txt: differs from apply at ${fx.sha} (!!)`,
  );
});

test("standards main without sync-manifest.mjs fails", () => {
  const fx = fixture({
    mutateStandards: (s) =>
      fs.rmSync(path.join(s, "distribution/sync-manifest.mjs")),
  });
  assertRejected(
    verify(fx),
    fx.sha,
    `standards@${fx.sha} has no distribution/sync-manifest.mjs`,
  );
});

test("a standards root that is not a Git checkout fails", () => {
  const fx = fixture();
  const empty = path.join(fx.dir, "empty");
  fs.mkdirSync(empty);
  assertRejected(
    verify(fx, { STANDARDS_ROOT: empty }),
    "resolved to unknown",
    `could not resolve the standards checkout at ${empty}`,
  );
});

test("a target the manifest does not manage fails", () => {
  const fx = fixture();
  assertRejected(
    verify(fx, { REPOSITORY: "melodic-software/other" }),
    fx.sha,
    "melodic-software/other is not a sync-manifest target at this SHA",
  );
});

// --- hand-edit check -------------------------------------------------------

test("a hand-edit points at the sync workflow, not a label", () => {
  const fx = fixture();
  const result = runScript("run.sh", fx);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /managed\/config\.txt/u);
  assert.match(result.stderr, /opened by the sync workflow/u);
  assert.match(result.stderr, /verified automatically/u);
  assert.doesNotMatch(result.stderr, /label the PR/u);
});

const keepToolAtBase = (target) =>
  write(target, "managed/tool.sh", "#!/bin/sh\necho v1\n", 0o755);

test("deleting only a managed file fails the hand-edit check", () => {
  const fx = fixture({
    mutateHead: (target) => {
      keepToolAtBase(target);
      fs.rmSync(path.join(target, "managed/config.txt"));
    },
  });
  const result = runScript("run.sh", fx);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /- managed\/config\.txt/u);
  assert.doesNotMatch(result.stderr, /managed\/tool\.sh/u);
});

test("renaming a managed file reports its old path", () => {
  const body = "line of managed config\n".repeat(20);
  const fx = fixture({
    mutateBase: (target) => write(target, "managed/config.txt", body),
    mutateHead: (target) => {
      keepToolAtBase(target);
      fs.rmSync(path.join(target, "managed/config.txt"));
      write(target, "other/config.txt", body);
    },
  });
  const result = runScript("run.sh", fx);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /- managed\/config\.txt/u);
});

// --- Dependabot mode -------------------------------------------------------

const { dependabotMode } = verifySyncCommits;
const DEPENDABOT_ID = 49699333;
const WEB_FLOW_ID = 19864447;

function dependabotCommit(
  sha,
  {
    author = DEPENDABOT_ID,
    committer = WEB_FLOW_ID,
    verified = true,
    reason = "valid",
  } = {},
) {
  return {
    sha,
    author: author === null ? null : { id: author, login: "dependabot[bot]" },
    committer: { id: committer, login: "web-flow" },
    commit: { verification: { verified, reason } },
  };
}

async function runDependabot(commits, listError) {
  const core = {
    warnings: [],
    info() {},
    warning(message) {
      this.warnings.push(message);
    },
  };
  const selected = await dependabotMode({
    github: fakeGithub({ commits, listError }),
    core,
    owner: "melodic-software",
    repo: "claude-code-plugins",
    pullNumber: 7,
    headSha: HEAD_SHA,
  });
  return { selected, warnings: core.warnings.join("\n") };
}

test("a Dependabot PR whose every commit is Dependabot's, verified, is skipped", async () => {
  const earlier = "1111111111111111111111111111111111111111";
  const { selected, warnings } = await runDependabot([
    dependabotCommit(earlier),
    dependabotCommit(HEAD_SHA),
  ]);
  assert.equal(selected, "skip");
  assert.equal(warnings, "");
});

test("a Dependabot PR with one foreign commit fails the hand-edit check on a managed edit", async () => {
  const foreign = "2222222222222222222222222222222222222222";
  const { selected, warnings } = await runDependabot([
    dependabotCommit(foreign, { author: 12345 }),
    dependabotCommit(HEAD_SHA),
  ]);
  assert.equal(selected, "hand-edit");
  assert.ok(warnings.includes(`commit ${foreign}: author id 12345`), warnings);
  const result = runScript("run.sh", fixture());
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /managed\/config\.txt/u);
});

test("an unverified Dependabot commit is not skipped", async () => {
  const { selected, warnings } = await runDependabot([
    dependabotCommit(HEAD_SHA, { verified: false, reason: "unsigned" }),
  ]);
  assert.equal(selected, "hand-edit");
  assert.ok(warnings.includes("verified=false, reason unsigned"), warnings);
});

test("a Dependabot commit not committed by web-flow is not skipped", async () => {
  const { selected } = await runDependabot([
    dependabotCommit(HEAD_SHA, { committer: 12345 }),
  ]);
  assert.equal(selected, "hand-edit");
});

test("a Dependabot PR whose listed head is not the checked head is not skipped", async () => {
  const moved = "3333333333333333333333333333333333333333";
  const { selected, warnings } = await runDependabot([dependabotCommit(moved)]);
  assert.equal(selected, "hand-edit");
  assert.ok(warnings.includes(`last listed commit ${moved}`), warnings);
});

test("an empty or unreadable Dependabot commit list is not skipped", async () => {
  assert.equal((await runDependabot([])).selected, "hand-edit");
  assert.equal(
    (await runDependabot([], new Error("Resource not accessible"))).selected,
    "hand-edit",
  );
});
