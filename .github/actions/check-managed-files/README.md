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

## Why standards `main`, not a SHA the PR names

Sync mode checks out standards at `main` when the check runs and verifies
against that commit. A SHA taken from the PR could name any older standards
commit and roll managed files back to stale content. If `main` moves while a
sync is in flight, the check fails closed: the sync workflow runs on every
standards `main` push, updates the PR, and CI re-runs.

## Caller requirements

The action is a trust boundary only when the PR cannot change it:

- Pin it by full commit SHA
  (`uses: melodic-software/ci-workflows/.github/actions/check-managed-files@<sha>`)
  from a workflow file that CODEOWNERS protects. With `uses: ./...`, as in
  ci-workflows' own dogfood job, the PR edits the code that grades it.
- Grant the job `pull-requests: read` (sync mode lists the PR's commits) and
  `contents: read`.
- Check out the PR with `fetch-depth: 0`, so the base and head commits are
  both present.
