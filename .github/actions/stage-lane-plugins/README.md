# stage-lane-plugins

Copy one or more Claude Code plugins into a read-only workspace tree for
`run-claude-cli` (`--plugin-dir` and `--add-dir`).

Under `--restricted`, Claude Code reads plugin files only inside a working
directory, so lanes copy trusted plugins (from a base-branch checkout or a
cloned marketplace outside the workspace) into `.lane/plugins/` before invoking
`run-claude-cli`. This action replaces repeated inline staging scripts with one
fail-closed implementation.

## Behavior

1. **Refuses a pre-existing or tracked staging root.** Fails closed when the
   top-level directory of `destination` (`.lane` by default) already exists on
   disk (file, directory, or dangling symlink) or is tracked in `HEAD` or the Git
   index.
2. **Validates every source plugin before writing.** Fails closed if any named
   plugin is missing, is not a directory, is a symbolic link, or contains any
   symbolic link or special file (FIFO, socket, device). Because `chmod` does
   not follow symlinks, refusing links prevents a staged tree from escaping the
   read-only copy or pointing outside the plugin root.
3. **Writes an empty `.mcp.json` when absent.** Creates
   `{"mcpServers":{}}` in each staged plugin that does not already ship a
   `.mcp.json`, while preserving any shipped `.mcp.json`. Claude Code's
   bubblewrap sandbox enforces its write denial on `.mcp.json` in each
   `--add-dir` by creating an empty file, which fails once the staged directory
   is read-only.
4. **Locks the staged tree read-only.** Strips all write bits (`a-w`) bottom-up
   across `destination` and every copied file and directory while preserving
   executable bits on plugin scripts.
5. **Excludes the staging root from Git.** When `GITHUB_WORKSPACE` is a Git
   checkout, appends `/<root>/` (for example `/.lane/`) to `.git/info/exclude`
   atomically if not already present. Non-Git workspaces skip the Git checks and
   exclude update cleanly.
6. **Rolls back on error.** If copying, locking, or updating `.git/info/exclude`
   fails, restores write bits and removes the staging root it created so no
   partial read-only directory is left behind.

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `source-dir` | Yes | — | Directory containing the plugin subdirectories to copy (relative paths resolve against `GITHUB_WORKSPACE`). |
| `plugins` | Yes | — | Plugin directory names under `source-dir`, one per line. Blank lines are ignored and duplicates collapse in order. |
| `destination` | No | `.lane/plugins` | Workspace-relative directory where plugins are staged read-only. Must not be inside `.git`. |

## Outputs

| Output | Meaning |
| --- | --- |
| `plugin-dirs` | Workspace-relative staged plugin directories, one per line in the order requested, ready to pass to `run-claude-cli`'s `plugin-dirs` input. |

## Use

```yaml
- name: Stage lane plugins
  id: plugins
  uses: melodic-software/ci-workflows/.github/actions/stage-lane-plugins@<sha>
  with:
    source-dir: .base/plugins
    plugins: |
      harness-ops
      planning

- name: Run the lane
  uses: melodic-software/ci-workflows/.github/actions/run-claude-cli@<sha>
  with:
    plugin-dirs: ${{ steps.plugins.outputs.plugin-dirs }}
    # ...
```

Tests: `.github/scripts/stage-lane-plugins.test.cjs`.
