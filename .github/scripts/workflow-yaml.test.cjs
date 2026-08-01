"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { WorkflowYamlError, parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsRoot = path.join(__dirname, "..", "workflows");

function rejects(source, expected) {
  assert.throws(
    () => parseWorkflow(source),
    (error) => {
      assert.ok(
        error instanceof WorkflowYamlError,
        `expected WorkflowYamlError, got ${error.name}: ${error.message}`,
      );
      assert.match(error.message, expected);
      return true;
    },
  );
}

// --- The subset ------------------------------------------------------------

test("a step sequence is enumerated positionally, not by name", () => {
  const document = parseWorkflow(`jobs:
  build:
    steps:
      - name: first
        run: echo a
      - name: first
        run: echo b
`);
  // Two steps share a name. An enumerator that indexed by name would see one.
  assert.deepEqual(
    document.jobs.build.steps.map((step) => step.run),
    ["echo a", "echo b"],
  );
});

test("a bare hyphen opens a real sequence item", () => {
  const document = parseWorkflow(`steps:
  -
    name: appended
    run: echo a
`);
  assert.deepEqual(document.steps, [{ name: "appended", run: "echo a" }]);
});

test("a block scalar is one opaque string, whatever it looks like inside", () => {
  const document = parseWorkflow(`steps:
  - name: real
    run: |
      echo one
      - name: decoy
      echo two
  - name: next
    run: echo three
`);
  assert.equal(document.steps.length, 2);
  assert.equal(document.steps[0].run, "echo one\n- name: decoy\necho two\n");
  assert.equal(document.steps[1].name, "next");
});

test("block scalar chomping and folding follow the style indicator", () => {
  const document = parseWorkflow(`literal: |
  a

  b
stripped: |-
  a
kept: |+
  a


folded: >-
  a
  b

  c
more-indented: >-
  a
    b
`);
  assert.equal(document.literal, "a\n\nb\n");
  assert.equal(document.stripped, "a");
  assert.equal(document.kept, "a\n\n\n");
  assert.equal(document.folded, "a b\nc");
  assert.equal(document["more-indented"], "a\n  b");
});

test("scalars resolve under the core schema the Actions runner applies", () => {
  const document = parseWorkflow(`on: push
enabled: true
disabled: false
missing:
count: 12
padded: 007
exponent: 1e3
hex: 0x1f
version: 24.18.0
quoted: '17 * * * *'
escaped: "a\\nb"
apostrophe: 'it''s'
commented: value # trailing
hash: a#b
flow-sequence: [main, 'release/*']
flow-mapping: {}
`);
  assert.deepEqual(document, {
    on: "push",
    enabled: true,
    disabled: false,
    missing: null,
    count: 12,
    padded: 7,
    exponent: 1000,
    hex: 31,
    version: "24.18.0",
    quoted: "17 * * * *",
    escaped: "a\nb",
    apostrophe: "it's",
    commented: "value",
    hash: "a#b",
    "flow-sequence": ["main", "release/*"],
    "flow-mapping": {},
  });
});

test("a sequence may sit at its key's own column or be indented past it", () => {
  const flush = parseWorkflow("paths:\n- a\n- b\n");
  const indented = parseWorkflow("paths:\n  - a\n  - b\n");
  assert.deepEqual(flush, indented);
  assert.deepEqual(flush.paths, ["a", "b"]);
});

test("every workflow in this repository parses to the same shape it is read as", () => {
  // The gate audit is only as sound as this parser's reach, so the whole
  // corpus is exercised: a file the subset cannot express must announce
  // itself here rather than in the audit that depends on it.
  const files = fs
    .readdirSync(workflowsRoot)
    .filter((name) => /\.ya?ml$/u.test(name));
  assert.ok(files.length > 0, "the workflows directory must not be empty");
  for (const name of files) {
    const source = fs.readFileSync(path.join(workflowsRoot, name), "utf8");
    let document;
    try {
      document = parseWorkflow(source);
    } catch (error) {
      // Rejection is a supported outcome; a crash that is not a
      // WorkflowYamlError is a parser bug that could equally have returned a
      // wrong shape.
      assert.ok(error instanceof WorkflowYamlError, `${name}: ${error.stack}`);
      continue;
    }
    assert.equal(typeof document.jobs, "object", `${name} must declare jobs`);
    for (const [jobId, job] of Object.entries(document.jobs)) {
      for (const step of job.steps ?? []) {
        assert.equal(
          typeof step,
          "object",
          `${name}: a step of '${jobId}' is not a mapping`,
        );
      }
    }
  }
});

// --- Failing closed --------------------------------------------------------

test("constructs outside the subset are rejected rather than approximated", () => {
  rejects("a: &anchor\n  b: 1\n", /unsupported node indicator/u);
  rejects("a: *alias\n", /unsupported node indicator/u);
  rejects(
    "base: &b\n  a: 1\nchild:\n  <<: *b\n",
    /unsupported node indicator/u,
  );
  rejects("---\na: 1\n", /document markers/u);
  rejects("a: 1\n...\n", /document markers/u);
  rejects("a:\n\tb: 1\n", /tab indentation/u);
  rejects("a: 1\na: 2\n", /duplicate key 'a'/u);
  rejects("a: 'unterminated\n", /unterminated quote/u);
  rejects("a: [1, 2\n", /must close on the line it opens/u);
  rejects('a: "\\q"\n', /unsupported escape/u);
});

test("a line the grammar cannot place is an error, never a silent skip", () => {
  rejects("a: 1\n  stray\n", /trailing content|unexpected indentation/u);
  rejects(
    "jobs:\n  build:\n    steps:\n      - a: 1\n     misindented: 2\n",
    /trailing content|indentation/u,
  );
});
