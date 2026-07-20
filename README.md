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
  (installs a pinned, checksum-verified binary). Its default discovery remains
  tracked `*.sh`/`*.bash`; `extra-globs` adds tracked extensionless inputs as
  newline-delimited Git pathspecs, with optional `extra-exclude-codes` scoped
  only to that extra lane so ordinary scripts keep the stricter result.
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
- `.github/actions/gitleaks` — gitleaks secret scan over a directory or local
  Git history against a caller-supplied config. Git mode requires a valid,
  non-shallow local worktree or repository and explicitly scans commits
  reachable from `HEAD` and every locally present ref under `refs/` (`--all`),
  including refs the remote advertised and the caller fetched into the checkout.
  Callers must use `fetch-depth: 0` for advertised branch and tag history and
  fetch every other intended ref because hidden, unadvertised, or unfetched
  remote refs are absent locally and cannot be scanned. The action installs a
  pinned, checksum-verified binary,
  unconditionally redacts secret values, validates requested reports, and fails
  closed on missing, malformed, or operationally incomplete results.
- `.github/actions/actionlint` — actionlint over the repo's GitHub Actions
  workflow files, with the canonical checksum-pinned ShellCheck release
  installed explicitly so embedded shell validation is identical on hosted and
  self-hosted workers.
- `.github/actions/lefthook-validate` — installs a checksum-pinned Lefthook
  binary and runs its official
  [`validate` command][lefthook-validate] against the caller's fully loaded
  config. Native discovery is the default; `config-file` selects an explicit
  main config through Lefthook's documented [`LEFTHOOK_CONFIG` override][lefthook-config].
  [`extends` fragments][lefthook-extends], remotes, and the matching local config
  are still loaded. The version and checksum inputs let a caller align the gate
  with an older consumer pin when necessary. This is a composed schema/load
  gate; Lefthook does not define it as a command or glob behavior test.
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
  resolves one immutable standards SHA, then blocks every write lane until a
  separate metadata-only credential proves the expected App identity, active
  selected-repository installation metadata, and two consecutive exact views of
  the full unfiltered manifest's repository set. A caller's `targets` filter
  limits materialization only; it never weakens this installation-scope
  attestation. After that barrier, the workflow scopes a different GitHub App
  token to each target and opens a signed, human-reviewed PR enumerating every
  managed source-to-destination mapping. It never writes a downstream receipt
  and never copies components declared `locally-owned`; the owner-scoped
  attestation token is never passed to checkout or PR mutation.
- `.github/workflows/select-runner.yml` — the single organization-approved
  hosted/self-hosted selector. With `self-hosted-only`, the selector itself
  queues on the always-on default `melodic-ubuntu-24.04-x64` route so it never
  spends hosted minutes before returning the caller's admitted managed label —
  the default tier or the capped review tier — and never runs its own selection
  on the review tier's small capacity. The
  `prefer-self-hosted` and `hosted-only` selector paths run on the standard
  `ubuntu-24.04` hosted runner (free on public repos, quota-covered on private)
  so their adaptive and explicit hosted semantics remain available. Every selector
  path has a two-minute timeout and returns one `runs-on` string. A downstream
  job has its own runner and timeout; the selector's platform limit does not
  carry into that job.
  `prefer-self-hosted` is deliberately fail-open to the configured hosted
  runner. It uses a read-only observer GitHub App and chooses local when a
  governed scale-set route has a managed-prefix runner that is online and not
  explicitly reported as non-ephemeral, regardless of busy state: liveness, not
  idleness. GitHub natively [queues a job until a matching runner is
  available][runner-routing], failing it only after 24 hours queued, so a busy
  fleet absorbs bursts without spending hosted minutes; only a fully offline
  fleet falls back to the hosted route. Re-running failed jobs reuses the
  prior attempt's successful selector output; re-running all jobs makes a
  fresh liveness decision. Neither forces the hosted route.
  `self-hosted-only` instead returns the configured exact managed
  label without inventory or observer credentials, so a
  trusted private workload queues until governed capacity is available. The
  queue-only label must be one of the centrally allowlisted routes — the default
  `melodic-ubuntu-24.04-x64` tier or the capped `melodic-review-ubuntu-24.04-x64`
  review tier; adding another route requires a reviewed
  immutable selector revision. Invalid queue-only configuration and selector
  infrastructure faults fail the selector job instead of falling back to paid
  hosted execution. Public
  repositories and fork pull requests — on `pull_request` and
  `pull_request_target` alike — route hosted before the observer-token
  action can execute, following GitHub's
  [self-hosted runner security guidance][runner-security]. Same-repository
  `pull_request_target` and `merge_group` runs are reviewed local event
  classes: `pull_request_target` executes only the trusted base-branch
  definition, and a merge group can be enqueued only by a write-access user
  after required checks pass, so metadata-only gates on those events reach
  governed capacity. Same-repository
  Dependabot runs route like any push: their lane code executes in ephemeral
  one-job workers, and the selector sources the observer key from the
  [Dependabot secrets store][dependabot-secrets] on Dependabot events, so the
  org mirrors `CI_RUNNER_OBSERVER_PRIVATE_KEY` there. Call it exactly once per
  workflow and feed the single output to every lane's `runs-on`; per-lane
  selector fan-out only multiplies identical preflight jobs:

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
  are `online`, `self-hosted-only`, `hosted-only`, `no-online-runner`,
  `missing-config`, `missing-secret`, `auth-error`, `api-timeout`, `api-error`,
  `invalid-response`, and the strict infrastructure sentinel `selector-error`.
  The security eligibility guard also reports
  `hosted-only`. `selector-conformance.yml` runs the deterministic selector test
  suite and proves the public, hosted-only, and queue-only contracts
  without accessing local capacity. The tested CommonJS source is generated
  into the workflow, so the reusable-workflow SHA pins the implementation
  without a second checkout/ref. This matters because actions inside a called
  workflow otherwise run in the
  [caller's repository context][reusable-workflow-context]. A conformance check
  fails if the executable copy drifts.

  A required reusable gate that declares `needs: select-runner` must execute
  after selector failures and skips. GitHub otherwise
  [skips the dependent job][job-dependencies] after a prerequisite failure, and
  a [skipped required job reports success][job-conditions]. It must also report
  on every outcome: the standards runner-policy validator requires
  selector-result reporters to declare exactly `if: ${{ always() }}` so every
  prerequisite outcome — including cancellation — still materializes the
  required check. GitHub generally
  [recommends `!cancelled()` instead of `always()`][workflow-troubleshooting]
  for jobs that should stop with a cancelled workflow; this contract
  deliberately trades that for fail-closed reporting, and the cost is bounded
  to one `ubuntu-24.04` reporter run on cancellation. Use the semantic-title
  gate's fail-closed prerequisite contract:

  ```yaml
  pr-title:
    needs: select-runner
    if: ${{ always() }}
    permissions:
      pull-requests: read
    uses: melodic-software/ci-workflows/.github/workflows/semantic-pr.yml@<sha>
    with:
      runner: ${{ needs.select-runner.outputs.runner || 'ubuntu-24.04' }}
      prerequisite-result: ${{ needs.select-runner.result }}
  ```

  When the caller workflow is active, any prerequisite result other than exact
  `success` runs the same required reusable job on `ubuntu-24.04` and fails
  before title validation. An explicitly delivered `cancelled` result remains
  fail-closed because the result alone does not prove that a successor run will
  cover the same required check. If the caller workflow is cancelled manually
  or by `concurrency.cancel-in-progress`, the `always()` reporter still runs
  and reports for its own, now-superseded run; the superseding run reports its
  own result, and a stale failure left by a superseded run clears on re-run.

  The normal success path still runs the existing `pr-title / pr-title` job
  only on the selector-returned runner; there is no routine aggregator or extra
  hosted job. The exceptional reporting job uses GitHub's
  [least-expensive hosted Linux SKU][runner-pricing].

  `self-hosted-labels-json` is an optional ordered JSON array of exact labels.
  When present it overrides `self-hosted-label`; malformed, empty, or duplicate
  candidate lists route hosted with `invalid-response`. Candidate priority is
  the array order, independent of runner API order. `self-hosted-only` requires
  exactly one centrally allowlisted candidate. Because GitHub documents
  [runner labels as case-insensitive][runner-labels], candidate and inventory
  labels are compared through case-normalized keys, case-only duplicates are
  rejected, and the selector returns the configured spelling. V1's governed
  labels and name prefixes are conservative ASCII literals provisioned by IaC;
  this contract does not claim generic Unicode case-fold or collation safety.
  GitHub's
  [generic default self-hosted labels][default-runner-labels] (`self-hosted`, OS,
  and architecture labels), as well as a candidate equal to the hosted fallback,
  are rejected because returning either as `runs-on` could escape the managed
  fleet. Organization
  routing normally leaves it unset and uses one shared exact label. The personal
  phase provisions it as operational data so the documented live-proof fallback
  can switch from one shared label to two host-specific exact labels without a
  workflow or selector code change.

  GitHub's official [runner-scale-set contract][runner-scale-sets] routes jobs
  by scale-set name. Its `2026-03-10` [OpenAPI runner schema][runner-openapi]
  requires `id`, `name`, `os`, `status`, `busy`, and a `labels` array, but
  declares `ephemeral` optional. Live scale-set inventory can represent a JIT
  runner with an empty label array and omit `ephemeral`. When exactly one route
  is configured, the selector can unambiguously attribute such an empty-label
  runner inside the governed name prefix to that sole scale-set route. With an
  ordered multi-route list, an empty-label runner cannot be attributed safely
  and is ineligible; a candidate must be observed explicitly instead. A present
  non-boolean `ephemeral` value invalidates the complete inventory, and explicit
  `false` excludes and contaminates the inferred single-route namespace.

  When `ephemeral` is omitted, local selection relies on the governed trust
  assumption that the configured runner-name prefix and scale-set route are
  reserved for the `ci-runner` controller's one-job JIT workers. The REST
  response does not attest that ownership or lifecycle. The selector rejects
  visible namespace conflicts, but credentials and configuration must prevent
  another runner from satisfying the same prefix-and-route contract. Online
  state is still required in the returned inventory observation.

  V1 compute is Linux x64, but GitHub's official
  [JIT-configuration response][runner-jit-config] reports `os: unknown`, as can
  live JIT inventory. The selector therefore accepts case-insensitive `linux`
  or `unknown` only. `unknown` is not an OS attestation; it is accepted solely
  under the same governed prefix-and-route/JIT trust assumption. Any explicit
  bearer of a candidate route reporting another OS contaminates that route.
  Selected jobs separately assert the official [runner context][runner-context]
  values `runner.os == Linux` and `runner.arch == X64` before substantive work.

  Because downstream `runs-on` contains only the returned route, namespace
  integrity is checked across every explicit case-insensitive bearer returned
  by the paginated inventory—not only the online runner observed by the selector.
  A route is contaminated when an explicit bearer is outside the managed name
  prefix, reports `ephemeral: false`, or reports an OS outside the V1
  Linux/JIT-unknown contract; that route is never returned. For one configured
  route, an empty-label managed runner is its unambiguous inferred bearer. For
  multiple configured routes, a conforming empty-label managed runner is
  ineligible because it cannot be attributed, while a nonconforming one
  contaminates every candidate because its hidden route could be any of them.
  An explicitly distinct clean lower-priority route remains eligible. Online
  counts include only eligible runners on clean routes. If every configured
  route is contaminated, selection fails hosted with `invalid-response`;
  omitted-field runners carrying unrelated explicit labels do not poison the
  managed namespace.

  Organization inventory is organization-wide. Selection therefore relies on
  IaC giving every same-label runner group identical selected-repository access
  for the migrated workflows. The selector cannot attest runner-group access
  parity: `runner_group_id` is optional in the inventory schema, and an
  observation without it does not prove which caller repositories can route to
  that runner.

  `CI_HOSTED_RUNNER` is operational configuration, but GitHub's runner-inventory
  API cannot prove that an arbitrary label belongs to hosted infrastructure. The
  selector therefore allowlists only the reviewed V1 value `ubuntu-24.04` and
  canonicalizes every missing, malformed, unapproved, generic self-hosted, or
  configured local-candidate value back to it. Introducing another hosted label
  requires an explicit governance and conformance review.

  Inventory is an observation, not a reservation or snapshot. Pagination can
  race with registration and status changes between requests; stable
  `total_count` and unique runner IDs are fail-closed consistency checks, not
  snapshot isolation. Several simultaneous selectors can observe the same
  online runner and select local; GitHub queues that burst until capacity
  appears. Only when no matching runner is online do later
  selectors route hosted with `no-online-runner`. Validation, authentication,
  API, timeout, malformed-response, and github-script failures produce hosted
  outputs. A failure of the selector job or hosted runner before outputs exist
  cannot be converted by workflow expressions; dependent jobs remain blocked
  and must be rerun. This boundary is intentionally not described as atomic
  fallback.
- `.github/workflows/link-check.yml` — online external-link checker, consumed
  via `uses:` at job level from a *scheduled* caller that grants `issues: write`.
  It is **advisory**: external link health is flaky, so it runs `fail: false` and
  maintains a rolling tracking issue rather than gating a build—opening or
  updating it on failure and, by default, closing it after the next clean run.
  Inputs (documented inline) let a caller shape the rolling issue — title,
  labels, native issue type, and the auto-close toggle — so a repo with an
  established issue scheme adopts the workflow without behavior change. (A whole
  scheduled job with issue maintenance is a reusable-workflow concern, not a
  composite action; the deterministic on-disk counterpart is the
  `lychee-offline` action above, which feeds `ci-status`.)
- `.github/workflows/zizmor.yml` — GitHub Actions security/static-analysis lint
  with zizmor (dangerous triggers, excessive permissions, template injection).
  **Advisory for findings** (surfaces PR annotations without failing unless
  `fail-on-findings` is enabled); consumed via `uses:` at job level. The
  workflow downloads the official x86_64 GNU/Linux archive for the reviewed
  [v1.27.0 release][zizmor-release-v1-27-0], verifies its committed SHA-256
  before extraction, and verifies the CLI-reported version before auditing.
  `latest` remains accepted for compatibility but resolves to that reviewed
  default rather than a mutable release. Installation and internal errors fail
  closed even in advisory mode; only zizmor's documented finding codes 11-14
  are suppressed. The verified binary runs from a fresh runner-temporary
  directory with a per-job cache and without Docker, a job/service container,
  or an installer-time privilege escalation. `runner` defaults to
  `ubuntu-24.04` and can consume the approved selector output for eligible
  private, non-fork calls. SARIF upload and blocking promotion
  remain deferred opt-ins. Inputs are documented inline.
- `.github/workflows/osv-scanner.yml` — dependency vulnerability scan with
  Google's official native OSV-Scanner v2.4.0 Linux X64 binary. The exact binary,
  its provenance, and the SLSA verifier are checksum-pinned; the verifier then
  attests the expected Google source repository and exact release tag before the
  scanner runs. One native SARIF scan emits escaped GitHub annotations without
  retaining or uploading an artifact. **Advisory for findings** (`fail-on-vuln`
  off by default); supply-chain, scanner, and invalid-result errors always fail
  closed. V2.4.0 scans
  supported manifests and lockfiles; .NET `.csproj`/`PackageReference` and
  Central Package Management are enabled by default. A committed
  `packages.lock.json` remains the reproducibility contract enforced by
  `dotnet-build`'s locked-mode restore, but is no longer the only .NET coverage
  path. An empty scan warns (advisory) or fails (blocking) unless the caller
  declares the repo genuinely dependency-less via `allow-no-lockfiles: true`.
  The caller must pass its approved selector output through `runner`; the native
  lane needs no Docker socket or privileged worker. Inputs are documented inline.
  See the [official v2.4.0 release][osv-release-v2-4].

  “Enabled by default” is not treated as proof that every MSBuild layout is
  covered. Each consumer's verification run must show nonzero package discovery
  for its actual `.csproj`/Central Package Management layout; committed lockfiles and
  the empty-scan guard remain required until that proof passes. The scanner's
  documented exit contract is also enforced: only `0` (clean) and `1`
  (findings) can be completed scans, `128` follows the explicit no-packages
  policy, and every other code fails closed. Completed exit codes must agree with
  a regular, non-symlink SARIF file and its finding count. Workflow-command
  properties and messages are escaped before annotations are emitted.

  The reviewed pin is machine-readable in `.github/osv-scanner-pin.json` and the
  workflow verifies the downloaded asset's checksum, SLSA provenance, source,
  release tag, and reported version before scanning. The release download is
  accepted only when it matches the reviewed checksum. The daily
  `tool-version-drift-check` compares Google's latest stable release and the
  GitHub-reported asset digests, then refreshes the existing maintenance issue;
  it never rewrites or auto-merges the pin. Updating requires
  release review, official asset/provenance checksum verification, exact source
  and tag verification, and a verification run in a consuming repository. See
  the [official installation and SLSA
  guidance][osv-installation]. Native OSV requires a governed `runner`; the
  optional inputs on `semantic-pr` and native `zizmor` preserve compatibility.
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
- `.github/workflows/claude-security-review.yml` — a dedicated LLM
  **security-review** pass with `anthropics/claude-code-action`, sibling of
  `claude-review.yml` with the same secrets interface and safe-handling model
  but a security-only prompt. It reviews the PR's changed files for the
  vulnerabilities static analysis misses — logic flaws, authorization gaps,
  injection surfaces, token/secret handling, dangerous workflow patterns
  (`pull_request_target`, script injection via the `github` context),
  permission-widening config changes, supply-chain pin loosening — and reports
  findings as a PR review with severity (CRITICAL/IMPORTANT/SUGGESTION) and a
  confidence axis, security only. **Advisory** (posts review comments, never
  gates `ci-status`); the intended promotion path is to flip to blocking on
  CRITICAL findings once the lane's precision is proven over a sustained window
  — an earned promotion (trust-before-scale). **Path-triggered by design:** the
  reusable workflow does not filter paths, because a security pass on every PR
  is noise in a doc-heavy repo where most PRs are prose. The caller owns the
  filter through its own `on.pull_request.paths` over security-sensitive
  surfaces (workflow files, permission/settings configs, hook and shell scripts,
  auth/token-touching code, network-call sites) — path filtering is how the
  default-on discipline scopes itself. Inputs (`runner`, `prompt`,
  `claude-args`, `skip-actors`) have public-safe defaults documented inline.
  Consume it from a `pull_request` caller that scopes those paths:

  ```yaml
  on:
    pull_request:
      types: [opened, synchronize, ready_for_review, reopened]
      paths:
        - '.github/workflows/**'
        - '.github/actions/**'
        - '**/*.sh'
        - '**/*.ps1'
        - '**/settings.json'
        # plus the caller's own auth/token and network-call source paths
  jobs:
    security-review:
      permissions:
        contents: read
        pull-requests: write
        id-token: write
      uses: melodic-software/ci-workflows/.github/workflows/claude-security-review.yml@<sha>
      secrets:
        CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
  ```

  The caller's job must grant those three permissions (a called workflow can only
  downgrade, not elevate) and the consumer repo must be in the
  `CLAUDE_CODE_OAUTH_TOKEN` org secret's selected scope. Pass that one named
  secret explicitly rather than `secrets: inherit`. Fork PRs receive no secrets
  by design and are not reviewed. Security rules live in [CLAUDE.md](CLAUDE.md).
- `.github/workflows/claude-e2e-verify.yml` — Claude-powered end-to-end
  verification of a PR with `anthropics/claude-code-action`. The caller passes a
  command that builds and serves its app plus the URL it listens on; the workflow
  provisions a pinned Playwright/Chromium toolchain, waits for the app to become
  healthy, then has the agent drive the running app through the caller's journeys
  and post its findings as a PR comment. **Advisory** (the agent step runs
  `continue-on-error`; findings are a PR comment, never a gating `ci-status`
  lane). A whole-job concern (job permissions + a secrets interface), so a
  reusable workflow. The caller owns the triggers and permission grant; this
  workflow owns the SHA-pinned action, the pinned browser toolchain, and the safe
  handling. Inputs (`runner`, `app-start-command`, `app-url`, `e2e-spec`,
  `claude-args`, `setup-command`, `timeout-minutes`) are documented inline.
  Consume it from a `pull_request` caller:

  ```yaml
  on:
    pull_request:
      types: [opened, synchronize, ready_for_review, reopened]
  jobs:
    e2e:
      permissions:
        contents: read
        pull-requests: write
        id-token: write
      uses: melodic-software/ci-workflows/.github/workflows/claude-e2e-verify.yml@<sha>
      with:
        app-start-command: npm ci && npm run build && npm run start
        app-url: http://localhost:3000
      secrets:
        CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
  ```

  The caller's job must grant those three permissions (a called workflow can only
  downgrade, not elevate) and the consumer repo must be in the
  `CLAUDE_CODE_OAUTH_TOKEN` org secret's selected scope. Pass that one named
  secret explicitly rather than `secrets: inherit`. This lane builds, serves, and
  browser-drives the PR head — it executes PR-authored code — so it is
  `pull_request`-only for the same reason review is: a fork gets no secrets and a
  read-only token, so that execution has nothing to exfiltrate. Fork PRs are not
  verified by design. The Playwright CLI version is an in-workflow pin watched by
  `tool-version-drift-check`, not Dependabot. Security rules live in
  [CLAUDE.md](CLAUDE.md). Promotion: flip to a selector-coupled required gate when
  the lane's findings prove precision over a sustained window — an earned
  promotion, mirroring the review lane's discipline.
- `.github/workflows/semantic-pr.yml` — validates the PR **title** against the
  Conventional Commits spec (wraps the SHA-pinned
  `amannn/action-semantic-pull-request`). **Gating**: a non-conforming title
  fails the job. Because governed repos squash-merge with the squash title set to
  `PR_TITLE`, the PR title becomes the default-branch subject line, so this is the
  single lever that yields a Conventional-Commits history (no commit-msg hook
  needed). It is a **standalone required check named `pr-title`**, not a
  `ci-status` lane — title edits must not re-run the file-lint lanes. Inputs
  (`runner`, `prerequisite-result`, `types`, `scopes`, `require-scope`,
  `subject-pattern`, `subject-pattern-error`, `validate-single-commit`,
  `ignore-labels`) have spec-aligned defaults documented inline. Consume it from
  a thin caller that triggers on title-relevant events. `prerequisite-result`
  defaults to `success` for direct callers; selector-dependent required callers
  must use the fail-closed pattern above.
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
- `.github/workflows/pr-issue-linkage.yml` — validates the PR **body** carries
  a native closing keyword (`Closes`/`Fixes`/`Resolves #N`, including
  `owner/repo#N`, or the literal `No linked issue` when the PR closes nothing)
  and a non-empty `## Related` section. **Gating**: a non-conforming body fails
  the job. HTML comments are stripped before either check, so an unedited PR
  template (whose instructional prose lives in comments) fails rather than
  passing vacuously. Generalizes
  [`melodic-software/provisioning`'s `pr-body.yml`](https://github.com/melodic-software/provisioning/blob/main/.github/workflows/pr-body.yml)
  into a shared reusable workflow — provisioning's own caller predates this
  workflow and is not required to switch. It is a **standalone required check
  named `pr-issue-linkage`**, not a `ci-status` lane — body edits must not
  re-run the file-lint lanes. Inputs (`runner`, `prerequisite-result`) match
  `do-not-merge-gate.yml`'s shape. Consume it from a thin caller that triggers
  on body-relevant events; note the emitted check context is
  **`pr-issue-linkage / pr-issue-linkage`** (the name a ruleset must require):

  ```yaml
  on:
    pull_request_target:
      types: [opened, edited, reopened, synchronize]
    merge_group:
  permissions: {}
  concurrency:
    group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
    cancel-in-progress: true
  jobs:
    pr-issue-linkage:
      permissions: {}
      uses: melodic-software/ci-workflows/.github/workflows/pr-issue-linkage.yml@<sha>
  ```

  `pull_request_target` runs the base-branch definition, so a head-branch edit
  cannot bypass the gate (safe here because the check reads PR body metadata
  only — it checks out and runs no head code). `edited` is required so a body
  edit re-validates. `merge_group` is required on any repo with a merge
  queue, for the same reason `pr-title.yml` needs it (the check passes on
  `merge_group` since the body was validated at PR time; inert where no queue
  exists). Then require the `pr-issue-linkage / pr-issue-linkage` check in the
  repo's ruleset (governed via `github-iac`) — but only **after** the caller
  is merged and emitting the check, or open PRs block on a check that never
  runs.
- `.github/workflows/do-not-merge-gate.yml` — fails the job while the calling PR
  carries a configured label (default `do-not-merge`). **Gating**: the label's
  presence fails the job; a caller that requires this check blocks the merge
  until the label is removed. It is a **standalone required check named
  `do-not-merge`**, not a `ci-status` lane. Inputs (`runner`,
  `prerequisite-result`, `label`) mirror `semantic-pr`'s fail-closed pattern.
  **Adopt the canonical block below.** Note the emitted check context is
  `<caller job> / <reusable job>` — with the caller below it is
  **`do-not-merge / do-not-merge`** (the name a ruleset must require, not bare
  `do-not-merge`):

  ```yaml
  on:
    pull_request_target:
      types: [opened, reopened, synchronize, labeled, unlabeled]
    merge_group:
  permissions:
    pull-requests: read
  concurrency:
    group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
    cancel-in-progress: true
  jobs:
    do-not-merge:
      permissions:
        pull-requests: read
      uses: melodic-software/ci-workflows/.github/workflows/do-not-merge-gate.yml@<sha>
  ```

  `pull_request_target` runs the base-branch definition, so a head-branch edit
  to this file cannot bypass the gate (safe here since the check reads PR label
  metadata only — it checks out and runs no head code). `labeled`/`unlabeled`
  are required — without them, adding the label after the check already passed
  would not re-trigger it, and the merge would never actually be blocked. Even
  with them present, a same-repo automation that labels using the default
  `GITHUB_TOKEN` still does not re-trigger this gate — see the "Known
  limitation — GITHUB_TOKEN-authored label changes" note below.
  `opened`/`reopened`/`synchronize` cover the check reporting on every other PR
  lifecycle event a ruleset's required-status-check needs to see. `merge_group`
  is required on any repo with a merge queue, both for the never-reports/deadlock
  reason documented under `semantic-pr` above **and** because the reusable
  workflow re-evaluates the label on `merge_group` itself (looking the
  PR named in the merge group's temporary ref up and re-checking its current
  labels via the API) — unlike `semantic-pr`'s immutable title, a label can be
  added after the PR's own `pull_request_target` run last passed, e.g. while
  the PR already sits in the queue, so trusting that earlier result would let
  a labeled PR merge through.

  **Known limitation — GITHUB_TOKEN-authored label changes.** The
  `labeled`/`unlabeled` triggers above only re-evaluate the gate when GitHub
  actually starts a new workflow run for that event. GitHub does not start a
  run at all for `labeled`/`unlabeled` events produced by the default
  `GITHUB_TOKEN` — that is a platform-level recursive-run guard
  ([triggering-a-workflow-from-a-workflow]), not a gap in the trigger list
  above. So if a same-repo automation job (e.g. a labeling policy workflow)
  applies this gate's blocking label using the default `GITHUB_TOKEN`
  **after** the check already reported success on the PR's HEAD SHA, no run —
  live-refetch or otherwise — is ever triggered, and the earlier green
  check-run stays on that SHA until a genuinely new qualifying event occurs
  (e.g. `synchronize` from a subsequent push, or a non-default-token
  `labeled`/`unlabeled` event). No trigger-list change can close this; the
  gap is that GitHub never starts a run.

  **Adoption requirement — label-setting automation must not use the default
  `GITHUB_TOKEN`.** Any same-repo workflow that applies or removes this
  gate's blocking label must authenticate with a GitHub App installation
  token or a personal access token instead of `${{ secrets.GITHUB_TOKEN }}` /
  `${{ github.token }}`. Only a label change authored by a non-default token
  creates the `labeled`/`unlabeled` run that re-evaluates this gate; a
  default-token label change leaves an already-green check silently
  unenforced. Verify this for every same-repo labeling automation before
  requiring `do-not-merge / do-not-merge` on that repo.

  **Known gap with batched merge queues:** GitHub's merge queue batches
  multiple PRs into one merge group by default (max group size 5), and the
  batch's temporary ref/SHA is named for only the *last* PR in the batch (a
  `[#1, #2]` batch runs as `pr-2`). The reusable workflow's `merge_group`
  handling re-checks only that named PR's labels, so a PR that isn't last in
  its batch is not individually re-evaluated at merge-queue time. Closing this
  fully needs either a validated way to enumerate every PR in a batch from a
  `merge_group` run (no such API is documented; unverified), or setting merge
  queue **maximum group size to 1** in the repo's ruleset (`github-iac`) so
  every merge group is single-PR. Until one of those lands, treat `merge_group`
  label coverage as best-effort, not exhaustive, on repos that allow batching.

  **Adoption precondition — single-PR merge groups.** This workflow does not
  itself detect or assert the queue's batch size; that only exists as the gap
  above. Coverage on `merge_group` runs is exhaustive **only** when a merge
  group contains exactly one PR. Before requiring `do-not-merge / do-not-merge`
  on a repo with a merge queue, confirm the queue actually produces single-PR
  groups — today that means the ruleset's merge-queue **maximum group size is
  1**; a repo that instead relies on batch enumeration must first have that
  enumeration implemented and validated here, which does not exist yet. Making
  the check required on a queued repo without satisfying this precondition
  does not fail loudly: it keeps reporting green while under-enforcing on
  non-tip batch members. Re-verify this precondition whenever the repo's
  merge-queue configuration changes.

  Then require the `do-not-merge / do-not-merge` check in the repo's ruleset
  (governed via `github-iac`) — but only **after** the caller is merged and
  emitting the check, or open PRs block on a check that never runs.

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
[lefthook-config]: https://lefthook.dev/usage/envs/LEFTHOOK_CONFIG/
[lefthook-extends]: https://lefthook.dev/configuration/extends/
[lefthook-validate]: https://lefthook.dev/usage/commands/validate/
[job-conditions]: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions
[job-dependencies]: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs#defining-prerequisite-jobs
[osv-installation]: https://google.github.io/osv-scanner/installation/
[osv-release-v2-4]: https://github.com/google/osv-scanner/releases/tag/v2.4.0
[pssa-1708]: https://github.com/PowerShell/PSScriptAnalyzer/issues/1708
[pulumi-oidc]: https://www.pulumi.com/docs/administration/access-identity/oidc-issuers/
[pulumi-stack-export]: https://www.pulumi.com/docs/iac/cli/commands/pulumi_stack_export/
[runner-routing]: https://docs.github.com/en/actions/reference/runners/self-hosted-runners#routing-precedence-for-self-hosted-runners
[runner-security]: https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners
[runner-pricing]: https://docs.github.com/en/billing/reference/actions-runner-pricing
[runner-labels]: https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels
[runner-jit-config]: https://docs.github.com/en/rest/actions/self-hosted-runners?apiVersion=2026-03-10#create-configuration-for-a-just-in-time-runner-for-an-organization
[runner-openapi]: https://github.com/github/rest-api-description/blob/3b43edf675308c515b5e92a3eb89db17f6e6d806/descriptions-next/api.github.com/api.github.com.2026-03-10.yaml
[runner-scale-sets]: https://docs.github.com/en/actions/concepts/runners/runner-scale-sets
[runner-context]: https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#runner-context
[reusable-workflow-context]: https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations#reusable-workflows
[triggering-a-workflow-from-a-workflow]: https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow
[workflow-troubleshooting]: https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#canceling-workflows
[zizmor-release-v1-27-0]: https://github.com/zizmorcore/zizmor/releases/tag/v1.27.0
