# setup-pinned-node

Put the exact Node version a version file pins on `PATH` without a GitHub API call.

`actions/setup-node` reads the `actions/node-versions` manifest through `api.github.com` with the
job token whenever the requested version is not in the runner's tool cache: two requests (the git
tree, then the manifest blob) a step. The runner image caches only the newest `24.*` at its build
date, so an exact pin misses whenever the two differ, and every miss spends the job token's hourly
limit, which every job in the calling repository shares.

This action uses the tool cache when it holds the version. Otherwise it downloads
`SHASUMS256.txt`, `SHASUMS256.txt.sig` and `node-v<version>-linux-x64.tar.gz` from
`https://nodejs.org/dist` and extracts the tarball into the tool cache only after this chain holds:

1. The trust root is the committed keyring, `pubring.kbx.hex`.
2. `gpgv` verifies `SHASUMS256.txt.sig` against that keyring before anything reads
   `SHASUMS256.txt`.
3. The tarball's SHA-256 matches the signed `SHASUMS256.txt`.

A compromised nodejs.org or CDN that swaps the files fails step 2 unless it also holds a releaser's
signing key. A tool-cache hit is the runner image's own copy and skips the chain.

Three choices keep it working on every runner its callers use, hosted and fleet:

- It fetches the `.tar.gz` release rather than `.tar.xz`. The fleet worker image
  (`melodic-software/ci-runner`'s `Dockerfile`, on `actions-runner`'s Ubuntu 24.04 base, installed
  with `--no-install-recommends`) has `gzip` but no `xz-utils`, so `tar -xJ` fails there.
- It commits the keyring as base16 text and decodes it with coreutils `basenc` at run time. The
  synced editorconfig-checker config reads every tracked file as text.
- It bounds each download with `_shared/install-release.sh`'s curl budget.

## Inputs

| Input | Meaning |
|---|---|
| `node-version-file` | The file holding the exact `X.Y.Z` version |

The step fails on a version that is not `X.Y.Z`, a runner other than Linux X64, a signature that
does not verify against the keyring, a checksum mismatch, or a `SHASUMS256.txt` without the
tarball's line.

## Release keyring

`pubring.kbx.hex` holds public keys only: `basenc --base16 -d pubring.kbx.hex` gives a byte-exact
copy of `gpg/pubring.kbx` from
[nodejs/release-keys](https://github.com/nodejs/release-keys) at commit
[`481637f813e912c4aa3622d7964ab426c97b8e8d`](https://github.com/nodejs/release-keys/blob/481637f813e912c4aa3622d7964ab426c97b8e8d/gpg/pubring.kbx):
95,960 bytes, sha256 `610b8d249da3d5733f5a128def2dd0294dbbf5b5713e6ca2529db8db419dee00`.

It changes only when Node.js adds or retires a releaser, so a version bump needs no edit here. When
the step fails on a signature, check whether the release was signed by a key new upstream. If so,
replace the file with `basenc --base16 -w 76` of a newer release-keys commit's keybox, confirm its fingerprints against the
release-keys README and the [nodejs/node README](https://github.com/nodejs/node#release-keys),
confirm the release's real `SHASUMS256.txt.sig` verifies, and update the commit and sha256 above.
If no new key explains it, treat the download as compromised.

## Use

A composite action in this repository runs the script from its sibling directory, since a `./`
path in a composite's `uses:` resolves against the caller's workspace:

```yaml
- name: Set up Node
  shell: bash
  run: bash "$GITHUB_ACTION_PATH/../setup-pinned-node/install-node.sh" "$VERSION_FILE"
```

The script finds the keyring from its own path, so this works from any action directory. A
workflow job calls the action itself:

```yaml
- name: Set up Node
  uses: melodic-software/ci-workflows/.github/actions/setup-pinned-node@<sha>
  with:
    node-version-file: .node-version
```

Tests: `install-node.test.sh` beside the script.
