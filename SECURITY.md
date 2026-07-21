# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately via GitHub's **Report a
vulnerability** flow (repo **Security** tab → **Report a
vulnerability**) — opens private advisory, maintainers-only.
No public issue or PR for security report.

Include affected action/workflow, commit SHA referenced, description or
proof of concept. Expect an initial acknowledgement within a few
business days.

## Supported versions

Repo publishes composite actions and reusable workflows, consumed by
reference. No released version stream: security fixes land on `main`,
consumers pick up via advancing pinned commit SHA (Dependabot
auto-opens bump PRs).

## How to consume securely

- **Pin by full commit SHA**, never branch or tag — full-length SHA
  only immutable reference, kept SHA-pinned consumers immune to
  tag-rewrite supply-chain attacks. Keep the `github-actions` Dependabot
  ecosystem enabled so pins stay current.
- **Set least-privilege `permissions:` in your own jobs.** Composite action
  runs inline in calling job, inherits that job's `GITHUB_TOKEN` scopes;
  cannot reduce them for you. Start from `permissions: {}`, grant only
  what lane needs.
- **Keep default workflow token read-only** at org and repo level,
  grant write scopes per job only where required.
