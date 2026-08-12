# ADR — CI fan-out consolidation (#122)

Status: accepted for Shape A; remaining slices deferred under `needs-human`

Parent: [melodic-software/github-iac#78](https://github.com/melodic-software/github-iac/issues/78)
Issue: [melodic-software/ci-workflows#122](https://github.com/melodic-software/ci-workflows/issues/122)

## Context

The 2026-07-16 capacity incident showed per-run micro-job fan-out burning
worker slots on spin-up. Target shape (issue body): one selector (Shape A),
consolidated lanes, unchanged `ci-status` fan-in, and main-push burst
collapse. A later placement-lane note revised the empirical per-job overhead
to ~3.4s and narrowed the durable case once capacity supply is fixed
([ci-runner#49](https://github.com/melodic-software/ci-runner/issues/49)).

## Decisions locked

1. **Shape A (single selector) is done for the first consumer.**
   `melodic-software/dotfiles` `main` `.github/workflows/ci.yml` has one
   `select-runner` job; every lane `needs: select-runner` and consumes
   `needs.select-runner.outputs.runner`. Medley / claude-code-plugins already
   shipped Shape A earlier. Item 1 of the issue body is closed.
2. **Consolidation primitive is composite actions, not reusable workflows.**
   A called reusable workflow is a separate job and pays full spin-up. Composites
   run as steps in the caller's job (no `secrets:` — re-plumb as inputs/env).
   The body's earlier "reusable workflow/template changes here" sequencing is
   superseded by this rule.
3. **`ci-status` remains the single required check.** Keep lane skips as
   in-workflow `if:` conditionals; never workflow-level `paths:` on required
   workflows.
4. **This repo's `ci.yml` keeps per-action dogfood jobs for now.**
   `.github/workflows/ci.yml` is the first consumer of each composite under
   `.github/actions/*`. Collapsing those micro-jobs into a hygiene lane would
   hide per-action failure granularity that dogfood depends on. Consumer lane
   consolidation is the valuable fan-out cut; local dogfood collapse is a
   later, separate judgment call — not this slice.

## Explicit non-goals for this slice

- No collapse of `ruff`/`pyright`, `biome`/`tsc`, `shellcheck`/`shfmt`,
  `dotnet-build`/`dotnet-format`, or the unconditional hygiene jobs in this
  repo's `ci.yml`.
- No main-push concurrency rewrite here. Issue body item 5
  (`group: <workflow>-${{ github.ref }}`, `cancel-in-progress: false`)
  conflicts with the canonical PR-safe block closed in
  [standards#151](https://github.com/melodic-software/standards/issues/151)
  (`pull_request.number || run_id`, `cancel-in-progress: true`), which this
  repo's `ci.yml` already follows. Choosing burst collapse vs that canonical
  block needs a human ruling under the issue's `needs-human` label.
- No reliance on parallel steps (`background` / `wait`) until fleet-tested.
- No 2 CPU / 4GiB lane sizing until
  [provisioning#133](https://github.com/melodic-software/provisioning/issues/133)
  / [#134](https://github.com/melodic-software/provisioning/issues/134) land.

## Ordered follow-up PRs

| Order | PR | Repo | What | Gate |
| --- | --- | --- | --- | --- |
| 1 | Human: priority / concurrency ruling | ci-workflows#122 | Decide whether residual hosted-minute + starvation case still justifies medium+ effort; pick main-push burst collapse vs standards#151 canonical | `needs-human` |
| 2 | Dotfiles hygiene lane | `melodic-software/dotfiles` | Collapse lint/hygiene micro-jobs into one worker: `continue-on-error: true` + step `id:` + final aggregation on `steps.<id>.outcome == 'failure'`; keep language/build lanes only where toolchain isolation differs; keep Shape A selector + `ci-status` | After (1) |
| 3 | Dotfiles main-push concurrency (if (1) chooses burst collapse) | `melodic-software/dotfiles` | Apply the chosen concurrency block; do not invent a third pattern | After (1)+(2) or with (2) |
| 4 | Optional ci-workflows dogfood pilot | `melodic-software/ci-workflows` | If (1) wants a reusable pattern proven here first: collapse one same-filter pair only (e.g. `shellcheck`+`shfmt` or `ruff`+`pyright`) behind `continue-on-error` aggregation, update `ci-status` `needs`, add a contract test — still not a full hygiene mega-lane | Optional; after (1) |
| 5 | Standards fixtures lane | `melodic-software/standards` | Fold fixture matrix cells into an in-job fixtures lane (each matrix cell is a separate job) | After (2) proves the pattern |
| 6 | Medley lane pass | `melodic-software/medley` | Medley already has detect-changes + most lanes; consolidate last. Also absorb comment-2 concurrency defects (`ci-status.yml` / `onboard-drift.yml` / `comment-review-gate.yml`) per standards#151 | After (5) |

## Consequences

- Shape A checklist item is recorded as complete in-repo; #122 stays open for
  lane consolidation and concurrency follow-through.
- No consumer behavior change from this ADR alone.
- Next autonomous coding slice should be PR (2) or optional (4) only after a
  human clears (1); until then prefer plan comments over structural `ci.yml`
  edits.
