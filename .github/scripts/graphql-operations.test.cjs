"use strict";

// Every GraphQL operation committed in this repository validates against
// GitHub's public schema. GitHub rejects an invalid operation only at run
// time, after the lane that sends it has already started, so a spread of a
// type that cannot occur at that position (a User-typed field spread
// `... on Bot`) breaks every run until someone notices. This test reads each
// tracked source file, extracts every string literal that opens with
// `query`, `mutation` or `subscription`, and validates it. A file that sends a
// GraphQL request but yields fewer operations than it has call sites fails,
// so a quoting shape the extractor misses cannot pass silently.
//
// The schema is GitHub's published SDL, committed at schemas/github/; refresh
// it from https://docs.github.com/public/fpt/schema.docs.graphql when an
// operation needs a newer field.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildSchema, parse, validate } = require("graphql");

const ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA = path.join(ROOT, "schemas", "github", "schema.docs.graphql");
const SOURCE = /\.(?:c?js|mjs|sh|bash|ya?ml)$/;
const OPENING = /[`'"]\s*(?:query|mutation|subscription)\b\s*[A-Za-z_({]/g;
// A request site: a github-script `github.graphql(` call, or a `gh api` /
// `gh_api` command whose path is `graphql`. Comment lines do not count.
const CALL_SITE = /\bgraphql\(|\bgh(?:_api|\s+api)\b.*\sgraphql\b/;
const COMMENT = /^\s*(?:#|\/\/|\*)/;
// Interpolations stand in for values the operations take as variables or
// literals; a quoted string keeps the document parseable without them.
const PLACEHOLDER = '"interpolated"';

function trackedSources() {
  return execFileSync("git", ["-C", ROOT, "ls-files", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => SOURCE.test(file) && !/\.test\.[^/]+$/.test(file));
}

// The literal starting at `start` (its opening quote): the text with
// `${...}` and `${{ ... }}` interpolations replaced, and the index after the
// closing quote. Shell single quotes have no escapes, except the `'\''`
// idiom that closes, escapes and reopens one.
function readLiteral(text, start, shell) {
  const quote = text[start];
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (quote === "'" && shell) {
      if (c !== "'") {
        out += c;
        i += 1;
      } else if (text.startsWith("'\\''", i)) {
        out += "'";
        i += 4;
      } else {
        return { body: out, end: i + 1 };
      }
    } else if (c === "\\") {
      out += text[i + 1] === "n" ? "\n" : text[i + 1];
      i += 2;
    } else if (c === quote) {
      return { body: out, end: i + 1 };
    } else if (c === "$" && text[i + 1] === "{") {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j += 1) {
        if (text[j] === "{") depth += 1;
        else if (text[j] === "}" && --depth === 0) break;
      }
      out += PLACEHOLDER;
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return null;
}

function extract(file, text) {
  const shell = /\.(?:sh|bash|ya?ml)$/.test(file);
  const operations = [];
  for (const match of text.matchAll(OPENING)) {
    const literal = readLiteral(text, match.index, shell);
    if (literal === null) continue;
    const line = text.slice(0, match.index).split("\n").length;
    operations.push({ file, line, source: literal.body });
  }
  const callSites = text
    .split("\n")
    .filter((line) => CALL_SITE.test(line) && !COMMENT.test(line)).length;
  return { operations, callSites };
}

function problems(schema, operation) {
  let document;
  try {
    document = parse(operation.source);
  } catch (error) {
    return [error.message];
  }
  return validate(schema, document).map((error) => error.message);
}

// assumeValid skips the type-system rules, which GitHub's own schema breaks
// (an implementation field deprecated where its interface field is not);
// operations are still validated against every type and field it defines.
const schema = buildSchema(fs.readFileSync(SCHEMA, "utf8"), {
  assumeValid: true,
});
const files = trackedSources().map((file) => ({
  file,
  ...extract(file, fs.readFileSync(path.join(ROOT, file), "utf8")),
}));

test("the schema rejects a fragment spread its position cannot hold", () => {
  const source = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      reviewThreads(first: 1) { nodes { resolvedBy { ... on Bot { login } } } }
    } }
  }`;
  const messages = problems(schema, { source });
  assert.ok(
    messages.some((message) => /cannot be spread/.test(message)),
    messages.join("\n") || "validated without errors",
  );
});

test("every file that sends a GraphQL request yields its operations", () => {
  const senders = files.filter((entry) => entry.callSites > 0);
  assert.ok(senders.length > 0, "no file sends a GraphQL request");
  const gaps = senders
    .filter((entry) => entry.operations.length < entry.callSites)
    .map(
      (entry) =>
        `${entry.file}: ${entry.callSites} GraphQL call sites, ${entry.operations.length} operations extracted`,
    );
  assert.deepEqual(gaps, []);
});

test("every committed GraphQL operation validates against GitHub's schema", (t) => {
  const failures = files.flatMap((entry) =>
    entry.operations.flatMap((operation) =>
      problems(schema, operation).map(
        (message) => `${operation.file}:${operation.line}: ${message}`,
      ),
    ),
  );
  for (const entry of files.filter((e) => e.operations.length > 0)) {
    t.diagnostic(`${entry.file}: ${entry.operations.length} operations`);
  }
  assert.deepEqual(failures, []);
});
