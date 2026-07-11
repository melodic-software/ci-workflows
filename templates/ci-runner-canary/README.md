# ci-runner-canary

This private repository is the selected-access acceptance target for the local
GitHub Actions fleet. Its two manual callers delegate all authorization,
selection, routing, and proof behavior to reviewed immutable workflows in
`melodic-software/ci-workflows`: compatibility canarying and the later
production two-host proof.

The repository must remain private. Configure only:

- repository variable `CI_RUNNER_OBSERVER_CLIENT_ID`;
- repository secret `CI_RUNNER_OBSERVER_PRIVATE_KEY` with access granted by the
  observer-secret policy;
- Actions access to the pinned public reusable workflow.

The caller passes that one secret explicitly. It must never use
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

## Compatibility promotion evidence

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

## Production two-host proof

Run `.github/workflows/production-ha-proof.yml` only after the isolated canary
passes and reviewed IaC grants this private repository access to both production
runner groups. The caller exposes no runner-label input. Its immutable reusable
workflow owns `melodic-ubuntu-24.04-x64`, the host prefixes, group names, REST
validation, and direct selector routing.

The workflow produces sanitized artifacts, but it cannot observe every physical
host fact. Before and after each dispatch, capture status on both hosts and
record the UTC capture time in the operator timeline:

```powershell
# Run on melo-desk-001.
ci-runner host status --json > melo-desk-001-before.json

# Run on melo-lap-001.
ci-runner host status --json > melo-lap-001-before.json
```

Run the command on the named host; do not copy one host's output and rename it.
Retain the run URL, workflow artifacts, both status snapshots, the relevant
redacted controller-log slice, `state/jobs.json` correlation, and the worker
diagnostic archive/deletion record. Review every local file for credential or
machine-path disclosure before attaching it to rollout evidence.

The REST artifact proves the two independent runner-group IDs, their identical
private selected-repository sets, and each group's current runner membership.
GitHub's [runner-group endpoints][runner-group-rest] expose no scale-set ID and
do not report listener capacity. Correlate them with each controller's
`pools[].scaleSetId`, `pools[].listenerId`, `pools[].maxCapacity`,
`pools[].capacityAcknowledged`, runner names, and checked-in host configuration.
The desktop and laptop must report different scale-set and listener IDs while
their configs use the same production scale-set name. Do not relabel a REST
group ID as a scale-set ID.

Run the modes in order:

1. `inventory`: enable both hosts and wait until each is healthy with one warm
   production worker. The hosted proof must report both exact groups online and
   idle. This establishes independent group membership, not assignment order;
   GitHub documents that two same-name scale sets in different groups race
   arbitrarily while both are online. [GitHub HA contract][runner-ha]
2. `desktop-only`: disable the laptop with `ci-runner host disable --wait`, keep
   the desktop enabled, and dispatch. The REST inventory requires zero online
   laptop runners before the governed job can assert a desktop runner name,
   `runner.os == Linux`, and `runner.arch == X64`.
3. `laptop-only`: disable the desktop, enable the laptop on AC, and repeat. The
   governed job must assert the laptop identity and the same documented
   [runner context][runner-context] values.
4. `failover`: enable both hosts and wait for one idle runner in each group, then
   dispatch. After inventory and selector jobs pass, the hosted hold prints an
   operator checkpoint. Only then run this on the desktop:

   ```powershell
   ci-runner host disable --wait
   ```

   Capture desktop status before and after the command. The post-drain status
   must show acknowledged zero new capacity and no busy job was killed. The
   hosted hold performs only read requests until desktop membership remains at
   zero and laptop idle capacity remains visible for two observations. The next
   governed job must acquire `melo-lap-001`. The workflow never drains a host,
   cancels a run, reserves a runner, or replays work. Re-enable the desktop only
   after collecting deletion diagnostics.
5. `laptop-power`: leave the desktop disabled, enable the laptop on stable AC,
   and dispatch. Wait until the laptop job has asserted its identity and emitted
   heartbeats, then unplug AC without signing out, sleeping, or closing the lid.
   Capture `ci-runner host status --json` while unplugged: it must show the
   Windows power observation with `power.acConnected=false`, power suspension,
   acknowledged zero new capacity, and the existing busy worker still present.
   Reconnect AC, wait through the configured stable-AC window, and capture status
   again. The same busy job must finish, and normal idle capacity must return
   afterward. Correlate the JSONL heartbeat timestamps across both power events
   with the status snapshots and controller logs. Heartbeats prove only that the
   already-acquired job stayed alive; they do not prove battery policy or
   advertised capacity by themselves.

Fresh-logon-on-battery is a separate physical gate because a workflow cannot run
on the runner whose absence it must prove. With Docker Desktop stopped, sign out,
unplug the laptop, and sign in. Capture the scheduled-task state,
`ci-runner host status --json`, `docker desktop status`, `docker info`, and the
organization runner-group view. Require the controller to be alive and
power-suspended, Docker to remain stopped/unreachable, and production capacity
to remain acknowledged at zero. Reconnect AC only after that evidence exists;
then prove stable recovery. Neither the REST artifact nor the laptop heartbeat
may be substituted for this physical gate.

Never use **Re-run jobs** for acceptance. The selector intentionally routes
attempt 2 hosted, and the reusable preflight rejects it so hosted execution
cannot be misreported as a local proof. Start a new dispatch instead.

[runner-context]: https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#runner-context
[runner-group-rest]: https://docs.github.com/en/rest/actions/self-hosted-runner-groups?apiVersion=2026-03-10
[runner-ha]: https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets#high-availability-and-automatic-failover
