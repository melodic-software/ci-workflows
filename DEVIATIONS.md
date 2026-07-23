# Deviations — issue #221 (tracking-issue author restriction)

## Scope expansion: third workflow hardened via the owning source

**Planned (original brief):** two workflows — `link-check.yml` and
`queue-monitor-liveness.yml`.

**Done:** three workflows — the two above plus
`.github/workflows/tool-version-drift-check.yml`.

**Why:** `queue-monitor-liveness.yml`'s adoption logic is a generated block
sourced from the shared `.github/scripts/find-tracking-issue.sh`. That script
has a second consumer, `tool-version-drift-check.yml`
(`render-find-tracking-issue.cjs` `workflowFiles` and the
`find-tracking-issue-render.test.cjs` `consumers` list both name it). Adding the
fail-closed author filter at the owning source (the brief's explicit "change at
the owning source" directive) requires a new required env var
`ISSUE_AUTHOR_LOGIN` and re-renders every consumer's embedded block; the render
`--check` test fails if any consumer drifts. So a green shared-source change is
impossible without also touching `tool-version-drift-check.yml`. It carries the
identical `github-actions[bot]` marker/title adoption hole, so hardening it is
inside the ratified pattern-port intent.

**Decision:** escalated to the orchestrator as a blocking scope question with a
RECOMMENDED option; Option 1 (expand scope) approved. The alternative
(re-implementing the filter in `queue-monitor-liveness.yml`'s per-workflow
prefetch line to avoid the shared source) was rejected for fragmenting the
fail-closed invariant out of its owning source.

**Blast radius:** `tool-version-drift-check.yml` receives exactly one
`ISSUE_AUTHOR_LOGIN` env line plus the regenerated tracking-issue block (verified
by `git diff`: nothing changed beyond the generated markers and that env line).
No `uses:` SHA pins, tool-version/checksum defaults, or any other logic touched.
The workflow is advisory (never a ci-status gate). Its issues are authored by the
ambient `GITHUB_TOKEN` (`github-actions[bot]`, type Bot), so the new required env
value matches its real author identity.
