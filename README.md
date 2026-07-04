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

This repo is public, so its actions and reusable workflows are consumable by any
repository — public or private, in or out of the org — with no access
configuration and no PAT. The runner fetches the referenced action directly, and
an action's bundled script is reached via `$GITHUB_ACTION_PATH` without any
checkout of this repo. (Public is required because a public consumer such as
`melodic-software/claude-code-plugins` can only `uses:` public repos.)

## Contract

- **Configurable, not forkable.** Each action exposes typed `inputs` with
  global-standard defaults. Consumers override repo-specific scope (globs,
  paths, tool versions, config location) through inputs — never by editing the
  action.
- **Pin by SHA.** Reference every action at a full commit SHA; Dependabot
  (`github-actions`, weekly) opens bump PRs that are reviewed and merged
  manually. Dependabot updates only `uses:` SHAs — the tool versions pinned in
  each action's `version:`/`analyzer-version:` input default (and the
  checksum-verified install URLs) have no package manifest it can track, so the
  scheduled `tool-version-drift-check` workflow watches upstream releases and
  files an advisory issue when a default falls behind.
- **Each consumer aggregates locally.** One action runs one tool inside a
  consumer job. The required-check contract is a single check named `ci-status`,
  produced by a thin gateway job the consumer keeps local so the required-check
  name stays un-nested. The gateway `needs:` the lane jobs and fails if any
  failed or was cancelled; a skipped job is allowed.

## Actions

- `.github/actions/markdown` — markdownlint-cli2 over the repo's markdown.
- `.github/actions/shellcheck` — ShellCheck over the repo's shell scripts
  (installs a pinned, checksum-verified binary).
- `.github/actions/shfmt` — shfmt formatting check over the repo's shell
  scripts, driven by the caller's `.editorconfig` (installs a pinned,
  checksum-verified binary).
- `.github/actions/powershell` — PSScriptAnalyzer over the repo's PowerShell,
  via the bundled `Invoke-Pssa.ps1` (per-file subprocess isolation).
- `.github/actions/editorconfig` — editorconfig-checker validation of tracked
  files against the repo's `.editorconfig`.
- `.github/actions/typos` — `typos` spell-check over source against a
  caller-supplied config.
- `.github/actions/gitleaks` — gitleaks secret scan over a directory against a
  caller-supplied config (installs a pinned, checksum-verified binary; optional
  SARIF output + PR annotations).
- `.github/actions/actionlint` — actionlint over the repo's GitHub Actions
  workflow files.
- `.github/actions/check-jsonschema` — check-jsonschema validation of JSON/YAML
  against one schema per call (call once per schema group).
- `.github/actions/lychee-offline` — lychee `--offline` link/anchor
  reference-integrity over the repo's docs (deterministic; no network).
- `.github/actions/reference-integrity` — resolves `file.md` "Anchor" prose
  citations against each cited file's headings and bold lead-ins (dependency-free
  awk); pairs with `lychee-offline`, which covers link/fragment targets.
- `.github/actions/exec-bit` — verifies every tracked shebang file carries git
  index mode 100755, so executable scripts keep their bit on checkout.
- `.github/actions/machine-specific-paths` — rejects machine-specific absolute /
  user-home paths in tracked files (portable placeholders allowed).
- `.github/actions/comment-hygiene` — scans comments for deferred-work markers
  (TODO/FIXME/HACK/XXX) and tracker references against a caller-supplied policy.
- `.github/actions/eol-renormalize` — detects index-level line-ending drift via
  git's clean filter, driven by the caller's `.gitattributes` (read-only).
- `.github/actions/ruff` — Ruff lint + format-check over the repo's Python
  (via `uvx`; emits `--output-format=github` annotations).
- `.github/actions/pyright` — Pyright strict, warnings-as-errors type-check over
  the repo's Python (via `uvx`).
- `.github/actions/biome` — Biome lint + format-check over the repo's JS/TS
  (via `npx`; `biome ci --error-on-warnings`, emits `--reporter=github`
  annotations).
- `.github/actions/tsc` — TypeScript `tsc --noEmit` type-check over the repo's
  TypeScript (via `npx`).
- `.github/actions/dotnet-build` — builds .NET projects with Roslyn analyzers and
  code-style enforced as warnings-as-errors (the analysis owner: code-quality
  `CAxxxx`, code-style `IDExxxx`, nullable, and compiler warnings). Restores in
  NuGet locked mode by default: a committed `packages.lock.json` that drifted
  from the project dependencies fails with `NU1004` instead of silently
  re-resolving (a no-op for repos without lock-file usage).
- `.github/actions/dotnet-format` — verifies the C# formatting the build does not
  own: whitespace/layout via `dotnet format whitespace --verify-no-changes`, and
  using-directive organization via `dotnet format style --diagnostics IDE0055
  --verify-no-changes` (the build-time analyzers own code-style and code-quality,
  so none of the three lanes double-report).

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
- `.github/workflows/zizmor.yml` — GitHub Actions security/static-analysis lint
  with zizmor (dangerous triggers, excessive permissions, template injection).
  **Advisory** (surfaces PR annotations, never gates `ci-status`); consumed via
  `uses:` at job level. SARIF upload and blocking promotion are deferred opt-ins.
  Inputs are documented inline.
- `.github/workflows/osv-scanner.yml` — dependency vulnerability scan with
  OSV-Scanner (composes Google's SHA-pinned scanner + reporter sub-actions;
  the same full scan runs on every event). **Advisory** (`fail-on-vuln` off by
  default). OSV-Scanner reads lockfiles only — a .NET repo gets transitive
  coverage exactly when it commits `packages.lock.json` (the standards .NET
  overlay's `RestorePackagesWithLockFile`, kept honest by `dotnet-build`'s
  locked-mode restore). An empty scan therefore warns (advisory) or fails
  (blocking) unless the caller declares the repo genuinely dependency-less via
  `allow-no-lockfiles: true`. Inputs are documented inline.
- `.github/workflows/dependabot-lock-regen.yml` — regenerates NuGet
  `packages.lock.json` on Dependabot PRs (`dotnet restore --force-evaluate`)
  and pushes the result back to the PR branch, covering the lock-file updates
  Dependabot's NuGet ecosystem misses. Self-guards to `dependabot[bot]` events
  on `dependabot/nuget/` branches, so the caller is a thin unconditional
  `pull_request` job granting `contents: write`. Inputs, the optional
  `PUSH_TOKEN` Dependabot secret, and the default-token no-retrigger caveat are
  documented inline.
- `.github/workflows/pester.yml` — runs a Pester suite on a dedicated runner
  (Windows by default) with a pinned Pester install. A whole-job concern (its own
  runner OS + checkout), so a reusable workflow: the caller passes a `run` command
  and owns discovery/reporting/exit; this supplies the runner, pinned Pester, and
  checkout. Inputs are documented inline.
- `.github/workflows/claude-review.yml` — automated PR code review with
  `anthropics/claude-code-action`. **Advisory** (posts review comments, never
  gates `ci-status`). A whole-job concern (job permissions + a secrets
  interface), so a reusable workflow. The caller owns the triggers and the
  permission grant; this workflow owns the SHA-pinned action and the safe
  handling. Inputs (`prompt`, `claude-args`, `track-progress`, `display-report`,
  `allowed-bots`, `exclude-comments-by-actor`, `skip-actors`, `timeout-minutes`)
  have public-safe defaults documented inline. Consume it from a `pull_request`
  caller:

  ```yaml
  on:
    pull_request:
      types: [opened, synchronize, ready_for_review, reopened]
  jobs:
    review:
      permissions:
        contents: read
        pull-requests: write
        id-token: write
      uses: melodic-software/ci-workflows/.github/workflows/claude-review.yml@<sha>
      secrets:
        CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
  ```

  The caller's job must grant those three permissions (a called workflow can only
  downgrade, not elevate) and the consumer repo must be in the
  `CLAUDE_CODE_OAUTH_TOKEN` org secret's selected scope. Pass that one named
  secret explicitly (above) rather than `secrets: inherit`, which forwards every
  parent secret. Fork PRs receive no
  secrets by design and are not reviewed. Security rules live in
  [CLAUDE.md](CLAUDE.md).
- `.github/workflows/semantic-pr.yml` — validates the PR **title** against the
  Conventional Commits spec (wraps the SHA-pinned
  `amannn/action-semantic-pull-request`). **Gating**: a non-conforming title
  fails the job. Because governed repos squash-merge with the squash title set to
  `PR_TITLE`, the PR title becomes the default-branch subject line, so this is the
  single lever that yields a Conventional-Commits history (no commit-msg hook
  needed). It is a **standalone required check named `pr-title`**, not a
  `ci-status` lane — title edits must not re-run the file-lint lanes. Inputs
  (`types`, `scopes`, `require-scope`, `subject-pattern`, `subject-pattern-error`,
  `validate-single-commit`, `ignore-labels`) have spec-aligned defaults documented
  inline. Consume it from a thin caller that triggers on title-relevant events
  (the `pr-title.yml` in this repo is the reference dogfood). Note the emitted
  check context is `<caller job> / <reusable job>` — with the caller below it is
  **`pr-title / pr-title`** (the name a ruleset must require, not bare
  `pr-title`):

  ```yaml
  on:
    pull_request:
      types: [opened, edited, reopened, synchronize]
    merge_group:
  permissions:
    pull-requests: read
  jobs:
    pr-title:
      permissions:
        pull-requests: read
      uses: melodic-software/ci-workflows/.github/workflows/semantic-pr.yml@<sha>
  ```

  `edited` is required so re-titling re-validates. `merge_group` is required on
  any repo with a merge queue — the queue gates on `pr-title / pr-title`, and
  without it that required check never reports and the queue deadlocks
  (semantic-pr passes on `merge_group` since the title was validated at PR time);
  it is inert where no queue exists. Then require the
  `pr-title / pr-title` check in the repo's ruleset (governed via `github-iac`) —
  but only **after** the caller is merged and emitting the check, or open PRs
  block on a check that never runs.

## Tool configuration lives elsewhere

These actions execute tools; they do not carry the tools' rulesets. A consumer
supplies its own config file and points the action at it through an input, so
adopting an action never couples the consumer to this repo at runtime beyond the
referenced action itself.
