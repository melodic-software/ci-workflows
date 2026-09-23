# Local-lane guards (pointer)

**Owner:** [`melodic-software/standards`](https://github.com/melodic-software/standards)
component [`components/local-lane-guards/`](https://github.com/melodic-software/standards/tree/main/components/local-lane-guards)
(ADR:
[`0004-local-lane-guards-via-standards-component.md`](https://github.com/melodic-software/standards/blob/main/docs/adr/0004-local-lane-guards-via-standards-component.md)).

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

The punctuation-only span exemption, the macOS shared-user directory guard, and
the per-line `machine-path:allow` marker are an intentional CI-only exception
to the parity rule above. They live in the CI driver
`check-machine-specific-paths.sh` because the synced pattern file is
standards-managed and must not be edited here. The standards local entrypoint
does not apply this filter yet, so the same line can fail a local lane and pass
CI.

Put `machine-path:allow` on a line, usually in a trailing comment, when the
line's path is an example on purpose: prose that describes the path form, or a
fixture whose assertion subject is the path. That line is not a finding. Lines
without the marker are scanned as before. Formats with no comment syntax, such
as JSON, cannot carry the marker; exclude those files through the composite's
`exclude` input instead.
