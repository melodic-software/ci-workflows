"use strict";

// select-model-credential is the one place a Claude model lane picks its
// credential: a start call reads the key's credit history, a first call in
// each leg job decides whether its model runs, and a last call names the
// next job's leg. These tests hold its rules, its calls (none but the credit
// read's), and that both reusables pick exactly the legs, credentials and
// fallback reasons their own copies of the rules picked before (the copies,
// quoted below as they stood at e4b17e9).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const select = require("../actions/select-model-credential/select.cjs");
const { markerName } = require("../actions/check-key-credit/gate.cjs");
const {
  FALLBACK_REASONS,
} = require("../actions/report-lane-outcome/classify.cjs");
const {
  FALLBACK_SECRET,
  handoffReason,
} = require("../actions/run-claude-cli/lane.cjs");
const { evaluate } = require("./actions-expression.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");
const { parseWorkflow } = require("./workflow-yaml.cjs");

const load = (name) =>
  parseWorkflow(
    fs.readFileSync(path.join(__dirname, "..", "workflows", name), "utf8"),
  );

// --- the rules ---------------------------------------------------------------

// run-claude-cli lane.cjs readConfig names them `<ROLE>_<suffix>`, the role
// upper-snake, and the fallback leg FALLBACK_CLAUDE_CODE_OAUTH_TOKEN.
test("the secret names are the ones run-claude-cli derives from the role", () => {
  assert.equal(
    select.secretName("issue-lane", "key"),
    "ISSUE_LANE_CLAUDE_API_KEY",
  );
  assert.equal(
    select.secretName("issue-lane", "subscription"),
    "ISSUE_LANE_CLAUDE_CODE_OAUTH_TOKEN",
  );
  assert.equal(select.secretName("issue-lane", "fallback"), FALLBACK_SECRET);
});

test("the start call names the subscription leg only on a credit skip", () => {
  assert.deepEqual(select.start({ skipKey: true }), {
    "next-leg": "subscription",
    "next-reason": "credit-stop",
  });
  assert.deepEqual(select.start({ skipKey: false }), {
    "next-leg": "key",
    "next-reason": "",
  });
});

test("a leg runs only on its own secret, and the key also not when held off", () => {
  const present = (leg, flags) =>
    select.leg({ leg, role: "reviews", ...flags }).outputs.present;
  for (const leg of ["key", "subscription", "fallback"]) {
    assert.equal(present(leg, { credentialSet: "true" }), "true", leg);
    for (const set of ["false", "", "True", " true", undefined]) {
      assert.equal(
        present(leg, { credentialSet: set }),
        "false",
        `${leg} ${set}`,
      );
    }
  }
  assert.equal(
    present("key", { credentialSet: "true", keyOff: "true" }),
    "false",
  );
  assert.equal(
    present("key", { credentialSet: "true", keyOff: "false" }),
    "true",
  );
  assert.equal(
    present("key", { credentialSet: "true", selected: "subscription" }),
    "false",
  );
  assert.equal(
    present("key", { credentialSet: "true", selected: "key" }),
    "true",
  );
  assert.equal(present("key", { credentialSet: "true", held: true }), "false");
  // key-off and selected bind only the key leg.
  assert.equal(
    present("subscription", {
      credentialSet: "true",
      keyOff: "true",
      selected: "subscription",
    }),
    "true",
  );
});

test("a leg's fallback reason is the previous leg's next-reason, from the closed list only", () => {
  const reason = (leg, value) =>
    select.leg({ leg, role: "reviews", reason: value }).outputs[
      "fallback-reason"
    ];
  for (const known of FALLBACK_REASONS) {
    assert.equal(reason("subscription", known), known);
    assert.equal(reason("fallback", known), known);
    assert.equal(reason("key", known), "", "the key leg follows no leg");
  }
  for (const forged of ["", "Auth", "auth\n::error::x", "planted"]) {
    assert.equal(reason("subscription", forged), "", JSON.stringify(forged));
  }
});

test("the next leg follows the chain and each leg's handoff reasons", () => {
  const next = (leg, flags, handoff, why) =>
    select.next({
      state: select.leg({
        leg,
        role: "reviews",
        credentialSet: "true",
        ...flags,
      }).outputs.state,
      handoff,
      handoffReason: why,
    });
  const none = { "next-leg": "", "next-reason": "" };
  // Key leg.
  assert.deepEqual(next("key", {}, "true", "credit-stop"), {
    "next-leg": "subscription",
    "next-reason": "credit-stop",
  });
  assert.deepEqual(next("key", {}, "true", "auth"), {
    "next-leg": "subscription",
    "next-reason": "auth",
  });
  assert.deepEqual(
    next("key", {}, "true", "limit-stop"),
    none,
    "a key leg never limit-stops on",
  );
  assert.deepEqual(next("key", {}, "false", "credit-stop"), none);
  assert.deepEqual(next("key", { credentialSet: "false" }), {
    "next-leg": "subscription",
    "next-reason": "no-key",
  });
  assert.deepEqual(next("key", { keyOff: "true" }), {
    "next-leg": "subscription",
    "next-reason": "no-key",
  });
  assert.deepEqual(next("key", { selected: "subscription" }), {
    "next-leg": "subscription",
    "next-reason": "credit-stop",
  });
  // Subscription leg.
  for (const why of ["limit-stop", "credit-stop", "auth"]) {
    assert.deepEqual(
      next("subscription", { fallbackSet: "true" }, "true", why),
      {
        "next-leg": "fallback",
        "next-reason": why,
      },
    );
  }
  assert.deepEqual(
    next("subscription", { credentialSet: "false", fallbackSet: "true" }),
    {
      "next-leg": "fallback",
      "next-reason": "no-key",
    },
  );
  assert.deepEqual(next("subscription", { credentialSet: "false" }), none);
  // The fallback leg is the last.
  assert.deepEqual(next("fallback", { credentialSet: "false" }), none);
  assert.deepEqual(next("fallback", {}, "true", "limit-stop"), none);
  // A leg that never decided, or a forged state, hands on nothing.
  for (const state of [
    "",
    "{",
    "null",
    '{"leg":"key"}',
    '{"leg":"x","present":false}',
  ]) {
    assert.deepEqual(
      select.next({ state, handoff: "true", handoffReason: "auth" }),
      none,
      state,
    );
  }
});

// --- the action's calls --------------------------------------------------------

const KEY_JOB = "claude-review-key";
const NOW = Date.parse("2026-11-06T12:00:00Z");
const NAME = markerName("pr-review-hosted.yml", KEY_JOB);
const ARTIFACT = (hoursAgo, name = NAME) => ({
  name,
  expired: false,
  created_at: new Date(NOW - hoursAgo * 3600 * 1000).toISOString(),
  workflow_run: { id: 98, repository_id: 1, head_repository_id: 1 },
});

function env(dir, extra = {}) {
  return {
    WORKFLOW_REF:
      "o/r/.github/workflows/pr-review-hosted.yml@refs/pull/1/merge",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_TOKEN: "t",
    GITHUB_API_URL: "https://api.example",
    GITHUB_SERVER_URL: "https://example",
    GITHUB_OUTPUT: path.join(dir, "output"),
    RUNNER_TEMP: dir,
    ...extra,
  };
}

const outputs = (dir) =>
  Object.fromEntries(
    fs
      .readFileSync(path.join(dir, "output"), "utf8")
      .trim()
      .split("\n")
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );

function counting(artifacts) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (artifacts === null) throw new Error("offline");
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        artifacts: url.includes("key-credit-stop-") ? artifacts : [],
      }),
    };
  };
  return { urls, fetchImpl };
}

test("the start call reads the credit history once and names the first leg; an empty window is 1 hour", async () => {
  for (const [hoursAgo, leg] of [
    [0.5, "subscription"],
    [3, "key"],
  ]) {
    const dir = makeTemporaryDirectory("select-start-");
    fs.writeFileSync(path.join(dir, "output"), "");
    const { urls, fetchImpl } = counting([ARTIFACT(hoursAgo)]);
    await select.main(
      env(dir, {
        INPUT_LEG: "start",
        INPUT_KEY_JOB: KEY_JOB,
        INPUT_WINDOW_HOURS: "",
        INPUT_PROBE_MINUTES: "0",
      }),
      fetchImpl,
      () => new Date(NOW),
    );
    const out = outputs(dir);
    assert.equal(out["next-leg"], leg, String(hoursAgo));
    assert.equal(out.marker, NAME);
    assert.equal(out["skip-key"], String(leg === "subscription"));
    assert.equal(urls.length, 1);
  }
});

test("a failed credit read runs the key", async () => {
  const dir = makeTemporaryDirectory("select-start-");
  fs.writeFileSync(path.join(dir, "output"), "");
  const { fetchImpl } = counting(null);
  const { lines } = await select.main(
    env(dir, { INPUT_LEG: "start", INPUT_KEY_JOB: KEY_JOB }),
    fetchImpl,
    () => new Date(NOW),
  );
  assert.equal(outputs(dir)["next-leg"], "key");
  assert.match(lines.join("\n"), /runs the key/u);
});

test("a key leg with key-job reads the credit history itself; leg and next calls make no API call", async () => {
  const dir = makeTemporaryDirectory("select-leg-");
  fs.writeFileSync(path.join(dir, "output"), "");
  const inline = counting([
    ARTIFACT(0.5, markerName("pr-review-hosted.yml", "check-intent")),
  ]);
  await select.main(
    env(dir, {
      INPUT_LEG: "key",
      INPUT_ROLE: "pr-verify",
      INPUT_CREDENTIAL_SET: "true",
      INPUT_KEY_JOB: "check-intent",
    }),
    inline.fetchImpl,
    () => new Date(NOW),
  );
  assert.equal(inline.urls.length, 1);
  assert.equal(outputs(dir).present, "false");
  assert.equal(outputs(dir)["key-skipped"], "true");

  const none = counting([ARTIFACT(0.5)]);
  for (const extra of [
    { INPUT_LEG: "key", INPUT_ROLE: "reviews", INPUT_CREDENTIAL_SET: "true" },
    {
      INPUT_LEG: "subscription",
      INPUT_ROLE: "reviews",
      INPUT_CREDENTIAL_SET: "true",
      INPUT_REASON: "auth",
    },
    {
      INPUT_LEG: "key",
      INPUT_ROLE: "reviews",
      INPUT_SELECTED: "subscription",
      INPUT_KEY_JOB: KEY_JOB,
    },
    {
      INPUT_STATE:
        '{"leg":"key","present":true,"key-skipped":false,"fallback-ready":true}',
      INPUT_HANDOFF: "true",
      INPUT_HANDOFF_REASON: "auth",
    },
  ]) {
    const out = makeTemporaryDirectory("select-leg-");
    fs.writeFileSync(path.join(out, "output"), "");
    await select.main(env(out, extra), none.fetchImpl, () => new Date(NOW));
  }
  assert.equal(none.urls.length, 0);
});

test("the leg call writes the outputs the jobs read; the next call reads its state", async () => {
  const dir = makeTemporaryDirectory("select-leg-");
  fs.writeFileSync(path.join(dir, "output"), "");
  const { lines } = await select.main(
    env(dir, {
      INPUT_LEG: "subscription",
      INPUT_ROLE: "issue-lane",
      INPUT_CREDENTIAL_SET: "false",
      INPUT_FALLBACK_SET: "true",
      INPUT_REASON: "credit-stop",
    }),
  );
  const out = outputs(dir);
  assert.equal(out.present, "false");
  assert.equal(out["fallback-ready"], "true");
  assert.equal(out["fallback-reason"], "credit-stop");
  assert.equal(out["secret-name"], "ISSUE_LANE_CLAUDE_CODE_OAUTH_TOKEN");
  assert.match(
    lines[0],
    /^::warning::ISSUE_LANE_CLAUDE_CODE_OAUTH_TOKEN is empty/u,
  );
  const next = makeTemporaryDirectory("select-next-");
  fs.writeFileSync(path.join(next, "output"), "");
  await select.main(env(next, { INPUT_STATE: out.state }));
  assert.deepEqual(outputs(next), {
    "next-leg": "fallback",
    "next-reason": "no-key",
  });
});

test("a role that is not lower-case kebab, or no leg and no state, fails the step", async () => {
  const dir = makeTemporaryDirectory("select-bad-");
  await assert.rejects(
    select.main(env(dir, { INPUT_LEG: "key", INPUT_ROLE: "ISSUE_LANE" })),
    /role/u,
  );
  await assert.rejects(select.main(env(dir, {})), /set leg/u);
});

test("the action passes every input to the script and holds the job token back unless it reads", () => {
  const action = parseWorkflow(
    fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "actions",
        "select-model-credential",
        "action.yml",
      ),
      "utf8",
    ),
  );
  const run = action.runs.steps[0];
  for (const name of Object.keys(action.inputs)) {
    if (name === "github-token") continue;
    const variable = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
    assert.equal(run.env[variable], `\${{ inputs.${name} }}`, name);
  }
  assert.equal(
    run.env.GITHUB_TOKEN,
    `\${{ inputs.key-job != '' && inputs.github-token || '' }}`,
  );
  // Empty window and probe inputs reach check-key-credit's own defaults.
  assert.equal(action.inputs["window-hours"].default, "");
  assert.equal(action.inputs["probe-minutes"].default, "");
  for (const name of Object.keys(action.outputs)) {
    assert.equal(
      action.outputs[name].value,
      `\${{ steps.select.outputs.${name} }}`,
      name,
    );
  }
});

// --- both reusables pick what their old copies picked --------------------------

// Every launcher outcome a leg can produce: run-claude-cli's own handoff rule
// over its classes, API statuses and stop flags, so the table never tests a
// state the launcher cannot reach.
function launches(leg, fallbackReady) {
  const seen = new Map();
  for (const failureClass of [
    "",
    "credit-stop",
    "auth",
    "rate-limit",
    "other",
  ]) {
    for (const status of [null, 401, 402, 403]) {
      for (const limitStop of [false, true]) {
        for (const creditStop of [false, true]) {
          const reason = handoffReason(
            { leg: leg === "key" ? "api-key" : leg },
            failureClass,
            status,
            {
              fallbackReady,
              limitStop: limitStop && failureClass === "rate-limit",
              creditStop: creditStop && leg === "subscription",
            },
          );
          const out = {
            "lane-class": failureClass,
            handoff: String(reason !== ""),
            "handoff-reason": reason,
          };
          seen.set(JSON.stringify(out), out);
        }
      }
    }
  }
  return [...seen.values()];
}

const bools = [true, false];
const PR = {
  event_name: "pull_request",
  actor: "kyle-sexton",
  event: {
    sender: { id: 1 },
    pull_request: {
      state: "open",
      draft: false,
      head: { repo: { full_name: "o/r" } },
      user: { login: "kyle-sexton" },
    },
  },
  repository: "o/r",
};

// pr-review-cli.yml's copies at e4b17e9 (the selection terms of each job's
// if:, each credential step's PRESENT, each fallback-reason).
const REVIEW_OLD = {
  keyRuns: `\${{ needs.check-key-credit.outputs.skip-key != 'true' }}`,
  keyPresent: `\${{ secrets.CLAUDE_API_KEY != '' && vars.REVIEWS_KEY_EXHAUSTED != 'true' }}`,
  subStarts: `\${{ ((needs.review-key.result == 'success' && (needs.review-key.outputs.handoff == 'true' || needs.review-key.outputs.credential-present == 'false')) || (needs.review-key.result == 'skipped' && needs.check-key-credit.outputs.skip-key == 'true')) }}`,
  subReason: `\${{ (needs.review-key.result == 'skipped' || needs.review-key.outputs.lane-class == 'credit-stop') && 'credit-stop' || needs.review-key.outputs.lane-class == 'auth' && 'auth' || needs.review-key.outputs.credential-present == 'false' && 'no-key' || '' }}`,
  fbStarts: `\${{ needs.review-subscription.result == 'success' && (needs.review-subscription.outputs.handoff == 'true' || needs.review-subscription.outputs.credential-present == 'false' && needs.review-subscription.outputs.fallback-ready == 'true') }}`,
  fbReason: `\${{ needs.review-subscription.outputs.handoff-reason == 'limit-stop' && 'limit-stop' || needs.review-subscription.outputs.handoff-reason == 'credit-stop' && 'credit-stop' || needs.review-subscription.outputs.handoff-reason == 'auth' && 'auth' || needs.review-subscription.outputs.credential-present == 'false' && 'no-key' || '' }}`,
};

test("pr-review-cli picks the same legs, credentials and reasons as its old copies, in every state", () => {
  const workflow = load("pr-review-cli.yml");
  const {
    "review-key": key,
    "review-subscription": sub,
    "review-fallback": fb,
  } = workflow.jobs;
  const credential = (job) => job.steps.find((s) => s.id === "credential").with;
  const inputs = {
    "allowed-bot-sender-ids": "",
    "dispatcher-actor-ids": "",
    publish: "comments",
  };
  let states = 0;
  for (const gate of ["skip", "ok", "failed"]) {
    for (const [keySet, subSet, fbSet] of bools.flatMap((a) =>
      bools.flatMap((b) => bools.map((c) => [a, b, c])),
    )) {
      for (const exhausted of ["", "true"]) {
        for (const scoped of bools) {
          const secrets = {
            CLAUDE_API_KEY: keySet ? "k" : "",
            CLAUDE_CODE_OAUTH_TOKEN: subSet ? "s" : "",
            FALLBACK_CLAUDE_CODE_OAUTH_TOKEN: fbSet ? "f" : "",
          };
          const vars = { REVIEWS_KEY_EXHAUSTED: exhausted };
          const skipKey =
            gate === "skip" ? "true" : gate === "ok" ? "false" : "";
          const start =
            gate === "failed" ? {} : select.start({ skipKey: gate === "skip" });
          // The key job.
          const oldKeyRuns = Boolean(
            evaluate(REVIEW_OLD.keyRuns, {
              needs: {
                "check-key-credit": { outputs: { "skip-key": skipKey } },
              },
            }),
          );
          const newKeyRuns = Boolean(
            evaluate(key.if, {
              github: PR,
              inputs,
              needs: {
                "check-key-credit": { result: "success", outputs: start },
              },
            }),
          );
          assert.equal(newKeyRuns, oldKeyRuns, `key runs ${gate}`);
          const keyOutcomes = [];
          if (!newKeyRuns)
            keyOutcomes.push({ result: "skipped", old: {}, new: {} });
          else {
            const oldPresent = scoped
              ? String(
                  Boolean(evaluate(REVIEW_OLD.keyPresent, { secrets, vars })),
                )
              : "";
            const decided = scoped
              ? select.leg({
                  leg: "key",
                  role: "reviews",
                  credentialSet: String(
                    evaluate(credential(key)["credential-set"], { secrets }),
                  ),
                  fallbackSet: String(
                    evaluate(credential(key)["fallback-set"], { secrets }),
                  ),
                  keyOff: String(
                    evaluate(credential(key)["key-off"], { vars }) ?? "",
                  ),
                }).outputs
              : {};
            assert.equal(decided.present ?? "", oldPresent, "key present");
            const runs =
              decided.present === "true"
                ? launches("key", fbSet)
                : [{ "lane-class": "", handoff: "", "handoff-reason": "" }];
            for (const launched of runs) {
              const oldOut = {
                ...launched,
                "credential-present": oldPresent,
                "fallback-ready": scoped ? String(fbSet) : "",
              };
              const newOut = select.next({
                state: decided.state ?? "",
                handoff: launched.handoff,
                handoffReason: launched["handoff-reason"],
              });
              keyOutcomes.push({ result: "success", old: oldOut, new: newOut });
            }
          }
          for (const k of keyOutcomes) {
            const oldNeeds = {
              "review-key": { result: k.result, outputs: k.old },
              "check-key-credit": { outputs: { "skip-key": skipKey } },
            };
            const newNeeds = {
              "review-key": { result: k.result, outputs: k.new },
              "check-key-credit": { result: "success", outputs: start },
            };
            const oldSub = Boolean(
              evaluate(REVIEW_OLD.subStarts, { needs: oldNeeds }),
            );
            const newSub = Boolean(
              evaluate(sub.if, { github: PR, inputs, needs: newNeeds }),
            );
            assert.equal(
              newSub,
              oldSub,
              `sub starts ${JSON.stringify({ gate, keySet, k })}`,
            );
            if (!newSub) {
              states++;
              continue;
            }
            const oldReason = evaluate(REVIEW_OLD.subReason, {
              needs: oldNeeds,
            });
            const subDecided = scoped
              ? select.leg({
                  leg: "subscription",
                  role: "reviews",
                  credentialSet: String(subSet),
                  fallbackSet: String(fbSet),
                  reason: evaluate(credential(sub).reason, { needs: newNeeds }),
                }).outputs
              : {};
            if (scoped)
              assert.equal(
                subDecided["fallback-reason"],
                oldReason,
                `sub reason ${JSON.stringify(k)}`,
              );
            const subOldPresent = scoped ? String(subSet) : "";
            assert.equal(subDecided.present ?? "", subOldPresent);
            const subRuns =
              subDecided.present === "true"
                ? launches("subscription", fbSet)
                : [{ "lane-class": "", handoff: "", "handoff-reason": "" }];
            for (const launched of subRuns) {
              const oldOut = {
                ...launched,
                "credential-present": subOldPresent,
                "fallback-ready": scoped ? String(fbSet) : "",
              };
              const newOut = select.next({
                state: subDecided.state ?? "",
                handoff: launched.handoff,
                handoffReason: launched["handoff-reason"],
              });
              const oldFbNeeds = {
                "review-subscription": { result: "success", outputs: oldOut },
              };
              const newFbNeeds = {
                "review-subscription": { result: "success", outputs: newOut },
              };
              const oldFb = Boolean(
                evaluate(REVIEW_OLD.fbStarts, { needs: oldFbNeeds }),
              );
              const newFb = Boolean(
                evaluate(fb.if, { github: PR, inputs, needs: newFbNeeds }),
              );
              assert.equal(
                newFb,
                oldFb,
                `fallback starts ${JSON.stringify(launched)}`,
              );
              if (newFb) {
                const fbDecided = select.leg({
                  leg: "fallback",
                  role: "reviews",
                  credentialSet: String(fbSet),
                  reason: evaluate(credential(fb).reason, {
                    needs: newFbNeeds,
                  }),
                }).outputs;
                assert.equal(
                  fbDecided["fallback-reason"],
                  evaluate(REVIEW_OLD.fbReason, { needs: oldFbNeeds }),
                );
                assert.equal(fbDecided.present, String(fbSet));
              }
              states++;
            }
          }
        }
      }
    }
  }
  assert.ok(states > 300, String(states));
});

// intake-triage.yml's copies at e4b17e9: the claude job's credential step
// (as a function: it was a shell script), each job's if:, each reason.
const intakeOldKey = (skipKey, keySet) =>
  skipKey === "true"
    ? { present: "false", "key-skipped": "true" }
    : { present: String(keySet), "key-skipped": "" };
const INTAKE_OLD = {
  subStarts: `\${{ needs.claude.outputs.handoff == 'true' || needs.claude.outputs.credential-present == 'false' }}`,
  subReason: `\${{ needs.claude.outputs.lane-class == 'credit-stop' && 'credit-stop' || needs.claude.outputs.lane-class == 'auth' && 'auth' || needs.claude.outputs.key-skipped == 'true' && 'credit-stop' || needs.claude.outputs.credential-present == 'false' && 'no-key' || '' }}`,
  fbStarts: `\${{ needs.subscription.outputs.handoff == 'true' || needs.subscription.outputs.credential-present == 'false' && needs.subscription.outputs.fallback-ready == 'true' }}`,
  fbReason: `\${{ needs.subscription.outputs.handoff-reason == 'limit-stop' && 'limit-stop' || needs.subscription.outputs.handoff-reason == 'credit-stop' && 'credit-stop' || needs.subscription.outputs.handoff-reason == 'auth' && 'auth' || needs.subscription.outputs.credential-present == 'false' && 'no-key' || '' }}`,
};

test("intake-triage picks the same legs, credentials and reasons as its old copies, in every state", () => {
  const workflow = load("intake-triage.yml");
  const { claude, subscription: sub, fallback: fb } = workflow.jobs;
  const credential = (job) => job.steps.find((s) => s.id === "credential").with;
  let states = 0;
  for (const gate of ["skip", "ok", "failed"]) {
    for (const [keySet, subSet, fbSet] of bools.flatMap((a) =>
      bools.flatMap((b) => bools.map((c) => [a, b, c])),
    )) {
      const skipKey = gate === "skip" ? "true" : gate === "ok" ? "false" : "";
      const start =
        gate === "failed" ? {} : select.start({ skipKey: gate === "skip" });
      const old = intakeOldKey(skipKey, keySet);
      const decided = select.leg({
        leg: "key",
        role: "automations",
        credentialSet: String(keySet),
        fallbackSet: String(fbSet),
        selected:
          evaluate(credential(claude).selected, {
            needs: { "check-key-credit": { outputs: start } },
          }) ?? "",
      }).outputs;
      assert.equal(
        decided.present,
        old.present,
        `key present ${gate} ${keySet}`,
      );
      assert.equal(
        decided["key-skipped"] === "true",
        old["key-skipped"] === "true",
      );
      const runs =
        decided.present === "true"
          ? launches("key", fbSet)
          : [{ "lane-class": "", handoff: "", "handoff-reason": "" }];
      for (const launched of runs) {
        const oldOut = {
          ...launched,
          "credential-present": old.present,
          "key-skipped": old["key-skipped"],
          "fallback-ready": String(fbSet),
        };
        const newOut = select.next({
          state: decided.state,
          handoff: launched.handoff,
          handoffReason: launched["handoff-reason"],
        });
        const oldSub = Boolean(
          evaluate(INTAKE_OLD.subStarts, {
            needs: { claude: { outputs: oldOut } },
          }),
        );
        const newSub = Boolean(
          evaluate(sub.if, { needs: { claude: { outputs: newOut } } }),
        );
        assert.equal(
          newSub,
          oldSub,
          `sub starts ${JSON.stringify({ gate, keySet, launched })}`,
        );
        if (!newSub) {
          states++;
          continue;
        }
        const subDecided = select.leg({
          leg: "subscription",
          role: "automations",
          credentialSet: String(subSet),
          fallbackSet: String(fbSet),
          reason: evaluate(credential(sub).reason, {
            needs: { claude: { outputs: newOut } },
          }),
        }).outputs;
        assert.equal(
          subDecided["fallback-reason"],
          evaluate(INTAKE_OLD.subReason, {
            needs: { claude: { outputs: oldOut } },
          }),
          `sub reason ${JSON.stringify({ gate, keySet, launched })}`,
        );
        assert.equal(subDecided.present, String(subSet));
        const subRuns =
          subDecided.present === "true"
            ? launches("subscription", fbSet)
            : [{ "lane-class": "", handoff: "", "handoff-reason": "" }];
        for (const subLaunched of subRuns) {
          const oldSubOut = {
            ...subLaunched,
            "credential-present": String(subSet),
            "fallback-ready": String(fbSet),
          };
          const newSubOut = select.next({
            state: subDecided.state,
            handoff: subLaunched.handoff,
            handoffReason: subLaunched["handoff-reason"],
          });
          const oldFb = Boolean(
            evaluate(INTAKE_OLD.fbStarts, {
              needs: { subscription: { outputs: oldSubOut } },
            }),
          );
          const newFb = Boolean(
            evaluate(fb.if, {
              needs: { subscription: { outputs: newSubOut } },
            }),
          );
          assert.equal(
            newFb,
            oldFb,
            `fallback starts ${JSON.stringify(subLaunched)}`,
          );
          if (newFb) {
            const fbDecided = select.leg({
              leg: "fallback",
              role: "automations",
              credentialSet: String(fbSet),
              reason: evaluate(credential(fb).reason, {
                needs: { subscription: { outputs: newSubOut } },
              }),
            }).outputs;
            assert.equal(
              fbDecided["fallback-reason"],
              evaluate(INTAKE_OLD.fbReason, {
                needs: { subscription: { outputs: oldSubOut } },
              }),
            );
          }
          states++;
        }
      }
    }
  }
  assert.ok(states > 100, String(states));
});

test("every leg job decides first and names the next leg last, and no job's if: reads a raw selection output", () => {
  for (const name of ["pr-review-cli.yml", "intake-triage.yml"]) {
    const workflow = load(name);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const legStep = job.steps?.find((s) => s.id === "credential");
      if (!legStep) continue;
      assert.equal(
        legStep.uses,
        "$/.github/actions/select-model-credential",
        `${name} ${id}`,
      );
      // The next-leg step has no if: (success()), and only the budget log,
      // which runs always and never fails the job, follows it: a next-leg
      // is set only by a leg job that succeeded, as the old `result ==
      // 'success'` terms required.
      const next = job.steps.at(-2);
      assert.equal(next.id, "next", `${name} ${id}`);
      assert.equal(next.if, undefined, `${name} ${id}`);
      assert.equal(next.uses, "$/.github/actions/select-model-credential");
      assert.equal(next.with.state, `\${{ steps.credential.outputs.state }}`);
      const last = job.steps.at(-1);
      assert.equal(last.name, "Log the API budget", `${name} ${id}`);
      assert.equal(last.if, "always()");
      assert.equal(last["continue-on-error"], true);
      assert.equal(
        job.outputs["next-leg"],
        `\${{ steps.next.outputs.next-leg }}`,
      );
    }
    for (const [id, job] of Object.entries(workflow.jobs)) {
      assert.doesNotMatch(
        String(job.if ?? ""),
        /outputs\.(handoff|credential-present|skip-key|fallback-ready|key-skipped|handoff-reason|lane-class)\b/u,
        `${name} ${id}`,
      );
    }
  }
});
