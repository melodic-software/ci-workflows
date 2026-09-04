# pr-contract

One composite step carrying the whole pull-request contract, so a consumer needs
one required status check (`ci-status`) instead of four.

| Check | Outcome |
|---|---|
| Conventional Commits title | Fails the step. |
| `do-not-merge` label present | Fails the step. |
| Issue linkage (closing keyword plus the four contract sections) | Advisory by default: a warning, one upserted marker comment, and a label. `linkage-mode: enforce` fails the step instead. |

The three checks come from the `semantic-pr`, `do-not-merge-gate` and
`pr-issue-linkage` reusable workflows; the semantics are ported, not redesigned.
Those reusables stay in place until the callers are retired.

## Why one step

A title edit, a label change, or a body edit changes the answer to a required
check without changing a commit. Splitting those answers across three
`pull_request_target` workflows meant three checks, three runner allocations,
and three required contexts per pull request. Folding them into the `ci-status`
job means the contract re-evaluates on `edited`, `labeled` and `unlabeled` while
every file-lint lane stays gated off.

## Inputs

Every input's meaning and default is documented inline in
[`action.yml`](action.yml). The two worth calling out here:

- `types` defaults to the twelve types
  `components/pr-convention-policy/policy.json` declares in
  `melodic-software/standards`: the eleven Conventional Commits defaults plus
  `security`. The `semantic-pr` reusable's action default is the eleven, so a
  `security:` title that policy allows fails that older gate and passes this one.
- `exempt-authors` is exact-login equality, never a `*[bot]` pattern, so an
  unknown future bot is not silently skipped. The default empty string exempts
  no one.

## Outputs

`title`, `do-not-merge`, and `linkage`. Every check runs before the step exits,
so all three are always set: `pass`, `fail`, `skipped` (no pull request in this
event), and additionally `exempt` for `linkage` when the author is exempt.

## Permissions

The calling job needs `pull-requests: write` for the advisory comment and label.
Every write is best-effort: a refused or missing write prints a `::notice::` and
leaves the exit code alone, so a read-only token degrades the composite to
reporting rather than breaking the gate.

## Behaviour worth knowing

- The pull request is read once from `repos/<owner>/<repo>/pulls/<number>`, not
  from the event payload, so `labeled` and `edited` runs see current state and a
  suppressed follow-up event cannot leave a stale answer green.
- An empty `pr-number` (a `push`, `schedule` or `workflow_dispatch` run) reports
  every output as `skipped` and exits 0. This is a pull-request gate; a push run
  must not fail on it.
- The advisory comment carries the HTML marker `<!-- pr-contract:linkage -->`.
  The step edits that comment rather than posting a second one, and on a linkage
  pass it rewrites the comment to say the body conforms rather than deleting it.
  Only a **bot-authored** comment carrying the marker is a candidate, and the
  newest one wins: on a public repository anyone can comment, so a stranger who
  planted the marker would otherwise capture the upsert and the gate's guidance
  would never appear.
- Attacker-controlled text (the title, body-derived quotes, the author login) is
  escaped to GitHub's workflow-command rules (`%` → `%25`, CR → `%0D`, LF →
  `%0A`) before it appears in an annotation, so a title carrying a newline cannot
  close the annotation and inject a second workflow command.
- `repository`, `pr-number` and both label inputs are validated against strict
  patterns before the first `gh api` call, and the label is percent-encoded in
  the label-removal path.
- The issue-linkage analyzer masks rendered HTML comments, fenced and indented
  code blocks, and inline code spans before matching, so a PR template's
  commented-out `Closes #N` example cannot satisfy the gate.
- A negated closing reference (`does not close #N`) fails outright and is never
  excused by a valid marker elsewhere in the body: GitHub's own linkage parser
  ignores the surrounding words and closes the issue on merge regardless of the
  disclaimer. Use `Refs: #N` or `Relates to: #N` on its own line instead.

## Consumer wiring

Both steps go in the `ci-status` job, in this order:

```yaml
  ci-status:
    if: ${{ !cancelled() }}
    needs: [lane-a, lane-b]
    permissions:
      contents: read
      pull-requests: write
      statuses: write
    runs-on: ubuntu-24.04
    steps:
      - uses: melodic-software/ci-workflows/.github/actions/pr-contract@<sha> # vX.Y.Z
      - name: Aggregate lane results
        # `!cancelled()` so a failing pr-contract step does not skip the
        # aggregation: the job still fails on the contract step's exit code, and
        # the ci-lanes status lands on the SHA for the next contract-only run.
        if: ${{ !cancelled() }}
        uses: melodic-software/ci-workflows/.github/actions/ci-status@<sha> # vX.Y.Z
        with:
          results: ${{ needs.lane-a.result }} ${{ needs.lane-b.result }}
```

The caller's workflow must add `edited`, `labeled` and `unlabeled` to
`on.pull_request.types` and gate every other job with `if: ${{ !(<predicate>) }}`
where `<predicate>` is, verbatim:

```text
github.event.pull_request.head.repo.full_name == github.repository && (contains(fromJSON('["labeled","unlabeled"]'), github.event.action) || (github.event.action == 'edited' && !github.event.changes.base))
```

The same negated predicate goes in `cancel-in-progress`, ANDed with any existing
condition there. Two exclusions in it are load-bearing: an `edited` event
carrying `changes.base` changed the base branch, so the merge commit the lanes
test changed with it and the run must be full; and a fork pull request is never
contract-only, because its token cannot record the lane state a later
carry-forward would read.

`ci-status` reads the same predicate through its own `contract-only` input,
whose default is that expression, so the caller passes nothing. A caller that
overrides `contract-only` owns the claim that the lanes did not run: the runner
branches on it before it looks at `same-repo`, so `contract-only: true` with
`same-repo: false` is treated as a carry-forward even though the shipped
defaults never produce that combination.

This repository's own `.github/workflows/ci.yml` is the reference wiring.

## Tests

`run.test.sh` drives `run.sh` against fixture JSON served by a `gh` shim placed
first on `PATH`, which also logs every API call so the harness can assert on the
writes that did and did not happen. Run it with
`bash .github/actions/pr-contract/run.test.sh`; the `selector-contract` lane runs
it in CI.
