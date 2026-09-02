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
| Timestamped JSON `{"state":"free","probedAt":"...","month":"YYYY-MM"}` (age ≤ 12h, current month) | hosted | `hosted-while-free` |
| `exhausted` or JSON with that state | fleet (CI-tier blind-queue) | `hosted-pool-exhausted` |
| `unknown` / missing / malformed / compact `free` / stale `free` | fleet | `billing-unknown` |

Compact untimestamped `free` is rejected: a stuck probe must not keep routing
hosted across a broken poll window. Failed probes with `--write-variable`
overwrite the org vars with `{"state":"unknown",...}`.

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
- Prefer hosted while private **pool draw** (`Σ quantity × multiplier`, see
  below) **&lt; 85 %** of included **and** no
  private paid spend (`netAmount > 0` on a standard hosted minute row).
- Public-repo minutes are excluded from the pool (same rule as ci-runner's
  budget monitor).

## Pool multipliers and fail-closed SKU handling

Fixed in [ci-workflows#519](https://github.com/melodic-software/ci-workflows/issues/519).
The earlier allowlist (`Actions Linux`, `Actions Linux Slim`, `Actions Windows`)
silently ignored every other Actions minute row, so 300 private macOS minutes —
a full 3000-minute pool at 10× — read as `privateMinutes = 0` and produced a
false `free`. `billing-headroom.cjs` now maps each **standard** hosted SKU to
the multiplier at which it draws the included pool and compares
`Σ quantity × multiplier` against `includedMinutes × 0.85`.

| Standard SKU (usage-API display name / billing id) | Multiplier | Per-minute rate |
| --- | --- | --- |
| `Actions Linux` / `actions_linux` | 1 | $0.006 |
| `Actions Linux Slim` / `actions_linux_slim` | 1 (floor; **not** credited below 1) | $0.002 |
| `Actions Linux ARM` / `actions_linux_arm` | 1 | $0.005 |
| `Actions Windows` / `actions_windows` (+ ARM) | 2 | $0.010 |
| `Actions macOS`, `Actions macOS 3-core`, `Actions macOS 4-core` / `actions_macos` | 10 | $0.062 |

Two sources are merged **fail-closed** — a SKU is never credited below its
documented legacy multiplier:

- Legacy included-pool multipliers (removed from current docs, still what the
  pool empirically draws at): Linux 1, Windows 2, macOS 10.
- Current per-minute rates from
  [Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing).
  macOS / Linux x64 is ≈ 10.33; 10 is the documented legacy floor and is the
  value used. Linux Slim's cheaper rate is deliberately **not** turned into a
  sub-1 multiplier, because undercounting draw is exactly the direction a
  false `free` comes from.

Every Actions minute row (`product = actions`, unit `Minutes`) is classified
and the evaluation **refuses to return `free`** — it throws, the probe records
`{"state":"unknown","error":...}` and exits 1, and the selector routes to the
fleet — when any of these hold:

| Row | Outcome |
| --- | --- |
| Standard SKU, private or unknown-visibility repo | counted at its multiplier |
| Standard SKU, public repo | excluded (does not draw the pool) |
| Larger-runner SKU (`linux_4_core`, `macos_l`, `windows_8_core_arm`, …) on a **private or unknown-visibility** repo | `unknown` — "included minutes cannot be used for larger runners", so paid Actions usage exists and no free headroom can be claimed |
| Larger-runner SKU on a **public** repo | excluded (paid, but never draws the private pool) |
| **Any SKU not in either table** | `unknown` — never ignored, never counted as raw minutes without a multiplier |
| Row missing `organizationName` / `repositoryName` / `sku` / finite `quantity` | `unknown` |

Adding a new hosted SKU therefore means adding it to
`STANDARD_HOSTED_SKU_MULTIPLIERS` (with its multiplier) or
`LARGER_RUNNER_SKU_IDS` in `billing-headroom.cjs`; until then the probe reports
`unknown`, which is the honest answer.

### Repo visibility is also fail-closed

The probe's `resolveVisibility` returns `"private"` / `"public"` only when
`GET /repos/{owner}/{repo}` yields a body with a boolean `private`. An empty
body, `null`, or a body without that field returns `"unknown"`, which the math
counts against the pool. The earlier `data?.private ? "private" : "public"`
turned those cases into `"public"` and dropped the minutes — a fail-open in a
function the headroom contract documents as fail-closed.

## `hasPaidSpend` is a tripwire, not a guard (accepted)

`netAmount > 0` on a private standard row still forces `exhausted`, and it
stays in place as a harmless additional tripwire. It is **empirically dead**
under this org's configuration: with a $0 Actions budget and
`prevent_further_usage: true`, overage is blocked before it bills, and across
all live minute rows every one has `discountAmount == grossAmount` and
`netAmount == 0`. `withinThreshold && !hasPaidSpend` reads as two independent
guards but is effectively one. The real guards are the pool math above and the
fail-closed handling of unknown SKUs and unknown visibility. This is accepted;
no Budgets-API dependency is added for it.

## Freshness is not correctness

`probedAt` and the selector's 12h staleness window attest to **when** the probe
ran — nothing more. They do **not** attest that the usage report was complete,
that every SKU was interpreted with the right multiplier, or that every repo's
visibility resolved. A fresh, well-formed, month-matching `{"state":"free",...}`
payload can still be wrong; the staleness guard catches stale answers and has
no mechanism to catch incorrect ones. That is why the math above refuses `free`
on anything it cannot account for rather than emitting a confident payload from
partial data. When touching the probe or the headroom math, ask "could this
path emit `free` from incomplete input?" — the freshness check will not save
you.
