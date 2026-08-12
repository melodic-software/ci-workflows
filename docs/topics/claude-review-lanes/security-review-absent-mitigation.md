# Absent required security-review check (#227)

## Problem

On repos that arm org ruleset required context `security-review / security-review`
(`requires-security-review=true`), an intermittent `pull_request` event-delivery
gap can leave that check **ABSENT** (not failed) on a PR head. Merge stays
`BLOCKED` while sibling `pull_request_target` workflows still fire and other
surfaces look green. Observed wedge windows ranged from minutes to ~13.5h and
cleared on a later push that re-delivered `pull_request`.

Moving the security lane onto privileged `pull_request_target` /
`workflow_run` with secrets is **out of bounds** — `claude-security-review.yml`
hard-fails those triggers (token-exfiltration tripwire).

## Mitigation (this repo)

Three cooperating pieces, none of which privilege the security lane:

1. **`workflow_dispatch` re-entry** on the dogfood caller
   (`.github/workflows/claude-security-review-self.yml`) and a `pr-number`
   input on the reusable — same shape as claude-review `#254`. Dispatch
   resolves the live head via API, checks it out, and runs the always-report
   lane so a real check attaches.

2. **`security-review-absent-mitigate.cjs`** — extends the
   `check-run-reconcile` taxonomy (`#399` / `#422`) to find open PRs whose
   required security-review context has no commit check-run past a grace
   window, then:
   - `report` — print findings
   - `post-failure-check` — create a **FAILED** check under the missing
     context name (forces visibility; not a security finding)
   - `dispatch` — `gh workflow run` the Claude Security Review caller with
     `pr-number`

3. **Companion workflows** — `security-review-absent-mitigate.yml` (reusable)
   and `security-review-absent-mitigate-self.yml` (`schedule` /
   `workflow_dispatch` only). Default mode posts the visibility failure check.

## Consumer adoption

Repos with `requires-security-review=true` should:

1. Add `workflow_dispatch` + `pr-number` to their Claude Security Review
   caller (see the reusable's canonical caller comment).
2. Call `security-review-absent-mitigate.yml` on a schedule (or copy the
   dogfood self caller), preferring `mode: dispatch` once (1) is live, or
   `post-failure-check` until then.

Do **not** replace `pull_request` with `pull_request_target` for this lane.
