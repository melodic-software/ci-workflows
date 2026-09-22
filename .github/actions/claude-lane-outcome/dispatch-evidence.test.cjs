"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyDispatchDelivery,
  UNPARSABLE_DETAIL,
} = require("./dispatch-evidence.cjs");

const CANARY = "canary-never-publish-this-body";

function evidence(overrides = {}) {
  return JSON.stringify({
    reviews: [],
    comments: [],
    baseline: { reviews: [], comments: [] },
    ...overrides,
  });
}

function surfaces(result) {
  return `${result.failureClass ?? ""}\n${result.detail}`;
}

test("pull_request and a review that was not attempted do not consult evidence", () => {
  for (const input of [
    {
      eventName: "pull_request",
      reviewAttempted: true,
      evidenceText: undefined,
    },
    { eventName: "schedule", reviewAttempted: true, evidenceText: "{}" },
    { eventName: "", reviewAttempted: true },
    {
      eventName: "workflow_dispatch",
      reviewAttempted: false,
      evidenceText: undefined,
    },
    {
      eventName: "workflow_dispatch",
      reviewAttempted: false,
      evidenceText: "not-json",
    },
  ]) {
    const result = classifyDispatchDelivery(input);
    assert.equal(result.applies, false, JSON.stringify(input));
    assert.equal(result.delivered, true, JSON.stringify(input));
    assert.equal(result.failureClass, null, JSON.stringify(input));
    assert.equal(result.detail, "", JSON.stringify(input));
  }
});

test("a dispatch run that attempted a review fails closed without usable evidence", () => {
  const cases = [
    undefined,
    null,
    "",
    "   ",
    "not-json",
    "{",
    "null",
    "[]",
    "1",
    JSON.stringify({ reviews: [], comments: [] }),
    JSON.stringify({ reviews: [], comments: [], baseline: {} }),
    JSON.stringify({
      reviews: {},
      comments: [],
      baseline: { reviews: [], comments: [] },
    }),
    JSON.stringify({
      reviews: [],
      comments: [],
      baseline: { reviews: [], comments: "nope" },
    }),
  ];
  for (const evidenceText of cases) {
    const result = classifyDispatchDelivery({
      eventName: "workflow_dispatch",
      reviewAttempted: true,
      evidenceText,
    });
    assert.equal(result.applies, true);
    assert.equal(result.delivered, false);
    assert.equal(result.failureClass, "no-delivery");
    assert.equal(result.detail, UNPARSABLE_DETAIL);
    assert.equal(surfaces(result).includes(CANARY), false);
  }
});

test("a new pull-request review or a new issue comment is delivery", () => {
  const reviewOnly = classifyDispatchDelivery({
    eventName: "workflow_dispatch",
    reviewAttempted: true,
    evidenceText: evidence({
      reviews: [{ id: 10, body: CANARY }],
      comments: [{ id: 2, body: CANARY }],
      baseline: { reviews: [], comments: [{ id: 2 }] },
    }),
  });
  assert.equal(reviewOnly.delivered, true);
  assert.equal(reviewOnly.failureClass, null);
  assert.equal(reviewOnly.detail, "");
  assert.equal(surfaces(reviewOnly).includes(CANARY), false);

  const commentOnly = classifyDispatchDelivery({
    eventName: "workflow_dispatch",
    reviewAttempted: true,
    evidenceText: evidence({
      reviews: [{ id: 10, body: CANARY }],
      comments: [{ id: 3, body: CANARY, user: { login: CANARY } }],
      baseline: { reviews: [{ id: 10 }], comments: [] },
    }),
  });
  assert.equal(commentOnly.delivered, true);
  assert.equal(surfaces(commentOnly).includes(CANARY), false);
});

test("ids that were already on the PR are not a new post", () => {
  const result = classifyDispatchDelivery({
    eventName: "workflow_dispatch",
    reviewAttempted: true,
    evidenceText: evidence({
      reviews: [{ id: 10, body: CANARY }],
      comments: [{ id: "20", body: CANARY }],
      baseline: {
        reviews: [{ id: "10" }],
        comments: [{ id: 20, body: CANARY }],
      },
    }),
  });
  assert.equal(result.delivered, false);
  assert.equal(result.failureClass, "no-delivery");
  assert.match(result.detail, /new reviews: 0, new comments: 0/u);
  assert.equal(surfaces(result).includes(CANARY), false);
});

test("numeric strings count and unusable ids do not", () => {
  const delivered = classifyDispatchDelivery({
    eventName: "workflow_dispatch",
    reviewAttempted: true,
    evidenceText: evidence({
      reviews: [{ id: "15" }],
      baseline: { reviews: [{ id: 14 }], comments: [] },
    }),
  });
  assert.equal(delivered.delivered, true);

  const ignored = classifyDispatchDelivery({
    eventName: "workflow_dispatch",
    reviewAttempted: true,
    evidenceText: evidence({
      reviews: [
        { id: 0 },
        { id: -3 },
        { id: 1.5 },
        { id: "01" },
        { id: "nope" },
        "10",
      ],
      comments: [{ body: CANARY }, null, []],
    }),
  });
  assert.equal(ignored.delivered, false);
  assert.equal(surfaces(ignored).includes(CANARY), false);
});

test("an extra body field on a payload that did post is not copied out", () => {
  const result = classifyDispatchDelivery({
    eventName: "workflow_dispatch",
    reviewAttempted: true,
    evidenceText: JSON.stringify({
      body: CANARY,
      reviews: [{ id: 1 }],
      comments: [],
      baseline: { reviews: [], comments: [] },
    }),
  });
  assert.equal(result.delivered, true);
  assert.equal(JSON.stringify(result).includes(CANARY), false);
});
