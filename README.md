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
  caller-supplied config. It installs a pinned, checksum-verified binary,
  unconditionally redacts secret values, validates requested reports, and fails
  closed on missing, malformed, or operationally incomplete results.
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
  hosted/self-hosted selector. With `self-hosted-only`, the selector itself
  queues on the centrally allowlisted `melodic-ubuntu-24.04-x64` route; it does
  not spend hosted minutes before returning that same managed label. The
  `prefer-self-hosted` and `hosted-only` selector paths retain `ubuntu-slim` so
  their adaptive and explicit hosted semantics remain available. Every selector
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
  queue-only label must be the exact centrally allowlisted
  `melodic-ubuntu-24.04-x64` route; adding another route requires a reviewed
  immutable selector revision. Invalid queue-only configuration and selector
  infrastructure faults fail the selector job instead of falling back to paid
  hosted execution. Public
  repositories, fork pull requests, and Dependabot runs route hosted before the
  observer-token action can execute, following GitHub's
  [self-hosted runner security guidance][runner-security] and
  [Dependabot secret boundary][dependabot-secrets]. Call it exactly once per
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
  after every selector outcome. GitHub otherwise
  [skips the dependent job][job-dependencies] after a prerequisite failure, and
  a [skipped required job reports success][job-conditions]. Use the
  semantic-title gate's fail-closed prerequisite contract:

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

  Any prerequisite result other than exact `success` runs the same required
  reusable job on `ubuntu-slim` and fails before title validation. The normal
  success path still runs the existing `pr-title / pr-title` job only on the
  selector-returned runner; there is no routine aggregator or extra hosted job.
  The exceptional reporting job uses GitHub's
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
  bearer of a candidate route reporting another OS contaminates that route. The
  canary separately requires the official [runner context][runner-context] values
  `runner.os == Linux` and `runner.arch == X64` before substantive work, then
  executes its Linux x64 compatibility proof.

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
- `.github/workflows/local-runner-canary.yml` — a reusable-only acceptance
  contract bound to the private `melodic-software/ci-runner-canary` repository.
  It has no executable trigger in this public repository. A hosted preflight
  requires that exact private caller, `workflow_dispatch`, protected `main`, and
  attempt 1 before any job receives the observer key. The immutable reusable
  workflow owns the selector: it calls the already-reviewed central selector at
  a full SHA with the exact `melodic-canary-ubuntu-24.04-x64` label and
  `ci-runner-canary-` name prefix, then consumes only direct `needs` outputs.
  The caller cannot claim a runner, route, reason, online count, repository,
  label, or prefix.

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
- `.github/workflows/production-ha-proof.yml` — the executable production
  two-host rollout gate, separate from compatibility canarying. It is
  reusable-only and accepts only a first-attempt manual dispatch from the exact
  private protected-main caller
  `melodic-software/ci-runner-canary/.github/workflows/production-ha-proof.yml`.
  The caller supplies no runner label or prefix and passes only the read-only
  observer key explicitly. Every inventory, validation, and operator-hold job is
  explicitly GitHub-hosted. Production execution consumes only the central
  selector's direct output, so hosted fallback and attempt-2 routing semantics
  remain owned by the selector; a fallback cannot be mistaken for a passing
  self-hosted proof.

  The hosted inventory reads the official organization runner-group,
  selected-repository, and group-runner endpoints with **Self-hosted runners:
  read**. It requires unique independent groups
  `ci-local-melo-desk-001` and `ci-local-melo-lap-001`, selected visibility,
  public access disabled, identical all-private repository sets containing the
  proof repository, and exact host-specific runner-name namespaces bearing
  `melodic-ubuntu-24.04-x64`. [GitHub's runner-group REST API][runner-group-rest]
  defines those public fields and the read permission. Its group `id` identifies
  a runner-group resource; the response contains no scale-set ID. The evidence
  therefore records that limitation instead of claiming the REST inventory can
  map the controller's persistent scale-set ID. Controller status and logs own
  that separate proof.

  Manual modes are deliberately small, observable gates:

  1. `inventory` requires an online idle production runner in each independent
     group.
  2. `desktop-only` and `laptop-only` require the other group to have zero online
     runners, then assert the acquired `runner.name`, `runner.os == Linux`, and
     `runner.arch == X64`. Those values are GitHub's documented
     [runner context][runner-context].
  3. `failover` first proves both groups idle and completes selection. A hosted
     hold then asks the operator to drain the desktop and waits read-only for
     two stable observations of desktop-zero/laptop-idle before releasing the
     governed job, which must acquire the laptop. It never reserves a runner,
     changes capacity, cancels, or replays a run. This exercises GitHub's
     documented active-active topology: same scale-set name in different runner
     groups, arbitrary assignment while both are online, and continued
     acquisition by the surviving set. [High availability and automatic
     failover][runner-scale-set-ha]
  4. `laptop-power` acquires the laptop while the desktop is drained and records
     UTC heartbeats for 10-30 minutes. The heartbeat artifact proves only that
     the already-running job survived across those timestamps. Promotion also
     requires externally captured controller status/logs and Windows power
     evidence for unplug, zero advertised new capacity, retained busy work,
     stable AC recovery, and fresh logon while already on battery. A workflow
     cannot prove the negative condition in which no runner is allowed to start,
     and REST runner inventory does not report controller `maxCapacity`.

  Evidence is sanitized JSON/JSONL retained as normal workflow artifacts. It
  includes REST group IDs, repository access, runner identities, observations,
  run correlation, and explicit limitations—never an App token, private key,
  JIT configuration, controller credential, or raw API response. GitHub's
  [artifact contract][workflow-artifacts] supplies the review/download boundary.
- `.github/workflows/link-check.yml` — online external-link checker, consumed
  via `uses:` at job level from a *scheduled* caller that grants `issues: write`.
  It is **advisory**: external link health is flaky, so it runs `fail: false` and
  files a rolling tracking issue on failure rather than gating a build. (A whole
  scheduled job with issue-creation is a reusable-workflow concern, not a
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
  private, non-fork, non-Dependabot calls. SARIF upload and blocking promotion
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
  covered. Each consumer canary must show nonzero package discovery for its
  actual `.csproj`/Central Package Management layout; committed lockfiles and
  the empty-scan guard remain required until that proof passes. The scanner's
  documented exit contract is also enforced: only `0` (clean) and `1`
  (findings) can be completed scans, `128` follows the explicit no-packages
  policy, and every other code fails closed. Completed exit codes must agree with
  a regular, non-symlink SARIF file and its finding count. Workflow-command
  properties and messages are escaped before annotations are emitted.

  The reviewed pin is machine-readable in `.github/osv-scanner-pin.json` and the
  workflow verifies the downloaded asset's checksum, SLSA provenance, source,
  release tag, and reported version before scanning. Deployment never references
  a mutable release. The daily `tool-version-drift-check` compares Google's
  latest stable release and the official asset digest, then refreshes the existing
  maintenance issue; it never rewrites or auto-merges the pin. Updating requires
  release review, official asset/provenance checksum verification, exact source
  and tag verification, and a canary. See the [official installation and SLSA
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
[job-conditions]: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions
[job-dependencies]: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs#defining-prerequisite-jobs
[native-aot]: https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/
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
[runner-group-rest]: https://docs.github.com/en/rest/actions/self-hosted-runner-groups?apiVersion=2026-03-10
[runner-scale-set-ha]: https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets#high-availability-and-automatic-failover
[reusable-workflow-context]: https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations#reusable-workflows
[workflow-artifacts]: https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts
[workflow-cancellation]: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/cancel-a-workflow-run
[zizmor-release-v1-27-0]: https://github.com/zizmorcore/zizmor/releases/tag/v1.27.0
