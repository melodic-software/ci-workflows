"use strict";

// The publish-review action: the one step that posts a pr-review-cli review.
// A fake GitHub records every write; a stand-in publish gate flags an
// Anthropic-key shape and warns on a password assignment, the two kinds of
// label claude-code-plugins' lib/publish-gate.mjs has (blocking and the one
// warn-only label).

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  commentableLines,
  partialRemedy,
  placeComments,
  run,
  stripHtml,
  summaryText,
  uncoveredRulesBlock,
} = require("../actions/publish-review/publish.cjs");
const { makeTemporaryDirectory } = require("./temporary-directories.cjs");

const root = makeTemporaryDirectory("publish-review-");
const gate = path.join(root, "publish-gate.mjs");
fs.writeFileSync(
  gate,
  `export const findSecret = (text) => {
  if (/sk-ant-[A-Za-z0-9_-]{20,}/.test(text)) return ["Anthropic key", 1];
  if (/password\\s*=\\s*"[^"]{8,}"/.test(text)) return ["password or secret assignment", 1];
  return null;
};
`,
);

// Key-shaped, built at run time so no scanner reads a key in this file.
const FAKE_KEY = ["sk", "ant", "api03", "x".repeat(26)].join("-");
const HEAD = "a".repeat(40);
const PATCH =
  "@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n@@ -10 +11 @@\n-x\n+y\n\\ No newline at end of file";

test("commentableLines numbers head lines for RIGHT and base lines for LEFT", () => {
  const lines = commentableLines(PATCH);
  assert.deepEqual(
    [...lines.RIGHT].sort((a, b) => a - b),
    [1, 2, 3, 4, 11],
  );
  assert.deepEqual(
    [...lines.LEFT].sort((a, b) => a - b),
    [1, 2, 3, 10],
  );
  assert.deepEqual(commentableLines(undefined), {
    RIGHT: new Set(),
    LEFT: new Set(),
  });
});

test("stripHtml drops HTML comments and escapes an unclosed opener", () => {
  assert.equal(stripHtml("a<!-- x -->b <!-- open"), "ab &lt;!-- open");
});

test("one bad anchor sends every comment to the summary", () => {
  const files = new Map([["a.js", commentableLines(PATCH)]]);
  const review = {
    findings: 2,
    summary: "S",
    comments: [
      { path: "a.js", line: 2, side: "RIGHT", body: "good" },
      { path: "a.js", line: 5, side: "RIGHT", body: "bad" },
    ],
  };
  const placed = placeComments(review, files, "claude-review");
  assert.equal(placed.inline.length, 0);
  assert.equal(placed.unanchored.length, 2);
  assert.deepEqual(placed.problems, [
    "a.js:5 (RIGHT) is not a line of the diff",
  ]);
  const ok = placeComments(
    { ...review, comments: [review.comments[0]] },
    files,
    "claude-review",
  );
  assert.deepEqual(ok.inline, [
    {
      path: "a.js",
      line: 2,
      side: "RIGHT",
      body: "good\n\nclaude-lane: claude-review",
    },
  ]);
  const range = placeComments(
    {
      ...review,
      comments: [
        { path: "a.js", line: 3, start_line: 2, side: "LEFT", body: "r" },
      ],
    },
    files,
    "claude-review",
  );
  assert.equal(range.inline[0].start_side, "LEFT");
  assert.deepEqual(
    placeComments(
      {
        ...review,
        comments: [{ path: "b.js", line: 1, side: "RIGHT", body: "x" }],
      },
      files,
      "l",
    ).problems,
    ["b.js is not a changed file with a diff"],
  );
});

function fakeGithub({ head = HEAD, posted = [], throws = false } = {}) {
  const writes = [];
  const call = (name, data) => async (params) => {
    if (throws) throw new Error("API down");
    writes.push([name, params]);
    return { data: typeof data === "function" ? data(params) : data };
  };
  return {
    writes,
    github: {
      paginate: async (method, params) => (await method(params)).data,
      rest: {
        pulls: {
          get: async () => {
            if (throws) throw new Error("API down");
            return { data: { head: { sha: head } } };
          },
          listFiles: async () => ({
            data: [{ filename: "a.js", patch: PATCH }],
          }),
          listReviewComments: async () => ({ data: posted }),
          createReview: call("createReview", (params) => ({
            id: 501,
            body: params.body,
          })),
          // The review's comments as GitHub stores them, ids from 601.
          listCommentsForReview: async ({ review_id }) => ({
            data: (
              writes.find(([name]) => name === "createReview")?.[1].comments ??
              []
            ).map((c, i) => ({
              id: 601 + i,
              pull_request_review_id: review_id,
              body: c.body,
            })),
          }),
        },
        issues: {
          updateComment: call("updateComment", {}),
          createComment: call("createComment", {}),
        },
      },
    },
  };
}

function fakeCore() {
  const log = {
    failed: [],
    notices: [],
    titles: [],
    warnings: [],
    summary: "",
  };
  const summary = {
    addRaw: (text) => {
      log.summary += text;
      return summary;
    },
    write: async () => {},
  };
  return {
    log,
    core: {
      setFailed: (m) => log.failed.push(m),
      notice: (m, properties) => {
        log.notices.push(m);
        log.titles.push(properties?.title);
      },
      warning: (m) => log.warnings.push(m),
      info: () => {},
      summary,
    },
  };
}

const REVIEW = {
  findings: 1,
  coverage: { read: 1, changed: 1 },
  summary: "Summary.<!-- hidden -->",
  comments: [
    { path: "a.js", line: 2, side: "RIGHT", body: "Off by one.<!-- x -->" },
  ],
};

function env(overrides = {}) {
  return {
    PUBLISH: "comments",
    GITHUB_WORKFLOW_REF: "o/r/.github/workflows/review.yml@refs/pull/7/merge",
    LANE_ID: "claude-review",
    PR_NUMBER: "7",
    HEAD_SHA: HEAD,
    BASE_REF: "main",
    MERGE_BASE: "b".repeat(40),
    PUBLISH_GATE: gate,
    ARTIFACT_DIR: "",
    SCOPE_REVIEW: "true",
    SCOPE: "whole",
    MARKER_ID: "",
    SUB_RESULT: "skipped",
    KEY_PRESENT: "true",
    KEY_FAILED: "false",
    KEY_CLASS: "",
    KEY_VERDICT: "complete",
    KEY_REVIEW: JSON.stringify(REVIEW),
    ...overrides,
  };
}

async function publish(overrides, options) {
  const { github, writes } = fakeGithub(options);
  const { core, log } = fakeCore();
  await run({
    github,
    context: { repo: { owner: "o", repo: "r" } },
    core,
    env: env(overrides),
  });
  return { writes, log };
}

// publish with `review` as the key leg's review.
const publishReview = (review, overrides, options) =>
  publish({ KEY_REVIEW: JSON.stringify(review), ...overrides }, options);

// The marker comment a run created.
const createdMarker = (writes) =>
  writes.find(([name]) => name === "createComment");

test("comments mode posts one COMMENT review of footed comments, the marker and the completion notice", async () => {
  const { writes, log } = await publish({});
  assert.deepEqual(log.failed, []);
  const [review, marker] = writes;
  assert.equal(review[0], "createReview");
  assert.equal(review[1].event, "COMMENT");
  assert.equal(review[1].commit_id, HEAD);
  assert.deepEqual(review[1].comments, [
    {
      path: "a.js",
      line: 2,
      side: "RIGHT",
      body: "Off by one.\n\nclaude-lane: claude-review",
    },
  ]);
  assert.equal(marker[0], "createComment");
  assert.equal(
    marker[1].body,
    [
      `<!-- claude-lane-reviewed-head lane=claude-review sha=${HEAD} -->`,
      `<!-- claude-lane-reviewed-base ref=main merge-base=${"b".repeat(40)} caller=.github/workflows/review.yml -->`,
      `**claude-review** reviewed \`${HEAD}\`: read 1 of 1 changed file(s); 1 finding(s), 1 as inline comments.`,
      "",
      "Summary.",
    ].join("\n"),
  );
  assert.deepEqual(log.notices, [
    `claude-lane-review-complete lane=claude-review sha=${HEAD} findings=1 inline=1 scope=whole`,
  ]);
});

test("the subscription leg's review is the one that counts, and its notice says account=fallback", async () => {
  const { log } = await publish({
    SUB_RESULT: "success",
    KEY_PRESENT: "true",
    KEY_FAILED: "true",
    KEY_CLASS: "credit-stop",
    KEY_VERDICT: "",
    SUB_PRESENT: "true",
    SUB_FAILED: "false",
    SUB_CLASS: "",
    SUB_VERDICT: "complete",
    SUB_REVIEW: JSON.stringify(REVIEW),
    SCOPE: "incremental",
    SINCE: "c".repeat(40),
  });
  assert.deepEqual(log.failed, []);
  assert.equal(
    log.notices.at(-1),
    `claude-lane-review-complete lane=claude-review sha=${HEAD} findings=1 inline=1 scope=incremental since=${"c".repeat(40)} account=fallback`,
  );
});

test("a rerun posts no comment this lane already posted on the head", async () => {
  const posted = [
    {
      user: { login: "github-actions[bot]" },
      commit_id: HEAD,
      path: "a.js",
      line: 2,
      side: "RIGHT",
      body: "Off by one.\n\nclaude-lane: claude-review",
    },
  ];
  const { writes, log } = await publish({ MARKER_ID: "99" }, { posted });
  assert.deepEqual(
    writes.map(([name]) => name),
    ["updateComment"],
  );
  assert.match(log.notices[0], / inline=1 /u);
});

test("a bad anchor posts no review and lists the findings in the marker's summary", async () => {
  const review = { ...REVIEW, comments: [{ ...REVIEW.comments[0], line: 9 }] };
  const { writes, log } = await publishReview(review);
  assert.deepEqual(
    writes.map(([name]) => name),
    ["createComment"],
  );
  assert.match(
    writes[0][1].body,
    /Findings not posted inline[\s\S]*`a\.js:9` \(RIGHT\): Off by one\./u,
  );
  assert.match(log.notices[0], / findings=1 inline=0 /u);
});

test("a credential-shaped review posts nothing and fails; a warn-only label posts with a warning", async () => {
  const leak = {
    ...REVIEW,
    summary: `key ${FAKE_KEY}`,
  };
  const withheld = await publishReview(leak);
  assert.deepEqual(withheld.writes, []);
  assert.match(
    withheld.log.failed[0],
    /failure-class=withheld: .*\(Anthropic key in the summary\)/u,
  );
  assert.doesNotMatch(withheld.log.failed[0], /sk-ant/u);
  const quoted = {
    ...REVIEW,
    summary: 'The diff sets password = "hunter2hunter2".',
  };
  const warned = await publishReview(quoted);
  assert.deepEqual(warned.log.failed, []);
  assert.equal(warned.writes.length, 2);
  assert.match(
    warned.log.warnings[0],
    /password or secret assignment in the summary/u,
  );
});

test("publish compares ignoring case, as the workflow's expressions do", async () => {
  const { writes } = await publish({ PUBLISH: "Comments" });
  assert.equal(writes[0][0], "createReview");
});

test("comments mode fails with a named class when no review happened", async () => {
  for (const [overrides, failureClass] of [
    [{ KEY_PRESENT: "false" }, "no-credential"],
    [
      {
        KEY_PRESENT: "false",
        SUB_RESULT: "success",
        SUB_PRESENT: "false",
        KEY_LANE_CLASS: "credit-stop",
      },
      "rate-limit",
    ],
    [
      {
        KEY_PRESENT: "false",
        SUB_RESULT: "success",
        SUB_PRESENT: "false",
        KEY_LANE_CLASS: "auth",
      },
      "auth",
    ],
    [{ KEY_FAILED: "" }, "no-outcome"],
    [{ KEY_FAILED: "", KEY_CLASS: "install-failed" }, "install-failed"],
    [{ KEY_FAILED: "true", KEY_CLASS: "max-turns" }, "max-turns"],
    [{ KEY_FAILED: "true", KEY_CLASS: "made-up" }, "other"],
    [{ KEY_VERDICT: "the leg wrote no structured output" }, "incomplete"],
    [{ KEY_REVIEW: "{}" }, "incomplete"],
    [{ PUBLISH_GATE: path.join(root, "absent.mjs") }, "publish-failed"],
  ]) {
    const { writes, log } = await publish(overrides);
    assert.deepEqual(writes, [], failureClass);
    assert.equal(log.failed.length, 1, failureClass);
    assert.match(
      log.failed[0],
      new RegExp(`failure-class=${failureClass}:`, "u"),
    );
    assert.deepEqual(
      log.notices.filter((n) => n.startsWith("claude-lane-review-complete")),
      [],
    );
  }
});

test("a session that returned no review to post fails as review-unposted with the extract step's reason", async () => {
  const unposted = await publish({
    KEY_FAILED: "true",
    KEY_CLASS: "review-unposted",
    KEY_VERDICT: "chunk 2 of 3: the leg wrote no structured output",
  });
  assert.deepEqual(unposted.writes, []);
  assert.deepEqual(unposted.log.failed, [
    "claude-review: failure-class=review-unposted: the review session ended without returning a review to post (chunk 2 of 3: the leg wrote no structured output)",
  ]);
  const malformed = await publish({
    KEY_FAILED: "true",
    KEY_CLASS: "incomplete",
    KEY_VERDICT: "the review's hold is malformed",
  });
  assert.match(
    malformed.log.failed[0],
    /failure-class=incomplete: .* \(the review's hold is malformed\)$/u,
  );
  // Other classes carry no verdict text.
  const turns = await publish({
    KEY_FAILED: "true",
    KEY_CLASS: "max-turns",
    KEY_VERDICT: "the leg wrote no structured output",
  });
  assert.match(
    turns.log.failed[0],
    /failure-class=max-turns: the review used every turn before finishing$/u,
  );
});

test("a review not needed carries the last summary forward and leaves the skip notice", async () => {
  const { writes, log } = await publish({
    SCOPE_REVIEW: "false",
    SKIP: "no-change",
    SINCE: "c".repeat(40),
    SKIP_REASON: "nothing changed",
    LAST_SUMMARY: "Earlier.<!-- x -->",
    MARKER_ID: "5",
  });
  assert.deepEqual(log.failed, []);
  assert.equal(writes[0][0], "updateComment");
  assert.match(
    writes[0][1].body,
    /needs no new review of `a{40}`: nothing changed\.\n\nEarlier\.$/u,
  );
  assert.deepEqual(log.notices, [
    `claude-lane-review-complete lane=claude-review sha=${HEAD} skip=no-change through=${"c".repeat(40)}`,
  ]);
});

test("summary mode never fails or writes to the pull request, whatever happened", async () => {
  const cases = [
    [{}, {}],
    [{ KEY_PRESENT: "false" }, {}],
    [{ KEY_FAILED: "" }, {}],
    [{ KEY_FAILED: "true", KEY_CLASS: "timeout" }, {}],
    [{ KEY_VERDICT: "incomplete" }, {}],
    [
      {
        KEY_REVIEW: JSON.stringify({
          ...REVIEW,
          summary: FAKE_KEY,
        }),
      },
      {},
    ],
    [{ PUBLISH_GATE: "" }, {}],
    [{ SCOPE_REVIEW: "false", SKIP_REASON: "docs only" }, {}],
    [{}, { throws: true }],
    [{}, { head: "f".repeat(40) }],
  ];
  for (const publishValue of ["summary", "", "anything"]) {
    for (const [overrides, options] of cases) {
      const { writes, log } = await publish(
        { PUBLISH: publishValue, ...overrides },
        options,
      );
      const label = `${publishValue} ${JSON.stringify(overrides)} ${JSON.stringify(options)}`;
      assert.deepEqual(log.failed, [], label);
      assert.deepEqual(writes, [], label);
      assert.deepEqual(
        log.notices.filter((n) => n.startsWith("claude-lane-review-complete")),
        [],
        label,
      );
    }
  }
});

// claude-code-plugins' babysit_review_evidence.py recognises a rate-limited
// publish by this pattern; only the named group's syntax differs from Python's.
const MERGE_GATE_RATE_LIMITED =
  /(?<lane>[\w-]+): failure-class=publish-failed: [^(\n]*\((?:API rate limit exceeded|You have exceeded a secondary rate limit)\b/u;
const PRIMARY_LIMIT = "API rate limit exceeded for installation ID 1234567.";
const SECONDARY_LIMIT =
  "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";

const NOT_NEEDED = {
  SCOPE_REVIEW: "false",
  SKIP: "no-change",
  SINCE: "c".repeat(40),
  SKIP_REASON: "nothing changed",
};
// Each API call outside the posting try, with the env that reaches it.
const GUARDED_CALLS = [
  ["pulls.get", {}],
  ["pulls.listFiles", {}],
  ["issues.updateComment", { ...NOT_NEEDED, MARKER_ID: "5" }],
  ["issues.createComment", NOT_NEEDED],
];

// publish with one API call refused the way Octokit reports a refusal.
async function publishRefused(call, message, overrides = {}) {
  const { github, writes } = fakeGithub();
  const [group, method] = call.split(".");
  github.rest[group][method] = async () => {
    throw Object.assign(new Error(message), { name: "HttpError" });
  };
  const { core, log } = fakeCore();
  await run({
    github,
    context: { repo: { owner: "o", repo: "r" } },
    core,
    env: env(overrides),
  });
  return { writes, log };
}

for (const [call, overrides] of GUARDED_CALLS) {
  for (const message of [PRIMARY_LIMIT, SECONDARY_LIMIT]) {
    test(`comments mode fails as publish-failed when ${call} answers: ${message}`, async () => {
      const { writes, log } = await publishRefused(call, message, overrides);
      assert.deepEqual(log.failed, [
        `claude-review: failure-class=publish-failed: posting the review failed (${message})`,
      ]);
      assert.equal(
        MERGE_GATE_RATE_LIMITED.exec(log.failed[0])?.groups.lane,
        "claude-review",
      );
      assert.deepEqual(writes, []);
      assert.deepEqual(log.notices, []);
    });
  }

  test(`comments mode names any other ${call} error without reading as rate-limited`, async () => {
    const { writes, log } = await publishRefused(call, "Not Found", overrides);
    assert.deepEqual(log.failed, [
      "claude-review: failure-class=publish-failed: posting the review failed (Not Found)",
    ]);
    assert.equal(MERGE_GATE_RATE_LIMITED.exec(log.failed[0]), null);
    assert.deepEqual(writes, []);
    assert.deepEqual(log.notices, []);
  });
}

for (const call of ["pulls.get", "pulls.listFiles"]) {
  test(`summary mode reports a rate-limited ${call} as a notice and never fails`, async () => {
    const { writes, log } = await publishRefused(call, PRIMARY_LIMIT, {
      PUBLISH: "summary",
    });
    assert.deepEqual(log.failed, []);
    assert.deepEqual(log.notices, [
      `shadow claude-review: publish step error: ${PRIMARY_LIMIT}`,
    ]);
    assert.deepEqual(writes, []);
  });
}

test("summary mode writes a scanned shadow report with the review and the leg's facts", async () => {
  const dir = path.join(root, "shadow");
  const { log } = await publish({
    PUBLISH: "summary",
    ARTIFACT_DIR: dir,
    KEY_TURNS: "12",
    KEY_MODELS: "claude-sonnet-5",
    KEY_COST: "0.5",
    KEY_LEG_MS: "90000",
    KEY_WALL_MS: "120000",
  });
  assert.match(log.summary, /### claude-review \(shadow\)/u);
  const report = JSON.parse(
    fs.readFileSync(path.join(dir, "claude-review.json"), "utf8"),
  );
  assert.deepEqual(
    [
      report.findings,
      report.inline,
      report.turns,
      report.models,
      report.total_cost_usd,
      report.leg_ms,
      report.wall_ms,
    ],
    [1, 1, "12", "claude-sonnet-5", "0.5", "90000", "120000"],
  );
  assert.equal(
    report.review.comments[0].body,
    "Off by one.\n\nclaude-lane: claude-review",
  );
  const leakDir = path.join(root, "shadow-leak");
  await publishReview(
    { ...REVIEW, comments: [{ ...REVIEW.comments[0], body: FAKE_KEY }] },
    { PUBLISH: "summary", ARTIFACT_DIR: leakDir },
  );
  // The withheld review leaves a report with its class and none of its text.
  const withheld = fs.readFileSync(
    path.join(leakDir, "claude-review.json"),
    "utf8",
  );
  assert.equal(JSON.parse(withheld).failure_class, "withheld");
  assert.doesNotMatch(withheld, /sk-ant|Off by one/u);
});

test("every completion notice carries the title a merge gate filters on", async () => {
  const runs = [
    await publish({}),
    await publishReview({ ...REVIEW, comments: [] }),
    await publish({
      SCOPE_REVIEW: "false",
      SKIP: "no-change",
      SINCE: "c".repeat(40),
      SKIP_REASON: "nothing changed",
    }),
    await publish({
      SCOPE_REVIEW: "false",
      SKIP: "docs-only",
      SKIP_REASON: "docs only",
    }),
  ];
  for (const { log } of runs) {
    const records = log.notices
      .map((notice, i) => [notice, log.titles[i]])
      .filter(([notice]) => notice.startsWith("claude-lane-review-complete"));
    assert.equal(records.length, 1, JSON.stringify(log.notices));
    assert.equal(records[0][1], "claude-lane-review-complete");
  }
});

// The marker body a demoted batch posts, for a review whose comments carry
// the given bodies and whose summary is `summary`.
async function demotedMarker(summary, bodies, findings = bodies.length) {
  const review = {
    findings,
    coverage: { read: 1, changed: 1 },
    summary,
    comments: bodies.map((body, i) => ({
      path: "a.js",
      line: 9 + i,
      side: "RIGHT",
      body,
    })),
  };
  const { writes } = await publishReview(review);
  assert.deepEqual(
    writes.map(([name]) => name),
    ["createComment"],
  );
  return writes[0][1].body;
}

const criticalLines = (body) =>
  [...body.matchAll(/^\s*`?critical-findings: (\d{1,6})`?\s*$/gmu)].map((m) =>
    Number(m[1]),
  );

test("a demoted CRITICAL batch raises the summary's critical-findings line in place", async () => {
  const body = await demotedMarker("Summary.\n\ncritical-findings: 0", [
    "Injection.\n\nseverity: CRITICAL",
    "Naming.\n\nseverity: SUGGESTION",
    "Unmarked.",
  ]);
  assert.deepEqual(criticalLines(body), [2]);
});

test("a demoted CRITICAL batch adds a critical-findings line the model left out", async () => {
  const body = await demotedMarker(
    "Summary.",
    ["Injection.\n\nseverity: CRITICAL", "Naming.\n\nseverity: IMPORTANT"],
    3,
  );
  assert.deepEqual(criticalLines(body), [2]);
});

test("an inline batch and a summary with two count lines keep the model's text", async () => {
  const inline = await publishReview({
    ...REVIEW,
    summary: "Summary.\n\ncritical-findings: 0",
  });
  const marker = createdMarker(inline.writes);
  assert.deepEqual(criticalLines(marker[1].body), [0]);
  const twice = await demotedMarker(
    "critical-findings: 0\ncritical-findings: 1",
    ["Injection.\n\nseverity: CRITICAL"],
  );
  assert.deepEqual(criticalLines(twice), [0, 1]);
});

// A comment the extract step could not place (its path, line or side is
// malformed) arrives in `malformed` and goes to the summary as a bullet.
test("a malformed comment beside a valid one posts the valid one inline and the other in the summary", async () => {
  const review = {
    findings: 2,
    coverage: { read: 1, changed: 1 },
    summary: "Summary.",
    comments: [REVIEW.comments[0]],
    malformed: [{ path: "b.js", line: 4, body: "Wrong side.<!-- x -->" }],
  };
  const { writes, log } = await publishReview(review);
  assert.deepEqual(log.failed, []);
  const [posted, marker] = writes;
  assert.equal(posted[0], "createReview");
  assert.equal(posted[1].comments.length, 1);
  assert.equal(posted[1].comments[0].path, "a.js");
  assert.match(marker[1].body, /^- `b\.js:4`: Wrong side\.$/mu);
  assert.match(marker[1].body, /2 finding\(s\), 1 as inline comments\./u);
  assert.match(log.notices[0], / findings=2 inline=1 /u);
});

test("a malformed CRITICAL comment raises the summary's critical-findings line", async () => {
  const review = (summary) => ({
    findings: 2,
    coverage: { read: 1, changed: 1 },
    summary,
    comments: [REVIEW.comments[0]],
    malformed: [{ body: "Injection.\n\nseverity: CRITICAL" }],
  });
  const raised = await publishReview(
    review("Summary.\n\ncritical-findings: 0"),
  );
  const marker = createdMarker(raised.writes);
  assert.deepEqual(criticalLines(marker[1].body), [1]);
  // With no line, one is added; the malformed finding counts once.
  const added = await publishReview(review("Summary."));
  const addedMarker = createdMarker(added.writes);
  assert.deepEqual(criticalLines(addedMarker[1].body), [1]);
  // A malformed SUGGESTION leaves the line as written.
  const suggestion = await publishReview({
    ...review("Summary.\n\ncritical-findings: 0"),
    malformed: [{ body: "Naming.\n\nseverity: SUGGESTION" }],
  });
  const kept = createdMarker(suggestion.writes);
  assert.deepEqual(criticalLines(kept[1].body), [0]);
});

// A review that read less than its scope, or whose diff is over one review's
// read budget or file cap, is partial: its comment states coverage first, records no
// reviewed head, and the check is not a success.
const BINARIES = Array.from(
  { length: 11 },
  (_, i) => `plugins/p${i + 1}/evals/fixtures.tar.gz`,
);
const TEN_NAMED = BINARIES.slice(0, 10)
  .map((p) => `\`${p}\``)
  .join(", ");
test("a partial review states its coverage first, records no head and fails, with no completion notice", async () => {
  const SPLIT =
    " A re-run of this diff stays partial. Split the pull request into smaller ones.";
  const BINARY_REMEDY =
    " An audio, image, video or font file whose extension matches its content is shown by its header only; any other binary file counts in full, so list it in the caller's `generated-data` file by a pull request merged first, since that list is read at the merge base.";
  for (const [coverage, size, remedy] of [
    [{ read: 2, changed: 1186 }, /^read 2 of 1186 changed file\(s\)\. /u, ""],
    [
      { read: 3, changed: 3, over_budget: 1330000 },
      /^read 3 of 3 changed file\(s\); the diff is 1330000 bytes, over one review's read budget\. /u,
      SPLIT,
    ],
    [
      { read: 170, changed: 170, over_files: 170 },
      /^read 170 of 170 changed file\(s\); one review faced 170 files that are not copies, more than it reads whole\. /u,
      SPLIT,
    ],
    // Every unread file is binary: the reason names them, first 10 by name.
    [
      { read: 73, changed: 84, binary_files: BINARIES },
      new RegExp(
        `^read 73 of 84 changed file\\(s\\); 11 binary file\\(s\\) not reviewable as text: ${TEN_NAMED} and 1 more\\. `,
        "u",
      ),
      "",
    ],
    // Mixed: the existing reason stays, then the binary count.
    [
      {
        read: 3,
        changed: 4,
        over_budget: 1330000,
        binary_files: ["t/fixtures.tar.gz"],
      },
      /^read 3 of 4 changed file\(s\); the diff is 1330000 bytes, over one review's read budget; 1 binary file\(s\) not reviewable as text: `t\/fixtures\.tar\.gz`\. /u,
      SPLIT + BINARY_REMEDY,
    ],
  ]) {
    const { writes, log } = await publishReview({
      ...REVIEW,
      findings: 0,
      comments: [],
      coverage,
    });
    assert.equal(log.failed.length, 1);
    assert.match(log.failed[0], /^claude-review: failure-class=partial: /u);
    // The failure names the coverage and the reason, as the status line does.
    const detail = /\((read .*)\)$/u.exec(log.failed[0])?.[1];
    assert.match(`${detail}. `, size, log.failed[0]);
    assert.deepEqual(log.notices, []);
    const [marker] = writes;
    assert.equal(marker[0], "createComment");
    const [hidden, base, status] = marker[1].body.split("\n");
    assert.equal(
      hidden,
      "<!-- claude-lane-reviewed-head lane=claude-review sha=none -->",
    );
    assert.match(base, / caller=\.github\/workflows\/review\.yml -->$/u);
    const prefix = `**claude-review** partial review of \`${HEAD}\`: `;
    assert.ok(status.startsWith(prefix), status);
    assert.match(status.slice(prefix.length), size);
    assert.ok(
      status.endsWith(
        `0 finding(s) in what was read, 0 as inline comments. This head is not reviewed.${remedy}`,
      ),
      status,
    );
  }
});

test("a partial review still posts the findings it made inline", async () => {
  const { writes, log } = await publishReview({
    ...REVIEW,
    coverage: { read: 1, changed: 2 },
  });
  assert.deepEqual(
    writes.map(([name]) => name),
    ["createReview", "createComment"],
  );
  assert.match(
    log.failed[0],
    /failure-class=partial: .*\(read 1 of 2 changed file\(s\)\)$/u,
  );
});

// A generated data file the job left out of the scope is named in the
// coverage, so the complete review and the shadow report both say which file
// no one reviewed; the completion notice, which merge gates parse, is unchanged.
test("a complete review names each generated data file it left out", async () => {
  const data =
    "plugins/source-control/skills/babysit-prs/scripts/verify-legacy-fails.json";
  const coverage = { read: 1, changed: 1, data_files: [data] };
  const { writes, log } = await publishReview({ ...REVIEW, coverage });
  assert.deepEqual(log.failed, []);
  const status = writes[1][1].body.split("\n")[2];
  assert.equal(
    status,
    `**claude-review** reviewed \`${HEAD}\`: read 1 of 1 changed file(s); 1 data file(s) not reviewed: \`${data}\`; 1 finding(s), 1 as inline comments.`,
  );
  assert.deepEqual(log.notices, [
    `claude-lane-review-complete lane=claude-review sha=${HEAD} findings=1 inline=1 scope=whole`,
  ]);
  const shadow = await publishReview(
    {
      ...REVIEW,
      coverage: { read: 1, changed: 1, data_files: ["a.json", "b/c.json"] },
    },
    { PUBLISH: "summary" },
  );
  assert.match(
    shadow.log.summary,
    /- Coverage: read 1 of 1 changed file\(s\); 2 data file\(s\) not reviewed: `a\.json`, `b\/c\.json`\n/u,
  );
});

test("the status line names the first 10 data files and counts the rest", async () => {
  const names = (n) => Array.from({ length: n }, (_, i) => `d/${i + 1}.json`);
  const status = async (n) => {
    const { writes } = await publishReview({
      ...REVIEW,
      coverage: { read: 1, changed: 1, data_files: names(n) },
    });
    return writes[1][1].body.split("\n")[2];
  };
  const ten = names(10)
    .map((name) => `\`${name}\``)
    .join(", ");
  assert.ok(
    (await status(10)).includes(
      `; 10 data file(s) not reviewed: ${ten}; 1 finding(s)`,
    ),
  );
  assert.ok(
    (await status(12)).includes(
      `; 12 data file(s) not reviewed: ${ten} and 2 more; 1 finding(s)`,
    ),
  );
});

test("a review with no coverage, or coverage past its scope, is incomplete", async () => {
  for (const coverage of [
    undefined,
    { read: 2, changed: 1 },
    { read: 1 },
    { read: 1, changed: 1, over_budget: 0 },
    { read: 1, changed: 1, over_files: 0 },
    { read: 1, changed: 1, over_files: "41" },
    { read: "1", changed: 1 },
    // A data file list that is empty, not a list, or names a path that
    // could break out of its code span.
    { read: 1, changed: 1, data_files: [] },
    { read: 1, changed: 1, data_files: "a.json" },
    { read: 1, changed: 1, data_files: ["a`b.json"] },
    { read: 1, changed: 1, data_files: ["a.json\n**x**"] },
    { read: 1, changed: 1, binary_files: [] },
    { read: 1, changed: 1, binary_files: "a.gz" },
    { read: 1, changed: 1, binary_files: ["a`b.gz"] },
  ]) {
    const { writes, log } = await publishReview({ ...REVIEW, coverage });
    assert.deepEqual(writes, [], JSON.stringify(coverage));
    assert.match(log.failed[0], /failure-class=incomplete/u);
  }
});

test("summary mode reports a partial review in the shadow report and never fails", async () => {
  const { writes, log } = await publishReview(
    { ...REVIEW, coverage: { read: 1, changed: 4 } },
    { PUBLISH: "summary" },
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(log.failed, []);
  assert.match(log.summary, /- Outcome: partial\n/u);
  assert.match(log.summary, /- Coverage: read 1 of 4 changed file\(s\)\n/u);
  assert.match(
    log.notices.at(-1),
    /^shadow claude-review: failure-class=partial: /u,
  );
});

// The comment record a run writes at LANE_RECORD: one JSON line per comment.
function readRecord(file) {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

const digest = (body) =>
  crypto.createHash("sha256").update(body, "utf8").digest("hex");
// A fresh comment record path.
const recordFile = () =>
  path.join(makeTemporaryDirectory("lane-record-"), "comments.jsonl");
const BINDING = `<!-- claude-lane-run id=4242 sha=${HEAD} -->`;

test("each comment carries the run's binding above its footer, and the record lists what the run posted", async () => {
  const record = recordFile();
  const { writes, log } = await publish({
    GITHUB_RUN_ID: "4242",
    LANE_RECORD: record,
  });
  assert.deepEqual(log.failed, []);
  const [review] = writes;
  const body = `Off by one.\n${BINDING}\n\nclaude-lane: claude-review`;
  assert.equal(review[1].comments[0].body, body);
  assert.match(
    review[1].body,
    new RegExp(`\\n${BINDING}\\n\\nclaude-lane: claude-review$`, "u"),
  );
  const base = { lane: "claude-review", pr: 7, head: HEAD };
  assert.deepEqual(readRecord(record), [
    { ...base, kind: "review", id: 501, sha256: digest(review[1].body) },
    { ...base, kind: "review_comment", id: 601, sha256: digest(body) },
  ]);
});

test("a re-run records the comments its run already posted and posts nothing twice; another run's are neither reposted nor recorded", async () => {
  const record = recordFile();
  const ours = `Off by one.\n${BINDING}\n\nclaude-lane: claude-review`;
  const posted = [
    {
      id: 9,
      user: { login: "github-actions[bot]" },
      commit_id: HEAD,
      path: "a.js",
      line: 2,
      side: "RIGHT",
      body: ours,
    },
  ];
  const rerun = await publish(
    { GITHUB_RUN_ID: "4242", LANE_RECORD: record, MARKER_ID: "99" },
    { posted },
  );
  assert.deepEqual(
    rerun.writes.map(([name]) => name),
    ["updateComment"],
  );
  assert.deepEqual(readRecord(record), [
    {
      lane: "claude-review",
      pr: 7,
      head: HEAD,
      kind: "review_comment",
      id: 9,
      sha256: digest(ours),
    },
  ]);
  const other = recordFile();
  const later = await publish(
    { GITHUB_RUN_ID: "5000", LANE_RECORD: other, MARKER_ID: "99" },
    { posted },
  );
  assert.deepEqual(
    later.writes.map(([name]) => name),
    ["updateComment"],
  );
  assert.deepEqual(readRecord(other), []);
});

test("a finding moved to the summary loses its binding and footer there", async () => {
  const review = { ...REVIEW, comments: [{ ...REVIEW.comments[0], line: 9 }] };
  const { writes } = await publishReview(review, { GITHUB_RUN_ID: "4242" });
  assert.match(writes[0][1].body, /`a\.js:9` \(RIGHT\): Off by one\.$/mu);
  assert.doesNotMatch(writes[0][1].body, /claude-lane-run|claude-lane: /u);
});

test("a partial review over the budget names what makes the next review complete", () => {
  assert.equal(
    partialRemedy({ read: 4, changed: 5, unread_files: ["src/a.js"] }),
    "",
  );
  assert.equal(
    partialRemedy({ read: 3, changed: 3, over_budget: 1330000 }),
    " A re-run of this diff stays partial. Split the pull request into smaller ones.",
  );
  assert.match(
    partialRemedy({ read: 170, changed: 170, over_files: 170 }),
    /^ A re-run of this diff stays partial\. Split the pull request into smaller ones\.$/u,
  );
  assert.match(
    partialRemedy({
      read: 3,
      changed: 4,
      over_budget: 1330000,
      binary_files: ["t/fixtures.tar.gz"],
    }),
    /shown by its header only; any other binary file counts in full, so list it in the caller's `generated-data` file by a pull request merged first/u,
  );
});

test("publish-review publishes structured uncovered_rules in the summary and preserves free-text blocks without duplication", async () => {
  const review = {
    findings: 0,
    coverage: { read: 1, changed: 1 },
    summary: "No findings.\n\ncritical-findings: 0",
    comments: [],
    uncovered_rules: [
      "Reject unpinned action tags in composite actions",
      "Uncovered rule: Require timeout-minutes on every job\u202E",
    ],
  };
  const body = summaryText(review, [], "claude-review");
  assert.match(
    body,
    /<details>\n<summary>Uncovered rules \(2\)<\/summary>\n\n- Uncovered rule: Reject unpinned action tags in composite actions\n- Uncovered rule: Require timeout-minutes on every job\n\n<\/details>$/u,
  );
  // A review whose summary already carries the same free-text block keeps it
  // unchanged and does not append a duplicate <details> block.
  const freeText = {
    ...review,
    summary:
      "No findings.\n\n<details>\n<summary>Uncovered rules (2)</summary>\n\n- Uncovered rule: Reject unpinned action tags in composite actions\n- Uncovered rule: Require timeout-minutes on every job\n\n</details>",
  };
  assert.equal(uncoveredRulesBlock(freeText, freeText.summary), "");
  assert.equal(summaryText(freeText, [], "claude-review"), freeText.summary);
  // When appending the block would exceed MAX_SUMMARY, the block is dropped first.
  const huge = {
    ...review,
    summary: "x".repeat(59990),
  };
  const capped = summaryText(huge, [], "claude-review");
  assert.equal(capped.length, 59990);
  assert.doesNotMatch(capped, /<summary>Uncovered rules/u);

  // Secret scanning runs over the published summary including uncovered_rules.
  const leaked = await publishReview({
    ...review,
    uncovered_rules: [`Never commit ${FAKE_KEY}`],
  });
  assert.match(leaked.log.failed[0] ?? "", /failure-class=withheld/u);
  assert.deepEqual(leaked.writes, []);

  // Shadow mode carries structured uncovered_rules in the artifact JSON.
  const artifactDir = makeTemporaryDirectory("publish-uncovered-shadow-");
  await publishReview(review, {
    PUBLISH: "summary",
    ARTIFACT_DIR: artifactDir,
  });
  const report = JSON.parse(
    fs.readFileSync(path.join(artifactDir, "claude-review.json"), "utf8"),
  );
  assert.deepEqual(report.review.uncovered_rules, review.uncovered_rules);
  assert.match(
    report.review.summary,
    /<summary>Uncovered rules \(2\)<\/summary>/u,
  );
});
