# ci-workflows

Reusable, configurable CI **execution** for the melodic-software org: the
workflows that install and run each code-quality tool, plus the runner scripts
they call.

Consumed by reference, never copied:

```yaml
jobs:
  markdown:
    uses: melodic-software/ci-workflows/.github/workflows/markdown.yml@<sha>
```

## Contract

- **Configurable, not forkable.** Each reusable workflow exposes typed `inputs`
  with global-standard defaults. Consumers override repo-specific scope (globs,
  paths, tool versions, config location) through inputs — never by editing the
  workflow.
- **Pin by SHA.** Reference every reusable workflow at a full commit SHA;
  Dependabot (`github-actions`, weekly) opens bump PRs that are reviewed and
  merged manually.
- **Each consumer aggregates locally.** A reusable workflow runs one tool. The
  required-check contract is a single check named `ci-status`, produced by a
  thin gateway job the consumer keeps local so the required-check name stays
  un-nested. The gateway `needs:` the called jobs and fails if any failed or was
  cancelled; a skipped job is allowed.

## Workflows

- `markdown.yml` — markdownlint-cli2 over the repo's markdown.
- `powershell.yml` — PSScriptAnalyzer over the repo's PowerShell, via
  `scripts/Invoke-Pssa.ps1` (per-file subprocess isolation).

Each input's meaning and default is documented inline in the workflow's
`inputs:` block.

## Tool configuration lives elsewhere

These workflows execute tools; they do not carry the tools' rulesets. A consumer
supplies its own config file and points the workflow at it through an input, so
adopting a workflow never couples the consumer to this repo at runtime beyond
the referenced workflow itself.
