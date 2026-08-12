# Claude review lanes — V2 plugin architecture

Status: shipped (minimum complete slice, ci-workflows#258)
Date: 2026-08-12

## TLDR

V1 shipped review criteria as reusable-workflow `prompt` input strings. V2 moves
that logic into **org-owned slash skills** in the `melodic-software`
claude-code-plugins marketplace (`/review:code-review`,
`/review:security-review`), installed by claude-code-action via `plugins` +
`plugin_marketplaces`. The reusable workflows keep owning checkout, tool/MCP
grants, retry, freshness, and reporting mechanics.

## Why

- Review logic becomes version-controlled and separately reviewable in the
  plugin repo, and updates fleet-wide when the plugin updates (consumers pin
  the reusable workflow SHA; the marketplace install resolves current plugin
  content at run time unless further pinned later).
- Two lane skills with no-overlap scoping baked in; criteria still read each
  repo's synced `REVIEW.md`.
- Built-in `/security-review` remains unusable in CI (origin/HEAD under Actions
  checkout; cannot post) — the security skill is org-authored.

## Architecture

```text
caller workflow
  └─ reusable claude-review.yml / claude-security-review.yml
       ├─ freshness / caps / relevance (unchanged)
       ├─ checkout + compose claude_args (inline-comment MCP grant)
       ├─ compose REVIEW_BODY
       │    ├─ V2 (default): "Invoke /review:<lane> …"
       │    └─ V1 (plugins empty): inputs.prompt body
       └─ anthropics/claude-code-action
            ├─ plugin_marketplaces → add org marketplace
            ├─ plugins → install review@melodic-software
            └─ prompt → header + REVIEW_BODY + reporting mechanics
```

### Org skills (claude-code-plugins `review` plugin ≥ 0.19.0)

| Skill | Invoked as | Lane |
|---|---|---|
| `skills/code-review` | `/review:code-review` | `claude-review.yml` |
| `skills/security-review` | `/review:security-review` | `claude-security-review.yml` |

Skills (not legacy `commands/`) — marketplace PLUGIN-PHILOSOPHY prohibits
`commands/` (merged into skills upstream).

Each skill carries: cheap skip-gate, lane criteria, high-signal bar,
adversarial-validation target (producer ≠ verifier), and the known traps
(frontmatter cannot install the inline-comment MCP server; no stale
confidence-score gate).

### Workflow inputs (dual-path)

| Input | Default | Role |
|---|---|---|
| `plugins` | `review@melodic-software` | Install list; empty → V1 path |
| `plugin-marketplaces` | `https://github.com/melodic-software/claude-code-plugins.git` | Marketplace URLs; empty-safe when plugins empty |
| `plugin-command` | `/review:code-review` or `/review:security-review` | Slash command when plugins non-empty |
| `prompt` | V1 criteria body | Used only when V1 path is active |

**Preference rule:** when `plugins` and `plugin-command` are both non-empty
after trim, V2 wins and `prompt` is not used for criteria. Clear `plugins` to
`""` to force V1. Clear only `plugin-command` (keeping plugins) to install
plugins while staying on the V1 prompt path.

Marketplace name is `melodic-software` (from
`.claude-plugin/marketplace.json` `name`), so the plugin reference is
`review@melodic-software`.

## Known traps (verified — do not repeat)

1. Official docs examples that omit posting instructions, `--allowedTools` for
   the inline-comment MCP server, or checkout — broken as published. This
   fleet's wrappers own those.
2. Anthropic code-review plugin README confidence-score tuning line that does
   not exist in the command — stale; our skills use adversarial validation.
3. Marketplace name ≠ repo name.
4. Built-in `/security-review` unusable in CI — use `/review:security-review`.

## Migration

### Consumers already on default inputs

No caller change required once they re-pin the reusable workflow SHA past this
slice. Defaults install the org review plugin and invoke the lane skill.

### Stay on V1 prompt body

```yaml
with:
  plugins: ""
  # prompt: keeps working as before (default or custom)
```

### Extend with additional plugins / marketplaces

```yaml
with:
  plugins: |
    review@melodic-software
    research@melodic-software
  plugin-marketplaces: |
    https://github.com/melodic-software/claude-code-plugins.git
  # plugin-command stays at the lane default unless overridden
```

Evaluate extra plugins/MCP servers per capability case by case (research reach,
etc.) — defaults stay minimal.

### Custom criteria with V2

Put the criteria in the org skill (or a fork/override plugin) and point
`plugins` / `plugin-command` at it. Do not rely on `prompt` while V2 is active.

## Out of this slice (follow-ups)

- Full model-tiered fan-out and per-issue adversarial subagent pipeline matching
  Anthropic dogfood depth (skills currently describe the target; deepen in the
  plugin).
- Pinning a marketplace plugin version from the reusable workflow (today:
  install resolves current marketplace tip at run time).
- Removing the V1 `prompt` default body once fleet consumers have all re-pinned
  and no caller clears `plugins`.

## References

- Issue: [ci-workflows#258](https://github.com/melodic-software/ci-workflows/issues/258)
- Plugin skills PR: melodic-software/claude-code-plugins (review 0.19.0)
- Brief / V1 plan: [PLAN.md](./PLAN.md) (V2 was out of scope there; this doc is
  the V2 SSOT)
