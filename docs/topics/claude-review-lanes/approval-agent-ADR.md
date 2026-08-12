# ADR — Approval Agent live APPROVE path (#256)

Status: accepted — live APPROVE behind explicit opt-in; fleet required-check
wiring still deferred

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

V1 scaffold (#433) landed a disabled `COMMENTED`-only reusable plus this ADR.
This revision enables the live `APPROVE` path behind an explicit opt-in.

## Decisions locked

1. **Target native approvals**, not `agent-approval-check`.
2. **Reuse an existing org App** via caller-supplied `app-id` /
   `app-private-key` secrets (dogfood caller maps
   `MELODIC_APP_ID` / `MELODIC_PRIVATE_KEY`). Do **not** register a new GitHub
   App for this workflow.
3. **Guardrails (enforced in `.github/scripts/approval-agent-guardrails.cjs`
   before any `APPROVE`):**
   - Never approve PRs that modify the Approval Agent's own
     policy / routing / workflow files (default deny-list covers the reusable,
     self caller, guardrails module, and this ADR).
   - Approver App never pushes; approver / author / pusher identities are
     strictly distinct (`require_last_push_approval` compatible).
   - Refuse when findings need human review (`refuse-on-human-risk`, default
     true) and `human-risk-findings` is non-empty.
   - Posture: does not replace full code review.
4. **Safe default.** `enable-approve` defaults to `false` → `COMMENTED` only
   after guardrails. Live `APPROVE` requires `enable-approve: true` **and**
   App secrets (independent identity). No production required-check / ruleset
   enablement in this PR. The in-repo dogfood caller stays
   `workflow_dispatch`-only.
5. **CODEOWNERS / org "Code review limits"** remain separate constraints: an
   App cannot satisfy `require_code_owner_reviews`; org Moderation limits can
   still restrict who may approve. Not re-probed here.

## Explicit non-goals for this slice

- No new GitHub App registration.
- No fleet caller component, standards sync-manifest entries, or required-check
  / ruleset edits.
- No model-review implementation (Fable / Opus / Codex) — findings are an
  opaque caller-supplied input for now.
- No changes related to issues #231 / #232 / #236.
- No `pull_request` auto-trigger on the self caller.

## Ordered follow-ups

| Order | What | Status |
| --- | --- | --- |
| 1 | ADR + probe doc + disabled `COMMENTED` skeleton | Done (#433) |
| 2 | Guardrail implementation + live `APPROVE` behind `enable-approve` | This PR |
| 3 | Model-backed review producing `human-risk-findings` | Deferred |
| 4 | Fleet caller component + selective `required_approving_review_count` wiring | Deferred |

## Consequences

- #256 closes when this PR merges: the Approval Agent lane can submit native
  `APPROVE` under guardrails when explicitly opted in.
- Default callers remain safe (comment-only) until they pass
  `enable-approve: true` and App credentials.
- Fleet enablement is a separate change and must not ride this PR.
