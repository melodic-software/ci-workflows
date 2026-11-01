"use strict";

// GraphQL operations committed under .github/ validate against GitHub's
// public schema. GitHub rejects an invalid operation only at run time, after
// the lane that sends it has already started, so a spread of a type that
// cannot occur at that position (a User-typed field spread `... on Bot`)
// breaks every run until someone notices.
//
// What this test guarantees, over tracked JS, shell and workflow files under
// .github/ (test files excluded):
// - every string literal that opens with `query`, `mutation` or
//   `subscription` parses and validates;
// - a literal that opens with `{` and reads as a shorthand query fails, and
//   so does `query=@file`, since neither shape can be checked here;
// - a file with more request sites (`github.graphql(`,
//   `github.graphql.paginate(`, `request("POST /graphql"`, or a `gh api` /
//   `gh_api` command whose path is `graphql`, continuation lines joined)
//   than extracted operations fails.
// It cannot see an operation assembled from several literals or read from
// another file when the per-file count still balances.
//
// The schema is GitHub's published SDL, committed gzipped at schemas/github/
// so the text lanes skip it; refresh it with `gzip -9 -n` over
// https://docs.github.com/public/fpt/schema.docs.graphql when an operation
// needs a newer field.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { gunzipSync } = require("node:zlib");

const { buildSchema, Kind, parse, validate } = require("graphql");

const ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA = path.join(ROOT, "schemas", "github", "schema.docs.graphql.gz");
const SOURCE = /\.(?:c?js|mjs|sh|bash|ya?ml)$/;
const OPENING = /[`'"]\s*(?:query|mutation|subscription)\b\s*[A-Za-z_({]/g;
const SHORTHAND = /[`'"]\s*\{/g;
const CALL_SITE =
  /\bgraphql(?:\.paginate)?\(|\brequest\(\s*[`'"](?:POST\s+)?\/graphql\b|\bgh(?:_api|\s+api)\b.*\sgraphql\b/;
const QUERY_FILE = /\bquery=@/;
const COMMENT = /^\s*(?:#|\/\/|\*)/;
// Interpolations stand in for values the operations take as variables or
// literals; a quoted string keeps the document parseable without them.
const PLACEHOLDER = '"interpolated"';

function trackedSources() {
  return execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--", ".github"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => SOURCE.test(file) && !/\.test\.[^/]+$/.test(file));
}

// Whether the literal at `index` follows shell quoting: always in a shell
// script; in a workflow only inside a `run:` value, while a github-script
// `script:` body and everything else follow JS rules.
function shellAt(file, text, index) {
  if (/\.(?:sh|bash)$/.test(file)) return true;
  if (!/\.ya?ml$/.test(file)) return false;
  const lines = text.slice(0, index).split("\n");
  const own = lines[lines.length - 1];
  const inline = own.match(/^\s*(?:-\s+)?([\w-]+):/);
  if (inline) return inline[1] === "run";
  const indent = own.match(/^\s*/)[0].length;
  for (let n = lines.length - 2; n >= 0; n -= 1) {
    const key = lines[n].match(/^(\s*)(?:-\s+)?([\w-]+):/);
    if (key && key[1].length < indent) return key[2] === "run";
  }
  return false;
}

// The length of the `${...}` or `${{ ... }}` interpolation at `i`.
function interpolationLength(text, i) {
  let depth = 0;
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === "{") depth += 1;
    else if (text[j] === "}" && --depth === 0) return j + 1 - i;
  }
  return text.length - i;
}

// The body of the literal opening at `start`, interpolations replaced, or
// null when it never closes. Shell single quotes have no escapes, except the
// `'\''` idiom that closes, escapes and reopens one, and expand no `${...}`;
// a workflow `${{ }}` expression is substituted before the shell runs, so it
// is replaced in every quoting.
function readLiteral(text, start, shell) {
  const quote = text[start];
  const raw = quote === "'" && shell;
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "$" && text.startsWith("{", i + 1)) {
      if (!raw || text.startsWith("{{", i + 1)) {
        // Inside a GraphQL string the quotes would close it early.
        const inString = (out.match(/(?<!\\)"/g) ?? []).length % 2 === 1;
        out += inString ? PLACEHOLDER.slice(1, -1) : PLACEHOLDER;
        i += interpolationLength(text, i);
        continue;
      }
    }
    if (raw && c === "'") {
      if (!text.startsWith("'\\''", i)) return out;
      out += "'";
      i += 4;
    } else if (!raw && c === "\\") {
      out += text[i + 1] === "n" ? "\n" : text[i + 1];
      i += 2;
    } else if (!raw && c === quote) {
      return out;
    } else {
      out += c;
      i += 1;
    }
  }
  return null;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// A literal opening with `{` is a shorthand operation when it parses as one
// anonymous query whose root fields all exist on Query; jq filters and JSON
// fail one of those checks.
function isShorthand(schema, source) {
  let document;
  try {
    document = parse(source);
  } catch {
    return false;
  }
  const [definition, ...rest] = document.definitions;
  if (rest.length > 0 || definition.kind !== Kind.OPERATION_DEFINITION) {
    return false;
  }
  if (definition.name || definition.loc.startToken.kind !== "{") return false;
  const fields = schema.getQueryType().getFields();
  return definition.selectionSet.selections.every(
    (selection) =>
      selection.kind === Kind.FIELD && selection.name.value in fields,
  );
}

function extract(schema, file, text) {
  const operations = [];
  const unsupported = [];
  const read = (index) => readLiteral(text, index, shellAt(file, text, index));
  for (const match of text.matchAll(OPENING)) {
    const body = read(match.index);
    if (body !== null) {
      operations.push({ file, line: lineOf(text, match.index), source: body });
    }
  }
  for (const match of text.matchAll(SHORTHAND)) {
    const body = read(match.index);
    if (body !== null && isShorthand(schema, body)) {
      unsupported.push(
        `${file}:${lineOf(text, match.index)}: shorthand operation; open it with \`query\``,
      );
    }
  }
  const lines = text.split("\n");
  lines.forEach((line, n) => {
    if (QUERY_FILE.test(line) && !COMMENT.test(line)) {
      unsupported.push(`${file}:${n + 1}: query=@file is not checked`);
    }
  });
  const callSites = text
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .filter((line) => CALL_SITE.test(line) && !COMMENT.test(line)).length;
  return { operations, unsupported, callSites };
}

function problems(schema, source) {
  let document;
  try {
    document = parse(source);
  } catch (error) {
    return [error.message];
  }
  return validate(schema, document).map((error) => error.message);
}

// assumeValid skips the type-system rules, which GitHub's own schema breaks
// (an implementation field deprecated where its interface field is not);
// operations are still validated against every type and field it defines.
const schema = buildSchema(
  gunzipSync(fs.readFileSync(SCHEMA)).toString("utf8"),
  { assumeValid: true },
);
const files = trackedSources().map((file) => ({
  file,
  ...extract(schema, file, fs.readFileSync(path.join(ROOT, file), "utf8")),
}));

test("the schema rejects a fragment spread its position cannot hold", () => {
  const source = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      reviewThreads(first: 1) { nodes { resolvedBy { ... on Bot { login } } } }
    } }
  }`;
  const messages = problems(schema, source);
  assert.ok(
    messages.some((message) => /cannot be spread/.test(message)),
    messages.join("\n") || "validated without errors",
  );
});

test("the extractor reports the shapes it cannot check", () => {
  const sample = [
    "await github.graphql.paginate(`{ viewer { login } }`);",
    "await github.request('POST /graphql', { query: q });",
    "gh api \\",
    "  graphql -f query=@op.graphql",
    "jq '{ number }'",
  ].join("\n");
  const { operations, unsupported, callSites } = extract(
    schema,
    "sample.cjs",
    sample,
  );
  assert.equal(operations.length, 0);
  assert.equal(callSites, 3);
  assert.deepEqual(unsupported, [
    "sample.cjs:1: shorthand operation; open it with `query`",
    "sample.cjs:4: query=@file is not checked",
  ]);
});

test("workflow expressions are replaced in every quoting", () => {
  const expression = `$\{{ github.repository_owner }}`;
  const yaml = [
    "      - run: |",
    `          gh api graphql -f query='query { repository(owner: "${expression}", name: "x") { id } }'`,
  ].join("\n");
  const [operation] = extract(schema, "w.yml", yaml).operations;
  assert.deepEqual(problems(schema, operation.source), []);
});

test("every file that sends a GraphQL request yields its operations", () => {
  const senders = files.filter((entry) => entry.callSites > 0);
  assert.ok(senders.length > 0, "no file sends a GraphQL request");
  const gaps = senders
    .filter((entry) => entry.operations.length < entry.callSites)
    .map(
      (entry) =>
        `${entry.file}: ${entry.callSites} GraphQL request sites, ${entry.operations.length} operations extracted`,
    );
  assert.deepEqual(gaps, []);
  assert.deepEqual(
    files.flatMap((entry) => entry.unsupported),
    [],
  );
});

test("every committed GraphQL operation validates against GitHub's schema", (t) => {
  const failures = files.flatMap((entry) =>
    entry.operations.flatMap((operation) =>
      problems(schema, operation.source).map(
        (message) => `${operation.file}:${operation.line}: ${message}`,
      ),
    ),
  );
  for (const entry of files.filter((e) => e.operations.length > 0)) {
    t.diagnostic(`${entry.file}: ${entry.operations.length} operations`);
  }
  assert.deepEqual(failures, []);
});
