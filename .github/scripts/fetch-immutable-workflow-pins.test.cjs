"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  fetchImmutablePins,
  immutableTemplatePins,
  parseCanonicalWorkflowUses,
  templateWorkflowFiles,
  workflowSha,
} = require("./fetch-immutable-workflow-pins.cjs");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const firstSha = "1111111111111111111111111111111111111111";
const secondSha = "2222222222222222222222222222222222222222";

test("canonical workflow parser accepts only literal immutable self references", () => {
  const source = `
steps:
  - uses: actions/checkout@v4
jobs:
  first:
    uses: melodic-software/ci-workflows/.github/workflows/zeta.yml@${secondSha} # reviewed
  duplicate:
    uses: "melodic-software/ci-workflows/.github/workflows/zeta.yml@${secondSha}"
  second:
    uses: melodic-software/ci-workflows/.github/workflows/alpha.yaml@${firstSha}
`;

  assert.deepEqual(parseCanonicalWorkflowUses(source), [
    { sha: secondSha, workflow: "zeta.yml" },
    { sha: secondSha, workflow: "zeta.yml" },
    { sha: firstSha, workflow: "alpha.yaml" },
  ]);
  assert.equal(workflowSha(source, "alpha.yaml"), firstSha);
});

for (const ref of [
  "main",
  "v1",
  "111111111111111111111111111111111111111A",
  "111111111111111111111111111111111111111",
]) {
  test(`canonical workflow parser rejects ref ${ref}`, () => {
    assert.throws(
      () =>
        parseCanonicalWorkflowUses(
          `uses: melodic-software/ci-workflows/.github/workflows/ci.yml@${ref}\n`,
          { sourceName: "fixture.yml" },
        ),
      /fixture\.yml:1: canonical self-workflow uses must end in a 40-character lowercase hexadecimal commit SHA/u,
    );
  });
}

test("canonical workflow parser fails when no self reference exists", () => {
  assert.throws(
    () => parseCanonicalWorkflowUses("uses: actions/checkout@v4\n"),
    /no canonical self-workflow uses found/u,
  );
});

test("repository template pins are derived, deduplicated, and sorted", () => {
  const pins = immutableTemplatePins(repositoryRoot);
  assert.ok(pins.length > 0);
  assert.deepEqual(pins, [...new Set(pins)].sort());
  for (const pin of pins) {
    assert.match(pin, /^[0-9a-f]{40}$/u);
  }
});

test("template discovery uses only tracked workflow files", () => {
  const calls = [];
  const files = templateWorkflowFiles("/repo", (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stderr: "",
      stdout: [
        "templates/example/.github/workflows/ci.yml",
        "templates/example/.github/workflows/ci.yaml",
        "templates/example/README.md",
        "templates/example/.github/actions/local/action.yml",
        "",
      ].join("\0"),
    };
  });

  assert.deepEqual(calls[0].args, ["ls-files", "-z", "--", "templates"]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(files, [
    path.join(
      "/repo",
      "templates",
      "example",
      ".github",
      "workflows",
      "ci.yaml",
    ),
    path.join(
      "/repo",
      "templates",
      "example",
      ".github",
      "workflows",
      "ci.yml",
    ),
  ]);
});

test("fetch uses fixed origin, discrete arguments, bounded retry, and verifies commits", () => {
  const calls = [];
  const backoffs = [];
  let fetchAttempts = 0;
  const run = (command, args, options) => {
    calls.push({ args, command, options });
    if (args[0] === "fetch") {
      fetchAttempts += 1;
      return {
        status: fetchAttempts === 1 ? 1 : 0,
        stderr: fetchAttempts === 1 ? "temporary failure" : "",
      };
    }
    return { status: 0, stderr: "" };
  };

  fetchImmutablePins({
    backoffMilliseconds: 17,
    cwd: repositoryRoot,
    pins: [secondSha, firstSha, secondSha],
    run,
    sleepFor: (milliseconds) => backoffs.push(milliseconds),
    timeoutMilliseconds: 23,
  });

  assert.deepEqual(backoffs, [17]);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.command, "git");
    assert.equal(call.options.cwd, repositoryRoot);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 23);
  }
  assert.deepEqual(calls[0].args, [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--depth=1",
    "origin",
    firstSha,
    secondSha,
  ]);
  assert.deepEqual(calls[1].args, calls[0].args);
  assert.deepEqual(calls[2].args, ["cat-file", "-e", `${firstSha}^{commit}`]);
  assert.deepEqual(calls[3].args, ["cat-file", "-e", `${secondSha}^{commit}`]);
});

test("fetch failure is bounded and does not verify missing commits", () => {
  let calls = 0;
  let backoffs = 0;
  assert.throws(
    () =>
      fetchImmutablePins({
        attempts: 2,
        cwd: repositoryRoot,
        pins: [firstSha],
        run: () => {
          calls += 1;
          return { status: 1, stderr: "unavailable" };
        },
        sleepFor: () => {
          backoffs += 1;
        },
      }),
    /git fetch .* failed with status 1: unavailable/u,
  );
  assert.equal(calls, 2);
  assert.equal(backoffs, 1);
});

test("fetch validates pins before invoking Git", () => {
  let invoked = false;
  assert.throws(
    () =>
      fetchImmutablePins({
        cwd: repositoryRoot,
        pins: ["main"],
        run: () => {
          invoked = true;
          return { status: 0, stderr: "" };
        },
      }),
    /pins must contain immutable lowercase commit SHAs/u,
  );
  assert.equal(invoked, false);
});
