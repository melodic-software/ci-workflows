"use strict";

// pr-review-cli.yml runs one review lane on run-claude-cli: the API key in
// the review-key job, the subscription token only in the review-subscription
// job after an exact handoff or with no key, and every write in a status job
// with no model. In summary mode (shadow) no job may end red: the guardrails
// merge guard refuses a merge while any check on the head concluded
// failure, timed_out, cancelled, action_required, startup_failure or stale.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { cliArgs, readConfig } = require("../actions/run-claude-cli/lane.cjs");
const { evaluate } = require("./actions-expression.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const workflow = parseWorkflow(
  fs.readFileSync(
    path.join(__dirname, "..", "workflows", "pr-review-cli.yml"),
    "utf8",
  ),
);
const {
  "review-key": key,
  "review-subscription": subscription,
  status,
} = workflow.jobs;
const step = (job, id) => job.steps.find((s) => s.id === id);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const PR = {
  event_name: "pull_request",
  actor: "kyle-sexton",
  repository: "o/r",
  event: {
    sender: { id: 1 },
    pull_request: {
      state: "open",
      draft: false,
      head: { repo: { full_name: "o/r" } },
      user: { login: "kyle-sexton" },
    },
  },
};
const withPr = (change) => {
  const github = structuredClone(PR);
  change(github);
  return github;
};

test("only the subscription job references the OAuth token, only the key job the key, and the status job neither", () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const text = JSON.stringify(job);
    assert.equal(
      text.includes("secrets.CLAUDE_CODE_OAUTH_TOKEN"),
      name === "review-subscription",
      name,
    );
    assert.equal(
      text.includes("secrets.CLAUDE_API_KEY"),
      name === "review-key",
      name,
    );
  }
  const credentials = (job) =>
    Object.keys(step(job, "claude").with).filter((k) => /key|token/u.test(k));
  assert.deepEqual(credentials(key), ["api-key"]);
  assert.deepEqual(credentials(subscription), ["subscription-token"]);
});

test("the model jobs cannot write and give the model no shell, GitHub token or second secret", () => {
  for (const job of [key, subscription]) {
    assert.deepEqual(job.permissions, {
      contents: "read",
      "pull-requests": "read",
    });
    assert.equal(job["cache-mode"], "none");
    assert.equal(job["runs-on"], "ubuntu-24.04");
    const launcher = step(job, "claude");
    assert.equal(launcher.uses, "$/.github/actions/run-claude-cli");
    assert.equal(launcher.with["permission-mode"], "dontAsk");
    assert.deepEqual(launcher.with.tools.trim().split("\n"), [
      "Read",
      "Grep",
      "Glob",
      "Skill",
      "Agent",
    ]);
    assert.match(launcher.with["disallowed-tools"], /^Bash$/mu);
    assert.doesNotMatch(
      JSON.stringify(launcher),
      /github\.token|GITHUB_TOKEN|GH_TOKEN/u,
    );
    assert.deepEqual(Object.keys(launcher.env), [
      "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
    ]);
  }
  assert.deepEqual(status.permissions, {
    contents: "read",
    "pull-requests": "write",
  });
  for (const job of Object.values(workflow.jobs)) {
    assert.doesNotMatch(JSON.stringify(job), /id-token/u, job.name);
  }
  // The writing job runs no model and checks nothing out.
  assert.doesNotMatch(
    JSON.stringify(status.steps),
    /run-claude-cli|claude-code-action|actions\/checkout/u,
  );
});

test("each secret-bearing job turns away forks, drafts, Dependabot, unlisted bots and other events", () => {
  const passes = (job, github, inputs = {}, outputs = {}) =>
    Boolean(
      evaluate(job.if, {
        github,
        inputs: { "allowed-bot-sender-ids": "", ...inputs },
        needs: {
          "review-key": {
            outputs: {
              handoff: "true",
              "credential-present": "true",
              ...outputs,
            },
          },
        },
      }),
    );
  for (const job of [key, subscription]) {
    assert.equal(passes(job, PR), true, job.name);
    const refused = [
      withPr((g) => {
        g.event.pull_request.head.repo.full_name = "fork/r";
      }),
      withPr((g) => {
        g.event.pull_request.draft = true;
      }),
      withPr((g) => {
        g.event.pull_request.state = "closed";
      }),
      withPr((g) => {
        g.event_name = "pull_request_target";
      }),
      withPr((g) => {
        g.actor = "dependabot[bot]";
      }),
      withPr((g) => {
        g.event.pull_request.user.login = "dependabot[bot]";
      }),
      withPr((g) => {
        g.actor = "some-app[bot]";
        g.event.sender.id = 7;
      }),
    ];
    for (const github of refused) {
      assert.equal(passes(job, github), false, JSON.stringify(github));
    }
    const bot = withPr((g) => {
      g.actor = "some-app[bot]";
      g.event.sender.id = 7;
    });
    assert.equal(passes(job, bot, { "allowed-bot-sender-ids": "5,7" }), true);
    assert.equal(passes(job, bot, { "allowed-bot-sender-ids": "5,,7" }), false);
    // Dependabot stays out even when a caller lists its id.
    const dependabot = withPr((g) => {
      g.actor = "dependabot[bot]";
      g.event.sender.id = 49699333;
    });
    assert.equal(
      passes(job, dependabot, { "allowed-bot-sender-ids": "49699333" }),
      false,
    );
  }
});

test("the subscription job starts only on an exact handoff or a key job with no key", () => {
  const starts = (outputs) =>
    Boolean(
      evaluate(subscription.if, {
        github: PR,
        inputs: { "allowed-bot-sender-ids": "" },
        needs: { "review-key": { outputs } },
      }),
    );
  assert.equal(starts({ handoff: "true", "credential-present": "true" }), true);
  assert.equal(starts({ handoff: "", "credential-present": "false" }), true);
  for (const handoff of ["", "false", "True", "true ", "1"]) {
    assert.equal(
      starts({ handoff, "credential-present": "true" }),
      false,
      JSON.stringify(handoff),
    );
  }
  // A review the scope step skipped sets no credential-present at all.
  assert.equal(starts({ handoff: "", "credential-present": "" }), false);
  assert.equal(subscription.needs, "review-key");
  assert.doesNotMatch(subscription.if, /always\(\)|failure\(\)/u);
});

test("the subscription job repeats the key job's steps but for the credential and the fallback reason", () => {
  const strip = (steps, secret, input) =>
    steps.map((s) => {
      const copy = structuredClone(s);
      if (copy.id === "credential") delete copy.env.PRESENT;
      if (copy.id === "credential") {
        assert.equal(copy.env.SECRET_NAME, secret);
        delete copy.env.SECRET_NAME;
      }
      if (copy.id === "claude") {
        assert.equal(copy.with[input], `\${{ secrets.${secret} }}`);
        delete copy.with[input];
      }
      if (copy.id === "review-outcome") delete copy.with["fallback-reason"];
      return copy;
    });
  assert.deepEqual(
    strip(subscription.steps, "CLAUDE_CODE_OAUTH_TOKEN", "subscription-token"),
    strip(key.steps, "CLAUDE_API_KEY", "api-key"),
  );
  for (const field of [
    "permissions",
    "outputs",
    "timeout-minutes",
    "cache-mode",
  ]) {
    assert.deepEqual(subscription[field], key[field], field);
  }
  for (const s of subscription.steps) {
    assert.doesNotMatch(s.uses ?? "", /download-artifact|actions\/cache/u);
    assert.doesNotMatch(s.run ?? "", /needs\./u, s.name);
    assert.doesNotMatch(s.with?.script ?? "", /needs\./u, s.name);
  }
  const names = key.steps.map((s) => s.name);
  assert.ok(
    names.indexOf("Apply the Claude managed settings") <
      names.indexOf("Isolate the runner") &&
      names.indexOf("Isolate the runner") < names.indexOf("Check out"),
  );
});

test("the key job runs no model when the key is empty or REVIEWS_KEY_EXHAUSTED is true", () => {
  const present = (secret, exhausted) =>
    evaluate(step(key, "credential").env.PRESENT, {
      secrets: { CLAUDE_API_KEY: secret },
      vars: { REVIEWS_KEY_EXHAUSTED: exhausted },
    });
  assert.equal(present("k", ""), true);
  assert.equal(present("k", "false"), true);
  assert.equal(present("k", "true"), false);
  assert.equal(present("", ""), false);
  assert.equal(
    evaluate(step(subscription, "credential").env.PRESENT, {
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
      vars: { REVIEWS_KEY_EXHAUSTED: "true" },
    }),
    true,
  );
  // The reason the subscription leg records.
  const reason = (outputs) =>
    evaluate(step(subscription, "review-outcome").with["fallback-reason"], {
      needs: { "review-key": { outputs } },
    });
  assert.equal(reason({ "lane-class": "credit-stop" }), "credit-stop");
  assert.equal(reason({ "lane-class": "auth" }), "auth");
  assert.equal(
    reason({ "lane-class": "", "credential-present": "false" }),
    "no-key",
  );
});

const minutes = (value, lane) =>
  Number(evaluate(String(value), { inputs: { lane } }));

// GitHub compares strings ignoring case, so `Comments` is comments mode.
for (const publish of ["summary", "", "anything"]) {
  test(`publish=${JSON.stringify(publish)} continues every step on error and keeps every job inside its limit`, () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const s of job.steps) {
        const value = s["continue-on-error"];
        assert.ok(
          value === true ||
            evaluate(String(value ?? "false"), { inputs: { publish } }) ===
              true,
          `${job.name} / ${s.name}`,
        );
      }
      for (const lane of ["code", "security"]) {
        const total = job.steps.reduce((sum, s) => {
          assert.ok(
            s["timeout-minutes"] !== undefined,
            `${job.name} / ${s.name} has no timeout`,
          );
          return sum + minutes(s["timeout-minutes"], lane);
        }, 0);
        // Job setup and post steps (action downloads, the artifact post
        // step) count against the job's limit too, so it keeps headroom.
        assert.ok(
          total + 5 <= minutes(job["timeout-minutes"], lane),
          `${job.name} (${lane}): steps ${total} min`,
        );
      }
    }
  });
}

test("comments mode lets the hardening and publish steps fail the job", () => {
  for (const name of [
    "Apply the Claude managed settings",
    "Isolate the runner",
    "Check out",
  ]) {
    const value = key.steps.find((s) => s.name === name)["continue-on-error"];
    assert.equal(evaluate(value, { inputs: { publish: "comments" } }), false);
  }
  const publish = status.steps.find((s) => s.name === "Publish the review");
  assert.equal(
    evaluate(publish["continue-on-error"], { inputs: { publish: "comments" } }),
    false,
  );
});

test("the shadow report uploads per lane and attempt, overwriting on a rerun", () => {
  const upload = status.steps.find(
    (s) => s.name === "Upload the shadow report",
  );
  assert.equal(
    upload.with.name,
    `pr-review-cli-\${{ inputs.lane }}-\${{ github.run_attempt }}`,
  );
  assert.equal(upload.with.overwrite, true);
  assert.equal(upload.with["if-no-files-found"], "ignore");
  assert.equal(
    Boolean(evaluate(upload.if, { inputs: { publish: "comments" } })),
    false,
  );
});

test("shadow lane records carry their own lane id", () => {
  const laneId = (lane, publish) =>
    evaluate(step(key, "review-outcome").with["lane-id"], {
      inputs: { lane, publish },
    });
  assert.equal(laneId("code", "comments"), "pr-review");
  assert.equal(laneId("security", "comments"), "pr-review-security");
  assert.equal(laneId("code", "summary"), "pr-review-shadow");
  assert.equal(laneId("security", "summary"), "pr-review-security-shadow");
});

test("run-claude-cli accepts the launcher step's inputs for both lanes and passes the tool rules through", () => {
  const workspace = makeTemporaryDirectory("pr-review-cli-launch-");
  fs.mkdirSync(path.join(workspace, ".lane", "plugins", "review"), {
    recursive: true,
  });
  const prompt = path.join(workspace, "prompt.md");
  const schema = path.join(workspace, "schema.json");
  fs.writeFileSync(prompt, "Review.\n");
  fs.writeFileSync(schema, "{}");
  const launcher = step(key, "claude");
  // run-claude-cli's action.yml maps each input to LANE_<INPUT>.
  const variable = (input) =>
    `LANE_${input.toUpperCase().replaceAll("-", "_")}`;
  for (const [lane, skill] of [
    ["code", "review:code-review"],
    ["security", "review:security-review"],
  ]) {
    const contexts = {
      inputs: { lane, role: "reviews" },
      secrets: { CLAUDE_API_KEY: "key-value-for-tests-1234" },
      steps: {
        compose: {
          outputs: {
            "prompt-file": prompt,
            "schema-file": schema,
            skill,
            model: "sonnet",
            effort: "high",
            "max-turns": "75",
          },
        },
      },
    };
    const resolve = (value) =>
      String(value).replace(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression) =>
        String(evaluate(expression, contexts) ?? ""),
      );
    const env = {
      GITHUB_WORKSPACE: workspace,
      LANE_CLI_VERSION: "2.1.302",
      LANE_CLI_PATH: "/usr/bin/claude",
      LANE_WORK_DIR: workspace,
      LANE_WATCHDOG_MAX_WAIT_MS: "1800000",
      LANE_SUBSCRIPTION_TOKEN: "",
    };
    for (const [input, value] of Object.entries(launcher.with)) {
      // cli-version feeds the install step; the run step gets the installed one.
      if (input === "cli-version") continue;
      env[input === "lane" ? "LANE_NAME" : variable(input)] = resolve(value);
    }
    const config = readConfig(env);
    const args = cliArgs(config);
    assert.equal(
      config.lane,
      lane === "code" ? "pr-review" : "pr-review-security",
    );
    assert.deepEqual(config.allowedTools, [
      "Read",
      "Grep",
      "Glob",
      `Skill(${skill})`,
      "Agent",
    ]);
    assert.deepEqual(config.tools, ["Read", "Grep", "Glob", "Skill", "Agent"]);
    assert.equal(config.legTimeoutMs, (lane === "code" ? 11 : 13) * 60_000);
    assert.deepEqual(args.slice(args.indexOf("--allowedTools")), [
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      `Skill(${skill})`,
      "Agent",
    ]);
    assert.ok(args.includes("--disallowedTools"));
    assert.equal(
      args[args.indexOf("--plugin-dir") + 1],
      path.join(workspace, ".lane", "plugins", "review"),
    );
    assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
  }
});

test("the prompt carries the FULL DIFF, REVIEW SCOPE and PR CONTEXT lines the review skills read, in both lanes", () => {
  const fullDiff = step(key, "full-diff");
  assert.equal(fullDiff.if, "steps.scope.outputs.review != 'false'");
  assert.match(fullDiff.run, /echo "note=FULL DIFF: .* is in \$DIFF_FILE\./u);
  const scope = step(key, "scope").with.script;
  assert.match(scope, /`REVIEW SCOPE: incremental\./u);
  assert.match(
    scope,
    /`That change is in \$\{env\.DIFF_FILE\}; read it, and use the FULL DIFF file only for context\.`/u,
  );
  assert.doesNotMatch(scope, /gh pr diff/u);
  assert.match(
    step(key, "pr-context").run,
    /note=PR CONTEXT: .* are in \$CONTEXT_FILE\./u,
  );
  const compose = step(key, "compose");
  for (const [name, source] of [
    ["SCOPE_NOTE", "steps.scope.outputs.note"],
    ["FULL_DIFF_NOTE", "steps.full-diff.outputs.note"],
    ["CONTEXT_NOTE", "steps.pr-context.outputs.note"],
  ]) {
    assert.equal(compose.env[name], `\${{ ${source} }}`);
    assert.match(compose.with.script, new RegExp(`env\\.${name},`, "u"));
  }
});

async function extract(files, env = {}) {
  const dir = makeTemporaryDirectory("pr-review-cli-extract-");
  const paths = {};
  for (const [name, content] of Object.entries(files)) {
    paths[name] = path.join(dir, name);
    fs.writeFileSync(paths[name], content);
  }
  const outputs = {};
  const values = {
    STRUCTURED_FILE: paths.structured ?? "",
    LOG_FILE: paths.log ?? "",
    MODE_OK: "true",
    SCOPE: "whole",
    FULL_DIFF: "true",
    ...env,
  };
  const saved = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, values);
  const summary = { addRaw: () => summary, write: async () => {} };
  try {
    await new AsyncFunction(
      "require",
      "core",
      step(key, "extract").with.script,
    )(require, {
      setOutput: (k, v) => {
        outputs[k] = v;
      },
      info: () => {},
      summary,
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return outputs;
}

const LOG = JSON.stringify({
  num_turns: 12,
  total_cost_usd: 0.5,
  duration_ms: 90000,
  started_at: "2026-10-23T00:00:00.000Z",
  ended_at: "2026-10-23T00:02:00.000Z",
  models_used: { "claude-sonnet-5": {}, "bad model!": {} },
});
const COMMENT = { path: "a.js", line: 3, side: "RIGHT", body: "Off by one." };

test("the extract step passes on a well-formed review with the scanned log's facts", async () => {
  const outputs = await extract({
    structured: JSON.stringify({
      findings: 0,
      summary: "One issue.<!-- hidden -->\n- `manifest name: flag`",
      comments: [COMMENT],
    }),
    log: `${LOG}\n`,
  });
  assert.equal(outputs.verdict, "complete");
  // Raised to the larger of one comment and one manifest flag line.
  assert.deepEqual(JSON.parse(outputs.review), {
    findings: 1,
    summary: "One issue.\n- `manifest name: flag`",
    comments: [COMMENT],
  });
  assert.equal(outputs.turns, "12");
  assert.equal(outputs.cost, "0.5");
  assert.equal(outputs["leg-ms"], "90000");
  assert.equal(outputs["wall-ms"], "120000");
  assert.equal(outputs.models, "claude-sonnet-5");
});

test("the extract step calls a review incomplete on every gap it checks", async () => {
  const good = { findings: 1, summary: "S", comments: [COMMENT] };
  for (const [files, env, reason] of [
    [
      { structured: JSON.stringify(good) },
      { MODE_OK: "false" },
      /permission mode/u,
    ],
    [{ structured: JSON.stringify(good) }, { FULL_DIFF: "" }, /full diff/u],
    [{}, {}, /no structured output/u],
    [
      { structured: JSON.stringify({ ...good, findings: -1 }) },
      {},
      /findings count/u,
    ],
    [
      { structured: JSON.stringify({ ...good, summary: "<!-- x -->" }) },
      {},
      /no summary/u,
    ],
    [
      {
        structured: JSON.stringify({
          ...good,
          comments: [{ ...COMMENT, side: "BOTH" }],
        }),
      },
      {},
      /malformed/u,
    ],
    [
      {
        structured: JSON.stringify({
          ...good,
          comments: [{ ...COMMENT, path: "/etc/passwd" }],
        }),
      },
      {},
      /malformed/u,
    ],
    [
      {
        structured: JSON.stringify({
          ...good,
          comments: [{ ...COMMENT, start_line: 3 }],
        }),
      },
      {},
      /malformed/u,
    ],
  ]) {
    const outputs = await extract(files, env);
    assert.match(outputs.verdict, reason);
    assert.equal(outputs.review, undefined);
  }
  // An incremental review needs no full diff.
  const outputs = await extract(
    { structured: JSON.stringify(good) },
    { FULL_DIFF: "", SCOPE: "incremental" },
  );
  assert.equal(outputs.verdict, "complete");
});
