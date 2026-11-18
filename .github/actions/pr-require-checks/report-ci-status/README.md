# report-ci-status

The shared steps of a consumer's `ci-status` job in one step:

1. [`check-contract`](../check-contract/README.md): title, `do-not-merge`
   label, issue linkage and the opt-in hold label.
2. The draft policy (`draft: refuse | allow`).
3. [`aggregate-results`](../aggregate-results/action.yml): the lanes verdict,
   recorded as the `ci-lanes` commit status, or carried forward on a
   contract-only event.

Steps 1 and 2 never fail the composite: their outcomes are the `contract` and
`draft` outputs, and the consumer fails its job on them in a step of its own.
`aggregate-results` carries a `ci-lanes` success forward only when the writer
step concluded `success`, and the jobs API lists the composite as that one step,
so its conclusion must follow the lanes alone. Otherwise a full run whose title
was wrong would leave a success no contract-only run could carry once the title
is fixed.

The composite calls the other two through `$/`, so all three run at the commit
the consumer pins. The job stays in the consumer: the required check `CI Status`
is a job name, and a job inside a reusable workflow would report as
`<caller> / <callee>`.

## Consumer job

```yaml
  ci-status:
    name: CI Status
    needs: [pr-run-checks]
    # A skipped required check reports success to branch protection.
    if: ${{ !cancelled() }}
    permissions:
      actions: write
      contents: read
      pull-requests: write
      statuses: write
    runs-on: ubuntu-24.04
    timeout-minutes: 3
    steps:
      - name: Aggregate lane results
        id: report
        uses: melodic-software/ci-workflows/.github/actions/pr-require-checks/report-ci-status@<sha> # vX.Y.Z
        with:
          step-name: Aggregate lane results
          results: ${{ join(needs.*.result, ' ') }}
          exempt-authors: 'dependabot[bot]'
          draft: refuse
      - name: Fail on the contract or draft policy
        if: ${{ !cancelled() && (steps.report.outputs.contract == 'failure' || steps.report.outputs.draft == 'failure') }}
        run: |
          echo "::error::ci-status: the pull-request contract or the draft policy failed; see the step above."
          exit 1
```

- The last step is the one every consumer adds: without it a failed contract
  or draft policy leaves `CI Status` green.

- `step-name` is the step's own `name:`. The jobs API lists the composite as
  that one step, and `aggregate-results` finds its own step, and the writer
  step of the full run it carries forward, by that name. Keep the name the
  aggregation step had before migrating: a contract-only run on an open pull
  request may carry forward a full run written under it.
- `treat-skipped-as` defaults to `fail`: a lane skipped on a full run is a lane
  that did not run. A consumer whose lanes skip on change detection passes
  `pass`.
- `draft` defaults to `allow`. With `refuse`, list `ready_for_review` in the
  `pull_request` types, or a draft never gets a passing run once marked ready.
- `yield-wait-seconds` defaults to `0`: a contract-only run fails at once while
  a full run is in flight, and the full run re-runs it on `success`. Above `0`
  it holds instead; the composite passes `0` on a contract-only run whose job,
  contract step or draft step already failed.
- Fixed: `yield-to-full-run: 'true'` and `carry-forward-wait-seconds: '0'`.

A consumer with steps of its own keeps them before this step and gives this
step `if: ${{ !cancelled() }}`, so a failed step of its own still records the
lanes verdict.

## Triggers, concurrency and lane gate

The reference copy. The lane predicate must stay identical to
`aggregate-results`' `contract-only` default.

```yaml
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited, labeled, unlabeled]

concurrency:
  group: >-
    ${{ (github.event.pull_request.head.repo.full_name == github.repository &&
    (contains(fromJSON('["labeled","unlabeled"]'), github.event.action) ||
    (github.event.action == 'edited' && !github.event.changes.base)))
    && format('ci-contract-{0}-{1}', github.event.pull_request.number, github.run_id)
    || format('{0}-{1}', github.workflow, github.event.pull_request.number || github.run_id) }}
  cancel-in-progress: true

jobs:
  pr-run-checks:
    if: ${{ !(github.event.pull_request.head.repo.full_name == github.repository && (contains(fromJSON('["labeled","unlabeled"]'), github.event.action) || (github.event.action == 'edited' && !github.event.changes.base))) }}
```

A push falls back to `github.run_id`, so every push to `main` keeps its own
result.

## Tests

- `run.test.sh`: the draft policy (`draft.sh`).
- `.github/scripts/ci-fanout-consolidation.test.cjs`: the step order, the
  `continue-on-error` contract and draft steps and their outputs, this
  repository's failing step, the aggregation's `!cancelled()`, the
  contract-only copies and the hold drop.
