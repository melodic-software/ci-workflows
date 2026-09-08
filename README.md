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
- **Pin by SHA.** Reference every action at a full commit SHA with a `# vX.Y.Z`
  comment. Consumers keep this repository out of Dependabot's `github-actions`
  updates (an `ignore` entry) and move the pin by reviewed pull request in their
  own repository, so a fix landed here does not reach a consumer until it
  repins — see Versioning. For the third-party actions a consumer does let
  Dependabot track, Dependabot updates only `uses:` SHAs — the tool versions
  pinned in each action's `version:`/`analyzer-version:` input default (and the
  checksum-verified install URLs) have no package manifest it can track, so the
  scheduled `tool-version-drift-check` workflow watches upstream releases and
  files an advisory issue when a default falls behind.
- **Each consumer aggregates locally.** One action runs one tool inside a
  consumer job. The required-check contract is a single check named `ci-status`,
  produced by a thin gateway job the consumer keeps local so the required-check
  name stays un-nested. The gateway `needs:` the lane jobs and fails if any
  failed or was cancelled. Whether a skipped lane passes is the consumer's
  policy via the `ci-status` action's `treat-skipped-as` input — see that
  action below for when a skip must block rather than pass.

## Versioning

Every tag is full SemVer (`vX.Y.Z`). A release is cut whenever `main` changes
by something worth pinning to — `release.yml`'s manual `workflow_dispatch`
(patch/minor/major) makes each release a deliberate act, and cutting one after
every meaningful change keeps a tagged SHA available for consumers to pin to.
Consumers are never bumped automatically: each pins this repository by full
commit SHA with a `# vX.Y.Z` comment, and moving that pin is a reviewed pull
request in the consumer's own repository. Because nothing cuts a release
automatically, the scheduled `release-gap-check` workflow watches for the
failure mode of that deliberateness — `main` running ahead of the newest
published Release for too long — and files an advisory rolling issue; cutting
the release stays manual. There is no calendar cadence; GitHub's own guidance is
silent on release frequency, and a tag-per-change policy is a closer fit for a
repository whose only "release" event is "a consumer might need to pin to
this." GitHub's reusable-workflow reference guidance treats a SHA, a release
tag, and a branch as equally valid `{ref}` forms and states plainly that
"Using the commit SHA is the safest option for stability and security"
([Reuse workflows][reuse-workflows]) — this repo's tag-per-change practice and
every consumer's SHA pin both sit inside that guidance, not around it.

**No floating major tag (`v1`).** GitHub's action-release guidance recommends
"keeping major (`v1`) and minor (`v1.1`) tags current to the latest
appropriate commit" so a consumer written as `uses: owner/action@v1` keeps
receiving non-breaking updates automatically
([Releasing and maintaining actions][releasing-actions]). That guidance is
scoped to actions consumed by a floating tag resolved at Actions runtime, and
its own reusable-workflow reference page makes no equivalent recommendation.
Neither the letter nor the premise of that guidance applies here: every
consumer of this repository pins by 40-character commit SHA — the
runner-policy allowlist requires it fleet-wide — so no consumer's workflow run
ever resolves `@v1`, and a floating major tag would exist only as a label
nothing at runtime reads. It would also actively conflict with the
pin-comment convention consumers now follow
(`melodic-software/standards#248`): that convention's primary form,
`# vX.Y.Z`, asserts the comment names *the* release the pinned SHA
corresponds to, a claim a moving tag cannot keep true once it moves. This is
declined outright, not deferred by oversight; the trigger for revisiting it is
this repository ever moving consumers onto tag-resolved-at-runtime references,
which the current SHA-pin governance model gives no reason to expect.

**`v0.x` carries no stability guarantee.** Per SemVer's own terms, "Major
version zero (0.y.z) is for initial development. Anything MAY change at any
time. The public API SHOULD NOT be considered stable" ([SemVer, item
4][semver]). This repository is `v0.7.0` at the time of writing: a release may
still ship a change a post-1.0 line would have to treat as its own
minor/patch distinction. Committing to `v1.0.0` — SemVer's "defines the public
API" milestone ([SemVer, item 5][semver]) — is a deliberate, separate decision
this document defers rather than resolves; nothing here should be read as an
implicit 1.0 commitment or a timeline toward one.

**A caller's SHA pin does not cascade.** Pinning this repository by SHA proves
only that the one referenced file's bytes are fixed at that commit; GitHub
resolves a reusable workflow's own nested calls to further reusable workflows
or actions independently, at their own `{ref}`
([Reusing workflow configurations][reusing-workflow-configurations]). GitHub's
docs do not call this out directly, but it follows structurally from that
per-reference resolution model, and it is exactly the gap reported in a
[community discussion][nested-pin-discussion] about a workflow whose nested
composite actions kept tracking a branch after the caller pinned the calling
workflow file to a commit. This repository closes that gap on its own side,
not the consumer's: every external reference its own actions and workflows
make — third-party actions such as `astral-sh/setup-uv`,
`anthropics/claude-code-action`, and `peter-evans/create-issue-from-file` — is
itself pinned to a full commit SHA with the same dual-form trailing comment
consumers use (`melodic-software/standards#248`). A consumer's pin on this
repository is only as trustworthy as this repository's own pins one level
down, and this repository keeps that chain closed rather than asking every
consumer to audit it.

## Actions

- `.github/actions/markdown` — markdownlint-cli2 over the repo's markdown.
- `.github/actions/shellcheck` — ShellCheck over the repo's shell scripts
  (installs a pinned, checksum-verified binary). Its default discovery remains
  tracked `*.sh`/`*.bash`; `extra-globs` adds tracked extensionless inputs as
  newline-delimited Git pathspecs, with optional `extra-exclude-codes` scoped
  only to that extra lane so ordinary scripts keep the stricter result.
  `files` takes an explicit list instead, one path per line or space-separated,
  and **wins over `paths`**: no discovery runs, and ShellCheck sees exactly the
  listed paths that still exist and end in `.sh` or `.bash`. A deleted or
  non-shell path in the list is skipped rather than failing the action, so a
  raw diff can be handed over unfiltered; a non-blank list that keeps nothing
  prints a notice and exits 0; a blank list (the default) leaves behaviour
  exactly as it was. `exclude` still applies, and `extra-globs` matches are
  narrowed to the same list. See [Diff-scoping the ShellCheck
  lane](#diff-scoping-the-shellcheck-lane).
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
- `.github/actions/ci-status` — aggregates a caller-built `needs.*.result` string
  into the single required gate check: `success` passes, anything else fails
  naming the offending result. `treat-skipped-as` is the caller's policy for
  `skipped` — `pass` (default) or `fail` for repos where a skipped lane means one
  that should have run did not, such as a runner selector falling back. An
  unrecognised policy value fails rather than defaulting. Empty input fails
  closed. GitHub offers no "all other jobs" selector, so the `needs` list and the
  matching results string stay caller-owned. `results` carries results, not lane
  names, so the recorded status description names the failing lane by its
  position in that list.

  It also carries the verdict forward across contract-only pull-request events.
  With `contract-only` false (the default expression's value on any event that is
  not a same-repository label flip or a base-preserving `edited`) it aggregates as
  above and then records the verdict as a commit status on `sha` under
  `status-context` (default `ci-lanes`). With `contract-only` true it skips
  aggregation — the lanes are `skipped` by construction — and passes only when the
  combined status for that context on that SHA is `success`. Both inputs default
  to the expressions the caller's lane gates use, so a caller passes neither;
  `contract-only` must stay identical to the caller's job gate or the two
  disagree about whether the lanes ran — a drifted copy would gate the lanes off
  while the composite aggregates their all-`skipped` results into a `success`
  for a run in which nothing executed, so `ci-fanout-consolidation.test.cjs`
  compares the two texts and fails on any difference. The carried verdict is
  read from the per-context status LIST, not the combined endpoint, and only an
  entry written by `github-actions[bot]` counts: any collaborator with write can
  `POST` a commit status, and the combined endpoint exposes no author, so a
  forged `ci-lanes=success` plus a label flip would otherwise turn the sole
  required check green over failing lanes. **The status write is load-bearing, not
  best-effort**: a write still refused after three retries fails the run naming
  the missing permission, because the carry-forward branch reads nothing else and
  a silently missing status turns every later contract-only run red with no way
  to tell a refused write from a failing lane. **The calling job therefore needs
  `statuses: write`** (plus `pull-requests: write` when it also runs
  `pr-contract`). The exception is `same-repo` false, a fork pull request: its
  token is read-only on `pull_request` whatever `permissions:` requests, so the
  run reports the lanes verdict, prints a `::notice::`, and records nothing —
  and, because the contract-only predicate is false for every fork event, a fork
  runs the full workflow each time and never needs a carried verdict. A commit
  status, not the `ci-status` check-run list, is the carried signal on purpose: a
  check run cannot say which event produced it, so a chain of contract-only runs
  could otherwise self-certify.

  **The bounded carry-forward wait** (`carry-forward-wait-seconds`, default
  `240`, `0` disables) closes the race the branched concurrency group below
  opens. Before ci-perf Phase 6b a contract-only run shared one concurrency group
  with the full run it reads and queued behind it, so the `ci-lanes` status was
  always already written; the branched group removes that queueing, so the two
  now race. Carry-forward mode therefore polls.

  It reads the current run
  (`GET /repos/{owner}/{repo}/actions/runs/{run_id}`) for its workflow, then
  every 15 seconds does two calls in a fixed order. First
  `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs?head_sha={sha}`
  for the runs of this workflow on the same commit that are `queued`,
  `in_progress`, `waiting`, `pending` or `requested`, excluding this run. Then
  the `status-context` list, read as above: newest entry by
  `github-actions[bot]`.

  A `success` or `failure` on that read is a settled verdict, so the poll stops
  and the verdict applies. Otherwise, if the first call found nothing in flight
  the poll stops too, because nothing that could still write a verdict exists
  and an absent status fails as it always has. If something is in flight, it
  sleeps and polls again. Four properties are load-bearing:

  - **Any in-flight sibling is waited on, at any run id.** Waiting only on lower
    run ids, as v0.22.1 did, assumed a full run always outranks the
    contract-only run beside it. A pull request opened with labels already
    applied (Dependabot, an app that labels on open) creates the `opened` full
    run and the `labeled` contract-only run together, and nothing decides which
    draws the lower id. The contract-only run that drew it had an empty wait
    set, read a status its sibling had not written yet, and failed instantly.
  - **Reading the settled status each poll is what prevents a mutual wait.**
    Widening the wait set gave up the ordering that used to guarantee one run of
    a pair waits on nothing. Two contract-only runs on one SHA now wait on each
    other until the full run writes its verdict, which releases both. With no
    full run in flight to write one, they run to the ceiling and both fail
    closed. That is the only case that waits to the ceiling in normal operation.
  - **Listing before reading, within a poll.** A sibling writes the status and
    flips to `completed` moments later. Reading first would let that completion
    land between the two calls and report both no status and nothing in flight,
    failing a SHA that does carry a verdict.
  - **The wait never turns a verdict green.** Reaching the ceiling prints
    `::error::no successful <context> status on <sha>; re-run the full workflow`,
    extended with how long it waited and on which run ids, and exits 1. There is
    no pass-on-timeout path.

  **The calling job needs `actions: read`.** Under an explicit `permissions:`
  block the default for every scope is none, so both Actions calls 403 without
  it. A 403 prints a `::warning::` naming the missing scope and then degrades to
  a single status read, which is the pre-6b contract: loud, and never a pass on
  an absent status. Any other read failure warns the same way.

  **The trade this makes.** Ending the wait on a settled status is what releases
  the mutual wait, and it gives up v0.22.1's guard against carrying an older
  `success` forward while a re-run of the same SHA is in flight to overwrite it.
  That guard bound only when a full run had already written a verdict for this
  exact SHA and another full run was in flight on it again, and it cost a false
  red on every same-second sibling. The defences against a forged status
  (context, creator login, `Bot` type, newest id) are untouched.

  The 15-second poll interval is deliberately not a caller input: the only knob a
  consumer should have to reason about is the ceiling.

  **Size the ceiling from the repository's own measured full run, then derive
  `timeout-minutes` from it.** `carry-forward-wait-seconds` must cover the wall
  time the contract-only run may have to wait out: the queue wait plus the p95
  wall of the full `ci` run on this repository. Set `timeout-minutes` to at
  least that figure plus two minutes, then set `carry-forward-wait-seconds` to
  `timeout-minutes * 60 - 60`.

  The derivation runs in that direction and not the other. The earlier guidance
  read "at least 60 seconds below `timeout-minutes`" as the whole rule, which
  sizes the wait from a budget nobody derived; a ceiling sized 60 seconds under
  a pure aggregator's default budget cannot outlast the run it is waiting for.
  Measured on claude-code-plugins#3777: a body edit one minute into a 4 to 5
  minute full run waited 210 seconds of a 240-second ceiling (run 33993232104)
  and 225 seconds on run 33993700139, so that repository moved from 5 and 240 to
  10 and 540. dotfiles derived 35 and 2040 the same way, from a `checks` wall
  p95 of 158 s plus a serial `test` wall p95 of 1,088 s plus three queue waits
  at its measured queue p50 of 165 s, which is 29.0 minutes.

  The 60-second margin survives as a **constraint, not a sizing rule**: a
  ceiling at or above the job budget lets the job timeout preempt the
  fail-closed error, which reports as a cancelled job rather than the
  actionable "re-run the full workflow" message.

  The `240` default therefore suits only a repository whose full run finishes in
  well under two minutes. The values in use across the fleet today:

  | repository | `timeout-minutes` | `carry-forward-wait-seconds` |
  | --- | --- | --- |
  | dotfiles | 35 | 2040 |
  | github-iac | 31 | 1800 |
  | provisioning | 36 | 2100 |
  | claude-code-proxy | 30 | 1740 |
  | claude-code-plugins | 10 | 540 |
  | ci-workflows | 15 | 840 |

  This repository's own row is derived the same way: over the last 84
  successful `ci` runs the wall p95 is 124 s, and 80 of those 84 queued for 0 s
  on hosted runners with a worst non-outlier queue of 331 s, so the floor is
  about 7.6 minutes and the existing `timeout-minutes: 15` clears it with room.

  A waiting run holds a fleet runner slot, or bills a hosted minute per minute,
  for as long as it waits, so the ceiling is a real cost and not a free margin.
  It is a ceiling, not a delay: the poll ends the moment a verdict settles or
  nothing is left in flight.
- `.github/actions/pr-contract` — the whole pull-request contract in one step:
  Conventional Commits title and the `do-not-merge` label gate the step, and
  issue linkage is advisory by default (a warning plus one upserted marker
  comment plus a label, exit code unchanged; `linkage-mode: enforce` makes it
  gate). Semantics are ported from the `semantic-pr`, `do-not-merge-gate` and
  `pr-issue-linkage` reusables, all three of which are now retired
  (`semantic-pr.yml` by ci-perf Phase 6b-ii, the other two by Phase 7), so this
  composite is the only implementation. The pull request is read from the API rather than the event payload,
  so `edited` and `labeled` runs see current state. Needs `pull-requests: write`
  for the comment and label; every write is best-effort and degrades to a
  `::notice::` on a read-only token. See
  [its README](.github/actions/pr-contract/README.md) for the consumer wiring.
- `.github/actions/change-detection` — decides which CI lanes a pull request's
  changed files make relevant, so a caller can skip lanes at JOB level and
  stop paying for runs a change cannot affect. Checkout-free: the PR file
  listing comes from the API, and caller-named filter groups match it with
  root-anchored gitignore rules — the same matcher `claude-security-review.yml`'s
  `changes` job uses, generalized to many named groups. One `results` JSON
  output maps each group to `"true"`/`"false"` strings; every operational
  fault (non-PR event, API failure, a listing at the 3,000-file API cap)
  fails OPEN to `"true"`, while unhonorable pattern syntax (`!`, `?`, `+`)
  and malformed group config are hard errors even on fallback runs. The
  required-check interplay is load-bearing: gate each lane job with
  `!cancelled() && fromJSON(needs.changes.outputs.results || '{}')['<group>']
  != 'false'` (never `== 'true'` — an unset output must run the lane, not
  skip it), keep aggregating through the always-running `ci-status` gateway
  with `treat-skipped-as: pass` (a job-level skip reports `skipped`, which
  branch protection counts as success under the single required check), add
  the detection job itself to the `ci-status` `needs` list so a broken
  filter config goes red instead of riding fail-open to green indefinitely,
  and never reach for workflow-level `on.<event>.paths` on a workflow whose
  check is required — a path-skipped workflow leaves that check Pending
  forever. Filter conservatively: include `.github/**` in every group so CI
  changes re-run everything, and leave content-agnostic lanes (spell-check,
  secret scan, editorconfig, link integrity, and kin) ungated — any file can
  carry the defect they gate on. This repo's own `ci.yml` `changes` job is
  the reference wiring.
- `.github/actions/lychee-offline` — lychee `--offline` link/anchor
  reference-integrity over the repo's docs (deterministic; no network).
- `.github/actions/reference-integrity` — resolves `file.md` "Anchor" prose
  citations against each cited file's headings and bold lead-ins (dependency-free
  awk); pairs with `lychee-offline`, which covers link/fragment targets.
- `.github/actions/exec-bit` — verifies every tracked shebang file carries git
  index mode 100755, so executable scripts keep their bit on checkout.
- `.github/actions/action-metadata-filename` — rejects any tracked
  `action.yaml` (GitHub also accepts this spelling, but every lane here globs
  `action.yml` only); repo-wide, not scoped to `.github/actions/`.
- `.github/actions/machine-specific-paths` — rejects machine-specific absolute /
  user-home paths in tracked files (portable placeholders allowed).
- `.github/actions/comment-hygiene` — scans comments for deferred-work markers
  (TODO/FIXME/HACK/XXX) and tracker references against its bundled organization
  policy, with an optional complete caller replacement.

  Local (non-CI) invocation of the four bespoke guards above is **not** owned
  here: use the standards `local-lane-guards` component
  ([pointer](docs/topics/local-lane-guards.md); standards ADR-0004 /
  ci-workflows#190). Composite actions remain the CI wrappers.
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

### Diff-scoping the ShellCheck lane

ShellCheck over a whole repository is a fixed cost that grows with the corpus
and not with the change: on a 766-file tree it measured 111 s per pull request
even after the batched fan-out. The `files` input exists so a caller can pay
that cost only for the files a pull request actually touched. It takes a list,
not search roots, and it wins over `paths`.

The caller computes the list. This repository's `change-detection` action
publishes only its `results` object, a per-filter-group `"true"`/`"false"` map,
so there is no changed-file output to feed in; the list comes from git:

```yaml
- name: List the shell scripts to check
  id: changed_shell
  env:
    BASE_REF: ${{ github.base_ref }}
  run: |
    changed="$(git diff --name-only --diff-filter=d "origin/$BASE_REF...HEAD")"
    # An .shellcheckrc edit changes what every file is judged against, so it
    # widens the list back to the whole tracked corpus rather than scoping.
    if grep -qxF '.shellcheckrc' <<<"$changed"; then
      list="$(git ls-files -- '*.sh' '*.bash')"
    else
      list="$(grep -E '\.(sh|bash)$' <<<"$changed" || true)"
    fi
    {
      echo 'files<<CHANGED_SHELL'
      echo "$list"
      echo CHANGED_SHELL
    } >>"$GITHUB_OUTPUT"

- name: Lint shell scripts
  if: steps.changed_shell.outputs.files != ''
  uses: melodic-software/ci-workflows/.github/actions/shellcheck@<sha> # <tag>
  with:
    files: ${{ steps.changed_shell.outputs.files }}
```

That step needs the base commit present, so it belongs after a checkout deep
enough to resolve `origin/$BASE_REF` (a `fetch-depth: 0` checkout, or the
caller's own base-fetch step).

The widening branch is not decoration. Once the step is gated on a non-empty
list, an empty list means "skip", so a pull request that edits only
`.shellcheckrc` would otherwise skip ShellCheck altogether: it changes no file
ending in `.sh` or `.bash` while changing what every such file is judged
against. Widening it back to the whole tracked corpus inside the same step
keeps the gate and the fallback compatible. The equivalent widening for a
sourced library is the caller's to name, because the composite cannot see which
scripts source what; a repository whose libraries carry no `.sh` extension
should add them to the same condition.

**The `if:` is load-bearing, and the reason is worth stating.** An empty list
and an unset input are the same empty string once YAML has rendered them, so
they are not distinguishable inside the action: a diff that touched no shell
script produces an empty output, `files` arrives blank, and the action falls
back to `paths` and scans the whole repository. That fallback is the safe
direction rather than the useless one, because a caller whose list computation
breaks or silently returns nothing gets a full scan rather than a green no-op,
but on the ordinary "this pull request changed no shell scripts" path it throws
away the whole saving. Gating the step on a non-empty list is what turns that
case into a skip. The notice-and-exit-0 path is therefore not this one: it is
reached when the list is non-blank and every entry in it is deleted or is not a
shell script, which is what a caller that hands over a raw unfiltered diff
produces.

**The fail-closed caveat is the caller's to answer, not this action's.** A
diff-scoped run only checks the files in the list, and some changes invalidate
findings in files that are not in it: an edit to `.shellcheckrc` changes what
every file is judged against, and an edit to a sourced library changes what its
sourcing scripts resolve. The action cannot see that, because all it receives
is the list. A caller that diff-scopes therefore has to widen back to the
whole repository when the diff touches those inputs, and it has to keep a
whole-repository run somewhere else, on `push` to the default branch or on a
schedule, so a gap is caught within a day rather than at the next unrelated
change.

## Reusable workflows

Hosted workflow defaults use explicit GA operating-system generations
(`ubuntu-24.04` and `windows-2025`) instead of moving `*-latest` aliases. This
keeps hosted/self-hosted parity reviews tied to a declared image contract while
GitHub continues the normal weekly patching of each hosted image generation.

- `.github/workflows/checks.yml` — the consolidated hygiene lane: **one job, one
  runner spin-up**, `change-detection` once, then every content-agnostic
  composite as a step. It replaces a fan-out of one job per tool, which is the
  cost it exists to remove, and it never calls a per-tool reusable workflow —
  composites are the unit of reuse. Required inputs: `runner` (no default; a
  hosted default would silently bill a private caller's pool) and `filters`
  (`change-detection` filter groups). `timeout-minutes` defaults to `15`.
  Twelve boolean toggles — `typos`, `gitleaks`, `editorconfig`, `markdown`,
  `shellcheck`, `actionlint`, `exec-bit`, `machine-specific-paths`,
  `eol-renormalize`, `comment-hygiene`, `lychee-offline`, `check-jsonschema` —
  turn composites off; all default `true` except `check-jsonschema`, whose
  `files` input is required and has no universal default (pass
  `check-jsonschema-files` and `check-jsonschema-builtin-schema`; one call
  carries one schema family). Enabling it with no `check-jsonschema-files`
  **fails the job** rather than skipping the validation: a gate that disappears
  on a typo is the failure mode this lane exists to prevent.
  `machine-specific-paths-exclude` and
  `comment-hygiene-exclude` pass a Git pathspec exclusion to those two scans.
  Every other composite input keeps its composite-side default. **Skipping is
  by filter group name**: a composite step is skipped when the caller declares
  a group named exactly after its toggle and that group evaluated `false`; an
  undeclared group leaves the composite ungated, because fail-open is the
  detection contract. Outputs: `results` (the detection JSON, verbatim) and
  `outcome` (`success` or `failure`). Every composite runs under
  `continue-on-error: true` and one join step names the first failure and fails
  the job, so one failing tool never hides the rest. Gate downstream lanes with
  `fromJSON(needs.checks.outputs.results || '{}')['<group>'] != 'false'`: a
  reusable workflow publishes no outputs when its job fails, so
  `needs.checks.result` stays the authoritative verdict. The caller's job block
  must grant `contents: read` and `pull-requests: read` — a called workflow
  cannot elevate, and the detection pass reads the pull request's file listing.
  `zizmor` is not among the toggles: it has no composite, only the reusable
  below, so callers that want it keep a separate job.

  The composites run by full path at a pinned SHA, because a relative action
  path inside a called workflow resolves against the caller's checkout. A
  tagged release therefore runs the composite bodies its pins name, one tag
  behind after a bump, and this repository's own `github-actions` Dependabot
  group moves those self-referencing pins like any other reference. That pin lag is why this repository keeps a
  `composites-head` job in its own `ci.yml`: it runs the same composites
  through `./.github/actions/<x>` so a pull request that changes a composite
  body is still exercised at HEAD instead of passing against the pinned copy.
  Phase 6b retires that job when GitHub's `$/` self-repository syntax becomes
  usable, which needs three things: actionlint shipping the `$/` support of
  rhysd/actionlint#732 in a version this repository pins, actions/runner#4669
  merging, and one measured cross-repository `$/` run.

  ```yaml
  jobs:
    checks:
      permissions:
        contents: read
        pull-requests: read
      uses: melodic-software/ci-workflows/.github/workflows/checks.yml@<sha>
      with:
        runner: ubuntu-24.04
        filters: |
          markdown:
            .github/**
            **/*.md
  ```

- `.github/workflows/pulumi-version-drift-check.yml` — reusable-only maintenance
  job for GitHub IaC callers. It accepts only a hosted default-branch push,
  schedule, or manual dispatch, compares the exact `.pulumi.version` pin with
  Pulumi's current stable release, and maintains one marker-identified auditable
  incident across rename or manual closure without resetting its age. It never
  changes or auto-merges a pin, retires resolved incidents instead of reusing
  them, and hard-fails after 14 days of unresolved drift. Drift detection runs
  on `actions/github-script` rather than a `gh`/`jq`-driven shell script: this
  reusable runs on whatever runner the caller selects, and a self-hosted image
  is not guaranteed to ship those CLIs, so the implementation lives directly in
  the workflow on the action's bundled Node runtime instead of a generated,
  equality-tested copy of a repo-local `.sh` source. Per-caller concurrency
  serializes issue mutation.
- `.github/workflows/issue-triage-label.yml` — applies a configured floor label
  (default `priority: needs-triage`) to an issue opened or reopened with no
  label matching a configured prefix (default `priority:`). **Non-gating**:
  never fails a PR or blocks a merge; it only guarantees new issues don't
  silently drop out of the triage queue for lack of a label. The guard is a
  label-**set** membership check (any label starting with `label-prefix`), not
  a title/body content match, so an explicit priority label at creation always
  wins. **Fail-closed on a missing label**: the raw add-labels endpoint
  auto-creates an unknown label name instead of failing, so this workflow
  first calls `GET /repos/{owner}/{repo}/labels/{name}` and hard-fails the job
  if that 404s, rather than ever letting a bare, undefined label get created.
  Label taxonomy stays github-iac-managed; this workflow only applies an
  existing label. Settled mechanism per
  [`claude-code-plugins`#506](https://github.com/melodic-software/claude-code-plugins/issues/506)'s
  research-resolution comment. The caller owns the trigger and **must**
  include `reopened` alongside `opened` so an issue reopened after its tier
  was cleared re-acquires the floor:

  ```yaml
  on:
    issues:
      types: [opened, reopened]
  permissions: {}
  jobs:
    issue-triage-label:
      permissions:
        issues: write
      uses: melodic-software/ci-workflows/.github/workflows/issue-triage-label.yml@<sha>
  ```

  Loop-safe by construction: adding a label emits `issues.labeled`, never
  `opened`/`reopened`, and GitHub does not start new workflow runs at all for
  `GITHUB_TOKEN`-authored events (except `workflow_dispatch`/
  `repository_dispatch`), so this cannot re-trigger itself. Idempotent: a
  re-run is a no-op once the target label or any other tier-prefixed label is
  present. A human triager assigning a real tier after this workflow ran is
  expected to remove the floor label as part of that transition — this
  workflow only guarantees a floor and does not police tier assignment.
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
  attestation token is never passed to checkout or PR mutation. It also arms
  GitHub auto-merge (squash) via the same target-scoped token on any sync PR
  auto-merge has *never* been armed on — unless the manifest opts that target
  out with `automerge: false`. Keying on arming history rather than on PR
  creation means a PR opened while a target was opted out is armed once the
  opt-out lifts, while a PR someone deliberately disarmed is never overridden.
  A rejected arm attempt (for example an already-mergeable PR) is logged and
  does not fail the sync — which is why the watchdog below detects a PR that
  was never armed as well as one that stayed armed but blocked. See
  `standards-sync-stuck-automerge-alert.yml`.
- `.github/workflows/standards-sync-stuck-automerge-alert.yml` — scans the
  standards-sync target repositories, read from the standards manifest at run
  time (never hardcoded), for open PRs authored by the standards-sync App in
  two states that stop a sync PR from merging itself, each past
  `threshold-hours` (default 4): **armed but stuck** (auto-merge on, GraphQL
  `mergeStateStatus: BLOCKED`), and **never armed** (no auto-merge and no
  auto-merge *enabled* event of any merge method in the timeline — a squash arm
  records `AutoSquashEnabledEvent` — in a target the manifest marks
  `automerge: true`). The second exists because the sync's arming step
  downgrades every rejection to a warning: a failed arm otherwise looks exactly
  like the status quo while the operator believes the PR is armed. Absence of
  an *enabled* event is what distinguishes arming that never took from
  auto-merge that was armed and later turned off, whether by a reviewer or by
  GitHub itself. A target opted out with `automerge: false` is never reported
  unarmed — that is the intended state, not an incident. Neither check covers
  an armed PR reporting a non-BLOCKED unmergeable state such as `DIRTY`.
  Consumed via `uses:` at job level from a *scheduled* caller. The tracking
  issue (a marker-deduped rolling report, the same mechanism `link-check.yml`
  and `release-gap-check.yml` use) is authored by the App, not by the
  caller's ambient token, so the caller grants no `issues:` scope and instead
  names the destination through the required `tracking-issue-repository`
  input: a bare repository name under the caller's own owner that the App is
  installed on. It is required rather than defaulted to the caller because the
  caller need not be — and for `melodic-software/standards`, the sync source,
  is not — a repository that installation covers. The run fails when it finds
  any — both states are actionable conditions, not flaky ones, so this is
  intentionally not advisory. A `test-mode` input (with a string
  `test-synthetic-candidates` count) skips live scanning and fabricates
  synthetic candidates under a test-only marker and title, so a dispatched
  caller can prove the tracking-issue create/update/close/fail lifecycle
  end-to-end without a real stuck PR and without touching the production
  rolling issue.
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
  **Advisory by default** (`fail-on-severity: never` surfaces PR annotations
  without failing); consumed via `uses:` at job level. The
  workflow downloads the official x86_64 GNU/Linux archive for the reviewed
  [v1.29.0 release][zizmor-release-v1-29-0], verifies its committed SHA-256
  before extraction, and verifies the CLI-reported version before auditing.
  `latest` remains accepted for compatibility but resolves to that reviewed
  default rather than a mutable release. zizmor runs in its own native
  `--format=github` mode, emitting a GitHub annotation for every finding
  directly and gating on severity via zizmor's own graduated exit codes
  (informational/low/medium/high) — no SARIF intermediate for gating, no
  hand-rolled parser. Callers opt into blocking by raising `fail-on-severity`
  to `low`, `medium`, or `high`; the legacy `fail-on-findings` boolean stays a
  back-compat alias for `low`. Installation, argument, and collection errors
  fail closed even in advisory mode. The verified binary
  runs from a fresh runner-temporary directory with a per-job cache and
  without Docker, a job/service container, or an installer-time privilege
  escalation.
  `runner` defaults to `ubuntu-24.04` and can consume the caller's governed
  managed runner label for eligible private, non-fork calls. Callers may
  opt into `upload-sarif: true` for durable code-scanning alerts
  (visibility-only — does not replace `fail-on-severity` gating). That opt-in
  requires the calling job to grant `security-events: write`; reusable
  workflows cannot elevate caller permissions, so the called job's
  `security-events: write` only applies when the caller already granted it.
  Inputs are documented inline.
- `.github/workflows/osv-scanner.yml` — dependency vulnerability scan with
  Google's official native OSV-Scanner v2.5.1 Linux X64 binary. The exact binary,
  its provenance, and the SLSA verifier are checksum-pinned; the verifier then
  attests the expected Google source repository and exact release tag before the
  scanner runs. One native SARIF scan emits escaped GitHub annotations without
  retaining or uploading an artifact. **Advisory for findings** (`fail-on-vuln`
  off by default); supply-chain, scanner, and invalid-result errors always fail
  closed. V2.5.1 scans
  supported manifests and lockfiles; .NET `.csproj`/`PackageReference` and
  Central Package Management are enabled by default. A committed
  `packages.lock.json` remains the reproducibility contract enforced by
  `dotnet-build`'s locked-mode restore, but is no longer the only .NET coverage
  path. An empty scan warns (advisory) or fails (blocking) unless the caller
  declares the repo genuinely dependency-less via `allow-no-lockfiles: true`.
  The caller must pass its governed managed runner label through `runner`; the native
  lane needs no Docker socket or privileged worker. Inputs are documented inline.
  See the [official v2.5.1 release][osv-release-v2-5].

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
  optional inputs on native `zizmor` preserve compatibility.
- `.github/workflows/dependabot-lock-regen.yml` — regenerates NuGet
  `packages.lock.json` on Dependabot PRs (`dotnet restore --force-evaluate`)
  and pushes the result back to the PR branch, covering the lock-file updates
  Dependabot's NuGet ecosystem misses. Self-guards to `dependabot[bot]` events
  on `dependabot/nuget/` branches, so the caller is a thin unconditional
  `pull_request` job granting `contents: write`. Inputs, the optional
  `PUSH_TOKEN` Dependabot secret, and the default-token no-retrigger caveat are
  documented inline.
- `.github/workflows/approval-agent.yml` — Approval Agent lane
  ([ci-workflows#256](https://github.com/melodic-software/ci-workflows/issues/256)).
  Guardrails always run (never approve own policy/workflow files; approver ≠
  author/pusher; refuse on human-risk findings). Live `APPROVE` is **opt-in**
  via `enable-approve: true` plus App secrets (default remains `COMMENTED`).
  Do not add it to production required checks until a fleet caller lands.
  Dogfood caller `approval-agent-self.yml` is `workflow_dispatch`-only.
  ADR + probe: `docs/topics/claude-review-lanes/approval-agent-ADR.md`.
- `.github/workflows/claude-assistant.yml` — org `@claude` mention-responder
  ([ci-workflows#255](https://github.com/melodic-software/ci-workflows/issues/255)).
  V1 is **answer / re-review only** (tool-allowlist floor; no Edit/Write, no
  commit/push/merge). Caller owns mention triggers + `@claude` guards;
  reusable owns pin, floor tools, timeout, concurrency. Dogfood caller
  `claude-assistant-self.yml`. ADR:
  `docs/topics/claude-review-lanes/claude-assistant-ADR.md`.
- `.github/workflows/claude-review.yml` — automated PR code review with
  `anthropics/claude-code-action`. All inputs have public-safe defaults
  documented inline in the workflow header (the authoritative list). Consume
  it per the [Claude lanes — shared consumption
  contract](#claude-lanes--shared-consumption-contract) below.
- `.github/workflows/claude-security-review.yml` — a dedicated LLM
  **security-review** pass with `anthropics/claude-code-action`, sibling of
  `claude-review.yml` with the same secrets interface and safe-handling model
  but a security-only prompt. It reviews the PR's changed files for the
  vulnerabilities static analysis misses — logic flaws, authorization gaps,
  injection surfaces, token/secret handling, dangerous workflow patterns
  (`pull_request_target`, script injection via the `github` context),
  permission-widening config changes, supply-chain pin loosening — and reports
  findings as a PR review with severity (CRITICAL/IMPORTANT/SUGGESTION) and a
  confidence axis, security only. The intended promotion path for the VERDICT
  is to flip to blocking on CRITICAL findings once the lane's precision is
  proven over a sustained window — an earned promotion (trust-before-scale).
  **Always-report shape:** a security pass on every PR is noise in a doc-heavy
  repo, so the lane scopes itself to security-sensitive surfaces — but the
  caller must NOT express that scope with a workflow-level `on.pull_request.paths`
  filter, because a path miss leaves a required check Pending forever and wedges
  every prose PR. Instead the caller triggers on all PR events and supplies that
  scope as a pattern list of root-anchored globs (workflow files,
  permission/settings configs, hook and shell scripts, auth/token-touching code,
  network-call sites); the workflow's `changes` job evaluates it and a
  not-applicable PR yields a name-stable skipped `security-review` check. After
  a successful review the lane persists the reviewed head in a marker comment;
  on later `synchronize` pushes it matches only the incremental delta, so a
  docs-only follow-up does not re-run a full security pass (deleting the marker
  forces a full re-review). A consumer's ruleset may make that EXECUTION check
  required (check context `<caller job> / security-review`); the VERDICT stays
  advisory.

  **Absent-check mitigation (ci-workflows#227):** an intermittent `pull_request`
  event-delivery gap can leave that required context ABSENT (not failed). Do
  not move the lane onto `pull_request_target` / `workflow_run`. Consumers
  should expose `workflow_dispatch` + `pr-number` on the caller (dogfood:
  `claude-security-review-self.yml`) so a missing context can be re-attached by
  dispatching the caller. The scheduled `security-review-absent-mitigate`
  companion that automated this is retired (ci-perf Phase 7); the historical
  design is `docs/topics/claude-review-lanes/security-review-absent-mitigation.md`.

  **Where that pattern list lives** is the caller's choice between two inputs.
  The conventional shape is `paths-file`, pointing at a repo-owned file
  (`.github/claude-security-paths`) so each repo keeps its own
  security-sensitive-surface list in its own tree; the inline `paths` input
  takes the same content directly and, when non-empty, wins over the file. The
  file is read from the PR's **base** branch, never the head, so a PR cannot
  edit its content to skip its own security review — repointing the input is
  still possible, but only as a visible caller diff, which is the pre-existing
  trust boundary. An absent or unreadable file **fails open** (every PR
  reviewed, with a warning), matching the `changes` job's fail-open discipline
  throughout; both inputs empty means no filtering, so a consumer that passes
  nothing is unaffected. Patterns are matched as root-anchored **gitignore**
  patterns rather than Actions `paths:` patterns — identical for the ordinary
  `*` / `**` globs worth writing here, but `!` negation cannot be honored as
  Actions defines it and is rejected outright, so express an exclusion by
  narrowing the positive patterns. All inputs have public-safe defaults
  documented inline
  in the workflow header (the authoritative list). Consume it per the [Claude
  lanes — shared consumption contract](#claude-lanes--shared-consumption-contract)
  below, triggering on all PR events (no workflow-level `paths:`):

  ```yaml
  with:
    paths-file: .github/claude-security-paths
  ```

- `.github/workflows/claude-e2e-verify.yml` — Claude-powered end-to-end
  verification of a PR with `anthropics/claude-code-action`. The caller passes a
  command that builds and serves its app plus the URL it listens on; the workflow
  provisions a pinned Playwright/Chromium toolchain, waits for the app to become
  healthy, then has the agent drive the running app through the caller's journeys
  and post its findings as a PR comment (the agent step runs
  `continue-on-error`). This workflow additionally owns the pinned browser
  toolchain. All inputs are documented inline in the workflow header (the
  authoritative list).
  Consume it per the [Claude lanes — shared consumption
  contract](#claude-lanes--shared-consumption-contract) below, with the caller
  additionally passing:

  ```yaml
      with:
        app-start-command: npm ci && npm run build && npm run start
        app-url: http://localhost:3000
  ```

  This lane builds, serves, and browser-drives the PR head — it executes
  PR-authored code — so the fork-PR safety guarantee in the shared contract is
  what makes it safe: a fork gets no secrets and a read-only token, so that
  execution has nothing to exfiltrate. The Playwright CLI version is an
  in-workflow pin watched by `tool-version-drift-check`, not Dependabot.
  Promotion: flip to a selector-coupled required gate when the lane's findings
  prove precision over a sustained window — an earned promotion, mirroring the
  review lane's discipline.

## Claude lanes — shared consumption contract

`claude-review.yml`, `claude-security-review.yml`, `claude-e2e-verify.yml`,
and `claude-assistant.yml` share one consumption shape. Each is **advisory**:
it posts PR/issue comments and never gates `ci-status`. (The advisory verdict
is separate from execution evidence: `claude-security-review.yml` scopes itself
to security-sensitive paths, and its name-stable `security-review` check may be
made a required status check — see its entry above. `claude-assistant.yml` is
mention-triggered answer/re-review, not a PR check.) Each is a whole-job
concern (job `permissions:` plus a `secrets:` interface), which is why each is
a reusable workflow rather than a composite action — the caller owns the
triggers and the permission grant, and the workflow owns the SHA-pinned
`anthropics/claude-code-action` and the safe handling. Security rules live in
[CLAUDE.md](CLAUDE.md).

```yaml
on:
  pull_request:
    types: [<per lane — see below>]
jobs:
  <lane>:
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    uses: melodic-software/ci-workflows/.github/workflows/<lane>.yml@<sha>
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

The caller's job must grant those three permissions (a called workflow can only
downgrade, not elevate); the `CLAUDE_CODE_OAUTH_TOKEN` org secret has
visibility "all repositories", so every org repo receives it. Pass that one
named secret explicitly rather than `secrets: inherit`, which forwards every
parent secret. Fork PRs receive no secrets by design and are not reviewed. On
both review lanes the caller can name actors whose comments are withheld from
the agent's context — prompt-injection hygiene, not a trigger gate.

**What the security lane's required check proves — and does not.** Only
`claude-security-review`'s check is designed to be required: it reports under
its own context (`<caller job> / security-review`), never through `ci-status`.
Its claim is narrow: a security pass RAN at this head, or the PR was judged not
applicable. The verdict stays advisory — findings never fail the job. Execution
is enforced in **two tiers**, split by whether the PR can clear the cause.
**Caller drift** — the action skipping itself because the caller's workflow file
differs from the default branch's copy — reports FAILURE, because `success`,
`neutral` and `skipped` all satisfy a required check, so failure is the only
conclusion that does not silently authorize a merge on absent evidence, and the
PR that caused it clears it by merging. An **external failure** — every class
the classifier emits: `auth` (dead credential, billing), `rate-limit` (usage
limit), `overloaded` (5xx), and the `other` catch-all, which also takes an
unparsable or missing execution file — emits a loud
`::warning` annotation and reports SUCCESS: the cause is outside the author's
and the org's control, and a required context that reddens on a provider outage
locks every merge in the fleet for the length of that outage. That mapping is
scoped to `pull_request` runs; a non-PR event cannot run the review at all and
keeps the historical pass-through, and a fork PR skips the job outright —
neither green is execution evidence.

The corollary is what the check does not prove. Every non-run reads as success
to a ruleset. Four are name-stable job-level skips: a fork PR, an out-of-scope
PR, a skip-listed actor, a kill-switched lane. A fifth is not a skip at all — a
run whose head was superseded while it queued retires itself step by step and
reports a **green** job having reviewed nothing, on the premise that the newer
run for the current head reports the same context. The sixth is the
external-failure tier above: a classified infrastructure failure now also
reports green, deliberately. So a green required check is not by itself proof
that this head was reviewed, and it never establishes that a fork PR was:
review fork changes to security-sensitive surfaces by hand.

What that sixth shape costs is worth stating plainly: during a provider outage,
merges land unreviewed behind a green required check. The alarm moves off the
conclusion onto three surfaces that never depended on it — the outcome
composite's machine-readable `class=<token>` annotation, the failure marker
comment on the PR, and the incident aggregator, which reads lane annotations
regardless of check-run conclusion and escalates the auth and runner classes —
and a rate-limit storm across several distinct PRs in one polling cycle, the
shape of an exhausted shared seat — to the attended queue. Availability on that tier is bought by the loud-open itself, helped by
the bounded retry below; break-glass on the consumer's ruleset remains the
override for caller drift and for any other red an operator must clear by hand.

That floor has an edge worth knowing. It covers what the lane can **classify**,
which means the ruling step has to be reached — a run that dies before it still
reddens the check. A genuine runner fault, the job hitting its 45-minute
`timeout-minutes`, or a pre-ruling step throwing (the resolve and outcome steps
carry no `continue-on-error`, so a crashed classifier fails rather than passing
through) all land outside the floor. Step-level timeouts are inside it at the
default configuration: each attempt is bounded at 18 minutes behind
`continue-on-error`, and at the default `retry-delay-seconds` the retry budget
fits under the job's 45-minute ceiling. A caller that raises
`retry-delay-seconds` far enough can push the retry past that ceiling, landing
the run in the job-timeout shape above — outside the floor. The guarantee is "no classified failure blocks a
merge", not "no infrastructure problem ever blocks one".

**Trigger cadence is per lane, deliberately.** `claude-review` runs on
`opened` / `ready_for_review` / `reopened` and **not** on `synchronize`: a push
does not re-trigger the code review, so re-run the job or `workflow_dispatch`
with the PR number (ci-workflows#254) for a fresh pass. That
caps per-PR spend on active branches, and it is safe precisely because the
lane's verdict gates nothing. It also skips draft PRs at job level, so an
`opened` event on a draft costs nothing and `ready_for_review` is what buys the
review. `claude-security-review` keeps `synchronize`, because its check
certifies that a security pass ran at the head being merged — a review of an
earlier head is not that evidence, and it reviews drafts. After a successful
review it persists that head and, on later pushes, skips with a name-stable
success when the incremental delta touches no security-relevant paths
(ci-workflows#259). It also accepts `workflow_dispatch` + `pr-number` so an
absent required check from a `pull_request` delivery gap can be re-attached
without privileged triggers (ci-workflows#227; see
`docs/topics/claude-review-lanes/security-review-absent-mitigation.md`).
`claude-e2e-verify`
keeps `synchronize` too, and gates on nothing but its kill-switches — no draft
skip, no `skip-actors` input — so the most expensive lane has the loosest gate.
Scope it with the caller's own trigger types. Take each lane's canonical caller
from its own workflow header.

**Bounded retry.** Every lane makes at most **two** agent attempts — one
automatic retry, never a loop. The retry is deliberately narrow, because a
second attempt after the agent has already spoken duplicates its comments: it
fires only on **zero assistant turns** in the first attempt's execution file.
Nor does an **auth-class** failure retry — HTTP 401/402/403, or an
`authentication_error` / `billing_error` / `permission_error` in the error
payload — because the credential needs an operator and no retry can clear it.
The gate also honors the same guards the first attempt does, so a superseded
run (and, on the code-review lane, a capped one) never spends a retry. Between
the attempts the lane backs off `retry-delay-seconds` plus a 0–29 second
jitter, so lanes retrying against the same contended seat do not re-collide in
lockstep. What this buys on the security lane is a real review against the
sporadic-429 class, rather than the evidence gap its loud-open tier would
otherwise leave behind.

One divergence is worth knowing. The two review lanes demand **proof** of zero
turns: a missing or unparsable execution file is not proof — a hard kill can
lose the file after turns were already spent — so they do not retry on one.
`claude-e2e-verify` reads an unreadable file as recording no assistant turn and
does retry. It also sets no `track_progress` tracking comment, so it has no
orphan comment to clean up between attempts, which the review lanes do.

**Review-count cap (code-review lane only).** `claude-review.yml` stops
reviewing a PR after `max-reviews-per-pr` successful reviews, capping spend on
long-lived PRs. The counter is a **visible** per-PR status comment upserted
after each successful review — failed and skipped runs never inflate it — which
doubles as the human "was this reviewed" signal;
deleting it resets the count, which is fail-open by design. A capped run is a
name-stable skip, not a red check. Treat it as a soft cap: concurrent runs for
different heads read the counter before either writes it, so a burst can
briefly exceed it by the number of concurrent heads.

**Kill-switches.** Every lane honors two Actions variables at job level:
`CLAUDE_LANES_DISABLED` (all lanes) and a per-lane switch
(`CLAUDE_REVIEW_DISABLED`, `CLAUDE_SECURITY_REVIEW_DISABLED`,
`CLAUDE_E2E_VERIFY_DISABLED`). `true` skips the lane's job name-stably — a
required security-review check reads the skip as success, so merges are never
wedged. An absent variable means enabled; a repository-level variable
overrides an organization-level one, so a single repo can opt out (or back
in) without an org-wide change. Incident use: set the org-level variable to
`true` to stop a misbehaving lane fleet-wide. While the security lane is
disabled NO lane reports security findings — REVIEW.md's code-review
exclusion keys on the security workflow file existing, and the file remains —
so re-enable promptly and treat the outage window as security-unreviewed.

All four organization variables carry **all-repositories** visibility. That is
a deliberate deviation from the org's selected-visibility convention for
Actions variables, not an oversight: a switch scoped to a selection is invisible
to every repo outside it, so flipping it during an incident would silently
no-op exactly where nobody is looking. A kill-switch is only worth having if it
reaches the whole fleet. Do not "correct" the visibility to selected.

**Adoption.** Each lane's own workflow header carries its canonical caller;
copy it from there. Callers are additionally being brought under the org's
sync-managed component distribution in
[`melodic-software/standards`](https://github.com/melodic-software/standards),
which materializes a canonical per-lane caller into every target repo and keeps
it current through the ordinary sync PR. Where a repo's caller is
sync-managed, change it at the component source and let the sync carry it to
every target — never edit the materialized caller in the target repo.

## Triage: fleet-wide single-workflow failure spikes

Before attributing a sudden, fleet-wide spike of failures in one reusable
workflow to infrastructure flake, check that reusable's commit history and its
job's runner routing (`runs-on:`, and which managed label the caller passes)
first. A recent change that shells out to a CLI (`gh`,
`jq`, …) combined with a routing change that moved callers onto a runner image
without that CLI produces exactly this signature: many unrelated repos failing
the same check at once, often with a low-level exit code rather than an
application-level error.

Lesson from the 2026-07-18 `do-not-merge` spike (~191 failures across 6
repos, `exit 127: gh: command not found`): `do-not-merge-gate.yml`'s label
refetch ran `gh api` in a `run:` step on a runner the caller selects, and a
routing shift landed it on a self-hosted image that does not ship the gh CLI.
Fixed in [#144](https://github.com/melodic-software/ci-workflows/pull/144) by
porting to `actions/github-script`, which runs on the action's own bundled
Node runtime and has no runner-image tooling dependency; the remaining
gh-calling reusables were audited and ported the same way in
[#209](https://github.com/melodic-software/ci-workflows/issues/209). See
REVIEW.md's "Always check" criterion for the standing rule this established.

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
`fixtures/` exist only to exercise action and CI-check contracts; they are not
mirrors of the standards catalog.

[lefthook-config]: https://lefthook.dev/usage/envs/LEFTHOOK_CONFIG/
[lefthook-extends]: https://lefthook.dev/configuration/extends/
[lefthook-validate]: https://lefthook.dev/usage/commands/validate/
[nested-pin-discussion]: https://github.com/orgs/community/discussions/70237
[osv-installation]: https://google.github.io/osv-scanner/installation/
[osv-release-v2-5]: https://github.com/google/osv-scanner/releases/tag/v2.5.1
[pssa-1708]: https://github.com/PowerShell/PSScriptAnalyzer/issues/1708
[pulumi-oidc]: https://www.pulumi.com/docs/administration/access-identity/oidc-issuers/
[pulumi-stack-export]: https://www.pulumi.com/docs/iac/cli/commands/pulumi_stack_export/
[releasing-actions]: https://docs.github.com/en/actions/creating-actions/releasing-and-maintaining-actions
[reuse-workflows]: https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
[reusing-workflow-configurations]: https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations
[semver]: https://semver.org/
[zizmor-release-v1-29-0]: https://github.com/zizmorcore/zizmor/releases/tag/v1.29.0
