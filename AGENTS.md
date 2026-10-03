## Code Review Rules

Each line names a rule CI does not enforce; the linked file states it in full.

- Org-wide criteria: [`REVIEW.md`](REVIEW.md), synced from `melodic-software/standards`.
- Claude lane security model (`pull_request` only, no PR-authored code run in a review lane,
  least-privilege token, logs kept clean): [`claude-review.yml`](.github/workflows/claude-review.yml)
  and [`claude-security-review.yml`](.github/workflows/claude-security-review.yml) `SECURITY MODEL` headers.
- Claude lane checks stay advisory, never required:
  [rule](README.md#claude-lanes--shared-consumption-contract).
- Configurable, not forkable: repository-specific scope goes through typed inputs with standard
  defaults: [contract](README.md#contract).
- Policy is authored in `melodic-software/standards`; `fixtures/` configs only exercise contracts:
  [policy ownership](README.md#policy-ownership-and-action-inputs).
- Local-lane guard wrappers keep parity with the standards component, never fork its policy:
  [local-lane guards](docs/topics/local-lane-guards.md).
- Lanes consolidate as composite actions; `ci-status` stays the single required check, with no
  workflow-level `paths:` on a required workflow: [ADR](docs/topics/ci-fanout-consolidation/ADR.md#decisions-locked).
