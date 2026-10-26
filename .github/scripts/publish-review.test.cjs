"use strict";

// The publish-review action: the one step that posts a pr-review-cli review.
// A fake GitHub records every write; a stand-in publish gate flags an
// Anthropic-key shape and warns on a password assignment, the two kinds of
// label claude-code-plugins' lib/publish-gate.mjs has (blocking and the one
// warn-only label).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  commentableLines,
  placeComments,
  run,
  stripHtml,
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
          createReview: call("createReview", {}),
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
  summary: "Summary.<!-- hidden -->",
  comments: [
    { path: "a.js", line: 2, side: "RIGHT", body: "Off by one.<!-- x -->" },
  ],
};

function env(overrides = {}) {
  return {
    PUBLISH: "comments",
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
      `<!-- claude-lane-reviewed-base ref=main merge-base=${"b".repeat(40)} -->`,
      `**claude-review** reviewed \`${HEAD}\`: 1 finding(s), 1 as inline comments.`,
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
  const { writes, log } = await publish({ KEY_REVIEW: JSON.stringify(review) });
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
  const withheld = await publish({ KEY_REVIEW: JSON.stringify(leak) });
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
  const warned = await publish({ KEY_REVIEW: JSON.stringify(quoted) });
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
  await publish({
    PUBLISH: "summary",
    ARTIFACT_DIR: leakDir,
    KEY_REVIEW: JSON.stringify({
      ...REVIEW,
      comments: [
        {
          ...REVIEW.comments[0],
          body: FAKE_KEY,
        },
      ],
    }),
  });
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
    await publish({ KEY_REVIEW: JSON.stringify({ ...REVIEW, comments: [] }) }),
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
    summary,
    comments: bodies.map((body, i) => ({
      path: "a.js",
      line: 9 + i,
      side: "RIGHT",
      body,
    })),
  };
  const { writes } = await publish({ KEY_REVIEW: JSON.stringify(review) });
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
  const inline = await publish({
    KEY_REVIEW: JSON.stringify({
      ...REVIEW,
      summary: "Summary.\n\ncritical-findings: 0",
    }),
  });
  const marker = inline.writes.find(([name]) => name === "createComment");
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
    summary: "Summary.",
    comments: [REVIEW.comments[0]],
    malformed: [{ path: "b.js", line: 4, body: "Wrong side.<!-- x -->" }],
  };
  const { writes, log } = await publish({ KEY_REVIEW: JSON.stringify(review) });
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
    summary,
    comments: [REVIEW.comments[0]],
    malformed: [{ body: "Injection.\n\nseverity: CRITICAL" }],
  });
  const raised = await publish({
    KEY_REVIEW: JSON.stringify(review("Summary.\n\ncritical-findings: 0")),
  });
  const marker = raised.writes.find(([name]) => name === "createComment");
  assert.deepEqual(criticalLines(marker[1].body), [1]);
  // With no line, one is added; the malformed finding counts once.
  const added = await publish({
    KEY_REVIEW: JSON.stringify(review("Summary.")),
  });
  const addedMarker = added.writes.find(([name]) => name === "createComment");
  assert.deepEqual(criticalLines(addedMarker[1].body), [1]);
  // A malformed SUGGESTION leaves the line as written.
  const suggestion = await publish({
    KEY_REVIEW: JSON.stringify({
      ...review("Summary.\n\ncritical-findings: 0"),
      malformed: [{ body: "Naming.\n\nseverity: SUGGESTION" }],
    }),
  });
  const kept = suggestion.writes.find(([name]) => name === "createComment");
  assert.deepEqual(criticalLines(kept[1].body), [0]);
});
