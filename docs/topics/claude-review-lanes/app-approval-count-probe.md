# Probe: custom App APPROVED vs `required_approving_review_count`

Tracks the must-verify item on [ci-workflows#256](https://github.com/melodic-software/ci-workflows/issues/256):

> Does a custom GitHub App's APPROVED review satisfy native
> `required_approving_review_count`?

GitHub documents only Copilot as excluded from that count. This probe settles
the question empirically on `melodic-software/claude-lane-sandbox` using the
existing org App `melodic-ai` (app id `3872665`).

## Result (2026-08-12)

**YES.**

| Signal | Value |
| --- | --- |
| Baseline `reviewDecision` | `REVIEW_REQUIRED` |
| App review | `melodic-ai[bot]` `APPROVED`, `author_association: NONE` |
| Post-review `reviewDecision` | `APPROVED` |
| Evidence PR | https://github.com/melodic-software/claude-lane-sandbox/pull/15 |
| Evidence review | https://github.com/melodic-software/claude-lane-sandbox/pull/15#pullrequestreview-4913014091 |
| Evidence run | https://github.com/melodic-software/claude-lane-sandbox/actions/runs/31563297925 |

`mergeStateStatus` stayed `BLOCKED` because the probe commits were unsigned
under the org `signing` ruleset (`commit.signature.isValid == false`). That is
orthogonal to the approval-count question — `reviewDecision` flipped to
`APPROVED` with only the App review present.

### Out of scope (still true; not re-probed here)

- `require_code_owner_reviews` cannot be satisfied by an App (owners are
  users/teams/emails with write access).
- Org "Code review limits" (Moderation) can further restrict who may approve.
- `anthropics/claude-code-action` `agent-approval-check` still discards bot/App
  approvals (`author_association: NONE`) — that is a separate check, not native
  branch protection.

## Repro checklist

Use only when re-validating after a GitHub behavior change. Prefer the existing
`melodic-ai` App; do **not** create a new GitHub App unless that App is gone.

1. **Grant secrets (temporary)** to `claude-lane-sandbox` (repo id
   `1323418033`):
   - org Actions secrets `MELODIC_APP_ID`, `MELODIC_PRIVATE_KEY`
   - `PUT /orgs/melodic-software/actions/secrets/{name}/repositories/1323418033`
2. **Add a temporary repo ruleset** on the sandbox default branch:
   - name e.g. `TEMP approval-probe required-reviews`
   - rule `pull_request` with `required_approving_review_count: 1`
   - `require_code_owner_review: false`, `require_last_push_approval: false`
   - no bypass actors
3. **Open a human-authored PR** (author ≠ App) with a workflow that:
   - mints an installation token via `actions/create-github-app-token` using
     `MELODIC_APP_ID` + `MELODIC_PRIVATE_KEY` scoped to
     `melodic-software/claude-lane-sandbox`
   - records GraphQL `pullRequest.reviewDecision` (expect `REVIEW_REQUIRED`)
   - `POST /repos/{o}/{r}/pulls/{n}/reviews` with `event=APPROVE` using the
     App token (do **not** call `GET /user` — installation tokens 403 it)
   - records `reviewDecision` again after a short wait
4. **Verdict rule**
   - `REVIEW_REQUIRED` → `APPROVED` after only the App review ⇒ **YES**
   - still `REVIEW_REQUIRED` ⇒ **NO**
   - any other pair ⇒ **INCONCLUSIVE** (inspect other rules / bypasses)
5. **Cleanup (required)**
   - delete the TEMP ruleset
   - revoke both org-secret repository grants (leave `medley` only)
   - close the throwaway PR / delete the probe branch

### Minimal GraphQL check

```graphql
query($n: Int!) {
  repository(owner: "melodic-software", name: "claude-lane-sandbox") {
    pullRequest(number: $n) {
      reviewDecision
      mergeStateStatus
      reviews(last: 10) {
        nodes { author { login } state authorAssociation }
      }
    }
  }
}
```
