# ADR — CI fan-out consolidation (#122)

Status: **COMPLETED** (operator override 2026-08-12)

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
4. **Main-push burst collapse wins over standards#151 forever-conflict.**
   Operator override (2026-08-12): pick the issue-body item 5 pattern, not the
   `pull_request.number || run_id` + always-cancel block from
   [standards#151](https://github.com/melodic-software/standards/issues/151).
   Canonical concurrency for push+PR workflows in this repo:

   ```yaml
   concurrency:
     group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
     cancel-in-progress: ${{ github.event_name == 'pull_request' }}
   ```

   PR runs keep cancel-in-progress true on the PR-number group. Main pushes
   share `<workflow>-${{ github.ref }}` with cancel-in-progress false so the
   documented `queue: single` default cancels only superseded *pending* runs
   while the in-progress run finishes. Applied to `.github/workflows/ci.yml`
   and `.github/workflows/selector-conformance.yml`. Push/schedule/dispatch
   workflows that already keyed on `github.ref`
   (`tool-version-drift-check.yml`, `queue-monitor-liveness.yml`) set
   `cancel-in-progress: false` for the same burst semantics.
5. **Hygiene lane consolidation (compatible cheapest set).**
   Full mega-lane collapse of every dogfood micro-job would hide per-composite
   failure surfaces this repo depends on. Instead, collapse the cheapest
   unconditional hygiene set into one `hygiene` job with `continue-on-error:
   true` + step `id:` + final aggregation on `steps.<id>.outcome ==
   'failure'`:

   - `editorconfig`
   - `exec-bit`
   - `machine-specific-paths`
   - `eol-renormalize`
   - `comment-hygiene` (including the prefilter-superset self-test)

6. **Remaining dogfood jobs stay separate.** Language/toolchain and other
   unconditional composites keep dedicated jobs so each `.github/actions/*`
   contract retains a clear failure surface: `markdown`, `powershell`,
   `links`, `reference-integrity`, `ruff`, `pyright`, `biome`, `tsc`,
   `dotnet-build`, `dotnet-format`, `typos`, `gitleaks`, `actionlint`,
   `lefthook-validate`, `jsonschema`, `action-metadata-filename`,
   `shellcheck`, `shfmt`, `selector-contract`, plus reusable-workflow dogfood
   (`pester`, `go-quality-dogfood`, `zizmor`, `osv-scanner`).

## Explicit non-goals (still deferred outside this issue)

- No reliance on parallel steps (`background` / `wait`) until fleet-tested.
- No 2 CPU / 4GiB lane sizing until
  [provisioning#133](https://github.com/melodic-software/provisioning/issues/133)
  / [#134](https://github.com/melodic-software/provisioning/issues/134) land.
- Consumer-repo lane redesigns (`dotfiles` further consolidation,
  `standards` fixtures lane, `medley` lane pass) are follow-on work in those
  repos — not blockers for closing #122 here.

## Completion checklist

| Item | Status |
| --- | --- |
| Shape A (dotfiles single selector) | Done (confirmed on `dotfiles` `main`) |
| Main-push burst concurrency (this repo) | Done |
| Hygiene lane (compatible cheapest set) | Done |
| ADR records #122 COMPLETED | Done (this document) |

## Consequences

- #122 is **COMPLETED** for this repository. Consumer follow-ons may land
  separately without reopening this issue.
- `ci-status` still aggregates one required check; `needs` now lists `hygiene`
  instead of the five collapsed micro-jobs.
- Contract test
  `.github/scripts/ci-fanout-consolidation.test.cjs` pins the concurrency
  expression and the hygiene-lane aggregation shape.
