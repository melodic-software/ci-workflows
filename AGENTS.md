## Code Review Rules

Each line names a rule CI does not enforce. A line with a link points at the file that states the
rule in full; a line without one states the whole rule itself.

- Org-wide criteria: [`REVIEW.md`](REVIEW.md), synced from `melodic-software/standards`.
- Claude lane security model (`SECURITY MODEL` headers):
  [`pr-review.yml`](.github/workflows/pr-review.yml) and
  [`pr-review-security.yml`](.github/workflows/pr-review-security.yml).
- Claude lane checks stay advisory: [rule](README.md#claude-lanes--shared-consumption-contract).
- Configurable, not forkable: [rule](README.md#contract).
- Policy is authored in standards; `fixtures/` configs only exercise contracts:
  [rule](README.md#policy-ownership-and-action-inputs).
- Local-lane guard wrappers keep parity with the standards component.
- Lanes consolidate as composite actions; `ci-status` stays the single required check.
