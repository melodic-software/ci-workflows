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

// Minimal body that satisfies closing-keyword + all four contract headers.
// Individual tests override pieces by composing around this helper.
function contractBody({
  closing = "Closes #42",
  summary = "Short summary of the change.",
  fix = "Concrete fix description.",
  verification = "Ran the unit tests.",
  related = "See also #40.",
} = {}) {
  return [
    closing,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Fix",
    "",
    fix,
    "",
    "## Verification",
    "",
    verification,
    "",
    "## Related",
    "",
    related,
  ].join("\n");
}

// Extracts the inline actions/github-script body (the same technique used to
// validate the equivalent block ported into melodic-software/medley's
// issue-labeling.yml) and runs it in a sandbox with a stub `core`/`process`,
// so the actual closing-keyword/contract-header parsing logic is exercised
// directly rather than only checked for structural presence in the YAML text.
function runScript(body, prAuthor = "", exemptAuthors = "") {
  // Prefer the Validate step's github-script body. The cancelled-prerequisite
  // cancelled-prerequisite resolver also embeds a `script: |` block earlier in the workflow.
  const validateMarker = "- name: Validate PR body against the closing-keyword";
  const validateStart = workflow.indexOf(validateMarker);
  assert.notEqual(validateStart, -1, "validate step marker missing");
  const scriptToken = "script: |";
  const scriptStart =
    workflow.indexOf(scriptToken, validateStart) + scriptToken.length;
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
    process: {
      env: {
        PR_BODY: body,
        PR_AUTHOR: prAuthor,
        EXEMPT_AUTHORS: exemptAuthors,
      },
    },
    core: { setFailed: (message) => (failedWith = message), info: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptLines.join("\n"), sandbox);
  return failedWith;
}

test("a body with a closing keyword and all four contract headers passes", () => {
  const failedWith = runScript(contractBody());
  assert.equal(failedWith, null);
});

test("Fixes/Resolves and the plural/past-tense forms are all recognized", () => {
  for (const kw of [
    "Fixes #1",
    "Fix #1",
    "Resolves #1",
    "Resolved #1",
    "Closed #1",
  ]) {
    const failedWith = runScript(contractBody({ closing: kw }));
    assert.equal(
      failedWith,
      null,
      `expected "${kw}" to satisfy the closing-keyword check`,
    );
  }
});

test("a cross-repo closing keyword (owner/repo#N) is recognized", () => {
  const failedWith = runScript(
    contractBody({
      closing: "Closes melodic-software/medley#123",
      related: "n/a",
    }),
  );
  assert.equal(failedWith, null);
});

test('"No linked issue" satisfies the closing-keyword requirement', () => {
  const failedWith = runScript(
    contractBody({ closing: "No linked issue.", related: "n/a" }),
  );
  assert.equal(failedWith, null);
});

test('"No related issue:" (claude-code-plugins pull-request skill convention) also satisfies the closing-keyword requirement', () => {
  const failedWith = runScript(
    contractBody({
      closing: "No related issue: refactor, nothing to link.",
      related: "n/a",
    }),
  );
  assert.equal(failedWith, null);
});

test("missing closing keyword and all contract headers fails with each message", () => {
  const failedWith = runScript("Just a description, nothing else.");
  assert.ok(failedWith, "expected a failure");
  assert.match(failedWith, /Summary/);
  assert.match(failedWith, /Fix/);
  assert.match(failedWith, /Verification/);
  assert.match(failedWith, /Related/);
  assert.match(failedWith, /closing keyword/);
});

test("a Related heading present but empty still fails", () => {
  const failedWith = runScript(
    "Closes #1\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\n## Next Heading\nsomething",
  );
  assert.ok(failedWith, "expected a failure");
  assert.match(failedWith, /Related.*empty/);
});

test("a Summary heading present but empty still fails", () => {
  const failedWith = runScript(
    "Closes #1\n\n## Summary\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nn/a",
  );
  assert.ok(failedWith, "expected a failure");
  assert.match(failedWith, /Summary.*empty/);
});

test("a Fix heading present but empty still fails", () => {
  const failedWith = runScript(
    "Closes #1\n\n## Summary\n\ns\n\n## Fix\n\n## Verification\n\nv\n\n## Related\n\nn/a",
  );
  assert.ok(failedWith, "expected a failure");
  assert.match(failedWith, /Fix.*empty/);
});

test("a Verification heading present but empty still fails", () => {
  const failedWith = runScript(
    "Closes #1\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\n## Related\n\nn/a",
  );
  assert.ok(failedWith, "expected a failure");
  assert.match(failedWith, /Verification.*empty/);
});

test("missing only Summary fails without blaming the other headers", () => {
  const failedWith = runScript(
    "Closes #1\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nn/a",
  );
  assert.ok(failedWith, "expected a failure");
  assert.match(failedWith, /Summary/);
  assert.doesNotMatch(failedWith, /Fix.*empty|Missing a "## Fix"/);
  assert.doesNotMatch(failedWith, /Verification/);
  assert.doesNotMatch(failedWith, /Related/);
  assert.doesNotMatch(failedWith, /closing keyword/);
});

test("an unedited PR template passes vacuously ONLY if the instructional prose is HTML-commented", () => {
  const templateBody =
    "<!-- Closes #N or Fixes #N here, and fill in ## Related below. -->\n\n## Summary\n\n" +
    "<!-- what -->\n\n## Fix\n\n<!-- how -->\n\n## Verification\n\n<!-- evidence -->\n\n" +
    "## Related\n\n<!-- list related items -->";
  const failedWith = runScript(templateBody);
  assert.ok(
    failedWith,
    "an unedited template (comment-only content) must still fail -- proves comment-stripping works",
  );
});

test("a closing keyword inside an HTML comment does not count (comment-stripping applies before the keyword check too)", () => {
  const failedWith = runScript(
    contractBody({ closing: "<!-- Closes #1 -->", related: "n/a" }),
  );
  assert.ok(
    failedWith,
    "a commented-out closing keyword must not satisfy the check",
  );
  assert.match(failedWith, /closing keyword/);
});

test("case-insensitive heading and keyword matching", () => {
  const failedWith = runScript(
    "fixes #1\n\n## summary\n\ns\n\n## fix\n\nf\n\n## verification\n\nv\n\n## related\n\nsomething",
  );
  assert.equal(failedWith, null);
});

test("an unterminated HTML comment hides the rest of the body instead of leaking it live", () => {
  const failedWith = runScript(
    "<!-- Closes #1\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nn/a",
  );
  assert.ok(
    failedWith,
    "an unclosed comment must not let closing-keyword/contract-header text leak through as live content",
  );
  assert.match(failedWith, /Related/);
  assert.match(failedWith, /closing keyword/);
});

test("a literal HTML-comment opener in inline code does not hide later linkage metadata", () => {
  const failedWith = runScript(
    "The parser handles an unclosed `<!--` marker.\n\n" +
      contractBody({ closing: "No linked issue", related: "- #123" }),
  );
  assert.equal(failedWith, null);
});

test("a literal HTML-comment opener in a multiline code span does not hide later linkage metadata", () => {
  const failedWith = runScript(
    "The parser handles `an unclosed\n<!-- marker` safely.\n\n" +
      contractBody({ closing: "No linked issue", related: "- #123" }),
  );
  assert.equal(failedWith, null);
});

test("HTML-comment syntax in a fenced code block does not hide later linkage metadata", () => {
  const failedWith = runScript(
    "```md\n<!-- example without a closer\n```\n\n" +
      contractBody({ closing: "No linked issue", related: "- #123" }),
  );
  assert.equal(failedWith, null);
});

test("linkage markers inside an inline code span do not satisfy the gate", () => {
  const failedWith = runScript(
    "Example: `No linked issue`\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\n- #123",
  );
  assert.ok(
    failedWith,
    "inline-code linkage text must not count as rendered metadata",
  );
  assert.match(failedWith, /closing keyword/);
});

test("linkage markers inside a fenced code block do not satisfy the gate", () => {
  const failedWith = runScript(
    "```md\nNo linked issue\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\n- #123\n```",
  );
  assert.ok(
    failedWith,
    "fenced linkage text must not count as rendered metadata",
  );
  assert.match(failedWith, /Related/);
  assert.match(failedWith, /closing keyword/);
});

test("linkage markers inside an indented code block do not satisfy the gate", () => {
  const failedWith = runScript(
    "    No linked issue\n\n    ## Summary\n\n    s\n\n    ## Fix\n\n    f\n\n    ## Verification\n\n    v\n\n    ## Related\n\n    - #123",
  );
  assert.ok(
    failedWith,
    "indented linkage text must not count as rendered metadata",
  );
  assert.match(failedWith, /Related/);
  assert.match(failedWith, /closing keyword/);
});

test("an unmatched backtick does not expose linkage metadata hidden in a later HTML comment", () => {
  const failedWith = runScript(
    "A stray ` delimiter.\n\n<!-- Closes #1 -->\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\nn/a",
  );
  assert.ok(
    failedWith,
    "commented-out linkage must remain hidden after an unmatched backtick",
  );
  assert.match(failedWith, /closing keyword/);
});

test("a nested subsection under ## Related counts as content, not a section boundary", () => {
  const failedWith = runScript(
    contractBody({ related: "### Issues\n\n- #123" }),
  );
  assert.equal(
    failedWith,
    null,
    "a ### subsection nested under ## Related must not empty the section",
  );
});

test("an exempt author passes with no closing keyword and no contract headers", () => {
  const failedWith = runScript(
    "Bumps a dependency, no linkage markers.",
    "dependabot[bot]",
    "dependabot[bot]",
  );
  assert.equal(
    failedWith,
    null,
    "a login listed in exempt-authors must skip body validation",
  );
});

test("fail-closed: a bot author with an empty exempt-authors list still fails", () => {
  const failedWith = runScript(
    "Bumps a dependency, no linkage markers.",
    "dependabot[bot]",
    "",
  );
  assert.ok(
    failedWith,
    "the default empty exempt-authors must exempt no one (opt-in, no behavior change)",
  );
  assert.match(failedWith, /Related/);
  assert.match(failedWith, /closing keyword/);
});

test("a human author not in a non-empty exempt-authors list still fails", () => {
  const failedWith = runScript(
    "Just a description, nothing else.",
    "octocat",
    "dependabot[bot],renovate[bot]",
  );
  assert.ok(
    failedWith,
    "a non-exempt author must still be validated even when others are exempted",
  );
  assert.match(failedWith, /Related/);
  assert.match(failedWith, /closing keyword/);
});

test("exempt-authors matching is exact-login, not a [bot]-suffix pattern", () => {
  const failedWith = runScript(
    "Bumps a dependency, no linkage markers.",
    "some-unknown[bot]",
    "dependabot[bot]",
  );
  assert.ok(
    failedWith,
    "an unlisted bot login must not be silently skipped by a pattern match",
  );
});

test("exempt-authors tolerates surrounding whitespace in the comma-separated list", () => {
  const failedWith = runScript(
    "Bumps a dependency, no linkage markers.",
    "renovate[bot]",
    " dependabot[bot] , renovate[bot] ",
  );
  assert.equal(
    failedWith,
    null,
    "whitespace around list entries must not defeat the exact-login match",
  );
});
