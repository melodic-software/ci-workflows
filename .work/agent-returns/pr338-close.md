# PR #338 close-out log — COMPLETE

Merged 2026-08-03T22:39:50Z, squash commit `193564b`. Issue #332 auto-closed 22:39:51Z.

## Final state (all verified via gh API after the fact)
| item | state |
| --- | --- |
| PR #338 | MERGED (squash `193564b`) |
| issue #332 | CLOSED (auto, via `Closes #332`) |
| PR #337 (evidence) | CLOSED + branch `demo/332-inline-comment-evidence` deleted |
| branch `fix/332-claude-review-inline-comments` | deleted |
| branch `fix/309-claude-review-gh-pr-diff-grant` | deleted (PR #319 merged 2026-07-30 from it; no open PR referenced it) |
| CI at merge | 42/42 SUCCESS, mergeStateStatus CLEAN |

Fix confirmed live on `origin/main`: inline tool no longer in the `claude-args` default
(L148), appended in compose-args (L462), corrected security note (L79) and causal comment
(L503).

## Commits
- `923a2d2` — the durability fix (P2) + SECURITY MODEL note.
- `8d7ab14` — corrections after independent verification (see below).

## Thread dispositions (both replied to and RESOLVED)
1. `PRRT_kwDOTCB_B86V0r8v` — codex P2, "Preserve the inline tool when callers override
   arguments". **Confirmed real; fixed with code**, using codex's own first proposed remedy.
   Reply: https://github.com/melodic-software/ci-workflows/pull/338#discussion_r3708139396
2. `PRRT_kwDOTCB_B86V0sEH` — claude SUGGESTION, widened trust surface. **Applied** as a
   SECURITY MODEL note (the form the thread asked for), **with its factual claim corrected**.
   Reply: https://github.com/melodic-software/ci-workflows/pull/338#discussion_r3708140588

## The fix
Invariant established, now written into the file: **whatever the non-overridable wrapper
prompt asserts must itself be non-overridable.**
- Inline-comment grant removed from the overridable `claude-args` input default.
- `compose-args` appends it unconditionally; that step feeds BOTH the first attempt and the
  retry, so one edit covers both.
- `Bash(gh pr diff:*)` deliberately stays overridable — the instruction that uses it lives in
  the equally overridable `prompt` input, so the two co-vary correctly.

Severity was higher than the thread reported: this lane runs in TAG mode, and tag mode derives
which MCP servers to install from these same args (`parseAllowedTools` filtered to
`mcp__github_*` -> `prepareMcpConfig`). Losing the grant meant the inline-comment server was
never installed, not merely un-granted.

## Corrections caught by independent verification (why `8d7ab14` exists)
The fresh verifier (cold read, rationale withheld) returned PASS on all three criteria but
found two committed statements that were NOT TRUE. Both were fixed before merge:
1. The SECURITY MODEL note repeated the review thread's claim that the action buffers and
   classifies inline comments before posting. It filters NOTHING in this lane: classification
   needs `ANTHROPIC_API_KEY`; this lane passes only `claude_code_oauth_token`, so
   `classifyComments` returns null and every buffered comment posts
   (`src/entrypoints/post-buffered-inline-comments.ts:45-51`). The error ran in the
   REASSURING direction — it described a control that is not there.
2. The step comment claimed a granted-but-unnamed tool "reads as unusable and goes uncalled".
   This repo's own `claude-security-review.yml` disproves it: it grants the tool, never names
   it, runs in the same tag mode under the same base prompt, and does post inline comments.
   The load-bearing part is instructing the agent to report findings AS A PULL REQUEST REVIEW;
   naming the tool is belt-and-braces. Comment now says so.
The empirical result the PR rests on is unaffected — the 5 line-anchored comments on #337
stand. Only the causal explanation was overstated.

## Verifier verdicts (fresh context, rationale withheld, pre-merge)
- (A) grant survives caller overrides — **PASS**, no default-path regression. It independently
  re-derived tag mode, the union semantics, the server-install dependency, and mechanically
  compared BEFORE (origin/main default) vs AFTER: both yield 14 SDK allowedTools, set-equal,
  zero symmetric difference.
- (B) both threads addressed — **PASS** on responsiveness, with the two prose defects above
  flagged as merge-blocking text corrections. Fixed, then merged.
- (C) prompt blocks byte-identical — **PASS**, verified mechanically (yaml.safe_load + SHA-256
  of each `with.prompt`; both `1a7f8a13...`). Independently confirmed by my own script
  (`scratchpad/check_prompt_blocks.py`): IDENTICAL, 810 bytes. Also still identical on main.

## Evidence method (recorded so it is not re-derived)
Authority is the pinned action's source at `be7b93b` (= v1.0.183), cloned and read at that SHA
— NOT the local `claude` CLI. An earlier CLI probe tested the wrong layer: the workflow never
invokes the CLI directly, the action parses `claude_args` itself. Ran the action's REAL
`parseAllowedTools` against the strings compose-args emits (bun); default path yields a tool
set identical to pre-fix, every override keeps the grant, and the pre-fix override reproduces
the bug as an empty list.

## Follow-ups filed (deliberately not folded in)
- **#340** — `claude-security-review.yml` has the IDENTICAL latent gap (same grant in its
  overridable default, forwarded verbatim at lines 702 and 960). It has no compose step, so
  closing it needs a new one.
- **#341** — the first-attempt/retry prompt parity invariant is stated in a comment but
  enforced by nothing; the sibling lane already has that test
  (`claude-security-review-fail-closed.test.cjs:417`).
- **#343** — the OTHER leg of the same invariant #338 committed to. The wrapper prompt now
  asserts a summary comment exists ("Keep your summary comment for the overview"), but
  `track-progress: false` flips the lane to agent mode where the comment server is not
  installed (`install-mcp-server.ts:95`, `shouldIncludeCommentServer = !isAgentMode ||
  hasGitHubCommentTools`, and this lane grants no `mcp__github_comment__*` tool). Low
  severity — that input already concedes reduced visibility — but the same defect class.

## Known residual (no live run yet)
The new two-flag composition has NOT been exercised end to end. The proof is set-equality
against the pinned action's real parser, which is the strongest evidence short of a run, and
the default path is provably identical at the SDK-options layer. First real validation
arrives with the next PR opened in this repo or in a consumer — watch that run's inline
comments. The PR body's evidence (5 comments on #337) predates this composition change.

## Durable-record confirmations
- The squash commit message for `193564b` is the PR title + FULL body, so the review-round
  section and the two corrections are in the git history, not only on GitHub.
- The `#337` closing comment posted ("Observation recorded in #338; retiring evidence PR.").

## Notes for whoever picks this up
- `.work/` is NOT gitignored in this repo — stage surgically, never `git add -A`.
- This worktree (`ci-workflows-332`) is now on a deleted branch; safe to remove once this log
  is no longer wanted.
