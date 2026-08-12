"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  findExactlyOneOrderedBlock,
  indentLines,
  normalizeNewlines,
  replaceGeneratedBlock,
  renderWorkflow,
  runRenderPass,
  writeOrCheck,
} = require("./render-compose.cjs");
const {
  TARGETS,
  bundledScript,
  filesForTarget,
  main,
  render,
} = require("./render.cjs");

const scriptsDirectory = __dirname;
const repositoryRoot = path.join(scriptsDirectory, "..", "..");

test("manifest covers every render-*.cjs thin wrapper still shipped", () => {
  const wrappers = fs
    .readdirSync(scriptsDirectory)
    .filter(
      (name) =>
        /^render-.+\.cjs$/u.test(name) &&
        !name.startsWith("render-compose"),
    )
    .sort();
  assert.deepEqual(wrappers, [
    "render-find-tracking-issue.cjs",
    "render-osv-scan-guard.cjs",
    "render-select-runner-workflow.cjs",
  ]);
  assert.deepEqual(Object.keys(TARGETS).sort(), [
    "find-tracking-issue",
    "osv-scan-guard",
    "select-runner-workflow",
  ]);
});

test("exactly-one ordered block rejects missing, reversed, and duplicate markers", () => {
  const begin = "BEGIN";
  const end = "END";
  assert.throws(
    () => findExactlyOneOrderedBlock("no markers", begin, end),
    /exactly one ordered generated block/u,
  );
  assert.throws(
    () => findExactlyOneOrderedBlock("END before BEGIN", begin, end),
    /exactly one ordered generated block/u,
  );
  assert.throws(
    () =>
      findExactlyOneOrderedBlock(
        "BEGIN one END BEGIN two END",
        begin,
        end,
      ),
    /exactly one ordered generated block/u,
  );
  const ok = findExactlyOneOrderedBlock("pre BEGIN body END post", begin, end);
  assert.equal(ok.start, "pre ".length);
  assert.equal(ok.end, "pre BEGIN body ".length);
});

test("replaceGeneratedBlock preserves surrounding text", () => {
  const out = replaceGeneratedBlock(
    "pre\nBEGIN\nold\nEND\npost\n",
    "BEGIN",
    "END",
    "BEGIN\nnew\nEND",
  );
  assert.equal(out, "pre\nBEGIN\nnew\nEND\npost\n");
});

test("indentLines leaves blank lines blank", () => {
  assert.deepEqual(indentLines(["a", "", "b"], "  "), ["  a", "", "  b"]);
});

test("normalizeNewlines collapses CRLF", () => {
  assert.equal(normalizeNewlines("a\r\nb\r\n"), "a\nb\n");
});

test("renderWorkflow names failures after the workflow file", () => {
  assert.throws(
    () =>
      renderWorkflow({
        workflow: "no markers here",
        source: "echo hi\n",
        beginMarker: "BEGIN",
        endMarker: "END",
        bundle: () => "BEGIN\nEND",
        name: "example.yml",
      }),
    /example\.yml: workflow must contain exactly one ordered generated block/u,
  );
});

test("writeOrCheck reports drift under --check without writing", () => {
  const filePath = path.join(
    require("node:os").tmpdir(),
    `render-compose-scratch-${process.pid}.txt`,
  );
  fs.writeFileSync(filePath, "current\n", "utf8");
  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    assert.equal(
      writeOrCheck({
        filePath,
        current: "current\n",
        expected: "expected\n",
        check: true,
        driftMessage: "drifted\n",
      }),
      false,
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), "current\n");
    assert.deepEqual(chunks, ["drifted\n"]);
  } finally {
    process.stderr.write = originalWrite;
    fs.rmSync(filePath, { force: true });
  }
});

test("runRenderPass returns exit 1 when any file drifts under --check", () => {
  const code = runRenderPass({
    check: true,
    files: [
      {
        filePath: "/dev/null",
        current: "a",
        expected: "a",
        driftMessage: "a\n",
      },
      {
        filePath: "/dev/null",
        current: "b",
        expected: "c",
        driftMessage: "b-drift\n",
      },
    ],
  });
  assert.equal(code, 1);
});

test("each thin wrapper --check stays green (no generated-output change)", () => {
  for (const wrapper of [
    "render-osv-scan-guard.cjs",
    "render-find-tracking-issue.cjs",
    "render-select-runner-workflow.cjs",
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.join(scriptsDirectory, wrapper), "--check"],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `${wrapper}: ${result.stdout}\n${result.stderr}`,
    );
  }
});

test("render.cjs --check covers the full manifest", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(scriptsDirectory, "render.cjs"), "--check"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("manifest render matches thin-wrapper exports byte-for-byte on fixtures", () => {
  for (const [id, target] of Object.entries(TARGETS)) {
    const source = fs.readFileSync(
      path.join(scriptsDirectory, target.source),
      "utf8",
    );
    const viaManifest = bundledScript(id, source);
    for (const workflowName of target.workflows) {
      const workflow = fs.readFileSync(
        path.join(repositoryRoot, ".github", "workflows", workflowName),
        "utf8",
      );
      const expected = render(id, workflow, source, workflowName);
      assert.ok(
        expected.includes(viaManifest),
        `${id}/${workflowName}: bundled block missing from render output`,
      );
      assert.equal(
        filesForTarget(id).find((file) =>
          file.filePath.endsWith(workflowName),
        )?.expected,
        normalizeNewlines(expected),
      );
    }
  }
});

test("main rejects unknown target ids", () => {
  assert.throws(
    () => main(["node", "render.cjs", "not-a-real-target"]),
    /unknown render target 'not-a-real-target'/u,
  );
});
