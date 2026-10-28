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
  "review-fallback": fallback,
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
  assert.deepEqual(credentials(fallback), ["fallback-token"]);
  // The fallback token's value reaches only the fallback job; the other
  // model jobs read only whether it is set.
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(
      JSON.stringify(job).includes(
        "secrets.FALLBACK_CLAUDE_CODE_OAUTH_TOKEN }}",
      ),
      name === "review-fallback",
      name,
    );
  }
  assert.equal(
    workflow.on.workflow_call.secrets.FALLBACK_CLAUDE_CODE_OAUTH_TOKEN.required,
    false,
  );
});

test("every model job tells its launcher whether the fallback token is set, never its value", () => {
  for (const job of [key, subscription, fallback]) {
    assert.equal(
      step(job, "credential").env.FALLBACK_PRESENT,
      `\${{ secrets.FALLBACK_CLAUDE_CODE_OAUTH_TOKEN != '' }}`,
      job.name,
    );
    assert.equal(
      step(job, "claude").with["fallback-ready"],
      `\${{ steps.credential.outputs.fallback-ready }}`,
      job.name,
    );
    assert.equal(
      job.outputs["handoff-reason"],
      `\${{ steps.claude.outputs.handoff-reason }}`,
      job.name,
    );
  }
  const dir = makeTemporaryDirectory("pr-review-cli-credential-");
  const ready = (present) => {
    const output = path.join(dir, `out-${present}`);
    fs.writeFileSync(output, "");
    require("node:child_process").spawnSync(
      "bash",
      ["-e", "-c", step(subscription, "credential").run],
      {
        env: {
          PATH: process.env.PATH,
          PRESENT: "true",
          SECRET_NAME: "X",
          FALLBACK_PRESENT: present,
          GITHUB_OUTPUT: output,
        },
      },
    );
    return fs.readFileSync(output, "utf8");
  };
  assert.match(ready("true"), /^fallback-ready=true$/mu);
  for (const present of ["false", "", "True"]) {
    assert.match(
      ready(present),
      /^fallback-ready=false$/mu,
      JSON.stringify(present),
    );
  }
});

test("the fallback job starts only after the subscription job succeeded and handed off exactly", () => {
  assert.deepEqual(fallback.needs, [
    "check-key-credit",
    "review-key",
    "review-subscription",
  ]);
  assert.equal(
    fallback.name,
    `\${{ inputs.lane == 'security' && 'security-review-fallback' || 'claude-review-fallback' }}`,
  );
  const starts = (outputs, result = "success", keyResult = "success") =>
    Boolean(
      evaluate(fallback.if, {
        github: PR,
        inputs: { "allowed-bot-sender-ids": "" },
        needs: {
          "review-key": { result: keyResult, outputs: {} },
          "review-subscription": { result, outputs },
        },
      }),
    );
  assert.equal(starts({ handoff: "true" }), true);
  // After a credit skip of the key job too.
  assert.equal(starts({ handoff: "true" }, "success", "skipped"), true);
  for (const handoff of ["", "false", "True", "true ", "1"]) {
    assert.equal(starts({ handoff }), false, JSON.stringify(handoff));
  }
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.equal(starts({ handoff: "true" }, result), false, result);
  }
  // A fork, a draft or Dependabot never reaches it either.
  assert.equal(
    Boolean(
      evaluate(fallback.if, {
        github: withPr((g) => {
          g.event.pull_request.head.repo.full_name = "fork/r";
        }),
        inputs: { "allowed-bot-sender-ids": "" },
        needs: {
          "review-subscription": {
            result: "success",
            outputs: { handoff: "true" },
          },
        },
      }),
    ),
    false,
  );
  assert.doesNotMatch(fallback.if, /always\(\)|failure\(\)/u);
});

const FALLBACK_LEG_REASON =
  `\${{ needs.review-subscription.outputs.handoff-reason == 'limit-stop' && 'limit-stop' || ` +
  "needs.review-subscription.outputs.handoff-reason == 'credit-stop' && 'credit-stop' || " +
  "needs.review-subscription.outputs.handoff-reason == 'auth' && 'auth' || '' }}";

test("the fallback job repeats the subscription job's steps but for the credential and the fallback reason", () => {
  const strip = (steps, secret, input) =>
    steps.map((s) => {
      const copy = structuredClone(s);
      if (copy.id === "credential") {
        assert.equal(copy.env.SECRET_NAME, secret);
        assert.equal(copy.env.PRESENT, `\${{ secrets.${secret} != '' }}`);
        delete copy.env.PRESENT;
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
    strip(fallback.steps, "FALLBACK_CLAUDE_CODE_OAUTH_TOKEN", "fallback-token"),
    strip(subscription.steps, "CLAUDE_CODE_OAUTH_TOKEN", "subscription-token"),
  );
  for (const field of [
    "permissions",
    "outputs",
    "timeout-minutes",
    "cache-mode",
    "runs-on",
  ]) {
    assert.deepEqual(fallback[field], subscription[field], field);
  }
  const value = step(fallback, "review-outcome").with["fallback-reason"];
  assert.equal(value, FALLBACK_LEG_REASON);
  const reason = (handoffReason) =>
    evaluate(value, {
      needs: {
        "review-subscription": { outputs: { "handoff-reason": handoffReason } },
      },
    });
  for (const known of ["limit-stop", "credit-stop", "auth"])
    assert.equal(reason(known), known);
  for (const forged of ["", "no-key", "Auth"])
    assert.equal(reason(forged), "", forged);
});

test("the status job counts the fallback leg when it ran, else the subscription leg", async () => {
  assert.deepEqual(status.needs, [
    "review-key",
    "review-subscription",
    "review-fallback",
  ]);
  const pick = step(status, "token-leg");
  const names = status.steps.map((s) => s.id ?? s.name);
  assert.ok(names.indexOf("handoffs") < names.indexOf("token-leg"));
  assert.ok(names.indexOf("token-leg") < names.indexOf("Publish the review"));
  assert.doesNotMatch(pick.with.script, /\$\{\{/u);
  const run = async (env) => {
    const outputs = {};
    const core = {
      setOutput: (k, v) => {
        outputs[k] = v;
      },
    };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      await new AsyncFunction("require", "core", pick.with.script)(
        require,
        core,
      );
    } finally {
      for (const k of Object.keys(env)) {
        if (k in saved) process.env[k] = saved[k];
        else delete process.env[k];
      }
    }
    return outputs;
  };
  const legs = {
    SUB_RESULT: "success",
    SUB_PRESENT: "true",
    SUB_FAILED: "true",
    SUB_CLASS: "rate-limit",
    SUB_VERDICT: "",
    SUB_REVIEW: "",
    SUB_TURNS: "1",
    FB_PRESENT: "true",
    FB_FAILED: "false",
    FB_CLASS: "",
    FB_VERDICT: "complete",
    FB_REVIEW: '{"findings":0}',
    FB_TURNS: "7",
  };
  const ran = await run({ ...legs, FB_RESULT: "success" });
  assert.deepEqual(
    [
      ran["leg-result"],
      ran.present,
      ran.failed,
      ran.class,
      ran.verdict,
      ran.review,
      ran.turns,
    ],
    ["success", "true", "false", "", "complete", '{"findings":0}', "7"],
  );
  for (const result of ["skipped", ""]) {
    const before = await run({ ...legs, FB_RESULT: result });
    assert.deepEqual(
      [before["leg-result"], before.failed, before.class, before.turns],
      ["success", "true", "rate-limit", "1"],
      JSON.stringify(result),
    );
  }
  for (const name of ["Publish the review", "Apply the hold"]) {
    const env = status.steps.find((s) => s.name === name).env;
    for (const field of [
      "RESULT",
      "PRESENT",
      "FAILED",
      "CLASS",
      "VERDICT",
      "REVIEW",
    ]) {
      assert.equal(
        env[`SUB_${field}`],
        `\${{ steps.token-leg.outputs.${field === "RESULT" ? "leg-result" : field.toLowerCase()} }}`,
        `${name} SUB_${field}`,
      );
    }
  }
  const handoffs = step(status, "handoffs");
  assert.equal(
    handoffs.env.FB_SHA256,
    `\${{ needs.review-fallback.outputs.handoff-sha256 }}`,
  );
  assert.match(
    handoffs.with.script,
    /\["review-fallback", "fb", env\.FB_SHA256\]/u,
  );
});

test("after a key-credit skip, publish reads the counted token leg's success, not no-outcome", async () => {
  // actions/github-script sets the step output `result` to the script's
  // return value after the script runs (src/main.ts:106 at the pinned sha),
  // so a script's own setOutput("result", ...) never reaches a later step.
  const { judge } = require("../actions/publish-review/publish.cjs");
  const pick = step(status, "token-leg");
  assert.equal(pick.with["result-encoding"] ?? "json", "json");
  const REVIEW = '{"findings":0,"summary":"No findings.","comments":[]}';
  const ok = {
    PRESENT: "true",
    FAILED: "false",
    CLASS: "",
    VERDICT: "complete",
    REVIEW,
  };
  const legEnv = (prefix, values) =>
    Object.fromEntries(
      Object.entries(values).map(([k, v]) => [`${prefix}_${k}`, v]),
    );
  // The key job skipped by the key-credit window: every KEY_ value empty.
  for (const [label, env] of [
    [
      "subscription",
      { SUB_RESULT: "success", ...legEnv("SUB", ok), FB_RESULT: "skipped" },
    ],
    [
      "fallback",
      {
        SUB_RESULT: "success",
        ...legEnv("SUB", {
          ...ok,
          FAILED: "true",
          CLASS: "rate-limit",
          VERDICT: "",
        }),
        FB_RESULT: "success",
        ...legEnv("FB", ok),
      },
    ],
  ]) {
    const outputs = {};
    const core = {
      setOutput: (k, v) => {
        outputs[k] = v == null ? "" : String(v);
      },
    };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    let returned;
    try {
      returned = await new AsyncFunction("require", "core", pick.with.script)(
        require,
        core,
      );
    } finally {
      for (const k of Object.keys(env)) {
        if (k in saved) process.env[k] = saved[k];
        else delete process.env[k];
      }
    }
    core.setOutput("result", JSON.stringify(returned));
    for (const name of ["Publish the review", "Apply the hold"]) {
      const stepEnv = status.steps.find((s) => s.name === name).env;
      const resolved = Object.fromEntries(
        Object.entries(stepEnv)
          .filter(([k]) => k.startsWith("SUB_") || k.startsWith("KEY_"))
          .map(([k, v]) => [
            k,
            String(
              evaluate(v, { steps: { "token-leg": { outputs } }, needs: {} }) ??
                "",
            ),
          ]),
      );
      assert.equal(resolved.SUB_RESULT, "success", `${label} ${name}`);
      const verdict = judge(resolved);
      assert.deepEqual(
        [verdict.ok, verdict.leg, verdict.review?.findings],
        [true, "SUB", 0],
        `${label} ${name}`,
      );
    }
  }
});

test("the model jobs cannot write and give the model no shell, GitHub token or second secret", () => {
  for (const job of [key, subscription, fallback]) {
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
  // Read-only actions and checks let the hold step read its earlier runs'
  // cost notices (claude-code-plugins#9635); the only write stays
  // pull-requests.
  assert.deepEqual(status.permissions, {
    actions: "read",
    checks: "read",
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
          "check-key-credit": { result: "success", outputs: {} },
          "review-key": {
            result: "success",
            outputs: {
              handoff: "true",
              "credential-present": "true",
              ...outputs,
            },
          },
        },
      }),
    );
  for (const job of [workflow.jobs["check-key-credit"], key, subscription]) {
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

test("the subscription job starts only on an exact handoff, a key job with no key or a credit skip", () => {
  const starts = (outputs, result = "success", skipKey = "") =>
    Boolean(
      evaluate(subscription.if, {
        github: PR,
        inputs: { "allowed-bot-sender-ids": "" },
        needs: {
          "check-key-credit": { outputs: { "skip-key": skipKey } },
          "review-key": { result, outputs },
        },
      }),
    );
  // A key job skipped by check-key-credit's exact `true`, and no other skip.
  assert.equal(starts({}, "skipped", "true"), true);
  for (const skipKey of ["", "false", "True", "true ", "1"]) {
    assert.equal(
      starts({}, "skipped", skipKey),
      false,
      JSON.stringify(skipKey),
    );
  }
  // A key job that failed or was cancelled starts nothing, as before.
  for (const result of ["failure", "cancelled"]) {
    assert.equal(starts({ handoff: "true" }, result, "true"), false, result);
  }
  assert.deepEqual(subscription.needs, ["check-key-credit", "review-key"]);
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
  assert.doesNotMatch(subscription.if, /always\(\)|failure\(\)/u);
});

test("the key job runs unless check-key-credit says exactly true, a failed check-key-credit included", () => {
  const runs = (skipKey, result = "success") =>
    Boolean(
      evaluate(key.if, {
        github: PR,
        inputs: { "allowed-bot-sender-ids": "" },
        needs: {
          "check-key-credit": { result, outputs: { "skip-key": skipKey } },
        },
      }),
    );
  assert.equal(runs("true"), false);
  for (const skipKey of ["", "false", "True"]) {
    assert.equal(runs(skipKey), true, JSON.stringify(skipKey));
  }
  assert.equal(runs("", "failure"), true);
  assert.equal(runs("", "skipped"), true);
  assert.equal(key.needs, "check-key-credit");
  const gate = workflow.jobs["check-key-credit"];
  assert.deepEqual(gate.permissions, { actions: "read" });
  assert.equal(gate.steps[0].uses, "$/.github/actions/check-key-credit");
  assert.equal(gate.outputs["skip-key"], `\${{ steps.gate.outputs.skip-key }}`);
  assert.doesNotMatch(JSON.stringify(gate), /secrets\./u);
});

test("the credit record steps carry the names and conditions check-key-credit reads", () => {
  const {
    MODEL_STEP,
    RECORD_PATTERN,
  } = require("../actions/check-key-credit/gate.cjs");
  const render = (name, context) =>
    name.replace(/\$\{\{\s*([^}]+?)\s*\}\}/gu, (_, expr) =>
      String(evaluate(expr, context)),
    );
  for (const job of [key, subscription]) {
    const record = job.steps.find((s) => s.name.startsWith("Record the key"));
    assert.match(
      render(record.name, { github: { run_id: "123" } }),
      RECORD_PATTERN,
    );
    assert.equal(step(job, "claude").name, MODEL_STEP);
    const runsAfter = (laneClass) =>
      Boolean(
        evaluate(record.if, {
          steps: { claude: { outputs: { "lane-class": laneClass } } },
        }),
      );
    assert.equal(runsAfter("credit-stop"), true);
    for (const laneClass of ["auth", "rate-limit", "", "other"]) {
      assert.equal(runsAfter(laneClass), false, laneClass);
    }
  }
  const carry = workflow.jobs["check-key-credit"].steps[1];
  const context = (skip) => ({
    steps: { gate: { outputs: { "skip-key": skip, "origin-run": "99" } } },
  });
  assert.match(render(carry.name, context("true")), RECORD_PATTERN);
  assert.equal(
    render(carry.name, context("true")).match(RECORD_PATTERN)[1],
    "99",
  );
  assert.equal(Boolean(evaluate(carry.if, context("true"))), true);
  assert.equal(Boolean(evaluate(carry.if, context(""))), false);
});

test("after a credit skip the status job runs and reads the subscription job's scope", () => {
  const needs = (keyResult, subResult) => ({
    "review-key": {
      result: keyResult,
      outputs:
        keyResult === "skipped"
          ? {}
          : { "scope-review": "key", "pr-files": "k" },
    },
    "review-subscription": {
      result: subResult,
      outputs:
        subResult === "skipped"
          ? {}
          : { "scope-review": "sub", "pr-files": "s" },
    },
  });
  const runs = (k, s) => Boolean(evaluate(status.if, { needs: needs(k, s) }));
  assert.equal(runs("skipped", "success"), true);
  assert.equal(runs("success", "skipped"), true);
  assert.equal(runs("skipped", "skipped"), false);
  for (const name of ["Publish the review", "Apply the hold"]) {
    const env = status.steps.find((s) => s.name === name).env;
    const read = (k, s, v) => evaluate(env[v], { needs: needs(k, s) });
    assert.equal(read("skipped", "success", "PR_FILES"), "s", name);
    assert.equal(read("success", "success", "PR_FILES"), "k", name);
    assert.equal(read("success", "skipped", "PR_FILES"), "k", name);
  }
  const publish = status.steps.find((s) => s.name === "Publish the review").env;
  for (const v of [
    "SCOPE_REVIEW",
    "SKIP",
    "SKIP_REASON",
    "SINCE",
    "SCOPE",
    "MARKER_ID",
    "MERGE_BASE",
  ]) {
    assert.match(
      publish[v],
      /needs\.review-key\.result == 'skipped' && needs\.review-subscription\.outputs\./u,
      v,
    );
  }
  assert.equal(
    evaluate(publish.SCOPE_REVIEW, { needs: needs("skipped", "success") }),
    "sub",
  );
  // The subscription leg records the skip as the credit stop it follows.
  assert.equal(
    evaluate(step(subscription, "review-outcome").with["fallback-reason"], {
      needs: { "review-key": { result: "skipped", outputs: {} } },
    }),
    "credit-stop",
  );
});

test("the status job takes the last summary from the subscription leg when the key leg left none", async () => {
  const dir = makeTemporaryDirectory("pr-review-cli-handoffs-");
  const crypto = require("node:crypto");
  const write = (leg, data) => {
    const bytes = Buffer.from(JSON.stringify(data));
    fs.writeFileSync(path.join(dir, `${leg}.json`), bytes);
    return crypto.createHash("sha256").update(bytes).digest("hex");
  };
  const check = status.steps.find((s) => s.id === "handoffs");
  const run = async (env) => {
    const outputs = {};
    const core = {
      setOutput: (k, v) => {
        outputs[k] = v;
      },
      warning: () => {},
    };
    const saved = { ...process.env };
    Object.assign(process.env, {
      HANDOFF_DIR: dir,
      KEY_SHA256: "",
      SUB_SHA256: "",
      ...env,
    });
    try {
      await new AsyncFunction("require", "core", check.with.script)(
        require,
        core,
      );
    } finally {
      for (const k of ["HANDOFF_DIR", "KEY_SHA256", "SUB_SHA256"]) {
        if (k in saved) process.env[k] = saved[k];
        else delete process.env[k];
      }
    }
    return outputs;
  };
  const sub = write("review-subscription", { "last-summary": "from sub" });
  assert.equal((await run({ SUB_SHA256: sub }))["last-summary"], "from sub");
  const keyLeg = write("review-key", { "last-summary": "from key" });
  assert.equal(
    (await run({ KEY_SHA256: keyLeg, SUB_SHA256: sub }))["last-summary"],
    "from key",
  );
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

test("a leg whose runner isolation failed reports install-failed, not no-outcome", () => {
  const { judge } = require("../actions/publish-review/publish.cjs");
  for (const [name, job, prefix] of [
    ["review-key", key, "KEY"],
    ["review-subscription", subscription, "SUB"],
    ["review-fallback", fallback, "SUB"],
  ]) {
    assert.ok(step(job, "isolate"), `${name} has an isolate step`);
    // The isolate step stops the job, so no later step ran or set an output.
    const leg = (isolate, outcomeClass = "") => {
      const context = {
        steps: {
          isolate: { outcome: isolate },
          claude: { outputs: {} },
          "review-outcome": { outputs: { "failure-class": outcomeClass } },
        },
      };
      const out = (field) =>
        String(evaluate(job.outputs[field], context) ?? "");
      return { FAILED: out("review-failed"), CLASS: out("failure-class") };
    };
    for (const outcome of ["failure", "cancelled"]) {
      const { FAILED, CLASS } = leg(outcome);
      assert.equal(CLASS, "install-failed", `${name} ${outcome}`);
      const env =
        prefix === "KEY"
          ? { KEY_FAILED: FAILED, KEY_CLASS: CLASS }
          : { SUB_RESULT: "failure", SUB_FAILED: FAILED, SUB_CLASS: CLASS };
      assert.equal(
        judge(env).failureClass,
        "install-failed",
        `${name} ${outcome}`,
      );
    }
    assert.equal(leg("success").CLASS, "", `${name} success`);
    assert.equal(
      leg("failure", "timeout").CLASS,
      "timeout",
      `${name} reported class`,
    );
  }
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

// Whether a step continues on error, evaluated as the runner does. After a
// composite action (`uses: $/...`) runs, the runner replaces the step's
// `inputs` and `steps` contexts with the action's own before it reads
// continue-on-error (actions/runner CompositeActionHandler.cs), so there
// only the step's env still carries the workflow's publish input.
function continues(s, publish) {
  const value = s["continue-on-error"];
  if (value === undefined || typeof value === "boolean") return value === true;
  // Only env values the publish input sets matter here.
  const env = Object.fromEntries(
    Object.entries(s.env ?? {})
      .filter(([, text]) => /^\$\{\{\s*inputs\.publish\s*\}\}$/u.test(text))
      .map(([name]) => [name, publish]),
  );
  const composite = String(s.uses ?? "").startsWith("$/");
  return (
    evaluate(String(value), {
      inputs: composite ? {} : { publish },
      steps: composite ? {} : undefined,
      env,
    }) === true
  );
}

// GitHub compares strings ignoring case, so `Comments` is comments mode.
for (const publish of ["summary", "", "anything"]) {
  test(`publish=${JSON.stringify(publish)} continues every step on error and keeps every job inside its limit`, () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const s of job.steps) {
        assert.equal(continues(s, publish), true, `${job.name} / ${s.name}`);
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

// The header's contract: in comments mode the status job goes red, naming the
// class, when no review happened; publish.cjs fails the step for it.
test("comments mode lets the hardening, publish and hold steps fail the job", () => {
  for (const job of [key, subscription]) {
    for (const name of [
      "Apply the Claude managed settings",
      "Isolate the runner",
      "Check out",
    ]) {
      const s = job.steps.find((x) => x.name === name);
      assert.equal(continues(s, "comments"), false, `${job.name} / ${name}`);
    }
  }
  for (const name of ["Publish the review", "Apply the hold"]) {
    const s = status.steps.find((x) => x.name === name);
    assert.equal(continues(s, "comments"), false, name);
  }
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
  const warnings = [];
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
      warning: (message) => warnings.push(message),
      summary,
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return Object.assign(outputs, { warnings });
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

test("the extract step keeps the valid comments and passes a malformed one on for the summary", async () => {
  const critical = "Injection.\n\nseverity: CRITICAL";
  for (const bad of [
    { ...COMMENT, side: "BOTH", body: critical },
    { ...COMMENT, path: "/etc/passwd", body: critical },
    { ...COMMENT, start_line: 3, body: critical },
    { ...COMMENT, line: 0, body: critical },
  ]) {
    const outputs = await extract({
      structured: JSON.stringify({
        findings: 0,
        summary: "S",
        comments: [bad, COMMENT],
      }),
    });
    assert.equal(outputs.verdict, "complete", JSON.stringify(bad));
    const review = JSON.parse(outputs.review);
    assert.deepEqual(review.comments, [COMMENT]);
    assert.equal(review.malformed.length, 1);
    assert.equal(review.malformed[0].body, critical);
    // Two findings: the valid comment and the malformed one.
    assert.equal(review.findings, 2);
  }
  // The location is kept only where it is readable.
  const located = await extract({
    structured: JSON.stringify({
      findings: 1,
      summary: "S",
      comments: [
        { path: "a.js", line: 7, side: "BOTH", body: "B" },
        { path: "x\ncritical-findings: 0", line: -1, body: "C" },
      ],
    }),
  });
  assert.deepEqual(JSON.parse(located.review).malformed, [
    { path: "a.js", line: 7, body: "B" },
    { body: "C" },
  ]);
});

test("the extract step drops a comment with no body, with a warning", async () => {
  const outputs = await extract({
    structured: JSON.stringify({
      findings: 1,
      summary: "S",
      comments: [COMMENT, { ...COMMENT, body: "  " }, { path: "a.js" }],
    }),
  });
  assert.equal(outputs.verdict, "complete");
  const review = JSON.parse(outputs.review);
  assert.deepEqual(review.comments, [COMMENT]);
  assert.equal("malformed" in review, false);
  assert.equal(outputs.warnings.length, 2);
});

// Linux refuses an environment string over 128 KiB (MAX_ARG_STRLEN), and the
// status job receives the review as one.
test("the extract step passes on a review no larger than one environment string can hold", async () => {
  const comment = (body) => ({ ...COMMENT, body });
  const largest = {
    findings: 25,
    summary: "s".repeat(20000),
    comments: Array.from({ length: 25 }, () => comment("b".repeat(3000))),
  };
  const fits = await extract({ structured: JSON.stringify(largest) });
  assert.equal(fits.verdict, "complete");
  assert.ok(Buffer.byteLength(fits.review) < 128 * 1024);
  // Three-byte characters at the schema's caps pass 100,000 bytes.
  const wide = {
    ...largest,
    summary: "€".repeat(20000),
    comments: Array.from({ length: 25 }, () => comment("€".repeat(3000))),
  };
  const refused = await extract({ structured: JSON.stringify(wide) });
  assert.match(refused.verdict, /too large to pass on/u);
  assert.equal(refused.review, undefined);
});

test("the extract step carries a well-formed hold and calls a malformed one incomplete", async () => {
  const good = { findings: 0, summary: "S", comments: [] };
  const held = await extract({
    structured: JSON.stringify({
      ...good,
      hold: { criteria: ["cost", "trust-gate"], reason: "Why<!-- x -->." },
    }),
  });
  assert.equal(held.verdict, "complete");
  assert.deepEqual(JSON.parse(held.review).hold, {
    criteria: ["cost", "trust-gate"],
    reason: "Why.",
  });
  const none = await extract({ structured: JSON.stringify(good) });
  assert.equal("hold" in JSON.parse(none.review), false);
  for (const hold of [
    null,
    { criteria: [], reason: "R" },
    { criteria: ["cost", "cost"], reason: "R" },
    { criteria: ["style"], reason: "R" },
    { criteria: ["cost"], reason: "<!-- only hidden -->" },
    { criteria: "cost", reason: "R" },
  ]) {
    const outputs = await extract({
      structured: JSON.stringify({ ...good, hold }),
    });
    assert.match(outputs.verdict, /hold is malformed/u, JSON.stringify(hold));
    assert.equal(outputs.review, undefined);
  }
});

test("the schema offers the hold criteria the extract step accepts, in both lanes", () => {
  for (const job of [key, subscription]) {
    const script = step(job, "compose").with.script;
    assert.match(
      script,
      /enum: \["cost", "trust-gate", "critical-security"\]/u,
    );
    assert.match(
      script,
      /reason: \{ type: "string", minLength: 1, maxLength: 2000 \}/u,
    );
    assert.doesNotMatch(
      script,
      /required: \["findings", "summary", "comments", "hold"\]/u,
    );
    assert.match(
      step(job, "extract").with.script,
      /\["cost", "trust-gate", "critical-security"\]\.includes\(c\)/u,
    );
  }
});

async function compose(env) {
  const dir = makeTemporaryDirectory("pr-review-cli-compose-");
  const outputs = {};
  const values = {
    LANE: "security",
    MODEL: "sonnet",
    EFFORT: "high",
    MAX_TURNS: "30",
    MODEL_ARGS: "",
    CLI_VERSION: "latest",
    REPOSITORY: "o/r",
    PR_NUMBER: "7",
    HEAD_SHA: "a".repeat(40),
    SCOPE_NOTE: "",
    FULL_DIFF_NOTE: "",
    CONTEXT_NOTE: "",
    HOLD_PATHS: "",
    RUNNER_TEMP: dir,
    ...env,
  };
  const saved = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, values);
  try {
    await new AsyncFunction(
      "require",
      "core",
      step(key, "compose").with.script,
    )(require, {
      setOutput: (k, v) => {
        outputs[k] = v;
      },
      setFailed: (m) => {
        throw new Error(m);
      },
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return fs.readFileSync(outputs["prompt-file"], "utf8");
}

// Owner decisions Q52 and Q53 (2026-10-24): only a real security issue or a
// real charge stops a pull request. A trusted path gets extra security
// scrutiny; spend from prepaid credits or subscription usage is a summary line.
test("the prompt sends hold-paths to extra security scrutiny and holds cost only for a real charge, in both lanes", async () => {
  for (const job of [key, subscription]) {
    assert.equal(
      step(job, "compose").env.HOLD_PATHS,
      `\${{ inputs.hold-paths }}`,
    );
    assert.equal(
      step(job, "compose").with.script,
      step(key, "compose").with.script,
    );
  }
  const prompt = await compose({
    HOLD_PATHS: "**/CODEOWNERS\n\n  .github/standards/trusted-actors/**  \n",
  });
  assert.match(
    prompt,
    /TRUSTED PATHS: give every changed file matching one of these globs extra security scrutiny[^\n]*\n- \*\*\/CODEOWNERS\n- \.github\/standards\/trusted-actors\/\*\*\n/u,
  );
  const flat = prompt.replace(/\n +/gu, " ");
  assert.match(
    flat,
    /A trusted-path match alone is never a hold: do not return trust-gate\./u,
  );
  assert.match(
    flat,
    /replace the review command's own "Hold for a person" classes/u,
  );
  for (const charge of [
    "enabling or changing a paid plan, extra usage, auto-reload or a payment method",
    "Azure resources or deploys that bill",
    "GitHub billing (paid seats, paid Actions minutes, larger runners, Codespaces, storage)",
  ])
    assert.ok(prompt.replace(/\n +/gu, " ").includes(charge), charge);
  for (const spend of [
    "turn limits",
    "timeouts",
    "model or effort choice",
    "more or longer lane runs",
    "extra review runs",
    "schedule frequency",
  ])
    assert.ok(prompt.replace(/\n +/gu, " ").includes(spend), spend);
  assert.match(
    prompt.replace(/\n +/gu, " "),
    /is not a hold: name what it spends in one summary line, not an inline comment, and do not count it in findings\./u,
  );
  const plain = await compose({ HOLD_PATHS: "" });
  assert.doesNotMatch(plain, /TRUSTED PATHS/u);
  assert.match(plain, /real charge/u);
});

test("the review with the largest hold still fits one environment string", async () => {
  const largest = {
    findings: 25,
    summary: "s".repeat(20000),
    comments: Array.from({ length: 25 }, () => ({
      ...COMMENT,
      body: "b".repeat(3000),
    })),
    hold: {
      criteria: ["cost", "trust-gate", "critical-security"],
      reason: "r".repeat(2000),
    },
  };
  const fits = await extract({ structured: JSON.stringify(largest) });
  assert.equal(fits.verdict, "complete");
});

test("the hold step runs only in comments mode with hold-label set, even after a red publish", () => {
  const hold = step(status, "hold");
  const names = status.steps.map((s) => s.name);
  assert.ok(
    names.indexOf("Publish the review") < names.indexOf("Apply the hold"),
  );
  assert.equal(hold.uses, "$/.github/actions/apply-review-hold");
  const runs = (inputs) => Boolean(evaluate(hold.if, { inputs }));
  assert.equal(
    runs({ "hold-label": "needs-human", publish: "comments" }),
    true,
  );
  assert.equal(runs({ "hold-label": "", publish: "comments" }), false);
  assert.equal(
    runs({ "hold-label": "needs-human", publish: "summary" }),
    false,
  );
  assert.match(hold.if, /^always\(\) && /u);
  assert.equal(continues(hold, "comments"), false);
  // Every input reaches the script through env, never an expression in it.
  // hold-paths reaches the prompt, never the hold: a path is not a stop.
  assert.equal(hold.env.HOLD_PATHS, undefined);
  for (const name of [
    "HOLD_LABEL",
    "HEAD_SHA",
    "KEY_REVIEW",
    "SUB_REVIEW",
    "SUB_RESULT",
  ]) {
    assert.ok(hold.env[name], name);
  }
  assert.deepEqual(status.outputs, {
    hold: `\${{ steps.hold.outputs.hold || 'false' }}`,
    "hold-criteria": `\${{ steps.hold.outputs.criteria }}`,
  });
  assert.equal(
    evaluate("steps.hold.outputs.hold || 'false'", {
      steps: { hold: { outputs: {} } },
    }),
    "false",
  );
});

test("the review leaves each leg as an artifact named for the run, head and leg, and only its sha256 as an output", () => {
  const name = `pr-review-cli-handoff-\${{ inputs.lane }}-\${{ github.job }}-\${{ github.run_id }}-\${{ github.event.pull_request.head.sha }}`;
  for (const job of [key, subscription, fallback]) {
    assert.equal(job.outputs.review, undefined);
    assert.equal(job.outputs["last-summary"], undefined);
    assert.equal(
      job.outputs["handoff-sha256"],
      `\${{ steps.handoff-file.outputs.sha256 }}`,
    );
    const names = job.steps.map((s) => s.id ?? s.name);
    assert.ok(names.indexOf("claude") < names.indexOf("handoff-file"));
    const upload = job.steps.find(
      (s) => s.name === "Upload the review handoff",
    );
    assert.equal(names.indexOf("handoff-file") + 1, job.steps.indexOf(upload));
    assert.equal(upload.with.name, name);
    assert.equal(upload.with.overwrite, true);
    assert.equal(upload.with["retention-days"], 1);
    assert.match(step(job, "handoff-file").if, /^always\(\)$/u);
  }
  const download = status.steps.find(
    (s) => s.name === "Download the review handoffs",
  );
  assert.equal(download.with.pattern, name.replace(`\${{ github.job }}`, "*"));
  // No token or run id: this run only, and no REST request.
  assert.deepEqual(Object.keys(download.with).sort(), [
    "merge-multiple",
    "path",
    "pattern",
  ]);
  for (const s of ["Publish the review", "Apply the hold"]) {
    const env = status.steps.find((x) => x.name === s).env;
    assert.equal(env.KEY_REVIEW, `\${{ steps.handoffs.outputs.key-review }}`);
    assert.equal(env.SUB_REVIEW, `\${{ steps.token-leg.outputs.review }}`);
  }
  assert.doesNotMatch(
    JSON.stringify(status),
    /needs\.[\w-]+\.outputs\.(review|last-summary)(?![\w-])/u,
  );
});

// The base marks lock files -diff, as main's own .gitattributes does, so a
// changed resolved URL in one would otherwise reach the reviewer as
// "Binary files differ".
test("the full diff shows text the base or head marks -diff or binary, or hides behind a NUL byte, in both lanes", () => {
  const { spawnSync } = require("node:child_process");
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  for (const job of [key, subscription]) {
    const dir = makeTemporaryDirectory("pr-review-cli-full-diff-");
    const origin = path.join(dir, "origin");
    fs.mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=main");
    git(origin, "config", "user.email", "t@example.com");
    git(origin, "config", "user.name", "t");
    const lockAttributes =
      "package-lock.json -diff\npackages.lock.json -diff\n*.lock -diff\n";
    const lock = (url) =>
      `{\n  "packages": {\n    "node_modules/a": {\n      "resolved": "${url}"\n    }\n  }\n}\n`;
    fs.writeFileSync(path.join(origin, "README"), "base\n");
    fs.writeFileSync(path.join(origin, ".gitattributes"), lockAttributes);
    fs.writeFileSync(
      path.join(origin, "package-lock.json"),
      lock("https://registry.npmjs.org/a/-/a-1.0.0.tgz"),
    );
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "base");
    const base = git(origin, "rev-parse", "HEAD");
    fs.writeFileSync(
      path.join(origin, ".gitattributes"),
      `${lockAttributes}hidden.sh -diff\nopaque.sh binary\n`,
    );
    fs.writeFileSync(path.join(origin, "hidden.sh"), "echo NO-DIFF-PAYLOAD\n");
    fs.writeFileSync(path.join(origin, "opaque.sh"), "echo BINARY-PAYLOAD\n");
    fs.writeFileSync(path.join(origin, "nul.sh"), "\0\necho NUL-PAYLOAD\n");
    fs.writeFileSync(
      path.join(origin, "package-lock.json"),
      lock("https://lockfile.example/a-1.0.0.tgz"),
    );
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "head");
    const head = git(origin, "rev-parse", "HEAD");
    const work = path.join(dir, "work");
    git(dir, "clone", "--quiet", origin, work);
    const fullDiff = step(job, "full-diff");
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", fullDiff.run],
      {
        cwd: work,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          GH_TOKEN: "test-token",
          GITHUB_SERVER_URL: "https://github.invalid",
          GITHUB_OUTPUT: path.join(dir, "output"),
          REPO: "o/r",
          BASE_SHA: base,
          HEAD_SHA: head,
          MERGE_BASE: base,
          DIFF_FILE: fullDiff.env.DIFF_FILE,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const diff = fs.readFileSync(
      path.join(work, fullDiff.env.DIFF_FILE),
      "utf8",
    );
    for (const payload of [
      "NO-DIFF-PAYLOAD",
      "BINARY-PAYLOAD",
      "NUL-PAYLOAD",
    ]) {
      assert.match(diff, new RegExp(`^\\+echo ${payload}$`, "mu"), payload);
    }
    assert.match(
      diff,
      /^- {6}"resolved": "https:\/\/registry\.npmjs\.org\/a\/-\/a-1\.0\.0\.tgz"$/mu,
    );
    assert.match(
      diff,
      /^\+ {6}"resolved": "https:\/\/lockfile\.example\/a-1\.0\.0\.tgz"$/mu,
    );
    assert.match(
      fs.readFileSync(path.join(dir, "output"), "utf8"),
      /^written=true$/mu,
    );
  }
});
