# CLAUDE.md

Guidance for working in this repo. The [README](README.md) covers what each
building block does and the consumer contract; this file captures the rules a
change must not violate.

## Security ground rules — the Claude lane reusable workflows

`claude-review.yml`, `claude-security-review.yml`, and `claude-e2e-verify.yml`
each run an AI agent with an org credential on a **public** repo, and each
workflow's `SECURITY MODEL` header block cites this file for the rationale.
These rules are load-bearing; changing any of them needs explicit review.

- **`pull_request` only; never `pull_request_target` or `workflow_run` with
  secrets.** Those triggers run in a privileged context (base-repo secrets +
  write token) over potentially untrusted fork code — the "pwn request" class,
  i.e. token exfiltration. Each workflow keeps a tripwire step that hard-fails
  on those two events. Do not whitelist a single event (that would block a
  consumer's legitimate `workflow_dispatch` / `schedule`); reject only the
  dangerous two.
- **Fork PRs are intentionally not reviewed.** GitHub passes no secrets and a
  read-only token to fork-triggered `pull_request` runs, so the agent cannot
  run. `claude-review` and `claude-e2e-verify` let it degrade to a warning;
  `claude-security-review` skips the job at job level instead, because its
  fail-closed mapping would otherwise pin every fork PR red for a cause no push
  can fix — and because that skip reads as success, its required check does not
  prove a fork PR was reviewed, so fork changes to security-sensitive surfaces
  need a human. The no-secrets guarantee is the safety property, not a bug —
  never "fix" it by reaching for `pull_request_target`.
- **SHA-pin both layers.** Consumers pin this reusable workflow `@<40-char-sha>`;
  this workflow pins `anthropics/claude-code-action@<sha>` (mutable tags were the
  tj-actions/CVE-2025-30066 vector). Dependabot bumps the inner pin.
- **Least privilege, owned by the caller.** A called workflow can only *downgrade*
  the caller's `GITHUB_TOKEN` grant, so the consumer's caller job must grant
  exactly `contents: read` + `pull-requests: write` + `id-token: write`
  (`id-token` mints the Claude GitHub App token and is required even with an
  OAuth/API-key credential). Each lane's job re-declares that minimal set so an
  over-granting caller is still narrowed here.
- **Never touch the org secret.** `CLAUDE_CODE_OAUTH_TOKEN` is an org secret
  with visibility *all repositories* — the live, deliberate value. Never
  revoke, edit, or re-scope it from automation, and do not "correct" it to
  selected-repositories. Forced-failure testing uses a repo-level same-name
  override in a sandbox repo, never a change to the org secret.
- **Public-repo log hygiene.** Keep `display_report` and `show_full_output` off
  — both can surface model-authored content or secrets in publicly visible
  logs. No lane sets `show_full_output`, so it stays at the action's off
  default. `display_report` is enforced unevenly, and deliberately so:
  `claude-security-review` hardcodes it `false` so a consumer cannot turn it
  on, `claude-e2e-verify` never sets it, and `claude-review` exposes it as an
  input for private consumers — **a public caller must never set
  `display-report: true`**. Never enable Actions debug (`ACTIONS_STEP_DEBUG`)
  here. Never echo the token.
- **Never execute PR-authored code in a review job.** All three lanes check out
  before the action step, and on `pull_request` the default checkout resolves to
  the PR merge ref, so PR-authored file content is already in the workspace root
  — presence is not the hazard, execution is. Never point a checkout at the PR
  head ref, and never run a build, install script, or test command against that
  tree in a review lane. `claude-e2e-verify` is the
  deliberate exception, because building, serving, and browser-driving the PR
  head *is* that lane: it runs PR-authored code on the runner alongside the
  persisted `GITHUB_TOKEN` and the agent's credential. That residual is
  accepted, not mitigated in-job; the reasoning, its bound (the
  `pull_request`-only tripwire plus the fork-PR no-secrets guarantee), and the
  hardening direction if the lane's scope widens are recorded in that
  workflow's own header. Do not widen it, and do not carry the pattern into a
  review lane.

The `secrets:`/`vars:` context is unavailable in composite actions; that, plus
the need for job-level `permissions` and the `secrets:` interface, is why each
Claude lane is a reusable workflow and the tool-runner lanes are composite
actions.

## Pin everything by SHA

Every `uses:` (workflows and actions, first-party included) pins a full commit
SHA with the version as a trailing `# vX.Y.Z` comment so Dependabot updates both
the pin and the comment. This is enforced repo-wide, not just for review.

Dependabot covers only those `uses:` SHAs. The tool versions pinned inside the
actions — each `version:`/`analyzer-version:` input default and the
checksum-verified install URLs — have no manifest it can read, so they are not
auto-bumped. The `tool-version-drift-check` workflow watches each tool's
upstream releases and files an advisory tracking issue when a default falls
behind; the operator absorbs the bump (recomputing the paired `sha256:` for
binary-install lanes).
