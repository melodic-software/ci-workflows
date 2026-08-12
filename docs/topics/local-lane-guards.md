# Local-lane guards (pointer)

**Owner:** [`melodic-software/standards`](https://github.com/melodic-software/standards)
component [`components/local-lane-guards/`](https://github.com/melodic-software/standards/tree/main/components/local-lane-guards)
(ADR:
[`0003-local-lane-guards-via-standards-component.md`](https://github.com/melodic-software/standards/blob/main/docs/adr/0003-local-lane-guards-via-standards-component.md)).

**Decision (ci-workflows#190):** local invocation of `comment-hygiene`,
`exec-bit`, `machine-specific-paths`, and `reference-integrity` reuses the
standards-owned entrypoint — pointer-not-copy. Do not add a repo-local bin or a
second composite-action-only runner for these guards.

**Invoke (once synced into a consumer):**

```sh
bash tools/shared/local-lane-guards/run-local-lane-guards.sh --help
bash tools/shared/local-lane-guards/run-local-lane-guards.sh all
```

**This repository** still owns the GitHub Actions composite wrappers under
`.github/actions/{comment-hygiene,exec-bit,machine-specific-paths,reference-integrity}/`
that gate CI. A follow-up may re-point those wrappers at the synced drivers so
CI and local share one byte stream; until then, keep behavioral parity with the
standards component and do not fork policy into action-only copies.
