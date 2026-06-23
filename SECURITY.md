# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's **Report a
vulnerability** flow (the repository **Security** tab → **Report a
vulnerability**), which opens a private advisory visible only to maintainers.
Please do not open a public issue or pull request for a security report.

Include the affected action or workflow, the commit SHA you referenced, and a
description or proof of concept. Expect an initial acknowledgement within a few
business days.

## Supported versions

This repository publishes composite actions and reusable workflows that are
consumed by reference. There is no released version stream: security fixes land
on `main`, and consumers pick them up by advancing the pinned commit SHA
(Dependabot opens those bump PRs automatically).

## How to consume securely

- **Pin by full commit SHA**, never a branch or tag — a full-length SHA is the
  only immutable reference, and it is what kept SHA-pinned consumers immune to
  tag-rewrite supply-chain attacks. Keep the `github-actions` Dependabot
  ecosystem enabled so pins stay current.
- **Set least-privilege `permissions:` in your own jobs.** A composite action
  runs inline in the calling job and inherits that job's `GITHUB_TOKEN` scopes;
  it cannot reduce them for you. Start from `permissions: {}` and grant only
  what a lane needs.
- **Keep the default workflow token read-only** at the org and repository level,
  and grant write scopes per job only where required.
