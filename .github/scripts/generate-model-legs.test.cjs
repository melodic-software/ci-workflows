"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { render, check } = require("./generate-model-legs.cjs");

const KEY_STEPS = `      - name: Pick the credential
        with:
          leg: key

      # BEGIN KEY-ONLY
      - name: Write the marker
        run: echo marker

      # END KEY-ONLY
      - name: Run
        with:
          api-key: \${{ secrets.KEY }}
          tag: one
          tag: one
`;

const DERIVED_STEPS = `      - name: Pick the credential
        with:
          leg: sub

      - name: Run
        with:
          token: \${{ secrets.TOKEN }}
          tag: one
          tag: one
`;

const workflow = (derivedSteps) => `jobs:
  key:
    runs-on: ubuntu-latest
    steps:
${KEY_STEPS}
  # Header comment for the derived job.
  sub:
    runs-on: ubuntu-latest
    steps:
${derivedSteps}
  # Trailing job.
  after:
    steps:
      - run: true
`;

const spec = {
  workflow: ".github/workflows/demo.yml",
  keyJob: "key",
  legs: [
    {
      job: "sub",
      substitutions: [
        { find: "leg: key", replace: "leg: sub", count: 1 },
        {
          find: `api-key: \${{ secrets.KEY }}`,
          replace: `token: \${{ secrets.TOKEN }}`,
          count: 1,
        },
      ],
    },
  ],
};

const marked = (steps) =>
  `      # BEGIN GENERATED: demo sub\n${steps}      # END GENERATED: demo sub\n`;

test("render wraps the derived steps in markers and changes no other line", () => {
  const before = workflow(DERIVED_STEPS);
  const after = render(before, spec);
  assert.equal(after, workflow(marked(DERIVED_STEPS)));
});

test("render is idempotent", () => {
  const once = render(workflow(DERIVED_STEPS), spec);
  assert.equal(render(once, spec), once);
});

test("render rewrites a stale generated region from the key steps", () => {
  const stale = workflow(marked(DERIVED_STEPS.replace("tag: one\n", "")));
  assert.equal(render(stale, spec), workflow(marked(DERIVED_STEPS)));
});

test("check names a stale region and passes once rendered", () => {
  const stale = workflow(marked(DERIVED_STEPS.replace("leg: sub", "leg: old")));
  assert.deepEqual(check(stale, spec), ["demo sub"]);
  assert.deepEqual(check(render(stale, spec), spec), []);
});

test("check names a derived job that has no generated markers", () => {
  assert.deepEqual(check(workflow(DERIVED_STEPS), spec), ["demo sub"]);
});

test("a substitution matching other than its count throws, naming the row", () => {
  for (const count of [0, 2]) {
    const bad = structuredClone(spec);
    bad.legs[0].substitutions[0].count = count;
    assert.throws(
      () => render(workflow(DERIVED_STEPS), bad),
      /sub: "leg: key" matched 1 times, expected [02]/u,
    );
  }
});

test("a find inside the KEY-ONLY block does not count toward a derived leg", () => {
  const bad = structuredClone(spec);
  bad.legs[0].substitutions.push({
    find: "echo marker",
    replace: "x",
    count: 1,
  });
  assert.throws(
    () => render(workflow(DERIVED_STEPS), bad),
    /"echo marker" matched 0 times, expected 1/u,
  );
});

test("a replacement that creates a later row's find leaves that row's count alone", () => {
  const chained = structuredClone(spec);
  chained.legs[0].substitutions = [
    {
      find: "tag: one\n          tag: one",
      replace: "tag: two\n          tag: two",
      count: 1,
    },
    { find: "leg: key", replace: "tag: one", count: 1 },
  ];
  const derived = DERIVED_STEPS.replace("leg: sub", "tag: one")
    .replace(`token: \${{ secrets.TOKEN }}`, `api-key: \${{ secrets.KEY }}`)
    .replace("tag: one\n          tag: one", "tag: two\n          tag: two");
  assert.equal(
    render(workflow(DERIVED_STEPS), chained),
    workflow(marked(derived)),
  );
});

test("overlapping substitutions throw", () => {
  const bad = structuredClone(spec);
  bad.legs[0].substitutions.push({ find: "eg: key", replace: "x", count: 1 });
  assert.throws(() => render(workflow(DERIVED_STEPS), bad), /overlap/u);
});

test("a key leg with no KEY-ONLY block or with two throws", () => {
  const none = workflow(DERIVED_STEPS).replace(
    / {6}# (BEGIN|END) KEY-ONLY\n/gu,
    "",
  );
  assert.throws(
    () => render(none, spec),
    /key: 0 KEY-ONLY blocks, expected 1/u,
  );
  const two = workflow(DERIVED_STEPS).replace(
    "      - name: Run\n",
    "      # BEGIN KEY-ONLY\n      # END KEY-ONLY\n      - name: Run\n",
  );
  assert.throws(() => render(two, spec), /key: 2 KEY-ONLY blocks, expected 1/u);
});

test("the steps region stops before the trailing blank line and the next job's comments", () => {
  const out = render(workflow(DERIVED_STEPS), spec);
  assert.match(
    out,
    /tag: one\n {6}# END GENERATED: demo sub\n\n {2}# Trailing job\.\n {2}after:\n/u,
  );
});

test("a missing job throws, naming it", () => {
  const bad = { ...spec, keyJob: "nope" };
  assert.throws(
    () => render(workflow(DERIVED_STEPS), bad),
    /no steps for job nope/u,
  );
});
