# ADR — Org `@claude` mention-responder lane (#255)

Status: accepted for V1 (answer / re-review only)

Issue: [melodic-software/ci-workflows#255](https://github.com/melodic-software/ci-workflows/issues/255)

Parent brief: [docs/topics/claude-review-lanes/PLAN.md](./PLAN.md)

Upstream reference: `anthropics/claude-code-action` tag mode (`claude.yml`)

## Context

Humans need an org lane where mentioning `@claude` on an issue or PR gets an
answer or a re-review. Medley already ships a local `claude-assistant.yml` with
write/commit capability; this ADR deliberately does **not** lift that shape.
V1 is designed from the #255 research brief: reusable workflow, answer/re-review
only, tool allowlist as the real control.

Product/policy decisions locked in the issue body (2026-07-26 interview +
first-principles research) and executed here:

| Decision | V1 choice |
| --- | --- |
| Shape | Reusable workflow + thin caller (same as other Claude lanes) |
| Auth | Org `CLAUDE_CODE_OAUTH_TOKEN` (WIF rejected) |
| Capability | Answer + re-review only — no Edit/Write, no `git commit`/`push`, no merge/approve |
| `allowed_bots` | Default **empty**; never `*` (rejected at runtime) |
| `allowed_non_write_users` | **Never** passed (upstream tripwire idea) |
| Self-trigger | `skip-actors` defaults ban `claude[bot]` and org apps |

## Decisions locked (this PR)

1. **Reusable owns** runner default, action pin, allowedTools floor, ~15m
   timeout, per-entity concurrency, model pin (`claude-sonnet-5`).
2. **Caller owns** `on:` (`issue_comment` / `pull_request_review_comment` /
   `workflow_dispatch`), `@claude` `contains()` guards, and the permission
   union (`contents: read`, `pull-requests: write`, `issues: write`,
   `id-token: write`).
3. **Tool allowlist floor** (appended in a compose step so a caller replacing
   `claude-args` cannot drop it): `Read`, `Grep`, `Glob`,
   `Bash(gh pr view:*)`, `Bash(gh pr diff:*)`, `Bash(gh issue view:*)`,
   `mcp__github_inline_comment__create_inline_comment`. Write-capable grants
   in caller `claude-args` are rejected.
4. **Author allowlist** input `allowed-authors` (empty = any write-access actor
   not in `skip-actors`). Complements `allowed-bots` (bot write-check bypass
   list — kept empty by default).
5. **Kill-switches**: `CLAUDE_LANES_DISABLED` (master) and
   `CLAUDE_ASSISTANT_DISABLED` (per-lane), same `vars.X != 'true'` pattern as
   sibling lanes.
6. **No untrusted PR-head checkout** before the action (CVE-2026-47751 class).
7. **Dogfood caller** `claude-assistant-self.yml` wires mention triggers +
   dispatch for this repo.

## Explicit non-goals for V1

- Fix-and-push / `--permission-mode acceptEdits` / `git-push.sh` wrappers (V2,
  behind a separate approval gate — see issue body).
- Autonomous merge or `APPROVE` reviews.
- Replacing Medley's local write-capable assistant (fleet migration is a later
  call).
- Incident-aggregator / retry-gate parity with the review lanes (users
  re-mention; advisory `continue-on-error` only).
- Passing `allowed_non_write_users` for any reason.

## Consequences

- #255 closes when this lands (`Fixes #255`).
- Consumers pin the reusable by SHA and keep triggers/permissions in their
  thin caller; public consumers must leave `allowed-bots` empty (or name
  specific bots — never `*`).
- V2 fix-and-push remains a separate decision record.
