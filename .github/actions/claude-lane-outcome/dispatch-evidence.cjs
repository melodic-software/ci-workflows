// Decide whether a workflow_dispatch re-review actually posted anything.
//
// claude-lane-outcome treats "the action succeeded and wrote an execution
// file" as a review that ran. On a dispatched re-review that is not enough:
// the model can finish with zero permission to call `gh pr review` or
// `gh pr comment` and the lane still looks green (ci-workflows#573). This
// module is the pass/fail decision. It does not call GitHub. The workflow
// step that shells out to `gh` writes a file of ids; this function only
// reads that payload.
//
// A post counts when a pull-request review id or an issue-comment id is
// present now and was not present in the baseline taken before the attempt.
// Pre-existing conversation on the PR must not count, or every dispatch
// against a PR that already has a comment would pass without posting.
// `gh pr review` shows up as a review; `gh pr comment` shows up as an issue
// comment. Either one is enough.
//
// The check applies only when the caller says the event is workflow_dispatch
// AND a review was actually attempted (the same shape as review_ran: the
// action succeeded with an execution file, which the outcome step reaches
// only when the run was not superseded, cancelled, or capped). Every other
// caller gets applies:false and must keep the historical success rule.
//
// Fail closed when the check applies and the payload is missing or
// unparsable. Nothing in the returned detail is taken from the payload.
// Bodies, logins, and paths are ignored on purpose so a collector that
// accidentally includes them cannot reach an annotation through this module.
"use strict";

const UNPARSABLE_DETAIL = "(dispatch delivery evidence missing or unparsable)";

function entryId(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const { id } = entry;
  if (typeof id === "number") {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return id;
  }
  if (typeof id === "string" && /^[1-9][0-9]*$/u.test(id)) {
    const parsed = Number(id);
    if (!Number.isSafeInteger(parsed)) return null;
    return parsed;
  }
  return null;
}

function uniqueIds(list) {
  const ids = [];
  const seen = new Set();
  for (const entry of list) {
    const id = entryId(entry);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function newIds(current, baseline) {
  const seen = new Set(uniqueIds(baseline));
  return uniqueIds(current).filter((id) => !seen.has(id));
}

function isIdList(value) {
  return Array.isArray(value);
}

function parseEvidence(evidenceText) {
  if (typeof evidenceText !== "string" || evidenceText.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(evidenceText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const baseline = parsed.baseline;
  if (
    !isIdList(parsed.reviews) ||
    !isIdList(parsed.comments) ||
    baseline === null ||
    typeof baseline !== "object" ||
    Array.isArray(baseline) ||
    !isIdList(baseline.reviews) ||
    !isIdList(baseline.comments)
  ) {
    return null;
  }
  return parsed;
}

function notApplicable() {
  return {
    applies: false,
    delivered: true,
    failureClass: null,
    detail: "",
  };
}

function noDelivery(detail) {
  return {
    applies: true,
    delivered: false,
    failureClass: "no-delivery",
    detail,
  };
}

function classifyDispatchDelivery({
  eventName = "",
  reviewAttempted = false,
  evidenceText,
} = {}) {
  if (eventName !== "workflow_dispatch" || reviewAttempted !== true) {
    return notApplicable();
  }
  const evidence = parseEvidence(evidenceText);
  if (evidence === null) return noDelivery(UNPARSABLE_DETAIL);

  const reviews = newIds(evidence.reviews, evidence.baseline.reviews);
  const comments = newIds(evidence.comments, evidence.baseline.comments);
  if (reviews.length > 0 || comments.length > 0) {
    return {
      applies: true,
      delivered: true,
      failureClass: null,
      detail: "",
    };
  }
  return noDelivery(
    `(dispatch run posted no pull-request review or issue comment; new reviews: ${reviews.length}, new comments: ${comments.length})`,
  );
}

module.exports = {
  classifyDispatchDelivery,
  UNPARSABLE_DETAIL,
};
