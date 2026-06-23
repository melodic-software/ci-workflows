# CI de-duplication program

Working folder for the multi-phase effort to make `ci-workflows` the single
de-duplication layer for CI **execution** across the melodic-software
constellation: lift duplicated CI logic out of consumer repos into configurable,
composable units here, then have every repo reference and customize them.

This folder is the durable plan-of-record. It spans phases and sessions; treat
it as the working source of truth and keep it current as work lands.

## Goal

Any CI logic that would otherwise be copy-duplicated across repos becomes a
granular, configurable building block in this repo — exposed through typed
inputs with best-practice defaults — and consumers reference it (pinned by SHA)
and override repo-specific scope through inputs instead of carrying their own
copy. Behavior is preserved: lift-and-shift as-is first, then backfill any
capability a consumer needs so it can switch over without losing coverage.

Config (tool rulesets) is out of scope here — it lives upstream in `standards`
and is adopted by copy. This program is about the *execution* side only.

## Documents

- [inventory.md](inventory.md) — current-state audit of every CI lane across the
  constellation, with a classification of what to lift.
- [architecture.md](architecture.md) — the design decisions (composite action
  vs reusable workflow, granularity, input design, pinning, cross-repo private
  consumption), each backed by cited research.
- [plan.md](plan.md) — the phased roadmap: sequencing, per-phase exit criteria,
  and progress checklists.

## How we work this program

- **Research-driven per item.** Before building or bumping any tool lane, verify
  against official, authoritative, and trusted sources that the tool, version,
  and usage are current and correct. Capture findings in this folder (per-tool
  notes added under a `research/` subfolder as phases proceed). Never rely on
  training data alone; flag anything unverified.
- **Lift-and-shift, then backfill.** First reproduce the consumer's existing
  behavior in a new building block; then add the optional inputs needed to cover
  any extra behavior the consumer had, so the cutover is lossless.
- **One concern per change.** Each new building block (and each consumer
  cutover) is its own PR, dogfooded in this repo's `ci.yml` and pinned by SHA
  downstream.
- **Open-closed.** Extend only by adding optional, behavior-preserving-default
  inputs so advancing a pinned SHA never breaks an existing call.

## Status

Phase 0 (inventory, architecture, plan) — in progress. See [plan.md](plan.md)
for the live phase status.

## Watch-items

- **Visibility / forkability.** All constellation repos are currently private and
  in-org, so cross-repo `uses:` works via the scoped installation token. If any
  consumer goes public or is forked outside the org, references to private
  `ci-workflows` break — at that point this repo must go public or be vendored.
  Re-evaluate the reference model if visibility changes.
- **Provider access setting.** `ci-workflows` must keep its Actions access set to
  "accessible from repositories in the organization" for consumers to reference
  it; verify this is set and stays set.
