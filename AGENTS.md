# AGENTS.md

This repo (`melodic-software/ci-workflows`) is a library of **reusable GitHub
Actions workflows and composite actions**. There is no long-running server to
boot: consumers reference the actions/workflows by SHA, and the repo *dogfoods*
itself — its own `.github/workflows/ci.yml` runs its actions against small
fixtures under `fixtures/` and self-test suites under `.github/`.

For the contribution/security contract see [`CLAUDE.md`](CLAUDE.md); for what
each building block does see [`README.md`](README.md). `ci.yml` is the source of
truth for how every lane is invoked.

## Cursor Cloud specific instructions

"Running the application" here means running the dogfood **self-test suites and
lint lanes** locally — there is no UI or service. The environment snapshot
already has the required toolchain installed; the update script is a no-op
because the repo has **no dependency manifest** (no `package.json`, no lockfile,
no `requirements.txt`) — every tool is pinned and installed inside CI jobs, and
baked into this snapshot for local use.

### Toolchain baked into the snapshot

- Node `24.18.0` via nvm (CI-pinned for `node --test`), plus the infra-provided
  Node 22 on `PATH`.
- PowerShell `pwsh` 7.4.6 with modules `PSScriptAnalyzer 1.25.0` and
  `Pester 6.0.0` (`CurrentUser` scope).
- `shellcheck` 0.11.0, `lefthook` 2.1.10, `yq` 4.53.3 (mikefarah/Go), `jq`, `go`.

### Non-obvious gotchas (read before running)

- **`node` on `PATH` is v22, not the CI-pinned 24.18.0.** `/exec-daemon/node`
  (v22) shadows the nvm install. All suites pass on both, but to match CI use
  the explicit path `~/.nvm/versions/node/v24.18.0/bin/node` (or
  `nvm exec 24.18.0 node ...`).
- **`yq` flavor and version matter for the PowerShell composite scan.**
  `.github/scripts/Invoke-CompositeRunPssa.ps1` needs mikefarah's Go `yq` whose
  `"\t"` renders a real tab. The default `/usr/bin/yq` is a jq-based `yq` (wrong
  flavor), and mikefarah `yq` 4.43–4.45 emit a literal `\t` and break the scan;
  the CI runner uses 4.53.3. `/usr/local/bin/yq` (4.53.3) is installed to shadow
  the wrong one — keep it first on `PATH`.
- Some bash tests read `RUNNER_TEMP`; they fall back to `/tmp`, so no export is
  required locally.

### Run the suites (mirrors `ci.yml`)

- Node contracts: `~/.nvm/versions/node/v24.18.0/bin/node --test .github/scripts/*.test.cjs`
  and `... --test .github/actions/claude-lane-outcome/*.test.cjs`.
- Bash self-tests: run each `*.test.sh` under `.github/scripts/` and
  `.github/actions/*/` (plus `.github/actions/comment-hygiene/superset-test.sh`)
  with `bash <path>`.
- PowerShell: `pwsh -File .github/scripts/Invoke-CompositeRunPssa.ps1` and its
  `*.test.ps1`; Pester: `pwsh -Command "Invoke-Pester -Path fixtures/pester -CI"`.
- Shell lint: `shellcheck $(git ls-files '*.sh' '*.bash')` (reads
  `.shellcheckrc`).

### Optional language lanes (not installed)

The `.NET` (`global.json` pins SDK `10.0.302`), `Go`, `Python` (via `uv`), and
`JS/TS` (via `npx`) lanes only exercise fixtures under `fixtures/` and each need
an extra toolchain. Install on demand if working on those lanes; see the
corresponding jobs in `.github/workflows/ci.yml`.
