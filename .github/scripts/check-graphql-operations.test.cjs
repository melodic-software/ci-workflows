"use strict";

// The check-graphql-operations action: its extractor, its allowlist, and a
// run over this repository's own .github/.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  check,
  extract,
  loadSchema,
  problems,
} = require("../actions/check-graphql-operations/check.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const schema = loadSchema();

// A git repository holding `files`, each tracked.
function repository(files) {
  const root = makeTemporaryDirectory("check-graphql-operations-");
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  execFileSync("git", ["-C", root, "init", "-q"], { env });
  execFileSync("git", ["-C", root, "add", "."], { env });
  return root;
}

test("the schema rejects a fragment spread its position cannot hold", () => {
  const source = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      reviewThreads(first: 1) { nodes { resolvedBy { ... on Bot { login } } } }
    } }
  }`;
  const { errors } = problems(schema, { source });
  assert.ok(
    errors.some((message) => /cannot be spread/.test(message)),
    errors.join("\n") || "validated without errors",
  );
});

test("the extractor reports the shapes it cannot check", () => {
  const sample = [
    "await github.graphql.paginate(`{ viewer { login } }`);",
    "await github.request('POST /graphql', { query: q });",
    "gh api \\",
    "  graphql -f query=@op.graphql",
    "jq '{ number }'",
    "// 'query value, to the second' is prose",
    "async function graphql(query, variables) {}",
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
    "sample.cjs:4: an operation read from a file is not checked",
  ]);
});

test("workflow expressions and shell parameters are replaced", () => {
  const expression = `$\{{ github.repository_owner }}`;
  const yaml = [
    "      - run: |",
    `          gh api graphql -f query='query { repository(owner: "${expression}", name: "x") { id } }'`,
    `          gh api graphql -f query="query { viewer { $fields pullRequests(first: $(count)) { totalCount } } }"`,
    "          gh api graphql -f 'query=query{viewer{login}}'",
  ].join("\n");
  const { operations } = extract(schema, "w.yml", yaml);
  assert.equal(operations.length, 3);
  for (const operation of operations) {
    assert.deepEqual(problems(schema, operation), { syntax: null, errors: [] });
  }
});

test("JS constants resolve and other interpolations take their position's placeholder", () => {
  // `@{` stands for `${`, so no plain string here holds a template placeholder.
  const sample = [
    'const ACTOR = "{ ... on User { databaseId } ... on Bot { databaseId } }";',
    "const PAGE = 100;",
    "const FIELDS = `login author @{ACTOR}`;",
    "const q = `query($o: String!) { repository(owner: $o, name: @{name}) {",
    "  pullRequests(first: @{PAGE}) { nodes { @{extra} author @{ACTOR} } }",
    "} }`;",
    'const bad = "query { viewer { " + FIELDS + " } }";',
    'const joined = "query { viewer { " +',
    '  list.map((x) => `a@{x}: login`).join(" ") +',
    '  " } }";',
    "const named = `query { viewer { @{connection}(first: 1) { totalCount } } }`;",
  ]
    .join("\n")
    .replaceAll("@{", "$${");
  const { operations } = extract(schema, "sample.mjs", sample);
  assert.deepEqual(
    operations.map((operation) => problems(schema, operation)),
    [
      { syntax: null, errors: [] },
      {
        syntax: null,
        errors: ['Cannot query field "author" on type "User".'],
      },
      { syntax: null, errors: [] },
      { syntax: "an interpolation names a field", errors: [] },
    ],
  );
});

test("Python literals join, f-strings resolve constants and placeholders, and only string tokens open", () => {
  const sample = [
    'ACTOR = "fragment actor on Actor{login}"',
    "PAGE = 100",
    "FIELDS = (",
    '    "login "  # a comment between literals',
    '    "url"',
    ")",
    "Q = (",
    '    "query($o:String!,$r:String!){repository(owner:$o,name:$r){"',
    '    f"pullRequests(first:{PAGE},orderBy:{{field:UPDATED_AT,direction:DESC}}){{"',
    '    f"nodes{{author{{{FIELDS} ...actor}} {extra}}}}}}}}}"',
    '    f"{ACTOR}"',
    ")",
    'T = """',
    'query { repository(owner: "o", name: "r") { id } }',
    '"""',
    '# "query { viewer { login } }" in a comment opens nothing',
    `S = 'a "query { viewer { nope } }" inside another string'`,
    'L = f"query {{ viewer {{ {name}(first: 1) {{ totalCount }} }} }}"',
    'J = "query($n:Int!" + suffix + "){viewer{login}}"',
    'SH = "{ viewer { login } }"',
    "B = (",
    '    "query($n:Int!){viewer{pullRequests(first:$n){nodes{reviewThreads(first:1){"',
    '    "nodes{resolvedBy{... on Bot{login}}}}}}}}"',
    ")",
  ].join("\n");
  const { operations, unsupported } = extract(schema, "sample.py", sample);
  assert.deepEqual(
    operations.map((operation) => operation.line),
    [8, 13, 18, 19, 22],
  );
  const [joined, triple, named, plus, spread] = operations.map((operation) =>
    problems(schema, operation),
  );
  assert.deepEqual(joined, { syntax: null, errors: [] });
  assert.deepEqual(triple, { syntax: null, errors: [] });
  assert.deepEqual(named, {
    syntax: "an interpolation names a field",
    errors: [],
  });
  assert.ok(plus.syntax, "a `+` ends the literal");
  assert.match(spread.errors.join("\n"), /cannot be spread/);
  assert.deepEqual(unsupported, [
    "sample.py:20: shorthand operation; open it with `query`",
  ]);
});

test("the allowlist must match the unreadable sites either way, and every exclude must match a file", () => {
  const root = repository({
    "src/a.mjs": "await github.graphql(query);\n",
    "src/b.mjs":
      "const q = `query { viewer { zzzz } }`;\nawait github.graphql(q);\n",
    "other/c.mjs": "await github.graphql(query);\n",
    "linear/d.mjs": "await github.graphql(query);\n",
  });
  const run = (allowlist) =>
    check({ root, paths: ["src", "linear"], schema, allowlist }).failures;
  assert.deepEqual(run(""), [
    'src/b.mjs:1: Cannot query field "zzzz" on type "User".',
    "linear/d.mjs: 1 sites cannot be checked, the allowlist lists 0",
    "src/a.mjs: 1 sites cannot be checked, the allowlist lists 0",
  ]);
  assert.deepEqual(
    run(
      [
        "exclude linear/ another GraphQL API",
        "exclude gone/ nothing is here",
        "src/a.mjs 1 the operation is passed in",
        "src/b.mjs 1 a stale row",
        "src/e.mjs",
      ].join("\n"),
    ),
    [
      "allowlist line 5: no reason",
      "allowlist excludes gone/ (nothing is here), which matches no tracked source",
      'src/b.mjs:1: Cannot query field "zzzz" on type "User".',
      "src/b.mjs: 0 sites cannot be checked, the allowlist lists 1",
    ],
  );
});

test("a tracked symlink is not read, and a message stays on one line", () => {
  const outside = makeTemporaryDirectory("check-graphql-operations-outside-");
  fs.writeFileSync(
    path.join(outside, "secret.mjs"),
    "const q = `query { viewer { zzzz } }`;\n",
  );
  const root = repository({
    "src/a.mjs":
      'const q = `query { viewer { pullRequests(first: """\n::warning::x\n""") { totalCount } } }`;\n',
  });
  fs.symlinkSync(
    path.join(outside, "secret.mjs"),
    path.join(root, "src/link.mjs"),
  );
  execFileSync("git", ["-C", root, "add", "src/link.mjs"], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const { failures, diagnostics } = check({ root, paths: ["src"], schema });
  assert.ok(failures.length > 0, "the block string is not an Int");
  for (const line of [...failures, ...diagnostics]) {
    assert.doesNotMatch(line, /[\r\n]/);
    assert.doesNotMatch(line, /link\.mjs|zzzz/);
  }
  fs.symlinkSync(
    path.join(outside, "secret.mjs"),
    path.join(root, "allow.txt"),
  );
  const cli = path.join(
    ROOT,
    ".github/actions/check-graphql-operations/check.cjs",
  );
  let refused;
  try {
    execFileSync(
      "node",
      [cli, "--root", root, "--allowlist", "allow.txt", "src"],
      {
        encoding: "utf8",
      },
    );
  } catch (error) {
    refused = error;
  }
  assert.equal(refused?.status, 1, "a symlinked allowlist fails the check");
  assert.match(refused.stdout, /allowlist allow\.txt is not a regular file/);
  assert.doesNotMatch(refused.stdout, /zzzz/);
});

test("every GraphQL operation under this repository's .github/ validates and every site is readable", (t) => {
  const { failures, diagnostics } = check({
    root: ROOT,
    paths: [".github"],
    schema,
  });
  for (const line of diagnostics) t.diagnostic(line);
  assert.deepEqual(failures, []);
  assert.match(diagnostics.at(-1), /^[1-9]\d* operations validated/);
});
