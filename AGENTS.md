## Org architecture

Org architecture (cross-repo decisions, glossary, why each trust link exists): private repo `melodic-software/architecture`. Repo map: `gh api orgs/melodic-software/properties/values` (system and role per repo). Read it with `gh api repos/melodic-software/architecture/contents/<path>`; on Claude Code on the web, attach it at session start; in CI, check it out with a read-only App token. If access is denied, stop and tell the user.

## Code Review Rules

Each line names a rule CI does not enforce; the linked file states it in full.

- Org-wide criteria: [`REVIEW.md`](REVIEW.md), synced from `melodic-software/standards`.
- Claude lane security model (`SECURITY MODEL` headers):
  [`pr-review.yml`](.github/workflows/pr-review.yml) and
  [`pr-review-security.yml`](.github/workflows/pr-review-security.yml).
- Claude lane checks stay advisory: [rule](README.md#claude-lanes--shared-consumption-contract).
- Configurable, not forkable: [rule](README.md#contract).
- Policy is authored in standards; `fixtures/` configs only exercise contracts:
  [rule](README.md#policy-ownership-and-action-inputs).
- Local-lane guard wrappers keep parity with the standards component:
  [rule](README.md#actions).
- Lanes consolidate as composite actions; `ci-status` stays the single required check:
  [rule](README.md#contract).
