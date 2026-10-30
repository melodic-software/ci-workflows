# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately via GitHub's **Report a
vulnerability** flow (repo **Security** tab → **Report a
vulnerability**) — opens private advisory, maintainers-only.
No public issue or PR for security report.

Include affected action/workflow, commit SHA referenced, description or
proof of concept. Expect an initial acknowledgment within a few
business days.

## Supported versions

Repo publishes composite actions and reusable workflows, consumed by
reference. melodic-software consumers reference reusable workflows at
`@main`, so a fix on `main` reaches them on their next run. They pin actions to
a full commit SHA, which the org Actions policy requires, and move that pin by
reviewed pull request, as other consumers do for every reference.

## How to consume securely

- **Outside melodic-software, pin by full commit SHA**, never branch or
  tag: the full-length SHA is the only immutable reference. Keep this
  repository out of Dependabot's `github-actions` updates (an `ignore`
  entry) and move the pin by reviewed pull request.
- **Set least-privilege `permissions:` in your own jobs.** Composite action
  runs inline in calling job, inherits that job's `GITHUB_TOKEN` scopes;
  cannot reduce them for you. Start from `permissions: {}`, grant only
  what lane needs.
- **Keep default workflow token read-only** at org and repo level,
  grant write scopes per job only where required.
