# Citing document

This file exercises the heading-cite resolver, citing a heading and a bold
lead-in in a target one directory DOWN. The nested target is the regression
guard for the corpus-enumeration glob: a git pathspec matches it recursively,
but a glob accidentally expanded by the shell against the cwd would not — so a
"no-file" here means the corpus collapsed to top-level files only.

- See `sub/target.md` "Install the binary" for setup.
- See `sub/target.md` "Checksum verification" for the integrity step.
