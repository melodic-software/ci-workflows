"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const workflow = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "pr-issue-linkage.yml"),
  "utf8",
);

// Extracts the inline actions/github-script body (the same technique used to
// validate the equivalent block ported into melodic-software/medley's
// issue-labeling.yml) and runs it in a sandbox with a stub `core`/`process`,
// so the actual closing-keyword/Related parsing logic is exercised directly
// rather than only checked for structural presence in the YAML text.
function runScript(body) {
  const scriptStart = workflow.indexOf("script: |") + "script: |".length;
  const lines = workflow.slice(scriptStart).split("\n").slice(1);
  const scriptLines = [];
  for (const line of lines) {
    if (line.startsWith("            ")) {
      scriptLines.push(line.slice(12));
    } else if (line.trim() === "") {
      scriptLines.push("");
    } else {
      break;
    }
  }
  assert.ok(scriptLines.length > 10, "extracted script is suspiciously short");

  let failedWith = null;
  const sandbox = {
    process: { env: { PR_BODY: body } },
    core: { setFailed: (message) => (failedWith = message) },
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptLines.join("\n"), sandbox);
  return failedWith;
}

test("a body with a closing keyword and a filled Related section passes", () => {
  const failedWith = runScript(
    "Closes #42\n\n## Related\n\nSee also #40.",
  );
  assert.equal(failedWith, null);
});

test("Fixes/Resolves and the plural/past-tense forms are all recognized", () => {
  for (const kw of ["Fixes #1", "Fix #1", "Resolves #1", "Resolved #1", "Closed #1"]) {
    const failedWith = runScript(`${kw}\n\n## Related\n\nn/a`);
    assert.equal(failedWith, null, `expected "${kw}" to satisfy the closing-keyword check`);
  }
});

test("a cross-repo closing keyword (owner/repo#N) is recognized", () => {
  const failedWith = runScript(
    "Closes melodic-software/medley#123\n\n## Related\n\nn/a",
  );
  assert.equal(failedWith, null);
});

test('"No linked issue" satisfies the closing-keyword requirement', () => {
  const failedWith = runScript("No linked issue.\n\n## Related\n\nn/a");
  assert.equal(failedWith, null);
});

test('"No related issue:" (claude-code-plugins pull-request skill convention) also satisfies the closing-keyword requirement', () => {
  const failedWith = runScript(
    "No related issue: refactor, nothing to link.\n\n## Related\n\nn/a",
  );
  assert.equal(failedWith, null);
});

test("missing both a closing keyword and a Related section fails with both messages", () => {
  const failedWith = runScript("Just a description, nothing else.");
  assert.ok(failedWith, "expected a failure");
  assert.match(failedWith, /Related/);
  assert.match(failedWith, /closing keyword/);
});

test("a Related heading present but empty still fails", () => {
  const failedWith = runScript("Closes #1\n\n## Related\n\n## Next Heading\nsomething");
  assert.ok(failedWith, "expected a failure");
  assert.match(failedWith, /Related.*empty/);
});

test("an unedited PR template passes vacuously ONLY if the instructional prose is HTML-commented", () => {
  const templateBody =
    "<!-- Closes #N or Fixes #N here, and fill in ## Related below. -->\n\n## Related\n\n" +
    "<!-- list related items -->";
  const failedWith = runScript(templateBody);
  assert.ok(
    failedWith,
    "an unedited template (comment-only content) must still fail -- proves comment-stripping works",
  );
});

test("a closing keyword inside an HTML comment does not count (comment-stripping applies before the keyword check too)", () => {
  const failedWith = runScript("<!-- Closes #1 -->\n\n## Related\n\nn/a");
  assert.ok(failedWith, "a commented-out closing keyword must not satisfy the check");
  assert.match(failedWith, /closing keyword/);
});

test("case-insensitive heading and keyword matching", () => {
  const failedWith = runScript("fixes #1\n\n## related\n\nsomething");
  assert.equal(failedWith, null);
});
