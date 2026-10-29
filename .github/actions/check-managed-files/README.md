# check-managed-files

Fails a pull request that hand-edits a file managed by
`melodic-software/standards`' sync-manifest. A standards-sync pull request is
verified instead of exempted:

- the PR is opened by `melodic-standards-sync[bot]` from `chore/standards-sync`
  in the same repository;
- every PR commit is authored by the sync App (login and noreply email) and
  committed by `web-flow` with a valid GitHub signature;
- every changed path is an added or modified managed destination, and
  `sync-manifest.sh apply` from standards `main` onto the PR head leaves no
  byte, mode, untracked or ignored-file difference.

The content check is the gate; the commit identity check is a second layer.

## Dependabot pull requests

A pull request opened by `dependabot[bot]` (account id `49699333`) skips the
guard only when every commit on it has author id `49699333`, committer
`web-flow` (id `19864447`) and a signature verified with reason `valid`, and
the last listed commit is the checked head. This is the identity rule
`pr-automerge-dependabot` uses. A commit anyone else pushed to the
`dependabot/*` branch, an unreadable commit list, or a moved head drops the
pull request to the hand-edit check, which fails on any managed-file edit.

## Merge groups

A `merge_group` payload names no pull request, so the guard maps the group to
the pull requests it holds and checks each one's own diff:

- It reads the queued pull request's number from the group's head ref,
  `gh-readonly-queue/<base>/pr-<N>-<sha>`, and reads it with `pulls.get`. A
  stack lands as one group, so while a pull request targets another pull
  request's branch rather than the queue's base branch, the guard reads that
  one too, down to the base branch.
- Each pull request gets the mode the rules above select. A hand-edit pull
  request fails on any managed path in its own file list from
  `pulls.listFiles`. A Dependabot pull request is skipped only when its commits
  pass the Dependabot check. A sync pull request must be queued alone: its
  commit identity is checked again, and the group's commits are verified
  against standards `main` as resolved when the group runs, so a sync that
  `main` has moved past fails in the queue.
- The run fails when the head ref names no pull request, a pull request or its
  file list cannot be read, the walk does not reach the base branch, or a path
  that `merge_group.base_sha...head_sha` changes belongs to none of the group's
  pull requests.

The head ref names only the group's last pull request, so the merge queue must
use `grouping_strategy: ALLGREEN`, as for
[check-contract](../pr-require-checks/check-contract/README.md). Under
`HEADGREEN`, a pull request that failed its own group can still merge inside a
later group, whose diff starts after it.

## Why standards `main`, not a SHA the PR names

Sync mode checks out standards at `main` when the check runs and verifies
against that commit. A SHA taken from the PR could name any older standards
commit and roll managed files back to stale content. If `main` moves while a
sync is in flight, the check fails closed: the sync workflow runs on every
standards `main` push, updates the PR, and CI re-runs.

## Caller requirements

The action is a trust boundary only when the PR cannot change it:

- Reference it at `@main`
  (`uses: melodic-software/ci-workflows/.github/actions/check-managed-files@main`)
  from a workflow file that CODEOWNERS protects. With `uses: ./...`, as in
  ci-workflows' own dogfood job, the PR edits the code that grades it.
- Grant the job `pull-requests: read` (sync and Dependabot modes list the PR's
  commits; a merge group reads each queued pull request and its files) and
  `contents: read`.
- To guard a merge queue, run the job on `merge_group` as well as
  `pull_request`.
- Check out the PR with `fetch-depth: 0`, so the base and head commits are
  both present (in a merge group, `merge_group.base_sha` and `head_sha`).
