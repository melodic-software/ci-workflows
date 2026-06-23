# CLAUDE.md

Guidance for working in this repo. The [README](README.md) covers what each
building block does and the consumer contract; this file captures the rules a
change must not violate.

## Security ground rules — `claude-review` reusable workflow

The PR-review workflow runs an AI agent with an org credential on a **public**
repo. These rules are load-bearing; changing any of them needs explicit review.

- **`pull_request` only; never `pull_request_target` or `workflow_run` with
  secrets.** Those triggers run in a privileged context (base-repo secrets +
  write token) over potentially untrusted fork code — the "pwn request" class,
  i.e. token exfiltration. The workflow keeps a tripwire step that hard-fails on
  those two events. Do not whitelist a single event (that would block a
  consumer's legitimate `workflow_dispatch` / `schedule`); reject only the
  dangerous two.
- **Fork PRs are intentionally not reviewed.** GitHub passes no secrets and a
  read-only token to fork-triggered `pull_request` runs, so the review degrades
  to a warning. That is the safety guarantee, not a bug — never "fix" it by
  reaching for `pull_request_target`.
- **SHA-pin both layers.** Consumers pin this reusable workflow `@<40-char-sha>`;
  this workflow pins `anthropics/claude-code-action@<sha>` (mutable tags were the
  tj-actions/CVE-2025-30066 vector). Dependabot bumps the inner pin.
- **Least privilege, owned by the caller.** A called workflow can only *downgrade*
  the caller's `GITHUB_TOKEN` grant, so the consumer's caller job must grant
  exactly `contents: read` + `pull-requests: write` + `id-token: write`
  (`id-token` mints the Claude GitHub App token and is required even with an
  OAuth/API-key credential). The review job re-declares that minimal set so an
  over-granting caller is still narrowed here.
- **Never widen the secret.** `CLAUDE_CODE_OAUTH_TOKEN` is an org secret scoped to
  *selected repositories* in the UI. Add an adopting repo to that list; never use
  "all repositories" / a visibility that exposes it to public repos.
- **Public-repo log hygiene.** Keep `display_report` and `show_full_output` off
  (defaults) — both can surface model-authored content or secrets in publicly
  visible logs. Never enable Actions debug (`ACTIONS_STEP_DEBUG`) here. Never
  echo the token.
- **No untrusted checkout before the action.** Do not check out a PR head ref
  into the workspace root ahead of the action step.

The `secrets:`/`vars:` context is unavailable in composite actions; that, plus
the need for job-level `permissions` and the `secrets:` interface, is why review
is a reusable workflow and the tool-runner lanes are composite actions.

## Pin everything by SHA

Every `uses:` (workflows and actions, first-party included) pins a full commit
SHA with the version as a trailing `# vX.Y.Z` comment so Dependabot updates both
the pin and the comment. This is enforced repo-wide, not just for review.
