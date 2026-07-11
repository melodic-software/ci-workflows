# ci-workflows

Reusable, configurable CI **execution** for the melodic-software org: composite
actions that install and run each code-quality tool, plus the runner scripts
they bundle.

Consumed by reference from a consumer job, never copied:

```yaml
jobs:
  markdown:
    runs-on: ubuntu-24.04
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
  via the bundled `Invoke-Pssa.ps1`. Each file is analyzed exactly once and any
  analyzer or rule error fails closed. `PSUseCorrectCasing` remains disabled
  while the upstream [runspace-affinity defect][pssa-1708] is open; retrying a
  crashing rule is not a quality gate.
- `.github/actions/pulumi-deploy-guard` — verifies the complete Pulumi personal
  [OIDC allow-policy][pulumi-oidc] set against a versioned exact-claim contract,
  then [exports stack state][pulumi-stack-export] without plaintext secrets and
  classifies reviewed operational
  resource URNs as existing or first-apply. Both GitHub IaC repositories call
  this one implementation after OIDC authentication and before minting their
  broad GitHub governance token. Contract v2 uses GitHub immutable owner/repo
  IDs and rejects Pulumi's `*`, `?`, and `.` pattern operators. Callers reserve
  its exact workflow name uniquely and require paired live positive/near-match
  negative token-exchange evidence before removing the legacy trust rules.
- `.github/actions/editorconfig` — editorconfig-checker validation of tracked
  files against the repo's `.editorconfig`.
- `.github/actions/typos` — `typos` spell-check over source against a
  caller-supplied config.
- `.github/actions/gitleaks` — gitleaks secret scan over a directory against a
  caller-supplied config (installs a pinned, checksum-verified binary; optional
  SARIF output + PR annotations).
- `.github/actions/actionlint` — actionlint over the repo's GitHub Actions
  workflow files, with the canonical checksum-pinned ShellCheck release
  installed explicitly so embedded shell validation is identical on hosted and
  self-hosted workers.
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
  (TODO/FIXME/HACK/XXX) and tracker references against its bundled organization
  policy, with an optional complete caller replacement.
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

Hosted workflow defaults use explicit GA operating-system generations
(`ubuntu-24.04` and `windows-2025`) instead of moving `*-latest` aliases. This
keeps hosted/self-hosted parity reviews tied to a declared image contract while
GitHub continues the normal weekly patching of each hosted image generation.

- `.github/workflows/pulumi-version-drift-check.yml` — reusable-only maintenance
  job for GitHub IaC callers. It accepts only a hosted default-branch push,
  schedule, or manual dispatch, compares the exact `.pulumi.version` pin with
  Pulumi's current stable release, and maintains one marker-identified auditable
  incident across rename or manual closure without resetting its age. It never
  changes or auto-merges a pin, retires resolved incidents instead of reusing
  them, and hard-fails after 14 days of unresolved drift. The tested canonical
  shell source is generated inline because reusable-workflow checkout resolves
  to the caller repository; an equality test prevents drift and callers never
  copy the implementation. Per-caller concurrency serializes issue mutation.
- `.github/workflows/standards-sync.yml` — orchestrates exact-file distribution
  from the schema-v2 component manifest in `melodic-software/standards`. The
  standards checkout validates and materializes its own manifest; this workflow
  resolves one immutable standards SHA, scopes a GitHub App token to each target,
  and opens a signed, human-reviewed PR enumerating every managed
  source-to-destination mapping. It never writes a downstream receipt and never
  copies components declared `locally-owned`.
- `.github/workflows/select-runner.yml` — the single organization-approved
  hosted/self-hosted selector. It runs on `ubuntu-slim` with a two-minute
  timeout and returns one `runs-on` string. A downstream job has its own runner
  and timeout; the selector's platform limit does not carry into that job.
  Selection is deliberately fail-open to the configured hosted runner. It uses
  a read-only observer GitHub App and chooses local only when an exact-label,
  managed-prefix runner is online, idle, and ephemeral. Full reruns
  (`github.run_attempt > 1`) always route hosted. Public repositories, fork pull
  requests, and Dependabot runs route hosted before the observer-token action
  can execute, following GitHub's [self-hosted runner security guidance][runner-security]
  and [Dependabot secret boundary][dependabot-secrets]. Call it once per
  independently schedulable workload:

  ```yaml
  jobs:
    select-runner:
      uses: melodic-software/ci-workflows/.github/workflows/select-runner.yml@<sha>
      with:
        policy: ${{ vars.CI_RUNNER_POLICY }}
        self-hosted-label: ${{ vars.CI_SELF_HOSTED_LABEL }}
        self-hosted-labels-json: ${{ vars.CI_SELF_HOSTED_LABELS_JSON }}
        hosted-runner: ${{ vars.CI_HOSTED_RUNNER }}
        scope: ${{ vars.CI_RUNNER_SCOPE }}
        managed-runner-prefix: ${{ vars.CI_MANAGED_RUNNER_PREFIX }}
        observer-client-id: ${{ vars.CI_RUNNER_OBSERVER_CLIENT_ID }}
      secrets:
        observer-private-key: ${{ secrets.CI_RUNNER_OBSERVER_PRIVATE_KEY }}

    test:
      needs: select-runner
      runs-on: ${{ needs.select-runner.outputs.runner }}
      steps:
        - run: ./test.sh
  ```

  Never use `secrets: inherit`; pass only the observer key. Stable output reasons
  are `idle`, `hosted-only`, `rerun`, `no-idle-runner`, `missing-config`,
  `missing-secret`, `auth-error`, `api-timeout`, `api-error`, and
  `invalid-response`. The security eligibility guard also reports
  `hosted-only`. `selector-conformance.yml` runs the deterministic selector test
  suite and proves the public, hosted-only, and attempt-2 contracts without
  accessing local capacity. The tested CommonJS source is generated into the
  workflow, so the reusable-workflow SHA pins the implementation without a
  second checkout/ref. This matters because actions inside a called workflow
  otherwise run in the [caller's repository context][reusable-workflow-context].
  A conformance check fails if the executable copy drifts.

  `self-hosted-labels-json` is an optional ordered JSON array of exact labels.
  When present it overrides `self-hosted-label`; malformed, empty, or duplicate
  candidate lists route hosted with `invalid-response`. Candidate priority is
  the array order, independent of runner API order. GitHub's [generic default
  self-hosted labels][default-runner-labels] (`self-hosted`, OS, and architecture
  labels), as well as a candidate equal to the hosted fallback, are rejected;
  returning either as `runs-on` could escape the managed fleet. Organization
  routing normally leaves it unset and uses one shared exact label. The personal
  phase provisions it as operational data so the documented live-proof fallback
  can switch from one shared label to two host-specific exact labels without a
  workflow or selector code change.

  `CI_HOSTED_RUNNER` is operational configuration, but GitHub's runner-inventory
  API cannot prove that an arbitrary label belongs to hosted infrastructure. The
  selector therefore allowlists only the reviewed V1 value `ubuntu-24.04` and
  canonicalizes every missing, malformed, unapproved, generic self-hosted, or
  configured local-candidate value back to it. Introducing another hosted label
  requires an explicit governance and conformance review.

  Inventory is an observation, not a reservation. Several simultaneous
  selectors can observe the same idle runner and select local; that burst can
  queue until capacity appears. Once all matching runners report busy, later
  selectors route hosted with `no-idle-runner`. Validation, authentication,
  API, timeout, malformed-response, and github-script failures produce hosted
  outputs. A failure of the selector job or hosted runner before outputs exist
  cannot be converted by workflow expressions; dependent jobs remain blocked
  and must be rerun. This boundary is intentionally not described as atomic
  fallback.
- `.github/workflows/local-runner-canary.yml` — a reusable-only acceptance
  contract bound to the private `melodic-software/ci-runner-canary` repository.
  It has no executable trigger in this public repository. A hosted preflight
  requires that exact private caller, `workflow_dispatch`, protected `main`, and
  attempt 1 before any job receives the observer key. The immutable reusable
  workflow owns the selector: it calls the already-reviewed central selector at
  a full SHA with the exact `melodic-canary-ubuntu-24.04-x64` label and
  `ci-runner-canary-` name prefix, then consumes only direct `needs` outputs.
  The caller cannot claim a runner, route, reason, idle count, repository, label,
  or prefix.

  Each selected job independently requires `runner.environment` to be
  `self-hosted`, checks the actual `runner.name` against the canary prefix, and
  derives only `melo-desk-001` or `melo-lap-001`. Static executable tests reject
  GitHub-hosted identity, a hosted label presented as a name, and the production
  fleet prefix. The seed and freshness jobs must derive the same host while
  reporting different container IDs and no surviving sentinels across home,
  `_work`, temp, tool cache, `/tmp`, and a privileged path.

  The canonical private-repository seed is under
  `templates/ci-runner-canary/`. Its caller delegates selection to this reusable
  workflow and explicitly passes only
  `CI_RUNNER_OBSERVER_PRIVATE_KEY`; it never inherits secrets. The seed also owns
  `.gitattributes`, a real Git LFS fixture, and a nonsecret cache-key fixture.
  IaC creates the empty selected-access repository; the reviewed seed is then
  pushed as its initial content before the workflow is enabled.

  `full` mode runs the same immutable compatibility probe on explicit
  `ubuntu-24.04` and the selector-returned local worker: Git LFS checkout, exact
  setup actions for .NET, Node.js, and Python, PowerShell, passwordless `sudo`,
  custom certificate trust, and Linux x64 Native AOT. It compares deterministic
  outputs, transfers artifacts in both directions, and restores nonsecret
  hosted-to-self and self-to-hosted caches. GitHub stores self-hosted caches in
  GitHub-owned cloud storage and restored caches are untrusted, so canary caches
  contain only fixed text and run IDs. [GitHub's cache guidance][dependency-cache]
  and [artifact guidance][workflow-artifacts] define those boundaries. The last
  selected job runs for at least 16 minutes after selection, proving the
  selector's separate timeout does not limit downstream work. Native AOT uses
  Microsoft's documented Ubuntu `clang` and zlib prerequisites.
  [Native AOT deployment][native-aot] The hosted and local jobs resolve their
  single shared probe from the exact reusable-workflow repository and SHA via
  GitHub's documented [job workflow context][job-workflow-context].

  Live acceptance is two sequential single-host proofs, not a two-host proof:

  1. Advertise canary capacity only from `melo-desk-001`; verify the laptop
     listener reports capacity zero. Dispatch `full` and record the workflow/job
     IDs, both runner names, their derived desktop host, both container IDs, and
     the controller diagnostic archives proving each completed container was
     deleted.
  2. Drain desktop canary capacity to zero. Advertise canary capacity only from
     `melo-lap-001`, repeat `full`, and correlate the same evidence to the laptop
     controller diagnostics.
  3. Do not infer distribution or high availability from these runs. The
     production two-host failover proof is a separate rollout gate.

  Cancellation is a separate two-dispatch observation on one isolated host.
  Dispatch `cancellation`, record the run, runner, host, container, controller
  job record, and diagnostic archive, then use GitHub's **Cancel workflow**
  control while the probe waits. Verify cancellation and container deletion in
  controller diagnostics. The workflow never calls the cancellation API.
  [Workflow cancellation][workflow-cancellation] Do not rerun that attempt:
  attempt 2 is intentionally hosted. Start a new `full` dispatch and record its
  fresh identities and diagnostics.

  Static gates cannot substitute for assignment, JIT registration, LFS object
  transfer, cache/artifact transport, cancellation delivery, or deletion
  diagnostics. All are required promotion evidence. The daily drift workflow
  monitors the exact .NET, Node.js, and Python patch lines and opens review
  evidence without editing or auto-merging a pin.
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
  `uses:` at job level. It is explicitly hosted because the pinned upstream
  [action][zizmor-action-script] invokes a digest-pinned container through
  Docker, while local workers deliberately receive no Docker socket. SARIF
  upload and blocking promotion are deferred opt-ins. Inputs are documented
  inline.
- `.github/workflows/osv-scanner.yml` — dependency vulnerability scan with
  Google's official OSV-Scanner v2.4.0 action image, invoked directly by an
  exact linux/amd64 OCI manifest digest. One JSON scan feeds the image's
  reporter for GitHub annotations plus a SARIF artifact; the same full scan runs
  on every event. **Advisory** (`fail-on-vuln` off by default). V2.4.0 scans
  supported manifests and lockfiles; .NET `.csproj`/`PackageReference` and
  Central Package Management are enabled by default. A committed
  `packages.lock.json` remains the reproducibility contract enforced by
  `dotnet-build`'s locked-mode restore, but is no longer the only .NET coverage
  path. An empty scan warns (advisory) or fails (blocking) unless the caller
  declares the repo genuinely dependency-less via `allow-no-lockfiles: true`.
  The job remains explicitly hosted because it invokes Docker. Inputs are
  documented inline. See the [official v2.4.0 release][osv-release-v2-4] and
  [action-container build source][osv-action-container-source].

  “Enabled by default” is not treated as proof that every MSBuild layout is
  covered. Each consumer canary must show nonzero package discovery for its
  actual `.csproj`/Central Package Management layout; committed lockfiles and
  the empty-scan guard remain required until that proof passes. The scanner's
  documented exit contract is also enforced: only `0` (clean) and `1`
  (findings) can be completed scans, `128` follows the explicit no-packages
  policy, and every other code warns in advisory mode or fails blocking mode.

  The scanner receives the caller checkout read-only plus one fresh writable
  output directory under the hosted runner's temporary directory. The reporter
  receives only that output, with networking disabled. Neither container gets
  host credentials, GitHub file-command directories, the Docker socket, added
  capabilities, or permission to gain privileges. Host-side policy accepts JSON
  and SARIF only as valid regular, non-symlink files inside that fresh directory;
  error/partial output is neither reported nor uploaded.

  Private consumers record these intentional hosted jobs in their
  `.github/runner-policy.json`; replace the workflow path and job IDs with the
  caller's actual keys:

  ```json
  {
    "exceptions": {
      ".github/workflows/ci.yml#zizmor": {
        "reason": "docker-socket",
        "justification": "The pinned zizmor action invokes Docker; local workers expose no Docker socket."
      },
      ".github/workflows/ci.yml#osv-scanner": {
        "reason": "docker-socket",
        "justification": "The official OSV image is invoked by exact OCI digest through Docker; local workers expose no Docker socket."
      }
    }
  }
  ```

  The reviewed pin is machine-readable in `.github/osv-scanner-pin.json` and the
  workflow verifies the pulled image's version and source-revision labels before
  scanning. Deployment never references a mutable tag. The daily
  `tool-version-drift-check` compares both Google's latest stable release and
  its current action-image manifest digest, then opens or refreshes the existing
  maintenance issue; it never rewrites or auto-merges the pin. Updating requires
  release review, exact linux/amd64 platform-digest resolution, label/platform
  verification, and a canary. GitHub documents that pulling by digest selects
  the same immutable container image [across pulls][github-container-digest].
  Google publishes SLSA provenance for the standalone scanner binaries, but the
  prebuilt reporter is experimental and available only in the action image; the
  digest-pinned image is the reviewed parity choice for one scan plus annotations
  and SARIF. Revisit the binary path if Google publishes an equally supported,
  provenance-verifiable reporter. See the [official installation and SLSA
  guidance][osv-installation].
  The `semantic-pr` workflow remains selectable through its backward-compatible
  `runner` input; these two Docker-dependent workflows do not expose one.
- `.github/workflows/dependabot-lock-regen.yml` — regenerates NuGet
  `packages.lock.json` on Dependabot PRs (`dotnet restore --force-evaluate`)
  and pushes the result back to the PR branch, covering the lock-file updates
  Dependabot's NuGet ecosystem misses. Self-guards to `dependabot[bot]` events
  on `dependabot/nuget/` branches, so the caller is a thin unconditional
  `pull_request` job granting `contents: write`. Inputs, the optional
  `PUSH_TOKEN` Dependabot secret, and the default-token no-retrigger caveat are
  documented inline.
- `.github/workflows/pester.yml` — runs a Pester suite on the fixed
  GitHub-hosted Windows 2025 runner with a pinned Pester install. A whole-job
  concern (its own runner OS + checkout), so a reusable workflow: the caller
  passes a `run` command and owns discovery/reporting/exit; this supplies the
  hosted runner, pinned Pester, and checkout. Inputs are documented inline.
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
  inline. Consume it from a thin caller that triggers on title-relevant events.
  **Adopt the canonical block below** (not the in-repo `.github/workflows/pr-title.yml`,
  which intentionally still triggers on `pull_request` — see the note after the
  block). Note the emitted check context is `<caller job> / <reusable job>` — with
  the caller below it is **`pr-title / pr-title`** (the name a ruleset must
  require, not bare `pr-title`):

  ```yaml
  on:
    pull_request_target:
      types: [opened, edited, reopened, synchronize]
    merge_group:
  permissions:
    pull-requests: read
  concurrency:
    group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
    cancel-in-progress: true
  jobs:
    pr-title:
      permissions:
        pull-requests: read
      uses: melodic-software/ci-workflows/.github/workflows/semantic-pr.yml@<sha>
  ```

  This block is the canonical pattern to copy. The in-repo
  `.github/workflows/pr-title.yml` dogfood caller deliberately stays on
  `pull_request` for now: this repo is already gated on its own `pr-title / pr-title`
  check, so a PR that flips that caller to `pull_request_target` would have the
  required check run the base-branch (still-`pull_request`) definition and block
  the flip. The self-flip is therefore deferred; consumers should follow this
  documented block rather than copying the dogfood file.

  `pull_request_target` runs the base-branch definition, so a head-branch edit to
  this file cannot bypass the gate (safe here because semantic-pr reads PR title
  metadata only — it checks out and runs no head code). Under
  `pull_request_target` `github.ref` is the base branch, so the concurrency group
  keys on `github.event.pull_request.number` (falling back to `github.ref` for
  `merge_group`) — a `github.ref` key would collapse all PRs into one group and
  let one PR's run cancel another's required check. `edited` is required so
  re-titling re-validates. `merge_group` is required on
  any repo with a merge queue — the queue gates on `pr-title / pr-title`, and
  without it that required check never reports and the queue deadlocks
  (semantic-pr passes on `merge_group` since the title was validated at PR time);
  it is inert where no queue exists. Then require the
  `pr-title / pr-title` check in the repo's ruleset (governed via `github-iac`) —
  but only **after** the caller is merged and emitting the check, or open PRs
  block on a check that never runs.

## Policy ownership and action inputs

Reusable rulesets are authored in
[`melodic-software/standards`](https://github.com/melodic-software/standards).
Consumers receive them through a tool-native package/reference or as managed
files at the tool's normal root path. Config-driven actions default to those
root paths and fail clearly when a required file is absent; an explicit input
can select a repository-owned config where the tool supports customization.

Comment hygiene is the intentional CI-only exception: its default policy ships
inside the action and is resolved through `$GITHUB_ACTION_PATH`, so consumers do
not need another repository file. `patterns-file` accepts a complete replacement
for repositories with a genuinely different policy. The small configs under
`fixtures/` exist only to exercise action contracts; they are not mirrors of the
standards catalog.

[dependabot-secrets]: https://docs.github.com/en/code-security/dependabot/troubleshooting-dependabot/troubleshooting-dependabot-on-github-actions#restrictions-when-dependabot-triggers-events
[default-runner-labels]: https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow#using-default-labels-to-route-jobs
[github-container-digest]: https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pulling-container-images
[dependency-cache]: https://docs.github.com/en/actions/concepts/workflows-and-actions/dependency-caching
[job-workflow-context]: https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context
[native-aot]: https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/
[osv-action-container-source]: https://github.com/google/osv-scanner/blob/b56b5191101d5f27d4787d5583d8d01e9518a7af/goreleaser-action.dockerfile
[osv-installation]: https://google.github.io/osv-scanner/installation/
[osv-release-v2-4]: https://github.com/google/osv-scanner/releases/tag/v2.4.0
[pssa-1708]: https://github.com/PowerShell/PSScriptAnalyzer/issues/1708
[pulumi-oidc]: https://www.pulumi.com/docs/administration/access-identity/oidc-issuers/
[pulumi-stack-export]: https://www.pulumi.com/docs/iac/cli/commands/pulumi_stack_export/
[runner-security]: https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners
[reusable-workflow-context]: https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations#reusable-workflows
[workflow-artifacts]: https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts
[workflow-cancellation]: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/cancel-a-workflow-run
[zizmor-action-script]: https://github.com/zizmorcore/zizmor-action/blob/192e21d79ab29983730a13d1382995c2307fbcaa/action.sh
