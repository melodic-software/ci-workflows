# ci-workflows

Reusable, configurable CI **execution** for the melodic-software org: composite
actions that install and run each code-quality tool, plus the runner scripts
they bundle.

Consumed by reference from a consumer job, never copied:

```yaml
jobs:
  markdown:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - uses: melodic-software/ci-workflows/.github/actions/markdown@<sha>
```

A composite action is pulled cross-repo via GitHub's scoped, read-only
installation token (distinct from the caller's repo-scoped `GITHUB_TOKEN`), so
this repo stays private with no PAT, and an action's bundled script is reached
via `$GITHUB_ACTION_PATH` without any checkout of this repo.

## Contract

- **Configurable, not forkable.** Each action exposes typed `inputs` with
  global-standard defaults. Consumers override repo-specific scope (globs,
  paths, tool versions, config location) through inputs — never by editing the
  action.
- **Pin by SHA.** Reference every action at a full commit SHA; Dependabot
  (`github-actions`, weekly) opens bump PRs that are reviewed and merged
  manually.
- **Each consumer aggregates locally.** One action runs one tool inside a
  consumer job. The required-check contract is a single check named `ci-status`,
  produced by a thin gateway job the consumer keeps local so the required-check
  name stays un-nested. The gateway `needs:` the lane jobs and fails if any
  failed or was cancelled; a skipped job is allowed.

## Actions

- `.github/actions/markdown` — markdownlint-cli2 over the repo's markdown.
- `.github/actions/powershell` — PSScriptAnalyzer over the repo's PowerShell,
  via the bundled `Invoke-Pssa.ps1` (per-file subprocess isolation).
- `.github/actions/shellcheck` — ShellCheck over the repo's shell scripts
  (installs a pinned, checksum-verified binary).
- `.github/actions/lychee-offline` — lychee `--offline` link/anchor
  reference-integrity over the repo's docs (deterministic; no network).

Each input's meaning and default is documented inline in the action's `inputs:`
block.

## Reusable workflows

- `.github/workflows/link-check.yml` — online external-link checker, consumed
  via `uses:` at job level from a *scheduled* caller that grants `issues: write`.
  It is **advisory**: external link health is flaky, so it runs `fail: false` and
  files a rolling tracking issue on failure rather than gating a build. (A whole
  scheduled job with issue-creation is a reusable-workflow concern, not a
  composite action; the deterministic on-disk counterpart is the
  `lychee-offline` action above, which feeds `ci-status`.)

## Tool configuration lives elsewhere

These actions execute tools; they do not carry the tools' rulesets. A consumer
supplies its own config file and points the action at it through an input, so
adopting an action never couples the consumer to this repo at runtime beyond the
referenced action itself.
