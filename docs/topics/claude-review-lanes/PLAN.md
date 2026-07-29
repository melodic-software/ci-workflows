# claude-review-lanes

## Brief

### TLDR

Modernize and harden the org's Claude CI lanes (claude-review, claude-security-review,
claude-e2e-verify in ci-workflows) and their fleet rollout: bump/currency-automate the
action pin, move to claude-sonnet-5, fix two verified config defects, change review
cadence to cut ~85% of volume (and the seat-contention failures it causes), add retry +
kill-switches + machine-readable failure-class observability, restructure review
criteria for zero lane overlap, distribute callers as sync-managed components to every
org repo, and queue five follow-up efforts as filed issues.

Decision record: `.work/claude-review-lanes/interview-checklist.md` (this repo).
Interview 2026-07-26; independently verified by a fresh-context Fable pass
(all 8 flagged uncertainties adjudicated; critical finding F1 folded in) and a
BugBot/approvals research pass. A Codex xhigh cross-check was dispatched and had not
returned at lock time — treat any late disagreement as re-derive-from-docs, not
auto-adopt.

### Goal

Every org repo runs both review lanes with: current pinned action (v1.0.183 at lock
time; Dependabot keeps it same-day current), pinned `claude-sonnet-5`, working comment
exclusion, inline comments enabled, single-pass code review + per-head security review,
seat-contention resilience (retry + serialization), fleet kill-switches, and
failure-class visibility for humans and agents — with review criteria scoped so the two
lanes never overlap.

### Constraints

- Subscription OAuth (org secret `CLAUDE_CODE_OAUTH_TOKEN`) stays; no API billing, no
  WIF. Token minted 2026-07-26 (expires ~2027-07-26). Expiry/exhaustion must be visible
  (canary asserts on real output — upstream #1501 silent-green).
- Advisory posture: infra failure never turns a check red. Security lane's
  execution-evidence required check must keep working (name-stable skip = success).
- Public-repo log hygiene: no model-authored free text in logs/annotations
  (`display_report`/`show_full_output` stay off; failure class is an allowlisted token).
- SHA-pin convention stands (floating tags rejected); the security-patch-delivery gap
  is closed by the Dependabot fast lane, not by unpinning.
- Claude must never trigger its own lanes (no claude/app actors in mention triggers;
  documented ban cases came from self-trigger loops).
- Reviewer roster cap: Claude x2 + Codex (single-pass, user-configured); BugBot deferred.

### Sequencing (locked)

1. **standards repo**: REVIEW.md restructure — lane-scoped sections (code-review vs
   security) + drop report-stage filtering ("Do not report", "Cap the nits") per
   Anthropic's Sonnet-5 harness-effect guidance; REVIEW-CREDENTIAL.md re-derivation
   (standards#264: claude-code-plugins is public → ineligible; add-dir blocker cleared;
   provisioning stays deferred behind github-iac governance).
2. **ci-workflows**: all workflow changes below + release tag.
3. **Fleet rollout**: callers become standards sync-manifest managed components; both
   lanes to every org repo (github-iac first among missing; `.github`/ci-runner/
   ci-runner-canary exemption decided + documented); normalized triggers/skip-actors/
   pins; kill-switch + draft-payload + queue-syntax smoke tests.
4. **Observability**: #237 failure-class token → #238 canary/aggregator.
5. **Follow-ups**: filed issues (see mapping).

### ci-workflows change set (step 2 detail)

- Pin bump `anthropics/claude-code-action` → v1.0.183 (config-drop-in; verified).
- `--model claude-sonnet-5` in all three lanes' claude-args defaults (unset model on
  Max seats = Opus 5; pin discipline mandatory). No `--effort` flag initially.
- `exclude_comments_by_actor` → `dependabot,dependabot[bot]` (upstream #1514: GraphQL
  logins carry no `[bot]` suffix; current value has never matched).
- Add `--allowedTools "mcp__github_inline_comment__create_inline_comment"` to both
  review lanes (the MCP server only installs when named there; without it no inline
  comments are possible). Keep `track_progress: true`.
- Cadence: claude-review canonical caller → `[opened, ready_for_review, reopened]` +
  job-level `if: github.event.pull_request.draft == false` (payload delivers
  draft:false on ready_for_review — safe) + `max-reviews-per-pr` input (default 5,
  name-stable skip beyond cap). **claude-security-review KEEPS `synchronize`** (QF1:
  required checks must report on the latest head; the paths gate makes non-relevant
  pushes skip in seconds). Update the reusable header's canonical-caller comment.
- Retry-with-backoff (all three lanes): attempt-1 `continue-on-error` → fail-closed
  gate (retry ONLY when execution file parses to zero assistant turns) → jittered
  delay (`retry-delay-seconds` input, default 90) → single attempt 2 → terminal
  double-failure feeds the marker/class path (never `exit 1`). Cleanup/update the
  attempt-1 orphan tracking comment (tag mode posts it BEFORE the first assistant
  turn — verifier F3/F5).
- Concurrency: per-(PR,head) cancel-in-progress group stays on the inner job;
  per-repo `queue: max` serialization group goes on the CALLER job (F2 —
  `queue: max` cannot share a block with cancel-in-progress; groups are repo-scoped,
  no org semaphore; freshness guard stays).
- Kill-switches: org Actions variables (per-lane + master, e.g.
  `CLAUDE_REVIEW_DISABLED`, `CLAUDE_SECURITY_REVIEW_DISABLED`,
  `CLAUDE_LANES_DISABLED`), **All-repositories visibility** (documented deviation
  from the selected-visibility convention — selected would silently no-op), read via
  `vars.X != 'true'` job-if inside the reusable; repo variable overrides org.
- Composite-action extraction: tripwire / freshness-guard / outcome-report /
  marker-comment / credential-strip quartet → `.github/actions/*` shared by all lanes.
- Marker-comment copy rewrite (F4): "pushing a new commit will retry" is wrong under
  single-pass; document the dispatch re-review path; mention/dispatch flows must
  clear/update markers.
- #237: emit machine-readable `class=auth|rate-limit|concurrency|overloaded|other`
  from the SDK result's api_error_status / allowlisted substrings, in the `::error`
  annotation + infra-status comment. #238: scheduled aggregator polling consumer
  check-run annotations for `class=` tokens, maintaining one incident work item,
  auto-resolving on recovery. Unifies three observed silent-failure modes
  (seat/credential death, SDK instant-fail claude-code-plugins#1327, runner mismatch
  provisioning#215).
- Migrate the jq outcome-report step to actions/github-script (F7; removes the last
  runner-tool dependency).
- Dependabot: daily schedule; `cooldown: default-days: 7` with
  `exclude: anthropics/claude-code-action`; group `exclude-patterns` so the action
  gets its own same-day PR.

### Verify-before-ship (smoke tests)

- `queue: max` accepted at job level inside a reusable workflow (throwaway branch).
- `ready_for_review` payload draft value on one test PR (belt-and-braces).
- Kill-switch: caller-job conclusion when inner jobs skip; exact required-check name
  strings across all consumer rulesets (`<caller-job> / <inner-job>`); org var read
  from a private repo.
- Whether agent-approval-check-style Co-Authored-By trailer parsing matters for any
  future gate (currently N/A — gate rejected for autonomous repos).

### Acceptance criteria

- All consumer repos on the new caller component; zero hand-written caller drift
  (medley `reopened` gap and skip-actors divergence gone).
- A PR in any consumer repo gets: one code review on open/ready (inline comments
  present), security review per head when security-relevant paths change, name-stable
  skips otherwise; required security check never wedges.
- Forced-failure test (bad token on a sandbox repo): check stays green, marker
  comment + `class=auth` annotation appear, canary opens/updates the incident
  item, and a human and the babysit-loop can both tell "not reviewed" from
  "reviewed clean".
- Setting the org kill-switch variable stops all lane runs fleet-wide within one event;
  unsetting restores.
- Dependabot opens a same-day PR for a new claude-code-action release.

### Captured assumptions

- Fable-verifier adjudications are authoritative where they contradict earlier agent
  reports (#443 refuted for reusables; queue GA; draft:false; repo-scoped groups).
- Sonnet 5's tokenizer (~30% more tokens) is quota-negative per review but net-positive
  after the ~85% volume cut.
- Org has Team plan (org vars reach private repos); confirmed by verifier.

### Out of scope (this effort)

- Assistant (@claude mention) lane build — ci-workflows#255.
- Approval-agent lane — ci-workflows#256 (agent-approval-check REJECTED for autonomous
  repos: bot approvals are discarded by design, author_association NONE; it requires N
  humans and would wedge solo autopilot merges).
- V2 plugin-command review logic (org marketplace) — ci-workflows#258.
- workflow_dispatch re-review entry — ci-workflows#254.
- Fleet SHA-pin staleness audit — ci-workflows#257.
- Incremental security-relevance gating — ci-workflows#259.
- BugBot adoption (deferred; trigger: roster review after cadence data).
- REVIEW-CREDENTIAL App provisioning (deferred behind github-iac governance).
- claude-e2e-verify future: included in mechanical scope here, but flagged as
  park/deprecate candidate — no upstream analog, zero external adopters; decide when
  the first real consumer appears or at next audit.

### Issue mapping (absorbed / superseded — update at implementation)

- ci-workflows #150 (drop synchronize) → implemented for code-review lane; security
  lane deliberately keeps synchronize (QF1) — close with rationale.
- #151 (loop-driven /code-review replacement) → stays deferred, trigger intact.
- #152 → concurrency half already shipped (ec91c34); codex-coverage-intent half
  answered by roster decision — close with pointer.
- #158 (bot detection by account type) → superseded by caller-component
  normalization + skip-actors defaults; evaluate account-type detection in the
  component.
- #227 (required check never fires on bot-pushed heads) → resolve within rollout
  (trigger normalization); verify bot-push behavior in smoke tests.
- #228/#237/#238 → this effort's observability workstream (class token + canary).
- #242 (fleet claude-code-action audit) → satisfied by this effort's research; close
  pointing at the decision record.
- claude-code-plugins #1327 → root-caused (seat contention class); close pointing at
  #237/#238 implementation.
- provisioning #215 → third failure mode folded into #238's taxonomy.
- standards #264 → step-1 REVIEW-CREDENTIAL re-derivation.

### Deferred questions

- [/planning:plan] Exact composite-action boundaries and input plumbing for the
  extracted quartet.
- [/planning:plan] max-reviews-per-pr counting mechanism (tracking-comment markers vs
  runs API).
- [/planning:plan] #238 aggregator host repo and work-item shape.
- [USER-RESERVED] `.github`/ci-runner/ci-runner-canary lane exemption (include vs
  exempt — document either way).
- [USER-RESERVED] e2e-verify park/deprecate (trigger above).

## Plan

Planned 2026-07-26 against origin/main `1b8f658`; revised twice same day: after a
fresh-context plan-review pass (25 findings, 3 CRITICAL) and after a fresh-context
/devils-advocate pass (16 findings, 3 CRITICAL, verdict SURVIVES-WITH-FIXES) plus a
doc-verified GitHub-platform research pass. All confirmed findings folded in below.
Standards grounding: ci-workflows CLAUDE.md (SHA-pin + log-hygiene + least-privilege
rules), README versioning contract + self-reference pin convention
(`# <short-sha> <date>`, e.g. do-not-merge.yml:25), standards AGENTS.md PR
conventions + `distribution/governance-process.md` reconciliation step,
`distribution/README.md` manifest scope statements, sync-manifest schema v2.

**Reality deltas vs Brief (verified):**

- #237's class-token emission ALREADY MERGED (#248/#249/#251, 2026-07-26) for both
  review lanes — bash `classify-infra-failure.sh` rendered into generated embeds;
  issue #237 closed. Remaining: F7 migration, e2e parity decision, #238 aggregator.
- `medley-archive`, `itinerary-planner`, `melodic-main-archive` are archived —
  "every org repo" = every non-archived repo. `ci-runner-canary` does not exist.
- Pinned actionlint 1.7.12 (latest upstream) hard-errors on `concurrency: queue:`
  (rhysd/actionlint#654 open) — and every CONSUMER lints its own workflows with its
  own pinned copy of the ci-workflows actionlint composite, several feeding a
  required `ci-status` check. The disposition is a FLEET precondition (Phase 3c0),
  not a ci-workflows-local one.
- The standards-sync App token is minted with contents+pull-requests write only
  (standards-sync.yml:387-388); writing `.github/workflows/` files requires the App
  `workflows` permission (platform-doc-verified) — Phase 3a0 gate.
- `CLAUDE_CODE_OAUTH_TOKEN` org secret has `visibility: all` (live-verified) — the
  forced-failure test must NEVER revoke it; it uses a sandbox repo with a
  repo-level same-name secret override (repo scope wins).
- Platform docs confirm: `concurrency` (incl. `queue`) is documented at BOTH
  workflow and job level, and `jobs.<id>.concurrency` is an allowed keyword on jobs
  that call reusable workflows; `queue: max` + `cancel-in-progress: true` in one
  block is a validation error; a full queue (100 pending) CANCELS new arrivals;
  job-level `if:` skips satisfy required checks while workflow-level non-triggers
  block them forever; `pull_request` runs execute the workflow file from the MERGE
  COMMIT (a sync PR replacing a caller exercises the NEW caller on itself).

### Phase 0: Throwaway probes, then the actionlint disposition [DONE]

Probes FIRST (devils-advocate F3: never spend an approval on a suppression before
the probe proves the syntax works). Probes run on a throwaway ci-workflows branch
via `workflow_dispatch`/branch-push (no PR → no actionlint run); branch deleted
after. Only 0d (disposition) changes production files, post-approval.

- **0a. Queue probes:** throwaway reusable + caller pair; three shapes:
  1. job-level `queue: max` on a plain job;
  2. job-level `queue: max` on a `uses:` (reusable-calling) job — the shipping
     shape — with a SEPARATE workflow-level per-PR `cancel-in-progress: true`
     block coexisting;
  3. workflow-level `queue: max` without cancel (fallback home).
  Fire overlapping runs: second queues (not cancels, not parallels). Record
  conclusions verbatim.
- **0b. `ready_for_review` draft payload probe:** probe workflow echoes
  `${{ github.event.pull_request.draft }}`; flip a test PR draft→ready; expect
  `false`.
- **0c. Kill-switch probe:** throwaway reusable with
  `if: ${{ !cancelled() && vars.PROBE_DISABLED != 'true' && ... }}` matching the
  security lane's job-if shape; repo-level variable set/unset/absent; record the
  caller-job conclusion when the inner job skips.
- **0d. actionlint disposition [USER-APPROVAL GATE]**, brought AFTER 0a with the
  real option space. If 0a-shape-2 works (docs say it should):
  1. RECOMMENDED: repo-local `.github/actionlint.yaml` ignore entry scoped to the
     queue syntax-check message, justification at the suppression site + dated
     removal trigger on rhysd/actionlint#654 — repo-local because consumers pin
     DIFFERENT composite SHAs (a composite `ignore` input would not exist on older
     pins); fleet distribution handled in Phase 3c0. Verify each consumer's pinned
     actionlint version accepts the config key before relying on it.
  2. Vendored patched actionlint (owns a fork — heavy).
  3. Drop `queue:` (loses the Brief's serialization decision).

**Sanity Check:** probe run URLs + observed conclusions recorded as a dated block
in this section; `git ls-remote origin 'refs/heads/*probe*'` returns empty after
cleanup; 0d decision + explicit approval recorded here before any `queue:` line
lands on a mainline branch.

**Probe results (2026-07-26, branch `probe/claude-review-lanes` @ 6cd08df/6d30857/383a797,
runs at `https://github.com/melodic-software/ci-workflows/actions/runs/<id>`):**

- **0a — all three queue shapes ACCEPTED and serialize.** Two pushes 20s apart,
  70s job sleeps; in every shape run 2's job started only after run 1's job
  completed, conclusions all `success`, nothing cancelled, no workflow-file
  validation errors:
  - shape 1 (job-level `queue: max`, plain job): runs 30223256397 →
    30223269024; job windows 22:30:12–22:31:24 → 22:31:28–22:32:41.
  - shape 2 (SHIPPING SHAPE — job-level `queue: max` on a `uses:` job +
    separate workflow-level `cancel-in-progress: true` block): runs
    30223256437 → 30223269148; job windows 22:30:12–22:31:25 →
    22:31:26–22:32:38. Coexisting blocks accepted.
  - shape 3 (workflow-level `queue: max`, no cancel): runs 30223256330 →
    30223269059; job windows 22:30:12–22:31:24 → 22:31:27–22:32:39.
- **0b — `ready_for_review` delivers `draft=false`.** PR #270 probe: `opened`
  (draft PR) echoed `draft=true` (run 30223287000); flip to ready echoed
  `action=ready_for_review draft=false` (run 30223293451). Job-level
  `if: github.event.pull_request.draft == false` is safe on this trigger.
- **0c — kill-switch job-if states** (reusable mirroring the security lane's
  job-if shape; repo variable `PROBE_DISABLED`): absent → inner `success`
  (run 30223256367); `true` → inner `skipped`, `changes` job and RUN
  conclusion `success` (run 30223269188) — skip is name-stable success;
  `false` → inner `success` (run 30223470912). `vars.X != 'true'` semantics
  confirmed for all three states.
- **0d — actionlint disposition (option 1, pre-approved — Approval record
  item 3).** Local pinned actionlint 1.7.12 reproduces the blocker verbatim
  (`unexpected key "queue" for "concurrency" section [syntax-check]`).
  Empirical config test: scratch repo with a `queue: max` workflow —
  `.github/actionlint.yaml` carrying a `paths → ignore` entry scoped to that
  message → exit 0; config removed → exit 1. Config key shape accepted by
  1.7.12. Shipped as `.github/actionlint.yaml` with justification + removal
  trigger (rhysd/actionlint#654); fleet distribution deferred to Phase 3c0.

### Phase 1: standards — REVIEW.md restructure + REVIEW-CREDENTIAL re-derivation [DONE]

One PR to melodic-software/standards. Closes standards#264. Runs in parallel with
Phase 0 (disjoint repos, no dependency).

- `REVIEW.md`: restructure into lane-scoped sections — code-review-lane scope and
  security-lane scope with explicit mutual-exclusion lines (code-review omits
  security findings; each lane pulls only its scope). DELETE `## Do not report`
  (`:74-85`) and `## Cap the nits` (`:87-90`) per Anthropic Sonnet-5 harness-effect
  guidance. Keep `## Severity`, `## Depth`, `blocking` tag semantics. The 6 "Always
  check" bullets route into lane sections (4 security-flavored `blocking` bullets →
  security section; audit-logging/atomicity → code-review section, tags kept).
- `distribution/REVIEW-CREDENTIAL.md`: re-derive per #264 — claude-code-plugins is
  PUBLIC → ineligible for native-reference mount; re-derive the eligible consumer
  set under the public-caller prohibition; mark the `--add-dir` subagent-visibility
  open question empirically resolved; provisioning stays deferred behind github-iac
  governance; update `## Review triggers` + Status.
- Cross-doc reconciliation self-review per `distribution/governance-process.md`
  before merge.
- PR body notes: `review-instructions` is managed in 5 repos, locally-owned in
  medley (Phase 5 equivalence follow-up).
- **Downstream gate:** Phase 2's model-switch PR (2b) does not merge until the five
  downstream `review-instructions` sync PRs have merged — otherwise claude-sonnet-5
  runs against criteria still carrying the filtering the restructure removes.

**Sanity Check:** in standards checkout: `grep -c "Do not report" REVIEW.md` == 0;
`grep -c "Cap the nits" REVIEW.md` == 0; both lane-scope headings present +
≥1 explicit mutual-exclusion line per lane (grep recorded verbatim at
implementation); `grep -ci "public" distribution/REVIEW-CREDENTIAL.md` shows the
claude-code-plugins reclassification; standards#264 closed by the merge; five
downstream sync PRs opened and (before 2b merges) merged — verify via
`gh pr list --repo melodic-software/<target> --search review-instructions`.

**Phase 1 evidence (2026-07-27):** standards#278 merged as `abeccc6`
(2026-07-27T00:03Z); #264 auto-closed by the merge. Post-merge greps on
standards main: `grep -c "Do not report" REVIEW.md` == 0; `grep -c "Cap the
nits" REVIEW.md` == 0; lane headings present (`## Code-review lane scope`
:62, `## Security lane scope` :88), each with an explicit mutual-exclusion
line ("does **not** report security findings … omitted here even when a
hunk plainly contains one" / "Everything else … is out of scope here and is
owned by the code-review lane; omit it"); `grep -ci public
distribution/REVIEW-CREDENTIAL.md` == 27 (public-state re-derivation
present). Three Codex review threads were fixed in `18bda17` before merge:
the mount prohibition now conditions on private content (with
`conventions/README.md` reconciled), the retained credential classification
is explicitly historical, and `ai-review-bot-composition.md`'s governed
baseline is the two scope-split lanes. Five `review-instructions` sync PRs
opened: ci-workflows#275, claude-code-plugins#1643, github-iac#230,
dotfiles#344, provisioning#221 — all five must be MERGED before 2b merges
(the 2b gate). Merge state (2026-07-27): automerge had never actually
armed (empty auto-merge timeline on every PR despite the prior session's
record); armed 2026-07-27, after which ci-workflows#275,
claude-code-plugins#1643, github-iac#230, and provisioning#221 merged
immediately (their checks were already CLEAN) and dotfiles#344 armed on a
second attempt; all five are MERGED (last: dotfiles#344,
2026-07-27T00:57Z). The review lanes SKIPPED on every sync PR — the
callers pass `skip-actors` including `melodic-standards-sync[bot]`
(verified in dotfiles' caller) — so the prior handoff's open question
resolves as "not exercised"; the new REVIEW.md's first real exercise
arrives with ordinary PR traffic.

### Phase 2: ci-workflows change set [DONE]

After Phases 0 + 1 (2b additionally gated on the five sync PRs). Delivery:
**PR-A1** (composites land, unreferenced), **PR-A2** (reusables repoint at the
merged SHA — self-reference pins resolvable only post-merge), **PR-B** (features
2b–2i). Release tag (2j) after all merge. Self-callers dogfood every PR.

- **2a. Composite extraction — THREE actions** (tripwire + credential-strip stay
  inline: a 5-line guard and a 1-line unset don't earn an action.yml + self-pin +
  fetch surface):
  - `claude-lane-freshness/` — github-script; output `superseded`.
  - `claude-lane-outcome/` — inputs `execution-file`, `lane`; outputs `outcome`,
    `failure-class`. F7 resolution: classifier rewritten as JS inside this
    composite; RETIRE `classify-infra-failure.sh`, `classify-infra-failure.test.sh`,
    `render-classify-infra-failure.cjs`, `classify-infra-failure-render.test.cjs`;
    port the classification corpus to `node --test` (`.test.cjs`). Generated-embed
    blocks in both review lanes replaced by the composite reference.
  - `claude-lane-marker-comment/` — inputs `marker`, `mode`
    (post-failure|clear-on-success), `failure-class`, `body-copy`; owns
    find-by-marker + edit-by-ID + fork-PR guard.
  - Reference form from the reusables:
    `melodic-software/ci-workflows/.github/actions/claude-lane-<x>@<sha>` with
    `# <short-sha> <date>` comment (self-reference convention) — local `./` refs
    resolve against the CALLER's checkout in a reusable and cannot work
    (precedent: render-classify-infra-failure.cjs:9-11).
  - Update `claude-review-superseded-guard.test.cjs` deliberately (7-occurrence
    tripwire changes shape).
- **2a-addendum (PR-A2 execution record, 2026-07-27):** PR-A1 merged as
  `b5d54bf7cb386b1f2c35426c6c5fb8d1686671bd`; composites pinned at that SHA.
  PR-A2 (ci-workflows#276) merged as `a7c7145` (2026-07-27T00:57Z) — the
  repoint is live on main; 2a is complete.
  #266's fail-closed change landed between plan approval and the repoint, so
  the security lane's outcome step was not a pure embed swap: the composite
  records the failure without failing, and a new inline `Fail closed on an
  in-scope non-run` step owns the required-check red — the same
  pull_request-only carve-out, expressed as a step condition
  (`review-failed == 'true' && github.event.pull_request.number != ''`).
  `claude-security-review-fail-closed.test.cjs` re-pins the wiring shape
  (resolve step, composite inputs, fail-closed condition); the
  classification behavior corpus lives in
  `.github/actions/claude-lane-outcome/classify.test.cjs`. The security
  lane's expanded marker body rides the composite's `body-copy` as
  blockquote-continuation lines (input description updated, docs-only).
  `selector-conformance.yml` also dropped its classifier path triggers +
  test step — a consumer of the retired files the plan had not listed.
  Known cosmetic delta until 2g: the composite annotation says "not a
  code-quality signal" on both lanes (the security lane previously said
  "not a security signal"); align the wording during the 2g copy rewrite.
- **2b. Config currency (all three lanes):** pin bump → v1.0.183 (full SHA +
  `# v1.0.183`); `--model claude-sonnet-5` defaults (no `--effort`);
  `exclude_comments_by_actor: dependabot,dependabot[bot]` + upstream-#1514 comment
  (claude-review input default AND security lane's hardcoded value — lift to input
  for symmetry); `--allowedTools "mcp__github_inline_comment__create_inline_comment"`
  composed into both review lanes' args; `track_progress: true` kept. Actor
  normalization: `skip-actors` default →
  `dependabot[bot],claude[bot],melodic-ai[bot],melodic-standards-sync[bot]`
  (self-trigger ban); `allowed_bots` stays `dependabot[bot]`. Correct the stale
  header claim that the org secret uses selected-repositories scope (live value:
  `all`) — devils-advocate F16.
- **2b-addendum (Phase 1 verifier finding, 2026-07-26):** claude-review.yml's
  default prompt says "review for correctness, security, and alignment…";
  restructured REVIEW.md scopes security out of this lane wherever a
  claude-security-review workflow exists. Align the default prompt during 2b:
  name the lane (code-review) and defer security scope to REVIEW.md's split.
- **2c. Cadence (claude-review only):** job-level
  `if: github.event.pull_request.draft == false` composed into existing skip
  conditions; header canonical-caller comment → `[opened, ready_for_review,
  reopened]`; remove `synchronize` from `claude-review-self.yml:14` (dogfood ships
  the cadence it documents). New input `max-reviews-per-pr` (default 5); counting
  mechanism [FALLBACK — confirm or override]: a VISIBLE per-PR status comment
  ("Claude has reviewed this PR N times", HTML marker for machine reads),
  upserted by the outcome step only after a successful review; gate step reads it
  and name-stable-skips beyond cap; deletion = fail-open (review resumes). Chosen
  after BOTH Brief-named candidates failed review: runs-API counts every advisory
  success incl. skips and needs `actions: read` no caller grants
  (devils-advocate F12); a bare hidden comment renders as an empty box and races
  (review F15) — the visible status comment doubles as the human "was this
  reviewed" signal, and the review lane's queue serialization bounds the race.
  **claude-security-review keeps `synchronize` (QF1) — untouched reporting shape.**
- **2d. Retry-with-backoff (all three lanes):** attempt-1 step
  `continue-on-error: true` + step-level `timeout-minutes` → gate step → jittered
  delay (`retry-delay-seconds` input, default 90) → single attempt-2, ALSO
  `continue-on-error: true` + step timeout → outcome consumes the last existing
  execution file. Job `timeout-minutes` = 2×attempt-budget + delay + 5 (a slow
  attempt 1 must never convert the advisory lane into a red job timeout). Retry
  gate [FALLBACK — minor refinement of locked B24]: retry iff execution file
  parses to ZERO assistant turns AND `failure-class` != `auth` — zero-turns is the
  artifact-safety condition (nothing posted → attempt 2 cannot duplicate inline
  comments; devils-advocate F9 killed the broader class-based gate), the class
  check only EXCLUDES pointless auth retries. Mid-review contention failures are
  NOT retried — accepted, documented in-header. Between attempts: locate and
  delete/supersede the attempt-1 orphan tracking comment (tag mode posts it before
  the first assistant turn — F3/F5). Terminal double-failure feeds marker/class
  path; never `exit 1`.
- **2e. Concurrency (per-LANE values — devils-advocate F5):** inner per-(PR,head)
  cancel groups unchanged; freshness guard stays. Caller shapes (ship in Phase 3
  components; documented in reusable headers now):
  - review caller: workflow-level per-PR `cancel-in-progress: true` group +
    job-level `queue: max` group `claude-review-${{ github.repository }}` as a
    separate block;
  - security caller: `cancel-in-progress: false` (claude-code-plugins' live,
    deliberate value on the one repo with the required check — a cancelled
    required check is not a skip and does not read success) and NO queue group
    initially; queue added only if the 3c overflow smoke proves the
    cancelled-overflow case cannot wedge the required check.
- **2f-addendum (Phase 1 verifier finding, 2026-07-26):** REVIEW.md's
  code-review-lane exclusion is gated on the security-lane WORKFLOW FILE
  existing. The 2f kill-switch makes the file exist while the lane is off —
  silently reopening the suppressed-security-findings window. Resolve during
  2f: either the exclusion predicate also keys on the kill-switch state, or
  the kill-switch docs (README + REVIEW.md wording) record that disabling the
  security lane re-widens the code-review lane, and the incident playbook
  says so. Decide with 2f, before Phase 3 rollout.
- **2f. Kill-switches:** job-if in all three reusables:
  `vars.CLAUDE_LANES_DISABLED != 'true' && vars.<LANE>_DISABLED != 'true'`
  (`CLAUDE_REVIEW_DISABLED`, `CLAUDE_SECURITY_REVIEW_DISABLED`,
  `CLAUDE_E2E_VERIFY_DISABLED`); absent var → `''` → enabled; repo var overrides
  org (both platform-verified). Security lane: composes into the `security-review`
  job's `!cancelled()` expression (skip = name-stable success), never the
  `changes` job. Verified by 0c probe + dogfood-tested with a repo-level variable
  BEFORE the release tag.
- **2g. Marker copy rewrite (F4):** replace "Re-running the job, or pushing a new
  commit, will retry the review" (claude-review.yml:533,
  claude-security-review.yml:601) with single-pass-correct copy (re-run the job;
  dispatch path arrives with #254); mention/dispatch flows must clear/update
  markers.
- **2h. e2e lane — mechanical currency only:** pin, model, kill-switch, retry.
  Marker/class adoption is NET-NEW PR-comment behavior for this lane — deferred
  into the USER-RESERVED park/deprecate decision; if kept live, adopt with a
  `github.event.pull_request` guard (workflow_dispatch has no PR).
- **2i. Dependabot:** `interval: daily`; `cooldown: default-days: 7` +
  `exclude: [anthropics/claude-code-action]`; group `github-actions` gains
  `exclude-patterns: [anthropics/claude-code-action]`.
- **2j. Release:** `release.yml` workflow_dispatch, bump `minor`.
- **2b-2i execution record (2026-07-27, PR-B):** built on
  `feat/claude-review-lanes-b` (stacked on A2, rebased onto main after the
  A2 squash). Commits: `0ea2492` (2b), `41fddc7` (2i), `eb89a2a` (2c),
  `042020f` (2d), `b7a13d7` (adversarial hardening), `97f8251` (doc
  reconciliation), `21af5ac` (2e), `656d69a` (2f), `796b993` (2g); 2h is
  satisfied by 2b/2d/2f's mechanical application to the e2e lane, with no
  marker/class adoption. Notes against the plan text:
  - Sanity-check amendments: "exactly 3" claude-code-action pins predates
    #266's in-workflow retry and 2d's verbatim-copy retries — actual is 6
    uses, all `be7b93b` `# v1.0.183`.
    `grep -c synchronize .github/workflows/claude-review-self.yml` == 1: a
    comment documenting the removal; the trigger list carries none.
  - The 2c counter and 2d retry gate shipped exactly as the plan-locked
    fallbacks (visible status comment; zero-assistant-turns AND not-auth).
  - 2f-addendum resolved via the DOCS route: the exclusion predicate cannot
    key on kill-switch state (REVIEW.md is static prose the review agent
    reads; Actions vars are invisible to it), so both lane headers record
    that a kill-switched security lane re-widens the
    suppressed-security-findings window until re-enabled.
  - 2g's composite edits (default body-copy, lane-aware annotation noun)
    take effect at the Phase 3g re-pin; claude-review passes an explicit
    live body-copy meanwhile.
  - Post-review steps swapped `always()` for `!cancelled()` on all three
    lanes (adversarial-review F2): cancellation is the concurrency group's
    retirement mechanism, so a cancelled run must not report an outcome,
    raise the fail-closed red, or mutate the newer run's comment state.
  - Independent fresh-context verifiers audited every producer's commits:
    2b/2i/2c PASS (doc drift D1-D4 fixed in `97f8251`); 2d-2g audit
    recorded in the PR thread.

**Sanity Check:**
`grep -rc "12531344451323133b0493233c759991ac61da12" .github/workflows/` == 0;
`grep -rn "claude-code-action@" .github/workflows/` shows exactly 3 matches, all
carrying `# v1.0.183`; `grep -c "claude-sonnet-5"` == 1 in each of the 3 lane
files; `grep -l "dependabot,dependabot\[bot\]"` lists both review lanes;
`grep -l "mcp__github_inline_comment__create_inline_comment"` lists both review
lanes; `grep -c "synchronize" .github/workflows/claude-review-self.yml` == 0;
actionlint (per 0d disposition) + zizmor +
`node --test .github/scripts/*.test.cjs` + remaining `.test.sh` suites exit 0;
`ls .github/scripts/classify-infra-failure* .github/scripts/render-classify-infra-failure*`
→ no matches; dogfood PR receives a review with ≥1 inline comment AND the
review-count status comment appears; forced-failure probe (SANDBOX repo with
repo-level bad-value `CLAUDE_CODE_OAUTH_TOKEN` override — NEVER revoke the
org-secret, visibility `all`): check concludes SUCCESS, marker present,
annotation contains `class=auth`; a second push to the dogfood PR does NOT
re-trigger claude-review but DOES run the security lane's `changes` job.

- **Phase 2 close-out (2026-07-27):** PR-B merged as `cf666f67` (#280,
  2026-07-27T12:41Z). Independent verifier series verdict: SHIP, with its
  findings fixed in `069a2c3`. Dogfood evidence on #280: the review-count
  status comment observed (`claude-review-count:1`, by github-actions[bot]);
  kill-switch dogfood — repo var `CLAUDE_REVIEW_DISABLED=true` produced a
  name-stable `review / review` skip on a re-run of run 30266815861, var
  removed afterwards. Release `v0.9.0` tagged via release.yml dispatch
  (run 30267095737). Deferred into the Phase 3c smoke: the forced-failure
  sandbox probe and the second-push cadence observation.

### Phase 3: fleet rollout via standards sync-manifest [DOING]

Ordered pre-steps, then waved rollout.

- **3a0. Sync App `workflows` permission [USER-APPROVAL GATE]:** grant
  `Workflows: read & write` on the standards-sync App (org-owner action; lands as
  a github-iac change per org conventions) + add `permission-workflows: write` to
  the token mint (standards-sync.yml:387-388 region). SURFACED: this widens the
  sync App from "materialize config files" to "can rewrite any workflow file in
  every target repo".
- **3c0. Fleet actionlint precondition (devils-advocate F1):** BEFORE any caller
  component syncs, distribute the 0d-approved `.github/actionlint.yaml`
  suppression to every consumer that lints its own workflows (dotfiles,
  github-iac, provisioning, claude-code-plugins, standards, medley) — itself a
  candidate sync component; verify each repo's pinned actionlint version accepts
  the config key (older binaries may reject unknown keys). Without this, the
  caller sync PRs fail each consumer's own `ci-status` required check and the
  whole rollout wedges.
- **3a. standards PR — caller components:** `claude-review-caller` +
  `claude-security-review-caller` (sources `components/claude-lanes/…`, dest
  `.github/workflows/claude-review.yml` / `claude-security-review.yml`), pinned to
  the Phase 2 release SHA + `# vX.Y.Z`. Component shape: job ids `review` /
  `security-review` (required-check continuity); triggers — review:
  `[opened, ready_for_review, reopened]`, security: + `synchronize`, NEVER
  workflow-level path filtering on the security caller (workflow non-trigger
  blocks a required check forever — platform-verified asymmetry); per-lane
  concurrency per 2e; normalized skip-actors (2b values); runner via
  `select-runner.yml` indirection uniformly [FALLBACK — confirm or override]:
  select-runner force-hosts public repos (select-runner.cjs:209-212) so one
  component serves both visibilities, BUT under `self-hosted-only` policy a
  selector failure or offline fleet is a silent-green/queue-forever path invisible
  to the canary (devils-advocate F4) — mitigation shipped with it: caller-side
  marker/`class=runner` emission on selector failure + a selector-failure case in
  the Phase 4 acceptance test (alternative: pin review lanes hosted-only — they
  are API-bound, not build-bound; costs Actions minutes on private repos).
  Security `paths` (devils-advocate F2 — per-repo policy, not fleet uniform): the
  REUSABLE gains a `paths-file` input (conventional path, e.g.
  `.github/claude-security-paths`); the `changes` job fetches it via the contents
  API (no checkout added); file absent → fail-open `relevant=true` (current `''`
  semantics unchanged). The component caller passes the conventional path; each
  repo owns its paths file (claude-code-plugins keeps its 27-entry tuned list
  verbatim; new adopters get a seeded starter list in their sync PR). Medley
  divergence classification: `reopened` gap + skip-actors = drift (normalized
  away); its `paths-ignore` block = TUNING — carried as accepted loss [FALLBACK —
  confirm]: component ships without it (medley review volume rises slightly);
  alternative: org-default paths-ignore in the component. README scope amendment:
  revise ALL THREE workflow-caller-exclusion statements (distribution/README.md
  ~:65, :116, :195) + grep AGENTS.md/governance-process.md for restatements;
  rationale: hand-written callers empirically drifted (medley `reopened` gap,
  skip-actors divergence, pin skew v0.6.1↔e295107).
- **3b. Kill-switch org variables** before rollout: `CLAUDE_LANES_DISABLED`,
  `CLAUDE_REVIEW_DISABLED`, `CLAUDE_SECURITY_REVIEW_DISABLED`,
  `CLAUDE_E2E_VERIFY_DISABLED` = `false`, **All-repositories visibility**
  (documented deviation: selected visibility silently no-ops outside the
  selection); rationale recorded in ci-workflows README kill-switch section.
  Medley's out-of-scope `claude-assistant.yml` lane [FALLBACK — confirm]: add the
  one-line `CLAUDE_LANES_DISABLED` check to it so the master switch actually
  stops ALL Claude lanes (alternative: record as known-uncovered with trigger
  tied to #255). Acceptance criterion reworded: master switch stops all MANAGED
  lane runs; the security `changes` relevance job still runs (by design —
  name-stable reporting).
- **3c. Pre-rollout smoke:** org-var flip on one private consumer (caller runs,
  inner skips, conclusion recorded; org var readable on Team plan); security-gate
  invariant intact post-component — BOTH halves, because the gate is org-owned,
  not repo-local (claude-code-plugins carries zero repo-local rulesets — check
  with `?includes_parents=false`, since the bare listing returns the 4
  org-sourced ones and reads as if the repo owned them): org ruleset `19388547`
  `security-review-gate` unchanged in EVERY field that can disarm it. Do not
  enumerate the fields to keep — enumerate only the ones provably inert and
  compare the whole remainder as canonicalized JSON, so a top-level field GitHub
  adds later is captured by default instead of silently dropped:
  `gh api orgs/melodic-software/rulesets/19388547 --jq 'del(.id, .name,
  .node_id, .source, .source_type, .created_at, .updated_at, ._links)'`. An
  allow-list is what fails here: `target` and `bypass_actors` are top-level
  SIBLINGS of `conditions` and `rules`, so pinning those two alone misses a
  retarget to `tag` and misses a bypass actor. Inside `conditions`,
  `repository_property.exclude` is the subtlest disarm of all — GitHub documents
  "The condition will not pass if any of these properties match", so excluding
  ANY property claude-code-plugins carries (`requires-signing == "true"`, say)
  disarms the gate with every other field byte-identical. AND the set of repos
  carrying `requires-security-review`
  `"true"` still equal to `{claude-code-plugins}`; the
  property is `org_actors`-editable and
  defaults `"false"`, so a flip on either side arms or disarms the required check
  WITHOUT touching the ruleset string, and 3d is exactly when that drifts;
  queue-overflow case: the old criterion named an artifact that may not exist, so
  probe the discriminator first — does a run cancelled while PENDING create a
  check RUN for its jobs? One adjacent observation says no: claude-code-plugins
  run `30172462100` (conclusion `cancelled`, zero jobs) left no
  `security-review / security-review` check run at `d26dac6`, where 24 sibling
  checks DID report. Two caveats, both load-bearing — it is ONE data point, and
  it came from pending EVICTION under `cancel-in-progress: false` with no
  `queue:` key, which is ADJACENT to `queue: max` overflow, not the same
  mechanism. Note also that the check SUITE there does conclude `cancelled` with
  zero runs, so the signal survives at suite level while the required check —
  which the ruleset evaluates by context — is simply absent. Pass requires the
  required check to REPORT a passing status (`success`, `skipped`, or `neutral`
  — enumerated for classic branch protection; the rulesets docs never enumerate
  conclusions, so treat it as the best-documented proxy for this gate, which is
  a ruleset); absence is a failure mode of equal weight. On either failure the
  queue stays off the security caller — 2e default already ships without it.
- **3d. Waved sync rollout (devils-advocate F7/F8):** pre-steps: (i) set
  `automerge: false` on every target for the rollout window (manifest change
  landing before the component PR; restore after), (ii) for NEW targets
  knowledge-corpus + songwriting [USER-APPROVAL GATE]: extend the App's selected
  access BEFORE the manifest PR merges, in the tightest window that ordering
  allows. The ordering stands; its ORIGINAL RATIONALE was wrong. Attestation
  never reaches the both-directions comparison first: the operative gate is a
  CARDINALITY check (`standards-sync.yml`, `attest` job) that aborts before any
  set-diff — grant first and a run inside the window fails on `installation
  reports 10 repositories; expected 8` (8 being today's manifest cardinality),
  merge first and it fails the inverse; the `missing`/`excess` set-diff is only
  reached on an equal-cardinality SUBSTITUTION. So EITHER order can wedge, but
  the two are NOT equally likely to, and that asymmetry is why BEFORE is right:
  the manifest merge is ITSELF a push to standards `main`, and the caller passes
  no `standards-ref`, so the reusable's `main` default plans the POST-merge
  manifest. Merge-first therefore MANUFACTURES its own triggering run and wedges
  unless the grant lands before that run's `attest` step executes — a
  seconds-to-minutes race, not something to plan around. Grant-first has no
  self-trigger, so it wedges only if some OTHER run reaches `attest` inside the
  window. PRECONDITION, and it is not just about new triggers: the reusable
  serializes on `concurrency: standards-sync` with `cancel-in-progress: false`,
  so runs QUEUE rather than cancel, and a queued run resolves the moving `main`
  ref when its `plan` job finally executes — an already-triggered run can
  therefore plan the PRE-merge manifest (8) against the POST-grant installation
  (10) and wedge. So DRAIN FIRST, and RE-CHECK — sequence is drain, grant,
  re-check, merge: `gh run list --repo melodic-software/standards --workflow
  sync.yml --limit 100 --json databaseId,status --jq
  '[.[]|select(.status!="completed")]'` should return `[]` immediately BEFORE
  the grant and again immediately BEFORE merging the manifest PR. Negate
  `completed` rather than enumerate the pending states — GitHub has at least
  five (`queued`, `in_progress`, `waiting`, `requested`, `pending`) and may add
  more — and pass `--limit` explicitly rather than lean on the default 20 and an
  undocumented newest-first ordering. This REDUCES the window, it does not close
  it: a push landing between the re-check and the merge still wedges, which is
  precisely why the fail-closed property below is what makes the whole procedure
  safe rather than the checks. Grant-first's cost is a different one and belongs
  on the page: for the window the App HOLDS write access to two repos that are
  not yet manifest targets (sync writes only to manifest targets, so the
  exposure is authority, not activity). Either way the wedge is FAIL-CLOSED and
  self-clearing: `attest` is a `needs:` of `sync`, so the whole matrix is
  skipped, not just the mismatched target — the engine has no `always()`,
  nothing mutates, no target is corrupted. Recovery is asymmetric too, the same
  way: under grant-first the manifest merge IS the clean recovery run (10 == 10,
  attest passes, all targets sync), whereas merge-first needs a manual
  `workflow_dispatch` with `dry-run: false` — the dispatch default is `true` and
  both `attest` and `sync` carry `if: !inputs.dry-run`, so a default dispatch
  syncs nothing. Either way recovery is available immediately; it is NOT a wait
  for the weekly cron. MECHANISM: repository SELECTION is REST-addressable —
  `PUT /user/installations/{installation_id}/repositories/{repository_id}` (add)
  and `DELETE` (remove), wrapped by Terraform
  `github_app_installation_repository(-ies)` and Pulumi
  `github.AppInstallationRepository`/`AppInstallationRepositories` — the plural
  forms manage the whole selected set. Docs, verbatim: "Add a single repository
  to an installation. The authenticated user must have admin access to the
  repository." and "This endpoint only works for PATs (classic) with the `repo`
  scope." So the gate does NOT require a hand-timed UI click: it requires a
  HOLDER of a classic `ghp_` PAT with `repo` scope and admin on the targets,
  after which the extension is an API call sequenceable to seconds inside the
  window. Installation `144867070` is `repository_selection: selected`, so an
  extension IS required; repository ids: knowledge-corpus `1300170946`,
  songwriting `1297959888`. Selection is NOT the same surface as installation
  PERMISSIONS — 3a0's `workflows: write` grant stays the org-owner action it is
  documented as, and this endpoint does not touch it. UNDOCUMENTED, do not
  resolve by inference: whether org-owned installations gate above repo-admin —
  the docs require only repo admin, but 144867070 IS org-owned, so as a
  PRECAUTION have an org owner hold the PAT rather than assume repo-admin
  suffices; and whether ADD works when `repository_selection` is `all` (only
  REMOVE states it requires `selected`). App authentication is NOT an open
  question — the PAT-only sentence plus OpenAPI `enabledForGitHubApps: false` on
  both operations excludes it. Shrink the window: every push to standards `main`
  is a real sync run, so merge nothing else inside it, and stay clear of the
  weekly `17 6 * * 1` reconciliation cron — allow hours of GitHub cron drift,
  not minutes. Wave 1: dotfiles (low-traffic private) — verify end-to-end,
  including that the sync PR itself is reviewed by the NEW caller (pull_request
  runs the merge-commit workflow file). Wave 2: remaining existing targets
  (github-iac FIRST for the security lane), then new targets. `.github` +
  ci-runner per the USER-RESERVED exemption decision (both already manifest
  targets; plan default: exempt from lane components, one-line targets comment).
  standards repo is the manifest SOURCE, not a target — its caller stays
  repo-local, byte-equivalence-checked in Phase 5. ROLLBACK procedure: revert
  the component source commit in standards → next sync run proposes the inverse
  delta to all targets → merge those PRs (automerge off ⇒ manual,
  minutes-scale); kill-switch covers the interim; the sync engine NEVER deletes
  files, so de-manifesting a component orphans it — reverting content is the
  only fleet revert.
- **3e. Post-rollout verification — ONE REPO AT A TIME** (devils-advocate F11:
  parallel verification manufactures the seat contention this effort fixes; use
  kill-switches as the sequencing mechanism): per consumer, one PR exercises —
  review fires once on open (inline comments present + count comment), security
  lane reports per head or name-stable-skips, and on ≥1 repo a PR touching the
  repo's PRIMARY language triggers an ACTUAL security run, not a skip (guards
  against a paths file that silently filters everything). #227 smoke: bot-pushed
  head still produces a reporting required check. Record observed concurrency
  data for the cadence follow-ups.
- **3f. Issue updates:** close #150 (code-review lane implemented; security keeps
  synchronize — QF1); comment-close #158 (superseded by component normalization;
  account-type detection noted as component-level candidate); verify+close #227;
  close #242 (pointer to decision record); verify #152's pointer comment.
- **3g. Fleet action-currency follow-through [FALLBACK — confirm or override]:**
  the Brief's "Dependabot keeps it same-day current" reaches ci-workflows only —
  every consumer `ignore`s ci-workflows refs, so fleet currency moves through
  release-tag → component re-pin → sync, all manual today (devils-advocate F10).
  RECOMMENDED: a small scheduled job in standards that re-pins the caller
  components to the newest ci-workflows release tag and lets the existing sync
  cascade carry it (scope addition); alternative: accept the lag, state the
  fleet-propagation SLA in README, and let #257 (staleness audit) be the
  detector.

**Sanity Check:** `bash distribution/sync-manifest.sh validate` exits 0; per
target: `gh api repos/melodic-software/<repo>/contents/.github/workflows/claude-review.yml --jq .sha`
equals `git hash-object components/claude-lanes/claude-review.yml` (blob-hash
equivalence loop recorded verbatim; count of mismatches == 0); medley's synced
caller contains `reopened`; the 3c security-gate invariant re-reads intact —
`gh api orgs/melodic-software/rulesets/19388547 --jq 'del(.id,.name,.node_id,.source,.source_type,.created_at,.updated_at,._links)'`
compared as canonicalized JSON, which is the FULL disarmable surface rather than
just `conditions` + `rules` (the repo-level `rulesets` listing returns none of
these keys, so it cannot verify this at all), AND the property set regenerated:
`gh api "orgs/melodic-software/properties/values?per_page=100" --paginate --jq '.[]|select(.properties[]|select(.property_name=="requires-security-review" and .value=="true"))|.repository_name'`
returns exactly `claude-code-plugins` — AND a live PR shows an ACTUAL
security run (not skip) on a code-touching PR; smoke transcripts (kill-switch,
overflow, #227, wave-1) recorded here; automerge restored after rollout
(`grep -c "automerge: false" distribution/sync-manifest.yml` == 0 post-restore,
or matches only deliberate standing opt-outs).

### Phase 4: observability — #238 aggregator [TODO]

Issue #237 shipped (#248/#249/#251; closed). This phase consumes it. Can be
developed in parallel with Phase 3 (disjoint files); its acceptance test runs
after wave 1.

- Scheduled workflow, host **ci-workflows** (lanes' home; emitted content is
  allowlisted tokens only — public-safe). Polling scope: PRs updated within a 24h
  lookback across consumer repos; per PR head, latest check-run annotations
  filtered for `class=<token>`; pagination bounded; the run LOGS its total
  API-call count as an explicit deliverable line.
- Maintains ONE incident work item: ci-workflows issue labeled
  `claude-lane-incident` — per-class counts, repo list, first/last seen; updated
  in place; auto-closed after 3 consecutive clean cycles.
- Credential: cross-repo `checks:read` + `issues:write`. Candidate: existing
  runner-observer App (`CI_RUNNER_OBSERVER_CLIENT_ID`) if permissions fit; else
  new minimal App per org precedent [USER-APPROVAL GATE either way — no silent
  App widening or creation].
- Canary property: asserts on REAL lane output — covers upstream #1501
  silent-green + seat/credential death, claude-code-plugins#1327 SDK
  instant-fail, provisioning#215 runner mismatch, and (if select-runner stays on
  lane callers) the caller-side `class=runner` selector-failure marker from 3a.
- Acceptance test: sandbox repo with repo-level bad-token override → green
  check + marker + `class=auth` annotation + incident item opens; restore →
  auto-resolves after 3 clean cycles.
- Close #228 + #238 on merge + passing acceptance test; comment-close
  claude-code-plugins#1327 (root cause + pointer); comment provisioning#215
  (folded into taxonomy).

**Sanity Check:** forced-failure transcript shows all four artifacts +
auto-resolve; scheduled-run log contains the API-call-count line;
`gh issue list --repo melodic-software/ci-workflows --label claude-lane-incident --state open`
returns ≤1; #228/#238 closed with pointers.

### Phase 5: close-out [TODO]

- ci-workflows README lane-contract section updated (new inputs, cadence,
  kill-switches, caller-component pointer, kill-switch visibility deviation,
  fleet-propagation SLA if 3g's alternative chosen); CLAUDE.md ground rules
  checked for drift. Sanity: `grep -c "max-reviews-per-pr" README.md` ≥ 1 and
  `grep -c "CLAUDE_LANES_DISABLED" README.md` ≥ 1.
- medley REVIEW.md content-equivalence check (locally-owned vs restructured
  managed source); standards repo-local caller blob-hash equivalence vs component
  source; file issues on drift.
- Co-Authored-By trailer-parsing finding (fourth Brief smoke item, record-only)
  posted as a comment on ci-workflows#256.
- Do-not-break sweep: #151 (loop-driven replacement — note whether the cadence
  cut changes its trigger), #254 (marker copy references it — consistent),
  #255/#256/#258/#259 untouched; #257 seeded with the Phase 3 pin inventory +
  (if 3g alternative chosen) named as the currency detector.
- PLAN.md tags advanced; topic close-out per /planning:plan close-out at PR time.

**Sanity Check:** every Brief issue-mapping row has a linked closing/updating
comment recorded in this file; equivalence results recorded (issue links or "no
drift"); `gh issue view 256 --repo melodic-software/ci-workflows --json comments`
contains the trailer-parsing note.

- **Phase 5 partial evidence (2026-07-29):** two of five bullets fully closed
  (trailer note, do-not-break sweep); one half-closed (equivalence — medley
  done, blob-hash blocked); two outstanding (README/CLAUDE.md, tags advanced),
  so the phase tag stays `[TODO]`.
  - **medley REVIEW.md equivalence — DRIFT, filed as medley#1671.** The
    comparison does not run the way the bullet's framing implies. medley's
    `REVIEW.md` is not a drifted copy of the managed source: it is an
    independently authored 188-line document with its own slice taxonomy, first
    added in `4a1d61a6`, never synced from standards (the 109-line managed
    source has no counterpart section structure). The absent lane-scope
    headings are therefore NOT the finding, because the restructure's
    mutual-exclusion rule is conditional on a named file — standards
    `REVIEW.md:66-73` suppresses security findings only "On a repository whose
    CI runs the security lane (a `.github/workflows/claude-security-review.yml`
    workflow exists)", and otherwise directs "report security findings under
    this lane too". medley has no such workflow and no caller routing to that
    reusable (its only `claude-*` workflows are `claude-assistant.yml` and
    `claude-review.yml`), so medley sits in the else branch and folding
    security in is correct; adopting the mutual-exclusion text would have
    produced the 2f-addendum failure mode of no lane reporting security
    findings. Phase 1 sanity greps clean on medley's copy (`grep -c "Do not
    report"` == 0, `grep -c "Cap the nits"` == 0). All FOUR security-lane
    `blocking` always-checks have counterparts — object-level authorization
    (`REVIEW.md:66` → `review/security.md:18`), secrets and injection
    (`:65` → `review/security.md:7`, `:11`), tenant scoping (`:96` →
    `review/multi-tenancy/README.md`) — as does the code-review lane's own
    audit-log check (`:67` → `review/logging.md:12`), which standards
    `REVIEW.md:79-81` explicitly assigns to the observability seam rather than
    the security lane. medley carries zero suppression language. The real
    drift is the one always-check that is NOT
    security-gated: multi-location atomicity (standards `REVIEW.md:82-86`) has
    no universal-checklist line in medley, and its nearest coverage
    `review/transactions-and-consistency.md` self-scopes to "EF Core
    persistence in the modular monolith" while medley is polyglot
    (`python-ci.yml`, `typescript-ci.yml`, `shell-lint.yml`). medley's file was
    NOT edited — `review-instructions` is `locally-owned` for medley, the
    customization seam. medley#1671 records the gap and the forward-looking
    trigger: adopting a security lane later inverts the finding into
    double-reporting and would then require the mutual-exclusion language.
  - **standards repo-local caller blob-hash equivalence — NOT DONE.** Blocked:
    it cannot run until standards#286 merges and the components sync; that PR
    is still OPEN and unmerged. This half of the equivalence bullet is
    outstanding, not waived.
  - **Co-Authored-By trailer-parsing note — POSTED** as a record-only comment on
    #256 (`issuecomment-5112552526`), satisfying the Sanity Check line. The
    item resolves N/A rather than pass/fail: it is conditional on the
    `agent-approval-check` gate, which #256 already records as rejected for
    autonomous repos, so no probe was run and the comment explicitly declines to
    assert how the trailer parsing works.
  - **Do-not-break sweep — COMPLETE.** #151 trigger UNCHANGED (it keys on a
    background review loop existing, which the cadence cut neither creates nor
    removes); comment records the one real nuance, that the cut erodes the
    "scheduling freedom" rationale without touching the trigger
    (`issuecomment-5112552666`). #254 CONSISTENT — the marker copy
    (`claude-review.yml:751`) advertises only the comment-deletion reset and
    correctly does not promise #254's unbuilt `workflow_dispatch` path.
    #255/#258/#259 UNTOUCHED (all OPEN, `updatedAt` unchanged at
    2026-07-27T02:11Z). #257 SEEDED with the Phase 3 pin inventory
    (`issuecomment-5112552823`), including the medley staleness findings
    (caller at v0.6.1 vs current v0.9.1; assistant lane on claude-code-action
    v1.0.174 vs the lanes' v1.0.183) and the sync-engine pin class where a
    granted capability stays inert until the engine pin moves; no currency
    detector named, since 3g has not run.
  - **Remaining for Phase 5:** the README/CLAUDE.md lane-contract bullet
    (ci-workflows#285, open); the blob-hash equivalence above; and the final
    bullet's "PLAN.md tags advanced; topic close-out at PR time", which cannot
    close while the other two are open — the tag is still `[TODO]`, so tags are
    by definition not yet advanced. Verification:
    FOUR fresh-context verifier rounds ran against the comments, the
    equivalence verdict, and this evidence block; all four returned REJECT and
    each caught a defect introduced while remediating the previous round.
    Round 1: a deployed-state overreach on the #151 comment and a false
    "uniform across all three lane workflows" claim on #257. Round 2: a
    `create-github-app-token` call-site undercount on #257 (one asserted, six
    actual). Round 3: on #257, an absolute "no other pin was assessed"
    disclaimer contradicted by the comment's own coverage claims, plus a
    substantively false one — medley's `claude-code-action` pin described as
    having no Dependabot path when medley#1668 was already open bumping it
    1.0.174 → 1.0.180; and in THIS block, the security-lane always-checks
    mislabelled as five (there are four) and an inverted `:65`/`:66` citation
    mapping. Round 4: this verification sentence itself, which undercounted the
    rounds and asserted the round-2 remediations had not been independently
    re-verified when round 3 had in fact re-verified them. The recurring
    failure mode is compression, not research — the primary evidence was read
    correctly each time and damaged while being condensed into prose. Round 4's
    two non-blocking findings were accepted as named gaps rather than
    remediated, to stop the fix-and-reverify cycle: the #257 Step 2 enumeration
    understates the cooldown/grouping assessment made for medley, and the
    round-listing in ci-workflows#287's body undercounts round 3's findings.

## Blast radius

HIGH. Fleet-wide CI touching every non-archived org repo's PR pipeline, one
required check (claude-code-plugins `security-review / security-review`),
org-level Actions variables, the standards distribution seam, and a permission
widening on the sync App (workflows:write across all targets). Advisory posture
caps the review lanes' failure mode; the dangerous edges — required check,
fleet-wide caller overwrite under armed automerge, App permission grant, shared
org secret — each carry a dedicated gate, wave, or smoke test before exposure.

## Stress-test summary

- Step 3 fresh-context plan review: 25 findings (3 CRITICAL: actionlint 1.7.12
  rejects `queue:`; sync App lacks `workflows` permission; local `./` composite
  refs unusable cross-repo + self-referential pins). All folded in; verdict
  FIX-THEN-SHIP.
- Step 4 /devils-advocate (fresh context, rationale withheld): 16 findings
  (3 CRITICAL: actionlint blocker is fleet-wide, not local; org-default security
  paths silently collapse claude-code-plugins' required-check coverage while
  every planned sanity check still passes; queue-shape approval sequenced before
  the probe that validates it). All folded in; verdict SURVIVES-WITH-FIXES.
- Doc-verified platform research pass settled: job-level `queue` documented incl.
  on reusable-calling jobs; overflow cancels new arrivals; skip-vs-non-trigger
  required-check asymmetry; merge-commit workflow-file semantics; App `workflows`
  permission requirement; org-var precedence + paid-plan private-repo access;
  unset-secret → empty string. Two formerly unverified legs: job-level queue
  (now doc-confirmed, probe retained), runs-API branch semantics (mooted —
  mechanism dropped).
- Research-iterate: no unresolved CRITICAL/HIGH remains; no further round needed.

## Execution shape

Waves (file-overlap + dependency analysis):

- **Wave A (parallel):** Phase 0 (ci-workflows throwaway) ∥ Phase 1 (standards
  PR). Disjoint repos, zero shared files, no dependency.
- **Wave B (sequential):** Phase 2 (PR-A1 → PR-A2 → PR-B → tag) — single-repo
  YAML surgery with stacked PRs; internally sequential by construction.
- **Wave C:** Phase 3 pre-steps 3a0/3c0/3b (parallelizable among themselves) →
  3a component PR → 3c smoke → 3d waves → 3e per-repo sequential (deliberately
  serialized — seat contention).
- **Wave C∥D:** Phase 4 development in parallel with Phase 3 (disjoint files);
  Phase 4 acceptance after 3d wave 1. Phase 5 last.

| Phase | Surface | Basis |
|---|---|---|
| 0 | main session | probe design + approval gate, judgment-heavy |
| 1 | main session (standards checkout) | normative-doc surgery + governance step |
| 2 | main session | core YAML surgery, tightly coupled, dogfood-monitored |
| 3 pre-steps + 3a | main session | gates + cross-repo governance |
| 3d/3e verification | sub-agent fan-out (sonnet), ONE repo at a time | mechanical per-repo checks; serialized for seat contention, not parallelism |
| 3f/5 issue sweeps | sub-agent (haiku/sonnet) | mechanical gh operations |
| 4 | main session (dev) + sub-agent (acceptance monitoring) | new workflow authoring = judgment; monitoring = mechanical |

Cost note: sub-agent usage here is small (verification + issue sweeps); the plan
is deliberately NOT wide-parallel — the constraint is the shared OAuth seat, not
wall-clock. Sequential fallback: run everything main-session in phase order;
nothing depends on agent parallelism.

## Approval record

2026-07-26: Plan APPROVED by operator, including all 12 open decisions resolved to
their RECOMMENDED options:

1. `.github` + ci-runner: EXEMPT from lane components (targets comment documents);
   ci-runner-canary N/A.
2. claude-e2e-verify: mechanical currency only (2h); marker/class adoption deferred
   with dated trigger note (first real consumer or next audit).
3. actionlint disposition: repo-local `.github/actionlint.yaml` suppression scoped
   to the queue syntax-check message + justification at site + removal trigger on
   rhysd/actionlint#654; fleet distribution in 3c0. Suppression explicitly approved.
4. Sync App `workflows: write` grant: APPROVED (org-owner + github-iac change;
   authority widening acknowledged).
5. knowledge-corpus + songwriting new targets: APPROVED; App access extends BEFORE
   manifest merge — ordering unchanged, but its rationale is corrected in 3d
   (cardinality gate, and merge-first self-triggers) — via the REST selection
   endpoint under a classic PAT (precaution: have an org owner hold it), after
   draining in-flight sync runs and re-checking before the merge (3d).
6. Phase 4 credential: reuse runner-observer App if permissions fit, else new
   minimal App — proceed per that order, report which at implementation.
7. Retry gate: zero assistant turns AND class != auth.
8. max-reviews-per-pr: visible per-PR review-count status comment.
9. select-runner kept on lane callers + caller-side class=runner failure surfacing.
10. medley `paths-ignore`: accepted loss (documented).
11. medley claude-assistant lane: gets the one-line CLAUDE_LANES_DISABLED check.
12. Fleet action-currency: scheduled component re-pin job in standards (3g).

Original decision text (recommendations + alternatives) retained below for context.

## Open questions (resolved — see Approval record)

- [USER-RESERVED] `.github` / ci-runner lane components: RECOMMENDED exempt both
  (near-zero PR traffic; ci-runner is runner infra where a wedged lane job could
  block its own substrate). ci-runner-canary: N/A — does not exist. One-line
  targets change either way, documented in manifest comments.
- [USER-RESERVED] claude-e2e-verify park/deprecate: RECOMMENDED keep mechanical
  currency only now (2h) and DEFER its marker/class adoption into this decision;
  dated trigger note in the reusable header + README (decide at first real
  consumer or next audit).
- [GATE] actionlint disposition (Phase 0d; RECOMMENDED repo-local
  `.github/actionlint.yaml` suppression + removal trigger on rhysd/actionlint#654,
  distributed fleet-wide in 3c0).
- [GATE] sync App `workflows: write` grant (Phase 3a0; authority widening stated).
- [GATE] knowledge-corpus + songwriting as new sync targets (App access BEFORE
  manifest merge, via the REST selection endpoint under a classic PAT —
  precaution: have an org owner hold it).
- [GATE] Phase 4 credential (reuse runner-observer App vs new App).
- [FALLBACK — confirm or override] retry gate = zero-turns AND class != auth
  (2d; minor refinement of locked B24).
- [FALLBACK — confirm or override] max-reviews-per-pr = visible per-PR
  review-count status comment (2c; both Brief-named candidates failed review).
- [FALLBACK — confirm or override] select-runner kept on lane callers WITH
  caller-side `class=runner` failure surfacing (3a; alternative hosted-only).
- [FALLBACK — confirm or override] medley `paths-ignore` = accepted loss (3a).
- [FALLBACK — confirm or override] medley assistant lane gets the one-line
  master-kill-switch check (3b).
- [FALLBACK — confirm or override] fleet action-currency: scheduled component
  re-pin job in standards (3g; alternative: accept lag + #257 detector + SLA in
  README).

## Handoff to implementation

### User-approval gates

- Phase 0d actionlint disposition (suppression needs explicit approval; fleet
  distribution in 3c0 rides the same approval).
- Phase 3a0 sync App `workflows: write` grant (org-owner + github-iac change).
- Phase 3d new sync targets (App access extended BEFORE manifest merge, via the
  REST selection endpoint under a classic PAT — precaution: have an org owner
  hold it).
- Phase 4 credential (App reuse vs creation).
- The two USER-RESERVED open questions and six [FALLBACK] items above.
- Any mid-flight pivot touching required-check semantics.

### Execution shape ([EXEC-SHAPE] tagged)

- [EXEC-SHAPE] Composites = 3 (freshness/outcome/marker), tripwire +
  credential-strip inline; two-stage landing (PR-A1/PR-A2); self-SHA pin form.
- [EXEC-SHAPE] F7 = JS rewrite inside `claude-lane-outcome`; retire the 4
  generated-embed classifier files; port corpus to `node --test`.
- [EXEC-SHAPE] Per-lane caller concurrency values (review: cancel+queue;
  security: cancel false, no queue pending overflow evidence).
- [EXEC-SHAPE] Security paths via per-repo `paths-file` + contents-API read;
  reusable default semantics unchanged.
- [EXEC-SHAPE] Forced-failure method = sandbox repo + repo-level secret
  override; never touch the org secret.
- [EXEC-SHAPE] Waved rollout (dotfiles first) + automerge-off window + rollback
  = revert-component-source procedure.
- [EXEC-SHAPE] 3e verification serialized one repo at a time via kill-switches.
- [EXEC-SHAPE] standards repo keeps repo-local caller (manifest source, not
  target); archived repos out of scope.
- Routing table above; PLAN.md edits stay main-session-only; agents report back.

### Mechanical work

- Commit/PR conventions: Conventional Commits PR titles (squash subjects);
  ci-workflows: no trailer_policy → harness default Co-Authored-By trailer;
  standards: same + governance reconciliation step before merge.
- Pin conventions: third-party `uses:` = full SHA + `# vX.Y.Z`; self-references =
  full SHA + `# <short-sha> <date>`.
- Phase 2 gate: full local suite (`node --test .github/scripts/*.test.cjs`, all
  `.test.sh`, actionlint per 0d, zizmor) green before each PR.
- Sequential fallback: every phase independently shippable; Phase 3 rollback per
  3d procedure; kill-switch covers any interim misfire window.
