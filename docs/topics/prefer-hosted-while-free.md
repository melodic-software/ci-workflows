# Billing-aware runner routing (`prefer-hosted-while-free`)

Track: [ci-workflows#252](https://github.com/melodic-software/ci-workflows/issues/252).

## Goal

Public repos always take the hosted route (free). Private repos consume included
hosted minutes first while pool headroom exists and no private paid spend is
visible; otherwise — and on any billing-state error — route to the self-hosted
fleet. The selector job itself stays fleet-routed under this policy so it does
not share the hosted cap's failure domain.

## Phase 0 probe (2026-08-12) — GATE PASSED (classic PAT)

| Endpoint | Result |
| --- | --- |
| `GET /organizations/melodic-software/settings/billing/usage` | **HTTP 200** |
| `GET /organizations/melodic-software/settings/billing/usage/summary` | **HTTP 200** |
| `GET /organizations/melodic-software/settings/billing/budgets` | **HTTP 200** |
| Legacy `GET /orgs/.../settings/billing/actions` | HTTP 410 (removed) |

**Credential that worked:** classic PAT with `admin:org` (accepted OAuth scope
header: `admin:org, repo`).

**App-token path:** not exercised in this environment (observer App private key
unavailable to the probe host). OpenAPI marks the usage endpoints
`enabledForGitHubApps: true`. The [permissions-required for GitHub
Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
table places them under **Organization permissions for "Administration"**
(read). That maps to App permission:

| Field | Value |
| --- | --- |
| App permission name | `organization_administration` |
| Access | `read` |
| `create-github-app-token` input | `permission-organization-administration: read` |
| Classic PAT equivalent | `admin:org` |

`melodic-ci-runner-observer` today grants runner/inventory reads only — it does
**not** yet include `organization_administration: read`. Extend that App (or a
dedicated billing-reader App) in github-iac before an installation-token poll
replaces the PAT. Fine-grained PATs remain unsupported; `GITHUB_TOKEN` can never
read billing.

**August 2026 headroom (private standard hosted minutes, Team 3 000 included):**
probe measured **543 / 3 000 (18.1 %)** with `hasPaidSpend=false` → state
`free`. Re-run:

```bash
node .github/scripts/probe-billing-usage.cjs --json
# optionally cache for selectors:
node .github/scripts/probe-billing-usage.cjs --write-variable
```

## Policy contract

| `billing-minutes-state` / `CI_HOSTED_MINUTES_STATE` | Private-repo route | Reason |
| --- | --- | --- |
| `free` | hosted | `hosted-while-free` |
| `exhausted` | fleet (CI-tier blind-queue) | `hosted-pool-exhausted` |
| `unknown` / missing / malformed | fleet | `billing-unknown` |

Public repos and non-local events still short-circuit to hosted (`hosted-only`)
before billing state is consulted.

Callers:

```yaml
jobs:
  select-runner:
    uses: melodic-software/ci-workflows/.github/workflows/select-runner.yml@<sha>
    with:
      policy: prefer-hosted-while-free
      billing-minutes-state: ${{ vars.CI_HOSTED_MINUTES_STATE }}
      self-hosted-label: ${{ vars.CI_SELF_HOSTED_LABEL }}
      hosted-runner: ${{ vars.CI_HOSTED_RUNNER }}
      scope: ${{ vars.CI_RUNNER_SCOPE }}
      managed-runner-prefix: ${{ vars.CI_MANAGED_RUNNER_PREFIX }}
      observer-client-id: ${{ vars.CI_RUNNER_OBSERVER_CLIENT_ID }}
    secrets:
      observer-private-key: ${{ secrets.CI_RUNNER_OBSERVER_PRIVATE_KEY }}
```

Org-wide `CI_RUNNER_POLICY` may stay `self-hosted-only` until enrolled callers
pin a SHA that understands `prefer-hosted-while-free` (an unknown policy on an
older pin falls through to hosted via `missing-config`). Flip the variable only
after that pin-bump rollout.

## Thresholds

- Included minutes default: **3 000** (GitHub Team / Pro).
- Prefer hosted while private consumption **&lt; 85 %** of included **and** no
  private paid spend (`netAmount > 0` on a standard hosted minute row).
- Public-repo minutes are excluded from the pool (same rule as ci-runner's
  budget monitor).
