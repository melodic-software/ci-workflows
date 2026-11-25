"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { FILE_LIST_CAP, writePullPaths } = require("./pull-files.cjs");

function fakeCore() {
  return {
    infos: [],
    warnings: [],
    info(message) {
      this.infos.push(message);
    },
    warning(message) {
      this.warnings.push(message);
    },
  };
}

function fakeGithub(answer) {
  return {
    rest: { pulls: { listFiles: "pulls.listFiles" } },
    paginate: async (method, params) => {
      assert.equal(method, "pulls.listFiles");
      assert.equal(params.pull_number, 12);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

async function write(answer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pull-files-"));
  const core = fakeCore();
  const file = await writePullPaths({
    github: fakeGithub(answer),
    core,
    owner: "melodic-software",
    repo: "target",
    pullNumber: 12,
    dir,
    sleep: async () => {},
  });
  return { core, dir, file };
}

test("writes the changed paths NUL-separated, both paths of a rename included", async () => {
  const { dir, file } = await write([
    { filename: "a.txt" },
    { filename: "docs/new.md", previous_filename: "REVIEW.md" },
  ]);
  assert.equal(file, path.join(dir, "pr-12"));
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "a.txt\0docs/new.md\0REVIEW.md\0",
  );
});

test("an empty diff writes an empty list, not a fallback", async () => {
  const { file } = await write([]);
  assert.notEqual(file, "");
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("a list at the API cap falls back to the clone", async () => {
  const files = Array.from({ length: FILE_LIST_CAP }, (_, i) => ({
    filename: `f${i}`,
  }));
  const { core, dir, file } = await write(files);
  assert.equal(file, "");
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.match(core.infos.join("\n"), /lists 3000 files, the API cap/u);
});

test("an unreadable list falls back to the clone with a warning", async () => {
  const error = Object.assign(new Error("Not Found"), {
    status: 404,
    response: { status: 404, headers: {} },
  });
  const { core, file } = await write(error);
  assert.equal(file, "");
  assert.match(
    core.warnings.join("\n"),
    /could not list the files of pull request #12.*diffing a clone instead/su,
  );
});
