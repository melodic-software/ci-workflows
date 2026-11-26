"use strict";

// resolve-review-scope's GraphQL read, answered in the shape GitHub returned
// it: fixtures/resolve-review-scope/pull-request-comments.json is
// `gh api graphql -i` with scope.cjs's query on claude-code-plugins#19249
// (bodies trimmed), plus one User comment node from the same query on #19224.
// Each answer is that capture with a test's head, changed-file count and
// comments, 100 a page, as the query asks.

const CAPTURE = require("./fixtures/resolve-review-scope/pull-request-comments.json");

const captured = CAPTURE.body.data.repository.pullRequest.comments.nodes;
const botNode = captured.find((node) => node.author.login === "github-actions");
const userNode = captured.find((node) => node.author.__typename === "User");

// A REST-shaped test comment ({ id, user: { login }, body }) as its GraphQL
// node: a `<slug>[bot]` login is the Bot `<slug>`.
function commentNode({ id, user, body }) {
  const login = user?.login ?? "";
  const bot = /^(.+)\[bot\]$/u.exec(login);
  return {
    ...botNode,
    databaseId: id,
    author: bot
      ? { ...botNode.author, login: bot[1] }
      : { ...userNode.author, login },
    body,
  };
}

// The `data` github.graphql resolves to for one page of the query.
function pullRequestPage({ head, changedFiles, comments = [] }, cursor) {
  const start = cursor ? Number(cursor) : 0;
  const data = structuredClone(CAPTURE.body.data);
  const pull = data.repository.pullRequest;
  pull.headRefOid = head;
  pull.changedFiles = changedFiles;
  pull.comments.nodes = comments.slice(start, start + 100).map(commentNode);
  pull.comments.pageInfo = {
    hasNextPage: start + 100 < comments.length,
    endCursor: String(start + 100),
  };
  return data;
}

module.exports = { CAPTURE, commentNode, pullRequestPage };
