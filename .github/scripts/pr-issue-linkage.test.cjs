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

// GitHub's parser treats closer+#N as a live closing reference even when the
// surrounding words negate it. Fixtures that need those phrases join the tokens
// at runtime so this file itself does not contain a live closer+#N.
function joinWords(parts) {
  return parts.join(" ");
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

test('"Refs: #N" satisfies linkage without arming GitHub\'s closing parser', () => {
  const failedWith = runScript(
    contractBody({ closing: "Refs: #42", related: "n/a" }),
  );
  assert.equal(failedWith, null);
});

test('"Relates to: owner/repo#N" is an equally valid non-closing marker', () => {
  const failedWith = runScript(
    contractBody({
      closing: "Relates to: owner/repo#42",
      related: "n/a",
    }),
  );
  assert.equal(failedWith, null);
});

test("the non-closing marker is case-insensitive and tolerates up to three leading spaces", () => {
  for (const marker of [
    "refs: #42",
    "REFS: #42",
    "   Relates To: #42",
    "Refs:#42",
  ]) {
    const failedWith = runScript(
      contractBody({ closing: marker, related: "n/a" }),
    );
    assert.equal(
      failedWith,
      null,
      `expected "${marker}" to satisfy the linkage requirement`,
    );
  }
});

test("a non-closing marker with trailing prose on the same line does not satisfy linkage", () => {
  const failedWith = runScript(
    contractBody({ closing: "Refs: #42 extra prose", related: "n/a" }),
  );
  assert.ok(
    failedWith,
    "only a bare marker line may satisfy the gate -- prose around it is not the marker form",
  );
  assert.match(failedWith, /closing keyword/);
});

test("a non-closing marker without its colon does not satisfy linkage", () => {
  const failedWith = runScript(
    contractBody({ closing: "Refs #42", related: "n/a" }),
  );
  assert.ok(failedWith, "the colon is required by the marker form");
  assert.match(failedWith, /closing keyword/);
});

test("a negated closing keyword fails the gate even with every contract header present", () => {
  const failedWith = runScript(
    contractBody({
      closing: joinWords(["This", "PR", "does", "not", "close", "#42."]),
      related: "n/a",
    }),
  );
  assert.ok(
    failedWith,
    "GitHub auto-closes the issue on merge regardless of the disclaimer, so the gate must fail",
  );
  assert.match(failedWith, /Negated closing reference/);
  assert.match(failedWith, /Refs: #N/);
});

test('a negated closing keyword still fails when "No linked issue" is also present', () => {
  const failedWith = runScript(
    contractBody({
      closing: `No linked issue. ${joinWords(["This", "PR", "does", "not", "close", "#42."])}`,
      related: "n/a",
    }),
  );
  assert.ok(
    failedWith,
    "the opt-out marker does not disarm the closing reference GitHub will act on",
  );
  assert.match(failedWith, /Negated closing reference/);
});

test("a negated closing keyword still fails when a valid non-closing marker is also present", () => {
  const failedWith = runScript(
    contractBody({
      closing: "Refs: #42",
      related: joinWords(["This", "PR", "does", "not", "close", "#42."]),
    }),
  );
  assert.ok(
    failedWith,
    "a correct marker elsewhere does not excuse a live closing reference",
  );
  assert.match(failedWith, /Negated closing reference/);
});

test("every negation form in the window is recognized", () => {
  for (const phrase of [
    ["This", "does", "not", "close", "#42."],
    ["This", "will", "not", "close", "#42."],
    ["We", "do", "not", "close", "#42."],
    ["It", "never", "closes", "#42."],
    ["It", "doesn't", "close", "#42."],
    ["It", "won't", "close", "#42."],
    ["It", "didn't", "close", "#42."],
    ["It", "deliberately", "closes", "#42."],
    ["It", "intentionally", "closes", "#42."],
    ["There", "is", "no", "scenario", "where", "this", "closes", "#42."],
    ["Merged", "without", "closing", "anything,", "resolves", "#42"],
  ].map(joinWords)) {
    const failedWith = runScript(
      contractBody({ closing: phrase, related: "n/a" }),
    );
    assert.ok(failedWith, `expected "${phrase}" to be read as negated`);
    assert.match(failedWith, /Negated closing reference/);
  }
});

test("negation is scoped to the same line and cut at a sentence break", () => {
  for (const phrase of [
    `Nothing here is optional. ${joinWords(["Closes", "#42"])}`,
    `This PR does not touch the selector.\n${joinWords(["Closes", "#42"])}`,
  ]) {
    const failedWith = runScript(
      contractBody({ closing: phrase, related: "n/a" }),
    );
    assert.equal(
      failedWith,
      null,
      `expected "${phrase}" to remain an ordinary closing reference`,
    );
  }
});

test("negation looks back at most five words", () => {
  const failedWith = runScript(
    contractBody({
      closing: joinWords([
        "This",
        "PR",
        "does",
        "not",
        "change",
        "any",
        "of",
        "the",
        "exported",
        "helper",
        "names,",
        "closes",
        "#42",
      ]),
      related: "n/a",
    }),
  );
  assert.equal(
    failedWith,
    null,
    "a negation six or more words back belongs to a different clause",
  );
});

test("a negated closing keyword is not itself accepted as the required linkage", () => {
  const failedWith = runScript(
    contractBody({
      closing: joinWords(["This", "PR", "does", "not", "close", "#42."]),
      related: "n/a",
    }),
  );
  assert.ok(failedWith, "expected a failure");
  assert.match(failedWith, /Negated closing reference/);
  assert.match(failedWith, /closing keyword/);
});

test("a non-negated closing keyword on a line that also carries a negated one still fails", () => {
  const failedWith = runScript(
    contractBody({
      closing: `${joinWords(["Closes", "#41"])} but ${joinWords(["does", "not", "close", "#42."])}`,
      related: "n/a",
    }),
  );
  assert.ok(failedWith, "expected a failure");
  assert.match(failedWith, /Negated closing reference/);
  assert.doesNotMatch(failedWith, /Missing a native closing keyword/);
});

test("a negated closing keyword inside a code span is not live and does not fail the gate", () => {
  const failedWith = runScript(
    `Never write \`${joinWords(["does", "not", "close", "#42"])}\` in a body.\n\n` +
      contractBody({ closing: "Refs: #42", related: "n/a" }),
  );
  assert.equal(
    failedWith,
    null,
    "code-span text is not rendered linkage, so GitHub will not act on it either",
  );
});

test("a non-closing marker inside a code span does not satisfy the gate", () => {
  const failedWith = runScript(
    "Example: `Refs: #42`\n\n## Summary\n\ns\n\n## Fix\n\nf\n\n## Verification\n\nv\n\n## Related\n\n- #123",
  );
  assert.ok(
    failedWith,
    "inline-code marker text must not count as rendered metadata",
  );
  assert.match(failedWith, /closing keyword/);
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
