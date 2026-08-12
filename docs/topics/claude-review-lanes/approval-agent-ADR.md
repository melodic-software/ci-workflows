# ADR — Approval Agent scaffold (#256)

Status: accepted for V1 scaffold only; live APPROVE and fleet wiring deferred

Issue: [melodic-software/ci-workflows#256](https://github.com/melodic-software/ci-workflows/issues/256)

Parent brief: [docs/topics/claude-review-lanes/PLAN.md](./PLAN.md)
Probe evidence: [app-approval-count-probe.md](./app-approval-count-probe.md)

## Context

Autonomous merge lanes need an independent approval identity that satisfies
GitHub native `required_approving_review_count`. Cursor-style Approval Agents
(separate from comment-only reviewers) are the adopted shape. Upstream
`anthropics/claude-code-action` `agent-approval-check` remains **rejected** for
autonomous repos (bot/App approvals arrive with `author_association: NONE` and
are discarded; an agent App APPROVED review flips "has agent activity" instead
of counting).

The must-verify sandbox probe (2026-08-12) returned **YES**: a custom GitHub
App's `APPROVED` review does satisfy native `required_approving_review_count`
on `melodic-software/claude-lane-sandbox` using existing org App
`melodic-ai[bot]` (app id `3872665`). Evidence: sandbox PR #15, review
`4913014091`, Actions run `31563297925`. No new App was created for the probe.

## Decisions locked (this scaffold)

1. **Target native approvals**, not `agent-approval-check`.
2. **Reuse an existing org App** for the eventual live APPROVE path
   (`melodic-ai` or a dedicated successor decided later). This PR does **not**
   create a new GitHub App.
3. **Guardrails (hard requirements before any live APPROVE):**
   - Never approve PRs that modify the Approval Agent's own
     policy / routing / workflow files (otherwise the gate is auto-approvable
     by the thing it gates).
   - Approver App never pushes; approver / author / pusher identities are
     strictly distinct (`require_last_push_approval` compatible).
   - Refuse when findings need human review or exceed a risk threshold.
   - Posture: does not replace full code review.
4. **V1 ships disabled.** The reusable posts a `COMMENTED` placeholder only.
   No live `APPROVE`. No production required-check / ruleset enablement in
   this PR. The in-repo dogfood caller is `workflow_dispatch`-only.
5. **CODEOWNERS / org "Code review limits"** remain separate constraints: an
   App cannot satisfy `require_code_owner_reviews`; org Moderation limits can
   still restrict who may approve. Not re-probed here.

## Explicit non-goals for this slice

- No new GitHub App registration or permission grants beyond docs.
- No `APPROVE` event in any workflow in this PR.
- No consumer caller components, standards sync-manifest entries, or
  required-check / ruleset edits.
- No model-review implementation (Fable / Opus / Codex) yet — placeholder
  body only.
- No changes related to issues #231 / #232 / #236.

## Ordered follow-up PRs

| Order | What | Gate |
| --- | --- | --- |
| 1 | This PR — ADR + probe doc + disabled `COMMENTED` skeleton | — |
| 2 | Guardrail implementation (path deny-list for own policy files; author/pusher ≠ approver checks; human-risk refuse) still posting `COMMENTED` only | After (1) |
| 3 | Optional App-token mint path (existing org App secrets) that still posts `COMMENTED` in a sandbox | After (2); no new App |
| 4 | Live `APPROVE` behind an explicit opt-in input + kill-switch, sandbox-only | After (3) + host ratification |
| 5 | Fleet caller component + selective required `required_approving_review_count` wiring | After (4) proves clean |

## Consequences

- #256 stays open until live Approval Agent work lands (this is a partial
  scaffold only).
- Wiring is reviewable without enabling autonomous approve.
- Next autonomous coding slice should be PR (2), not fleet enablement.
