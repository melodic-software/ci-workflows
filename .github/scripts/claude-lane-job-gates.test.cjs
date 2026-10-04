"use strict";

// Job-level gates on both review lanes: draft PRs, fork PRs and bot-authored
// PRs skip; a bot pusher runs only when named in allowed-bots. Privileged
// triggers still reach the tripwire because the draft, fork and author tests
// are scoped to pull_request.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflowsDir = path.join(__dirname, "..", "workflows");
const ALLOWED_BOTS = "${{ inputs.allowed-bots }}";
const IDENT = /^[A-Za-z_][\w-]*/u;
const SAME_REPO = "melodic-software/app";

const functions = {
  endsWith(searchString, suffix) {
    return String(searchString)
      .toLowerCase()
      .endsWith(String(suffix).toLowerCase());
  },
  contains(search, item) {
    return String(search)
      .toLowerCase()
      .includes(String(item).toLowerCase());
  },
  format(template, ...args) {
    return String(template).replaceAll(/\{(\d+)\}/gu, (_, index) =>
      String(args[Number(index)] ?? ""),
    );
  },
};

function lookup(context, dotted) {
  const value = dotted.split(".").reduce(
    (node, key) => (node == null ? undefined : node[key]),
    context,
  );
  return value === undefined ? "" : value;
}

function equals(left, right) {
  if (typeof left === "string" && typeof right === "string") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

// GitHub Actions expression subset used by the review-lane job gates.
function evaluateGate(source, context) {
  const text = source.trim().replace(/^\$\{\{\s*/u, "").replace(/\s*\}\}$/u, "");
  let index = 0;

  const skip = () => {
    while (index < text.length && /\s/u.test(text[index])) index += 1;
  };
  const match = (re) => {
    skip();
    const found = re.exec(text.slice(index));
    if (!found || found.index !== 0) return null;
    index += found[0].length;
    return found[0];
  };
  const take = (literal) => {
    skip();
    if (!text.startsWith(literal, index)) return false;
    index += literal.length;
    return true;
  };

  function parseOr() {
    let left = parseAnd();
    while (take("||")) {
      const right = parseAnd();
      left = Boolean(left || right);
    }
    return left;
  }

  function parseAnd() {
    let left = parseEq();
    while (take("&&")) {
      const right = parseEq();
      left = Boolean(left && right);
    }
    return left;
  }

  function parseEq() {
    const left = parseUnary();
    skip();
    if (take("==")) return equals(left, parseUnary());
    if (take("!=")) return !equals(left, parseUnary());
    return left;
  }

  function parseUnary() {
    if (take("!")) return !parseUnary();
    return parsePrimary();
  }

  function parsePrimary() {
    skip();
    if (take("(")) {
      const value = parseOr();
      if (!take(")")) {
        throw new Error(`expected ) at ${index}: ${text.slice(index, index + 40)}`);
      }
      return value;
    }
    if (text[index] === "'") {
      index += 1;
      let value = "";
      while (index < text.length && text[index] !== "'") {
        value += text[index];
        index += 1;
      }
      if (text[index] !== "'") throw new Error("unterminated string");
      index += 1;
      return value;
    }
    const ident = match(IDENT);
    if (ident === null) {
      throw new Error(`unexpected at ${index}: ${text.slice(index, index + 40)}`);
    }
    if (ident === "true") return true;
    if (ident === "false") return false;
    if (ident === "null") return null;
    skip();
    if (text[index] === "(") {
      index += 1;
      const args = [];
      skip();
      if (text[index] !== ")") {
        args.push(parseOr());
        while (take(",")) args.push(parseOr());
      }
      if (!take(")")) {
        throw new Error(`expected ) at ${index}: ${text.slice(index, index + 40)}`);
      }
      const fn = functions[ident];
      if (typeof fn !== "function") throw new Error(`unknown function ${ident}`);
      return fn(...args);
    }
    let pathName = ident;
    while (text[index] === ".") {
      index += 1;
      const part = match(IDENT);
      if (part === null) throw new Error(`expected property at ${index}`);
      pathName += `.${part}`;
    }
    return lookup(context, pathName);
  }

  const value = parseOr();
  skip();
  if (index !== text.length) {
    throw new Error(`trailing input at ${index}: ${text.slice(index)}`);
  }
  return Boolean(value);
}

function context(overrides = {}) {
  const {
    actor = "alice",
    author = "alice",
    eventName = "pull_request",
    repository = SAME_REPO,
    headRepo = SAME_REPO,
    draft = false,
    allowedBots = "",
  } = overrides;
  return {
    github: {
      actor,
      event_name: eventName,
      repository,
      event: {
        pull_request: {
          draft,
          user: { login: author },
          head: { repo: { full_name: headRepo } },
        },
      },
    },
    inputs: { "allowed-bots": allowedBots },
  };
}

function claudeStep(job) {
  return job.steps.find((step) =>
    String(step.uses ?? "").startsWith("anthropics/claude-code-action@"),
  );
}

for (const { file, job } of [
  { file: "claude-review.yml", job: "review" },
  { file: "claude-security-review.yml", job: "security-review" },
]) {
  const workflow = parseWorkflow(
    fs.readFileSync(path.join(workflowsDir, file), "utf8"),
  );
  const reviewJob = workflow.jobs[job];
  const allowedBots = workflow.on.workflow_call.inputs["allowed-bots"];
  const runs = (overrides) => evaluateGate(reviewJob.if, context(overrides));

  test(`${file}: allowed-bots is a comma-separated list, empty by default, never '*'`, () => {
    assert.equal(allowedBots.type, "string");
    assert.equal(allowedBots.default, "");
    assert.match(allowedBots.description, /cursor\[bot\]/u);
    assert.match(allowedBots.description, /never '\*'/u);
    assert.doesNotMatch(reviewJob.if, /author_association|skip-actors/u);
    assert.equal(workflow.on.workflow_call.inputs["skip-actors"], undefined);
  });

  test(`${file}: human actor / human author runs`, () => {
    assert.equal(runs({ actor: "alice", author: "alice" }), true);
  });

  test(`${file}: listed bot actor / human author runs`, () => {
    assert.equal(
      runs({
        actor: "cursor[bot]",
        author: "alice",
        allowedBots: "cursor[bot]",
      }),
      true,
    );
  });

  test(`${file}: unlisted bot actor / human author skips`, () => {
    assert.equal(
      runs({ actor: "cursor[bot]", author: "alice", allowedBots: "" }),
      false,
    );
    const wrappedList = functions.format(",{0},", "");
    const wrappedActor = functions.format(",{0},", "cursor[bot]");
    assert.equal(wrappedList, ",,");
    assert.equal(functions.contains(wrappedList, wrappedActor), false);
  });

  test(`${file}: any actor / dependabot[bot] author skips`, () => {
    assert.equal(runs({ actor: "alice", author: "dependabot[bot]" }), false);
    assert.equal(
      runs({
        actor: "cursor[bot]",
        author: "dependabot[bot]",
        allowedBots: "cursor[bot]",
      }),
      false,
    );
  });

  test(`${file}: the action step gets allowed_bots from the same input`, () => {
    assert.equal(claudeStep(reviewJob).with.allowed_bots, ALLOWED_BOTS);
  });

  test(`${file}: ${job} skips draft and fork PRs, scoped to pull_request`, () => {
    assert.equal(runs({ draft: true }), false);
    assert.equal(runs({ headRepo: "fork/app" }), false);
    assert.equal(
      runs({
        eventName: "pull_request_target",
        draft: true,
        headRepo: "fork/app",
      }),
      true,
    );
  });

  test(`${file}: the privileged-trigger tripwire is the first step`, () => {
    const [reject] = reviewJob.steps;
    assert.equal(reject.name, "Reject privileged triggers");
    assert.equal(
      reject.if,
      "github.event_name == 'pull_request_target' || github.event_name == 'workflow_run'",
    );
    assert.match(reject.run, /exit 1/u);
  });
}
