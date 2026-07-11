# ci-runner-canary

This private repository is the selected-access acceptance target for the local
GitHub Actions fleet. Its one manual caller delegates all authorization,
selection, routing, and proof behavior to the reviewed immutable workflow in
`melodic-software/ci-workflows`.

The repository must remain private. Configure only:

- repository variable `CI_RUNNER_OBSERVER_CLIENT_ID`;
- repository variable `CI_CACHE_EPOCH`, provisioned by IaC and matching the
  production cache epoch;
- repository secret `CI_RUNNER_OBSERVER_PRIVATE_KEY` with access granted by the
  observer-secret policy;
- Actions access to the pinned public reusable workflow.

The caller passes the governed epoch and that one secret explicitly. The
reusable preflight rejects a missing or unsafe epoch before local work. The
caller must never use
`secrets: inherit`, accept a runner label, or reproduce selector logic.
Dependabot checks the immutable reusable-workflow reference weekly and opens a
reviewed PR; no dependency update is auto-merged.

## Seed after IaC

IaC creates and initializes the empty private repository and its selected runner
access. From a reviewed `ci-workflows` checkout with Git LFS objects present,
run the sibling `bootstrap.ps1` against a clean clone:

```powershell
./templates/ci-runner-canary/bootstrap.ps1 -TargetPath <clean-clone>
```

The bootstrap validates the exact remote and `main` branch, copies only the
reviewed seed files, runs `git lfs install --local`, stages the result, and
proves that `fixtures/lfs/canary.txt` became the expected LFS pointer. It does
not commit or push. Review the staged diff, open the initial-content PR through
the normal protected-branch process, and verify the LFS object uploads with that
push. A GitHub Contents API write of the pointer alone is not sufficient because
the LFS object must also exist in Git LFS storage.

The fixed materialized LFS content is `ci-runner-canary-lfs-v1` followed by LF;
its SHA-256 is
`962ab05586b24dbc1c300c70385ead92d59393900fb9240f6d4d5cc949ec1cb2`.
The cache fixture is nonsecret fixed text.

## Promotion evidence

Run `full` twice with only one canary host advertising capacity at a time:

1. desktop capacity on, laptop capacity zero;
2. laptop capacity on, desktop capacity zero.

For each run, retain the two runner names, derived host, container IDs, job IDs,
and controller diagnostic archives proving both completed containers were
deleted. These are two single-host proofs; they do not prove two-host
distribution or failover.

Run `cancellation` separately on one isolated host, cancel it from the GitHub UI,
and correlate the canceled job with controller deletion diagnostics. Start a
new `full` dispatch afterward. Do not rerun the canceled attempt because reruns
are intentionally hosted.
