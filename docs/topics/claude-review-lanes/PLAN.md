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
   ci-runner-canary exemption decided + documented — ci-runner leg superseded
   2026-08-01, see Phase 3d); normalized triggers/skip-actors/
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
  `queue: max` cannot share a block with `cancel-in-progress: true`; groups are
  repo-scoped, no org semaphore; freshness guard stays).
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

- Assistant (@claude mention) lane build — ci-workflows#255 (V1 answer/re-review
  shipped: `claude-assistant.yml` + ADR `claude-assistant-ADR.md`; V2
  fix-and-push remains a separate decision).
- Approval-agent lane — ci-workflows#256 (agent-approval-check REJECTED for autonomous
  repos: bot approvals are discarded by design, author_association NONE; it requires N
  humans and would wedge solo autopilot merges).
- V2 plugin-command review logic (org marketplace) — ci-workflows#258
  (**shipped** 2026-08-12: see [V2-PLUGIN-ARCHITECTURE.md](./V2-PLUGIN-ARCHITECTURE.md);
  thin org skills `/review:code-review` + `/review:security-review`, dual-path
  workflow inputs; deepen adversarial fan-out in the plugin as follow-up).
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
- The sandbox repo is NOT an unconstrained playground (live-verified,
  `orgs/melodic-software/properties/schema` + the two rulesets below): a newly
  created org repo inherits org custom-property defaults, and both org
  rulesets `base` (`17988999`, target `~ALL` repos) and `signing` (`17989003`,
  gated on property `requires-signing == "true"`, which defaults `true`) are
  scoped `conditions.ref_name.include: ["~DEFAULT_BRANCH"]` with an empty
  exclude. So: a non-default branch — the path a PR-based probe takes — is
  unconstrained (no signing requirement, no gate); the sandbox's DEFAULT
  branch is PR-gated (`base` requires `pull_request` + linear history — a
  direct push there is refused regardless of signature) and signature-gated
  (`signing` requires `required_signatures` — satisfied for free by GitHub's
  own squash/rebase merge commit, which GitHub signs itself). `requires-
  security-review` defaults `false` on a new repo, so the security-review
  gate does NOT arm on the sandbox — the desirable half, easy to mistake for
  the whole picture. Net: work the sandbox through PRs (fine as-is). A
  direct push to its default branch stays refused by `base` regardless of
  signing, so `requires-signing=false` alone never enables one — it would
  additionally take an org actor with a bypass on (or a re-scope of) the
  `base` ruleset, a github-iac change; only then does unsetting
  `requires-signing` matter, and only for unsigned pushes.
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

### Phase 3: fleet rollout via standards sync-manifest [DONE]

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
  concurrency per 2e; skip-actors normalized to the 2b values by INHERITANCE,
  not by a passed input (SKIP-ACTORS INHERITANCE below); runner via
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
  repo owns its paths file (claude-code-plugins keeps its 26-entry tuned list
  verbatim; new adopters get a seeded starter list in their sync PR). Medley
  divergence classification: `reopened` gap + skip-actors = drift (normalized
  away); its `paths-ignore` block = TUNING — carried as accepted loss [FALLBACK —
  confirm]: component ships without it (medley review volume rises slightly);
  alternative: org-default paths-ignore in the component. README scope amendment:
  revise ALL THREE workflow-caller-exclusion statements (distribution/README.md
  ~:65, :116, :195) + grep AGENTS.md/governance-process.md for restatements;
  rationale: hand-written callers empirically drifted (medley `reopened` gap,
  skip-actors divergence, pin skew v0.6.1↔e295107).

  SKIP-ACTORS INHERITANCE (measured 2026-07-29): the 2b values reach the fleet
  as the reusable's DEFAULT, not as a value the component passes. The shipped
  component passes no `skip-actors` at all (`grep -c skip-actors` on
  `components/claude-lanes/claude-review.yml` at standards `main` returns 0),
  while the reusable declares the input with default
  `dependabot[bot],claude[bot],melodic-ai[bot],melodic-standards-sync[bot]`.
  Behavior matches the 2b decision today only because both lists contain
  `melodic-standards-sync[bot]`. The old hand-written callers passed an
  explicit two-actor list — `dependabot[bot],melodic-standards-sync[bot]`,
  still live in provisioning's default-branch caller — so the component MOVED
  this value from caller-declared to reusable-inherited. DURABLE RISK: a
  future change to the reusable's default silently alters fleet skip behavior
  with no component diff and no consumer diff to review; the only review
  surface left is the reusable's own PR. This does not contradict the Phase 1
  evidence above, which correctly records the OLD callers passing
  `skip-actors`.
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
- **3d. Waved sync rollout (devils-advocate F7/F8):** pre-steps, STRICTLY IN
  ORDER. (0) RE-PIN THE ENGINE, before anything else. ENGINE HALF LANDED —
  standards#293 moved `sync.yml` to `8202e03f`; the watchdog half below is
  still outstanding, so read the rest of (0) as the record of why, plus the one
  step that remains. As written, standards `sync.yml` pinned
  ci-workflows at `ac223bb`, where auto-merge arming was gated on
  `pull-request-operation == 'created'`. That gate is unsound for THIS phase,
  and the reason is precise — `create-pull-request` (pinned `5f6978f`, v8.1.1)
  always attempts `pulls.create` FIRST and reports `created`; it reports
  `updated` only when that call is rejected with "A pull request already exists
  for". So the discriminator is an OPEN PR, NOT the existence of the
  `chore/standards-sync` branch. Consequence for 3d specifically: the window
  holds sync PRs OPEN by design, so any target whose PR is already open when
  arming would fire is silently NOT armed — and restoring `automerge: true`
  while those wave PRs are still open leaves exactly them unarmed, to be merged
  by hand. It is not permanent and not fleet-wide (once a PR merges, its branch
  is deleted and the next delta reports `created` again), which is why it is
  easy to miss. Re-pin to `8202e03f30dd0c0189c862052d5f242b9a496798` (#291): it
  changes the gate to `pull-request-number != ''` — non-empty on BOTH the create
  and update paths. #291 ALSO adds the never-armed watchdog, but ONE PIN DOES
  NOT SATISFY BOTH — the watchdog lives in a DIFFERENT reusable
  (`standards-sync-stuck-automerge-alert.yml`), reached through a SEPARATE
  standards caller carrying its OWN pin, so re-pinning `sync.yml` activates the
  arming half and nothing else. That watchdog caller
  (`.github/workflows/standards-sync-stuck-automerge-alert.yml:19`) still sits
  at `43bc8d0` (2026-07-22), which predates BOTH #291's never-armed detection
  and #234's split-scan reliability fix. It needs its own re-pin to
  `8202e03f`, as its own PR with its own `components/runner-policy/policy.json`
  entry, and the deadline is BEFORE `automerge: true` is restored: the
  never-armed scan only considers targets the manifest marks `automerge: true`,
  so it is inert while the window holds all 8 at `false` and becomes
  load-bearing at the exact moment the restore lands. (The armed-but-stuck scan
  is NOT automerge-gated — it sweeps every target on the hourly cron today, and
  is quiet only because no sync PR is currently armed.) Confirm nothing
  functional has landed since with `git diff --name-only 8202e03 origin/main`,
  and update the trailing `# <short-sha> <date>` comment alongside the SHA.
  Expect this push to fire a real sync run that refreshes open sync PRs —
  benign here (cardinality unchanged, and
  `automerge: false` still blocks arming). Being a push to standards `main`, it
  goes BEFORE the window opens; inside it, it is exactly the trigger the drain
  exists to exclude. (i) `automerge: false` on every target for the rollout
  window — ALREADY LANDED (standards#290, 8/8 targets), so this is a state to
  CONFIRM by reading the manifest, NOT a step to perform; re-applying it would
  be another push to standards `main`, so if it is ever needed, it happens
  before the grant, never inside the window. Restore it only AFTER (0) is in
  place, and expect to merge any still-open wave PRs by hand. (ii) for NEW
  targets knowledge-corpus + songwriting [USER-APPROVAL GATE] — TARGET SET
  SUPERSEDED 2026-08-01 (see WAVE-TARGET SET — RATIFIED below): both repos are
  retired as planned targets, so this gate is UNREACHED rather than removed. No
  adopted target is landable yet (see RATIFIED BUT NOT YET LANDABLE below), and
  the mechanism and ordering analysis through the end of this step stay live for
  whichever NEW target eventually lands — cursor-plugins or claude-code-proxy,
  NOT ci-runner, which is already a manifest target and whose gate is the
  removal trigger rather than this grant (see APP GRANT and RATIFIED BUT NOT
  YET LANDABLE below). The step as approved, and still the procedure for a new
  target: extend the App's
  selected access BEFORE the manifest PR merges, in the tightest window that
  ordering allows. The ordering stands; its ORIGINAL RATIONALE was wrong.
  Attestation never reaches the both-directions comparison first: the operative
  gate is a CARDINALITY check (`standards-sync.yml`, `attest` job) that aborts
  before any set-diff — grant first and a run inside the window fails on
  `installation reports 10 repositories; expected 8` (8 being today's manifest
  cardinality), merge first and it fails the inverse; the `missing`/`excess`
  set-diff is only reached on an equal-cardinality SUBSTITUTION. So EITHER order
  can wedge, but the two are NOT equally likely to, and that asymmetry is why
  BEFORE is right: the manifest merge is ITSELF a push to standards `main`, and
  the caller passes no `standards-ref`, so the reusable's `main` default plans
  the POST-merge manifest. Merge-first therefore MANUFACTURES its own triggering
  run and wedges unless the grant lands before that run's `attest` step executes
  — a seconds-to-minutes race, not something to plan around. Grant-first has no
  self-trigger, so it wedges only if some OTHER run reaches `attest` inside the
  window. PRECONDITION, and it is not just about new triggers: the reusable
  serializes on `concurrency: standards-sync` with `cancel-in-progress: false`,
  so runs QUEUE rather than cancel, and a queued run resolves the moving `main`
  ref when its `plan` job finally executes — an already-triggered run can
  therefore plan the PRE-merge manifest (8) against the POST-grant installation
  (10) and wedge. So DRAIN FIRST, and RE-CHECK. Whole ordered sequence, (0)
  through the merge: re-pin, confirm `automerge: false`, drain, grant, re-check,
  merge — of these ONLY the re-pin writes (confirming is a read), and because it
  writes to standards `main` it MUST precede the drain, or it becomes the very
  trigger the drain exists to exclude. Restoring `automerge: true` afterwards is
  a second write, and belongs after the window closes, never inside it. The
  drain check must return `[]` immediately BEFORE the grant and again
  immediately BEFORE merging the manifest PR:
  `gh api "repos/melodic-software/standards/actions/workflows/sync.yml/runs?per_page=100" --paginate --slurp | jq -c '[.[].workflow_runs[]|select(.status!="completed")]'`
  Two deliberate choices. It NEGATES `completed` rather than enumerating the
  pending states, because GitHub has at least five (`queued`, `in_progress`,
  `waiting`, `requested`, `pending`) and may add more. And it PAGINATES the full
  run history rather than sampling a page, because `gh run list` defaults to 20
  and its newest-first ordering is undocumented — a pending run outside the
  sample would read as a drained queue. (`--slurp` is rejected alongside `--jq`,
  hence the pipe; it also makes the result ONE array instead of one per page.)
  This REDUCES the window, it does not close it: a push landing between the
  re-check and the merge still wedges, which is precisely why the fail-closed
  property below is what makes the whole procedure safe rather than the checks.
  Grant-first's cost is a different one and belongs on the page: for the window
  the App HOLDS write access to two repos that are not yet manifest targets
  (sync writes only to manifest targets, so the exposure is authority, not
  activity). Either way the wedge is FAIL-CLOSED and self-clearing: `attest` is
  a `needs:` of `sync`, so the whole matrix is skipped, not just the mismatched
  target — the engine has no `always()`, nothing mutates, no target is
  corrupted. Recovery is asymmetric too, the same way: under grant-first the
  manifest merge IS the clean recovery run (10 == 10, attest passes, all targets
  sync), whereas merge-first needs a manual `workflow_dispatch` with `dry-run:
  false` — the dispatch default is `true` and both `attest` and `sync` carry
  `if: !inputs.dry-run`, so a default dispatch syncs nothing. Either way
  recovery is available immediately; it is NOT a wait for the weekly cron.
  MECHANISM: repository SELECTION is REST-addressable —
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
  songwriting `1297959888` — THESE TWO IDS ARE SUPERSEDED 2026-08-01 with the
  target set (see WAVE-TARGET SET — RATIFIED below); the selected-access
  mechanism itself is unchanged, and a future target supplies its own id.
  Selection is NOT the same surface as installation
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
  not minutes. Wave 1: **provisioning** (lowest-traffic private consumer;
  measured 2026-07-29 — see WAVE-1 TARGET below) — verify end-to-end across
  TWO PRs, not one: the sync PR proves the caller FILE EXECUTES, and only a
  human-authored PR can prove review BEHAVIOR (see WAVE-1 CRITERIA below).
  Wave 2: remaining existing targets (github-iac FIRST — the ordering stands,
  its "for the security lane" rationale does not; see PHASE 3 CLOSURE below),
  then new targets.
  `.github` + ci-runner per the USER-RESERVED exemption decision (both already
  manifest targets; plan default: exempt from lane components, one-line targets
  comment). ci-runner's EXEMPTION BASIS IS SUPERSEDED 2026-08-01 (see
  WAVE-TARGET SET — RATIFIED below, which reverses Approval-record item 1). The
  OUTCOME is unchanged for now: ci-runner still carries no lane, because its
  adoption is blocked on the public-visibility removal trigger and must
  additionally clear item 1's self-block concern on its own merits (see
  RATIFIED BUT NOT YET LANDABLE and STILL LIVE below). `.github` stays exempt,
  untouched by the ratification.
  standards repo is the manifest SOURCE, not a target — its caller stays
  repo-local, equivalence-checked in Phase 5 modulo its documented deviations
  (byte equality is impossible: standards is public and cannot call the
  selector). ROLLBACK procedure: revert
  the component source commit in standards → next sync run proposes the inverse
  delta to all targets → merge those PRs (automerge off ⇒ manual,
  minutes-scale); kill-switch covers the interim; the sync engine NEVER deletes
  files, so de-manifesting a component orphans it — reverting content is the
  only fleet revert.

  INSTALLATION-EXTENSION MECHANISM — CORRECTION (2026-07-31). The MECHANISM
  paragraph above already excludes App authentication and is not restated
  here; what is new is that under a NO-CLASSIC-PAT posture the REST route is a
  DEAD END with no substitute anywhere on the REST surface, so the classic PAT
  is not one holder among several, it is the only one. Three live artifacts,
  each independent of the others. The docs page for the add operation carries
  a section headed `Fine-grained access tokens for "Add a repository to an app
  installation"` whose entire body is "This endpoint does not work with GitHub
  App user access tokens, GitHub App installation access tokens, or
  fine-grained personal access tokens." — extending the exclusion to
  FINE-GRAINED PATs, which the PAT-only sentence quoted above does not say and
  which is the leg that actually closes this route. The public OpenAPI carries
  `x-github.enabledForGitHubApps: false` on both operations (cited above). And
  the docs payload's `progAccess` block for the add operation reads
  `{"userToServerRest":false,"serverToServer":false,"fineGrainedPat":false,"permissions":[]}`
  — every programmatic door shut, with an empty permission set because no
  permission can open it. The operation's absence from the official
  token-allowlist pages is that same fact read from the other side, not a
  fourth artifact.

  NO EQUIVALENT EXISTS — recorded as a sweep with counts so nobody repeats it.
  Against the public OpenAPI: 7 mutating operations on any `installation`
  path, of which exactly TWO are App-enabled (`POST
  /app/installations/{id}/access_tokens` and `DELETE /installation/token`, both
  token lifecycle, neither touching selection); 15 mutating `category: apps`
  operations, with those same two the only App-enabled members; and exactly ONE
  mutating operation whose description mentions `repository_selection` — the
  DELETE half of this very pair, itself App-disabled. No org-admin route and no
  App-authenticated route to an installation's repository selection exists.
  ONE NEAR-MISS that is not one: the token mint accepts a `repositories` body
  parameter, but "The installation access token cannot be granted access to
  repositories that the installation was not granted access to." — it NARROWS a
  token inside the existing selection and cannot widen the selection itself.

  ZERO-CREDENTIAL ROUTE — the org-owner UI, whose steps the docs give in full:
  profile picture → Your organizations → Settings next to the organization name
  → sidebar "Third-party Access" → GitHub Apps → Configure next to the App →
  under "Repository access" select "Only select repositories" → pick the
  repositories in the Select repositories dropdown → "Click Save".

  CONSEQUENCE FOR IaC, and it outlives this phase: under a no-classic-PAT
  posture the Terraform/Pulumi wrappers named in MECHANISM are UNUSABLE, not
  merely awkward. `github_app_installation_repository`'s own doc carries the
  note "This resource is not compatible with the GitHub App Installation
  authentication method." (`docs/resources/app_installation_repository.md:9`),
  and the provider code does not enforce that note:
  `resourceGithubAppInstallationRepositoryCreate` calls
  `client.Apps.AddRepository` and returns its error unchanged, carrying none of
  the `checkOrganization(meta)` precondition guard that other resources in the
  same provider carry — so a wrong-auth apply fails at the API at APPLY time
  rather than at plan time. The exact status was NOT OBSERVED; do not write a
  code into this record. Net: installation SCOPE either stays off the IaC
  surface as a deliberate UI-only boundary, or the no-classic-PAT constraint
  bends far enough to mint one. THAT IS A POLICY CHOICE AND IS NOT DECIDED
  HERE. It disturbs no approved decision: Approval-record item 5 resolved the
  ORDERING (grant before manifest merge) and named a classic PAT as the holder;
  all that is new is that no other holder exists, so the item-5 route requires
  either that PAT or the UI.

  Anyone changing App PERMISSIONS later (3a0's `workflows: write`, or any
  successor) faces a different surface with its own asymmetry, verified the
  same day: there is no REST route at all — enumerating every mutating
  `category: apps` operation returns 15, none of which edits an App's declared
  permissions — so the change is UI-only. REMOVALS "will take effect
  immediately". ADDITIONS do not: "each account where the app is installed will
  need to approve the new permissions", GitHub "will send an email to each
  organization owner or user", and "Updated permissions won't take effect on an
  installation or user authorization until the new permissions are approved."
  So a removal is one action by the App owner, while an addition is a two-party
  handshake — App owner edits, each installing account's owner approves — and
  costs a second browser action by whoever holds org ownership, even when that
  is the same person.

  WAVE-TARGET SET — RATIFIED 2026-08-01 (measured 2026-07-31). Adopted as put:
  a code-review lane belongs on code repositories, and running it over
  untrusted scraped content is a prompt-injection surface rather than a
  code-quality one. This supersedes Approval-record item 5's target set, and
  reverses item 1's ci-runner exemption.

  CENSUS. 13 non-archived org repos; SEVEN carry a claude-review lane —
  ci-workflows, claude-code-plugins, dotfiles, github-iac, medley,
  provisioning, standards, which reconciles with the accounting already in this
  file rather than introducing a new population (the 4 managed
  `claude-review-caller` targets, plus claude-code-plugins locally-owned, plus
  standards repo-local, plus ci-workflows' own self-caller). SIX do not:
  `.github`, ci-runner, claude-code-proxy, cursor-plugins, knowledge-corpus,
  songwriting. TWO of those six are APPROVED EXEMPTIONS, not gaps — `.github`
  and ci-runner, per Approval-record item 1.

  THE OBSERVATION. 3d(ii)'s two new targets are the two repos where a
  CODE-review lane has near-zero signal: knowledge-corpus is private HTML whose
  stated purpose is consolidated corpus material for the knowledge plugin's
  ingest pipelines, and songwriting is private with no primary language, a
  personal working repo of lyric and song files. Meanwhile two unexempted
  no-lane repos are genuine code: cursor-plugins (public, PowerShell, the
  sibling Cursor plugin marketplace to claude-code-plugins, real `plugins/`,
  `scripts/`, and `docs/` trees, pushed on the measurement date) and
  claude-code-proxy (private; a local HTTPS proxy that captures Claude Code's
  API traffic to disk — credential adjacent, so security-lane relevant rather
  than merely code-review relevant, though as measured it is ONE commit holding
  only a README, so the value is prospective rather than present). Both
  POSTDATE the plan — created 2026-07-30 against a 2026-07-26 lock — which is
  why neither appears anywhere above.

  PROPOSAL, as put: drop knowledge-corpus + songwriting from the 3d(ii) target
  set and adopt cursor-plugins, claude-code-proxy, and ci-runner in their
  place. THE ci-runner LEG WOULD REVERSE APPROVAL-RECORD ITEM 1, which exempted
  it, and item 1's reason is an argument on the merits rather than bookkeeping:
  ci-runner is runner infrastructure where a wedged lane job could block its
  own substrate. A ratifying operator should weigh that against ci-runner's
  candidacy on the other side (public, Go, 8 workflows, runner image
  infrastructure). The `.github` exemption is untouched by the proposal.

  ONE CLAIM MADE FOR THE PROPOSAL DOES NOT SURVIVE CHECKING, and it is recorded
  as refuted so it is not re-adopted: retargeting does NOT delete the
  installation-extension problem above. Installation `144867070` is
  `repository_selection: selected` and its selected set equals the manifest
  target set exactly — attested live on 2026-07-31, standards run
  `30637559324`: "Attested 8 selected repositories for melodic-standards-sync."
  So ANY new manifest target requires the extension, whichever repositories are
  chosen; retargeting changes only WHICH repositories are added, never whether
  an extension is needed. The correction above therefore applies to the
  proposal unchanged.

  RATIFIED BUT NOT YET LANDABLE (measured 2026-08-01): none of the three
  adoptions can become a MANAGED `claude-review-caller` target on the caller
  shape as written, so the standards manifest records each with its blocker
  instead of adding it (melodic-software/standards,
  `distribution/sync-manifest.yml`). The blockers do NOT partition by
  visibility alone.

  VISIBILITY, ci-runner and cursor-plugins: both are PUBLIC, and the
  manifest's own private-only constraint bites. `runner-policy.mjs` emits
  `public-self-hosted-routing` for a selector-routed caller on a public
  repository, and `components/runner-policy/runner-policy.test.mjs` fails the
  build outright if a `components/claude-lanes/` component is `managed` for a
  public target. Their shared gate is the SAME removal trigger the parked
  security caller carries — the runner indirection moving inside the reusable.

  APP GRANT, where the two diverge. ci-runner is ALREADY one of the 8 manifest
  targets the installation attests, so adding this component to its existing
  `managed:` list adds no repository to the expected access set: the attest
  step derives that set from the target repositories alone
  (`[.include[].repo]` over the unfiltered matrix), never from component
  membership. ci-runner's gate is therefore the removal trigger, NOT the App
  grant (see STILL LIVE below for the second consideration its adoption must
  clear — a merits question, not a mechanical gate). cursor-plugins is NOT a
  manifest target, so adopting it is a NEW target and the correction above
  applies to it in full — it needs the installation extension TOO, exactly
  like claude-code-proxy. Adding it without the grant would fail the sync for
  all 8 existing targets, not just for cursor-plugins. claude-code-proxy is
  private and clears the visibility constraint, leaving only the installation
  extension; it also needs its `TARGET_VISIBILITY` entry, whose lookup fails
  closed. (For a public repo that entry unblocks nothing on its own — it only
  makes the failure legible instead of a fail-closed assert.)

  THE PUBLIC BAR IS NOT ABSOLUTE, recorded so it is not overstated: it is a
  property of the SELECTOR-ROUTED caller shape, not of public visibility as
  such. A public-safe shape already exists in the fleet — claude-code-plugins
  owns hand-written hosted-only callers passing `runner: ubuntu-24.04`
  directly with no caller-side selector, which runner-policy admits on a
  public repository. CONSIDERED AND REJECTED here because it forks the
  reviewed caller into a second per-visibility variant, which standards
  deliberately declined pending the reusable-side indirection; it would
  additionally require revisiting `runner-policy.test.mjs`, whose "every
  managed target of a claude lane caller admits that caller" test rejects a
  public managed target for EVERY component sourced from
  `components/claude-lanes/`, selector-using or not — so a hosted-only
  component in that directory would still trip it.

  STILL LIVE, not erased by the reversal: Approval-record item 1 exempted
  ci-runner because it is runner infrastructure where a wedged lane job could
  block its own substrate. That concern is orthogonal to visibility and was
  never rebutted — visibility merely became the nearer blocker. When the
  removal trigger fires, ci-runner's adoption must clear the self-block
  concern on its own merits rather than inheriting a pass.

  What landed is the RETIREMENT OF THE PLANNED-TARGET RECORD for
  knowledge-corpus and songwriting, plus their `TARGET_VISIBILITY` entries;
  nothing left the manifest's `targets:` map, because neither repo ever held a
  target block. The adoptions did not land.

  DEFERRED WITH TRIGGER, per this plan's own convention rather than dropped:
  knowledge-corpus ingests external documents that agents later read, which is
  a PROMPT-INJECTION surface, not a code-quality one. Revisit it for a security
  or content-scanning lane, not for claude-review. Separately, claude-code-proxy
  being private and security-lane relevant brushes PHASE 3 CLOSURE's candidate
  (b) without touching it: (b) stays NOT taken on its recorded terms, a private
  repo adopts the security lane on its own merits, and nothing here manufactures
  unpark or closure evidence.

  WAVE-1 TARGET (measured 2026-07-29, replacing dotfiles): wave 1 named
  dotfiles as the "low-traffic private" consumer; measurement contradicts that
  premise. The population is the four private non-archived consumers carrying
  the caller component — dotfiles, medley, github-iac, provisioning. On
  claude-review runs over the trailing 7 days — the runs a
  `CLAUDE_REVIEW_DISABLED` window actually suppresses, and so the metric that
  bounds a wave's blast radius — dotfiles is the HIGHEST-traffic private
  consumer, not the lowest: dotfiles 111, medley 53, github-iac 38,
  provisioning 24. Provisioning is ~4.6x quieter than dotfiles and satisfies
  wave 1's purpose identically: private, non-archived, already a sync-manifest
  target, and already carrying a `claude-review.yml` caller, so its own sync PR
  still EXECUTES the NEW caller on itself (execution, not review — WAVE-1
  CRITERIA below separates the two).

  Two cautions on those figures. They are a SLIDING 7-day window, so absolute
  values drift between measurements (medley read 78 earlier the same day); the
  durable claim is the ORDERING, which has reproduced across measurements.
  And do not re-derive the pick from TOTAL workflow-run volume: that metric
  counts every unrelated workflow in the repo and transposes the top two
  (medley 969, dotfiles 689, github-iac 271, provisioning 174), so it would
  wrongly absolve dotfiles. It does NOT change the pick — provisioning is
  lowest under BOTH metrics — and is recorded here only so the discrepancy is
  not mistaken for an error and "corrected" back.

  WAVE-1 CRITERIA (measured 2026-07-29) — TWO PRs, because ONE cannot carry
  both. Wave 1 previously named the sync PR as the single vehicle and required
  that it "is reviewed by the NEW caller". That is unsatisfiable, and by
  design: every sync PR is authored by `melodic-standards-sync[bot]`; the
  caller component passes NO `skip-actors` input, so the reusable's default
  applies — declared on the `skip-actors` input of the ci-workflows REUSABLE
  (`.github/workflows/claude-review.yml` there, not the same-basename
  component) as
  `dependabot[bot],claude[bot],melodic-ai[bot],melodic-standards-sync[bot]`
  — and the review job's own `if` skips when `github.actor` is in that list.
  So the criterion contradicted 2b's self-trigger ban. This is not one round's
  accident — it holds for EVERY sync PR, because the author is fixed and the
  skip list is a default the component never overrides. Confirmed live on the
  2026-07-29 round: provisioning run `30469715753` reports
  `review / review -> skipped`. Cite a RUN ID, not a PR number, and read the
  OPEN-event run rather than the PR's current head: sync PRs are recreated
  round to round so their numbers decay, and the no-`synchronize` cadence means
  a later push produces no claude-review run at all, so a head-keyed query
  returns no such check rather than a skip. Phase 1 above already recorded the
  same skip on the earlier `review-instructions` sync round. Split accordingly:

  (a) SYNC PR — proves the caller FILE EXECUTES, and nothing more. It can prove
  that at all only because `pull_request` runs the MERGE-COMMIT workflow file,
  so the sync PR's own run executes the NEW caller rather than the one on the
  default branch. Criterion: the run's `referenced_workflows` names the NEW
  pin. The run CONCLUSION is NOT the evidence — a run whose review job skipped
  still concludes `success`. `referenced_workflows` comes from the static
  workflow parse, so it is populated even then:
  `gh api repos/melodic-software/<repo>/actions/runs/<run-id> --jq '.referenced_workflows[]'`
  ALREADY SATISFIED for wave 1: provisioning run `30469715753` (event
  `pull_request`, head `7b9d016`) references
  `claude-review.yml@c136b27f404dd32ce3873f39a6f3443891d1c16e` and
  `select-runner.yml` at the same SHA, against a pre-sync default-branch caller
  pinned `90f1c54935203fa31b5b3d1f41531228be2c2b7f`. The discriminator is the
  PIN, which survives the review job skipping — and it stays checkable after
  the sync PR merges, when the default branch no longer shows the old pin.

  (b) HUMAN-AUTHORED PR in the wave-1 target — the ONLY vehicle for review
  BEHAVIOR. Criteria: the PR's open-event run's `referenced_workflows` names
  the NEW pin (same check as (a); a human PR opened before the sync PR merges
  runs the OLD default-branch caller, so every behavior item below could pass
  while the new caller has exercised only its bot-skip path — merge the sync
  PR first, and verify the pin on THIS run, not just the sync PR's); review
  fires exactly once on open; inline comments present; the count comment
  carries `claude-review-count:1` and is authored by `github-actions[bot]`
  (the TRACKING comment is `claude[bot]` — a different author, do not conflate
  them); and the no-`synchronize` cadence holds, i.e. a push to the same PR
  does not re-trigger the lane. The count marker is an HTML comment, so read
  raw comment BODIES and PAGINATE — the endpoint defaults to 30 results/page,
  so on a busy PR an un-paginated read can miss the marker and falsely fail
  this criterion
  (`gh api --paginate repos/melodic-software/<repo>/issues/<pr>/comments --jq '.[].body'`,
  then filter for the marker) — it is invisible in the rendered PR. None of
  these is observable on a bot-authored PR, so wave 1 does not close until
  such a PR exists in provisioning.

  WAVE-1 (b) SATISFIED (2026-07-30): provisioning#235 (human-authored,
  README-only, non-managed). Open-event run `30503910653` (head `84adc33`,
  `run_attempt` 1): `referenced_workflows` names
  `claude-review.yml@c136b27f404dd32ce3873f39a6f3443891d1c16e` and
  `select-runner.yml` at the same SHA — the NEW pin, on THIS run; exactly one
  claude-review run for the PR (three independent paginated enumerations,
  including a workflow-scoped runs query); count comment id `5125040466`
  authored by `github-actions[bot]`, raw body line 1
  `<!-- claude-review-count:1 -->` (tracking comment id `5125025302` is
  `claude[bot]`, no marker); follow-up push `a41e175` at 01:00Z produced NO
  claude-review run (re-confirmed ~15 min later) — the no-`synchronize`
  cadence holds. ONE CRITERION REWORDED, not waived: "inline comments
  present" is unsatisfiable on a CLEAN review — the review found nothing,
  posted no review object, and the reusable documents that clean reviews
  otherwise produce no visible output (its `track-progress` mitigation for
  upstream #1071). The clean-review evidence is the count marker plus the
  tracking comment. The INLINE-COMMENT PATH itself is UNPROVEN at the rollout
  pin: github-iac PR #247's lane run `30507312523` was ALSO clean ("No
  buffered inline comments" in the review job log; marker comment
  `5125524714`, tracking comment `5125500446`) — the one line-anchored P2
  comment on that PR (id `3679387284`) was authored by
  `chatgpt-codex-connector[bot]`, the Codex reviewer, not this lane; it
  landed inside the lane run's window and was initially misattributed
  (caught by a fresh-context verifier). So (b) reads: review fires exactly
  once on open; count comment present; inline comments expected only WHEN the
  review has findings — and the inline path stays an open verification item
  until a findings-bearing LANE review is observed on any consumer at the
  rollout pin. Cadence data: review job queue-to-start 85 s
  (upper bound on contention — ARC pod provisioning indistinguishable),
  runtime 158 s, self-hosted `melodic-review-ubuntu-24.04-x64`, zero 429s,
  `RETRY_OUTCOME: skipped`, repo had zero in-flight lane runs (uncontended
  measurement).
- **3e. Post-rollout verification — ONE REPO AT A TIME** (devils-advocate F11:
  parallel verification manufactures the seat contention this effort fixes;
  sequenced by MERGE ORDER — the kill-switch cannot sequence anything it does
  not reach, and reachability at rollout time was 1 of 7 callers, so the
  original "use kill-switches as the sequencing mechanism" was unsound and is
  replaced): per consumer, one PR exercises —
  review fires once on open (inline comments present + count comment), security
  lane reports per head or name-stable-skips, and on ≥1 repo a PR touching the
  repo's PRIMARY language triggers an ACTUAL security run, not a skip (guards
  against a paths file that silently filters everything) — but 3e scopes "each
  repo" to the consumers a wave rolls out to, and NO wave target runs a
  security lane, so the ≥1 is unreachable WITHIN that scope. It is satisfiable
  only by widening the population past the waves, which is the routing
  decision flagged in PHASE 3 CLOSURE below. #227 smoke: bot-pushed
  head still produces a reporting required check. Record observed concurrency
  data for the cadence follow-ups.

  3e EVIDENCE (2026-07-30, merge order): provisioning DONE — see WAVE-1 (b)
  above (run `30503910653`; no security lane in the repo, so the security row
  is N/A by absence, not by skip). github-iac DONE — PR #247, open-event run
  `30507312523` referencing the NEW pin, `review / review` RAN and concluded
  success, a second CLEAN review (count marker `5125524714`, tracking comment
  `5125500446`, "No buffered inline comments" in the job log; the PR's one
  inline P2 comment is `chatgpt-codex-connector[bot]`'s, not this lane's); no
  security lane in the repo. dotfiles DONE (2026-07-30) — PR #371
  (human-authored, docs-only, non-managed; verified against the enumerated
  managed set with transitive `requires` expansion), open-event run
  `30511335419` at head `c422863`: NEW pin on `referenced_workflows`,
  `review / review` RAN (job `90771924713`, success), fires exactly once
  (three independent paginated enumerations), count comment `5126089411` by
  `github-actions[bot]` with raw first line `<!-- claude-review-count:1 -->`
  (tracking comment `5126074243` is `claude[bot]`), clean review (0 inline
  comments, 0 review objects — the reworded criterion's marker+tracking
  signature), follow-up push `6036728` produced NO claude-review run across
  three checks over 25 min. Cadence: queue-to-start 70 s with a genuinely
  overlapping run (`30510976401`) whose review job completed the same second
  this one was created — the repo-wide `queue: max` group released
  immediately, so the 70 s is ARC pod acquisition, not queue blocking; with
  provisioning's 85 s (zero in-flight), two samples converge at 70-85 s and
  the queue has still not been observed to BLOCK on the consumer where it was
  most likely to. Incidental: marker read `claude-review-count:1` on a repo
  with 111 trailing-7-day review runs — the counter is per-PR, not per-repo.
  medley DONE (2026-07-30) — PR #1679 (human-authored, three markdown files
  at the reviewed head `48541af`, none managed: `REVIEW.md` — covered by the
  `locally-owned` `review-instructions` component — plus
  `review/error-handling.md` and a `.work/` restatement-review evidence
  file, both in no component at all), open-event
  run `30514566338` at head `48541af`: NEW pin on `referenced_workflows`,
  review RAN and concluded success, exactly one claude-review run for the
  branch (workflow-scoped enumeration), count marker comment `5127540056`
  (`github-actions[bot]`), tracking comment `5127516271` (`claude[bot]`,
  "finished in 1m 49s"), clean lane review (the only line-anchored review
  comments are `chatgpt-codex-connector[bot]`'s plus later human replies),
  and NO claude-review run at the later
  heads (3 commits on the branch, current head `af355fd`) — the
  no-`synchronize` cadence holds. Cadence — the first observed QUEUE
  CONTENTION: three medley PRs (#1678/#1679/#1680) opened within 16 min put
  queue depth at 3 in the `claude-review-<repo>` group (all three review
  jobs simultaneously waiting 04:58-05:05Z, then strictly serialized); this
  run sat queued ~2h (created 04:41:52Z, completed 06:43:35Z) against a
  6m48s review-job wall time (the 1m49s figure is the Claude task runtime
  inside it, per the tracking comment). The serializer queues rather than cancels, exactly as designed
  — record for the 3g/cadence follow-ups that repo-level burst latency is
  bounded by runner availability, not by review runtime. ALL FOUR 3e ROWS
  ARE DONE; the inline-comment path is still unproven at the rollout pin
  (every lane review to date was clean — see WAVE-1 (b) above) and closes on
  the first findings-bearing lane review. The ≥1 ACTUAL-security-run item
  routes per PHASE 3 CLOSURE below.
  #227 smoke recorded but INVALID as verification: four bot-authored sync PRs
  on claude-code-plugins (2026-07-29) all show `security-review / security-review`
  reporting `skipped` within seconds-to-minutes (check-runs `90636524265`,
  `90682064295`, `90712488013`, `90728741759`), BUT the issue's own
  triggering example #1103 reached the identical terminal state while broken,
  so the predicate cannot verify the fix — see the amended 3f below.
- **3f. Issue updates [AMENDED 2026-07-30 — three of the five directives were
  wrong against their threads; dispositions recorded]:** #150 CLOSED as
  directed. #152 CLOSED, pointer comment verified (cross-links #150,
  `issuecomment-5085070277`). #158: trigger 2 EXECUTED 2026-07-30 — the
  account-type evaluation was performed and posted
  (`issuecomment-5132316690`), verdict REJECT-WITH-REASON: the identical
  skip predicate guards the REQUIRED security check, where a type-based skip
  converts "no security review happened" into a green required check;
  failure directions are asymmetric (stale name list fails visibly toward
  wasted budget, type detection fails silently toward non-review of exactly
  the agent-authored PRs that most warrant it); and the measured benefit is
  now zero (62 bot-actor runs resolve at JOB level to 49 skipped / 13
  executed, all 13 predating centralization — job-level resolution is
  mandatory, run-level conclusions mislead on this lane). Both DO-NOT-CLOSE
  triggers are therefore met; the issue stays OPEN only because its
  `needs-human` label bars autonomous closure — closing is a one-click
  human action. #227 stays OPEN, CORRECTED IN PLACE and RETITLED
  (2026-07-30) — the earlier "close-as-misdiagnosed" framing recorded here
  was itself wrong, refuted by direct run inventory: on #1103's open head
  `67ffa66` the `pull_request_target` workflows fired within 4 s while ZERO
  `pull_request` runs occurred, so the event split was REAL on the wedged
  head; what failed was the generalization (three later bot force-pushes
  each fired both event classes within seconds, the wedge cleared on a bot
  push after ~13h31m with no human commit, and the previously cited ~23h20m
  — actually 23h16m25s — measured to the bot's next force-push). A second
  instance with the identical signature exists: ci-runner#143 open head
  `750310d`, cleared ~42 min later; dotfiles#299 showed a 2m19s same-head
  lag — an intermittent, variable-latency `pull_request` event-delivery gap
  (0-5 s typical, 2m19s, ~42 min, ~13h31m, plus the 20m46s #1754 outlier),
  `pull_request_target` unaffected in every observed case. The issue body's
  root-cause, impact, category, fix-direction, and title were revised in
  place (edit-noted; correction of record `issuecomment-5132244199`, erratum
  `issuecomment-5132722167`), non-recurrence across four 2026-07-29 rounds
  recorded, root cause still unknown (webhook delivery logs unreachable from
  the Actions surface). Three fresh-context verifier rounds ran on the
  disposition; the final round returned PASS on all four criteria with zero
  factual errors and presentational-only residuals, accepted as named gaps. #242 stays OPEN, not closable — deliverables 4 (capability
  deep-dive) and 7 (medley claude-assistant extraction evaluation) remain
  untouched; medley's `--model claude-sonnet-4-6` pin is still stale (its
  action pin has since moved to v1.0.180 via Dependabot, recorded to prevent a
  false staleness re-report).
- **3g. Fleet action-currency follow-through [DECISION RESOLVED — Approval
  record item 12; IMPLEMENTATION TRACKED IN standards#314]:** the tag covers the
  DECISION only — the job is specified but unbuilt, so the work is tracked
  outside this phase rather than closed with it. The Brief's
  "Dependabot keeps it same-day current" reaches
  ci-workflows only — every consumer `ignore`s ci-workflows refs, so fleet
  currency moves through release-tag → component re-pin → sync, all manual
  today (devils-advocate F10). Resolved to the recommended option,
  pre-approved 2026-07-26 (Approval record item 12): a scheduled re-pin job
  in standards. Spec (implementation pending): new workflow in standards,
  daily `schedule` + `workflow_dispatch`, offset from sync's Monday
  `17 6 * * 1`; resolve `releases/latest` on ci-workflows, deref the tag to
  a commit SHA (handle annotated and lightweight — today's tags are
  lightweight), rewrite every
  `uses: melodic-software/ci-workflows/...@<sha>` under
  `components/claude-lanes/` ONLY (the pin-comment-convention fixtures hold
  deliberate bad pins — never in scope) to `@<new-full-sha> # <tag>`; no
  diff → exit clean; diff → force-update the fixed branch
  `chore/repin-claude-lanes` and open-or-update ONE PR (idempotent; a yanked
  release self-corrects on the next run; a merged bad pin rolls back via the
  3d revert-component-source procedure). The PR is NEVER auto-merged —
  human review of the re-pin diff is the fleet's compatibility gate; the
  existing pin-comment-convention check validates the pin form on the PR;
  the sync cascade (sync.yml `push: main`, a real non-dry run) carries the
  merge to targets with no further action. Credential: App token, because a
  `pull_request` event caused by the default `GITHUB_TOKEN` creates no
  workflow runs at all (this repo documents the behavior in README and
  `dependabot-lock-regen.yml` — recursion prevention, not an
  approval-required hold), so required checks never report —
  reuse the standards-sync App if its installation covers standards itself
  with contents + pull-requests write (verify at implementation), else a
  minimal new App [USER-APPROVAL GATE per org precedent — no silent App
  creation]. The alternative (accept lag + README SLA + #257 as sole
  detector) is dead; #257 remains the belt-and-suspenders staleness
  detector. Implementation tracked in standards#314, which carries the
  credential branch forward as OPERATOR-GATED and flags one discrepancy to
  reconcile: a prior settled-decisions ledger records that the standards-sync
  App must NOT be widened to cover standards itself — which would foreclose the
  reuse branch this bullet still presents as open pending verification.

**Sanity Check:** `bash distribution/sync-manifest.sh validate` exits 0; per
target, blob-hash equivalence (loop recorded verbatim; count of mismatches ==
0) — and BOTH sides of that comparison have a fault the obvious form does not
survive, each producing a valid-looking WRONG value rather than an error.
EXPECTED side: `git fetch origin && git rev-parse
origin/main:components/claude-lanes/claude-review.yml`, never `git hash-object
<path>` — `hash-object` hashes the WORKING TREE, so an uncommitted edit, or a
checkout sitting on another branch, yields a different hash (two agents in
separate checkouts read different values minutes apart this way); the `git
fetch` is not optional, since a stale `origin/main` fails identically.
OBSERVED side: an EXPLICIT `?ref=` —
`gh api "repos/melodic-software/<repo>/contents/.github/workflows/claude-review.yml?ref=<sha>" --jq .sha`
— because without it the API resolves the DEFAULT branch, which still holds
the old hand-written caller. `<sha>` is the sync PR head during the rollout
window and the merged SHA after it; the output cannot tell you which case you
are in, so pass it always. DENOMINATOR is 4, not 8: the repos where
`claude-review-caller` is MANAGED in `distribution/sync-manifest.yml` —
dotfiles, github-iac, medley, provisioning. claude-code-plugins holds it
`locally-owned`, so it is not in the loop, and `claude-security-review-caller`
has ZERO managed targets, so it has nothing to compare (PHASE 3 CLOSURE
below). No expected blob value is written down here: it changes on every
component edit, so it is REGENERATED by the command above, never transcribed.
Last consequence of that, and the one remaining way to read a true mismatch as
a failure: the expected side reads standards `main` LIVE while the observed
side reads a possibly-older PR head, so a component change landing between the
sync PR's last refresh and the check produces a mismatch that is real and
benign. Compare at compatible points — re-run after the sync PR refreshes, or
read the expected side at the component SHA the sync PR was built from.
Measured 2026-07-29 against the then-open sync PR heads: the corrected form
returned 0 mismatches of 4, the as-written form 4 of 4, all false.
medley's synced caller contains `reopened`; the 3c security-gate invariant re-reads intact —
`gh api orgs/melodic-software/rulesets/19388547 --jq 'del(.id,.name,.node_id,.source,.source_type,.created_at,.updated_at,._links)'`
compared as canonicalized JSON, which is the FULL disarmable surface rather than
just `conditions` + `rules` (the repo-level `rulesets` listing returns none of
these keys, so it cannot verify this at all), AND the property set regenerated:
`gh api "orgs/melodic-software/properties/values?per_page=100" --paginate --jq '.[]|select(.properties[]|select(.property_name=="requires-security-review" and .value=="true"))|.repository_name'`
returns exactly `claude-code-plugins` — AND a live PR shows an ACTUAL
security run (not skip) on a code-touching PR, which waves 1-2 cannot supply
(PHASE 3 CLOSURE below); smoke transcripts (kill-switch,
overflow, #227, wave-1) recorded here; automerge restored after rollout
(`grep -c "automerge: false" distribution/sync-manifest.yml` == 0 post-restore,
or matches only deliberate standing opt-outs).

**PHASE 3 CLOSE-OUT LEDGER (2026-07-31; last item cleared 2026-08-03; tag
advanced to `[DONE]` 2026-08-03).** Every item this Sanity Check names is
satisfied. The one item that had kept the tag `[DOING]` — the kill-switch
org-var flip smoke — was executed 2026-08-03 and is recorded below. The tag was
then advanced on operator authority: the session handoff's remaining-actions
item 2 pre-committed the sequencing, "record the transcript in PLAN.md, then
advance Phase 3's tag to `[DONE]`". The two `if:`-clause findings the smoke
surfaced refine smoke METHODOLOGY and weaken no Phase 3 goal.
ENUMERATION FIX (2026-08-03): this Sanity Check listed only the VERIFICATION
items and never enumerated 3g's implementation, which is why "the only thing
blocking the tag" read as complete while a specified-but-unbuilt Phase 3
deliverable still existed. Caught by review on the tag-flip PR. The list below
now carries it explicitly, and a phase's close-out must enumerate its
DELIVERABLES, not just its checks — otherwise the sanity check certifies its own
blind spot.
3g IMPLEMENTATION — **NOT BUILT**, enumerated here so it cannot be lost again.
Its DECISION is resolved (Approval record item 12); the WORK is tracked OUTSIDE
this phase in standards#314, with its credential branch operator-gated. This
item is dispositioned tracked-elsewhere, never done — closing Phase 3 strands
nothing only because that issue exists.
SATISFIED: `sync-manifest.sh validate` exits 0; per-target blob-hash
equivalence 4/4 (all managed targets at `a9dfe7f4`); the 3c gate invariant
re-read intact with the single documented break-glass delta (see the re-read
block below); the `requires-security-review` property set still exactly
`{claude-code-plugins}`; the ACTUAL-security-run observation, closed via the
routing decision and its evidence block (runs `30602103731` and `30602120481`,
independently verified twice); automerge restored — `grep -c automerge` on
standards `main` returns 0, the pre-window shape, since the restore was a key
REMOVAL and absent means true; wave-1 and #227 smoke transcripts recorded
above.
SATISFIED 2026-08-03 — the **kill-switch org-var flip smoke** [DONE], the last
item that was blocking the tag; transcript in the KILL-SWITCH FLIP SMOKE block
below. The queue-overflow probe is separately recorded as SUPERSEDED rather than
outstanding: 3e produced a real contention observation on medley — three PRs
opened within 16 minutes drove queue depth to 3 in the repo-wide group, all
three review jobs waited simultaneously and were then strictly serialized,
with one run queued ~2h against a 6m48s job — which is stronger evidence than
the synthetic probe was designed to manufacture, and it confirms the
serializer queues rather than cancels.

**KILL-SWITCH FLIP SMOKE (2026-08-03, executed; independently verified).** Both
arms ran on dotfiles PR #401 against the pinned reusable
`c136b27f404dd32ce3873f39a6f3443891d1c16e` (v0.9.1), head
`b83a47f3f29524a6697d13600bf3f625dbfa680b`. All times UTC.

ARM A — `CLAUDE_REVIEW_DISABLED=true`: PATCH 22:12:42Z, readback `true`
(`updated_at` 22:12:43Z) with `CLAUDE_LANES_DISABLED=false`; `ready_for_review`
22:12:51Z; run `30857789171` CREATED 22:12:54Z (**3s**, inside the ≤30s
run-creation gate — a smoke-local DISCARD rule, not a platform SLA and not a
documented bound: it exists because of the #227 `pull_request` event-delivery
gap recorded above, where delivery is 0-5s typically but was observed at 2m19s,
~42min, and ~13h31m with root cause still unknown. An arm that produces no run
therefore cannot be read as a skip — the event may simply not have arrived — so
it is discarded rather than scored. Delivery here was 3s / 3s / 2s across the
three runs this smoke created); concluded `success` 22:16:51Z with jobs
`Select runner / Select runner` = `success` and `review / review` = **`skipped`**
— the name-stable job-level skip the design predicts. RESTORE: PATCH `false`
22:17:07Z, readback `false` (`updated_at` 22:17:09Z); PR back to draft 22:17:22Z.
**True-window 22:12:43Z → 22:17:09Z = 4m26s.**

ARM B — `CLAUDE_REVIEW_DISABLED=false`: `ready_for_review` 22:18:07Z; run
`30858125013` CREATED 22:18:09Z (**2s**); `review / review` observed `queued`
22:18:28Z then `in_progress` 22:19:20Z, and it ran to completion `success` with
20 executed steps including `Claude review` and `Post Claude review`. A job whose
`if:` is false is materialized directly as `completed`/`skipped` and never enters
`queued`, so `queued` alone already decides the arm; the executed steps make it
unambiguous.

CONTROLLED COMPARISON: both arms used the same PR, the same trigger
(`ready_for_review`), the same actor (`kyle-sexton`), the same non-draft payload
state, and — verified — the same head SHA with no intervening push. The only
variable that changed was `CLAUDE_REVIEW_DISABLED`, so the switch is the
operative cause of the skip rather than a confound.

TARGET SUBSTITUTION: the briefed target (dotfiles #400) had merged
2026-08-03T21:53:12Z, and dotfiles held no other open draft PR — the only open PR
(#375) is not a draft at all (and is additionally `CONFLICTING`/`DIRTY`), so it
affords no draft→ready toggle, and every recently closed PR was MERGED so
`reopened` had no candidate either. PR #401 was therefore purpose-built as a disposable draft (scratch note
under `docs/`, which dotfiles `.chezmoiignore` excludes, so no chezmoi-managed
target was touched), labeled `do-not-merge`, torn down at 22:20:01Z — PR closed,
branch `chore/kill-switch-flip-smoke` deleted (ref 404). All four
`CLAUDE_*_DISABLED` org vars confirmed `false` post-teardown. Because arm B ran a
real review to completion, a review comment on the now-closed #401 is expected
and is not drift.

TWO `if:`-CLAUSE FINDINGS, recorded because they constrain how this smoke — and
any future re-run — must be designed. The reusable's `review` job gates on FOUR
conjuncts, not just the two kill-switches:

1. `github.event.pull_request.draft == false` shares the `if:` with the
   kill-switches, so a newly-OPENED draft PR fires `pull_request:opened` but skips
   for the DRAFT reason, producing a job table byte-identical to a kill-switch
   skip. Measured here: PR #401's own open event produced run `30857697384`
   (created 22:11:27Z) whose `review / review` was `skipped` while
   `CLAUDE_REVIEW_DISABLED` was still `false`. A draft-PR-open arm is therefore
   UNATTRIBUTABLE; only a `ready_for_review` toggle isolates the switch.
2. `!contains(format(',{0},', inputs.skip-actors), format(',{0},', github.actor))`
   means an actor in `skip-actors` makes BOTH arms skip — arm A passing
   spuriously while arm B fails for an unrelated cause. Cleared before the flip:
   the dotfiles caller passes no `skip-actors`, so the reusable default
   (`dependabot[bot],claude[bot],melodic-ai[bot],melodic-standards-sync[bot]`)
   governs, and the acting identity `kyle-sexton` is not in it. Any re-run must
   re-clear this first, or a failed arm B is uninterpretable.

Also confirmed pre-flight: dotfiles carries ZERO repo-level Actions variables
(`total_count: 0`), so no repo-level value shadows the org ones — the reusable's
own comment notes repo-level overrides org-level, making this load-bearing.

INDEPENDENT VERIFICATION: a fresh-context verifier, given only the run ids and
the claimed conclusions with the rationale withheld, re-fetched both job tables,
the PR timeline, the org-variable state, and the branch ref, and returned
CONFIRMED on all seven claims — including that both runs carry the identical
`headSha` and that each run's creation immediately follows a distinct
`ready_for_review` event separated by the 22:17:22Z `convert_to_draft`.

3c INVARIANT RE-READ (2026-07-30): the canonicalized-JSON read of ruleset
19388547 shows `bypass_actors: []`, `conditions` intact
(`~DEFAULT_BRANCH` include, empty excludes on both `ref_name` and
`repository_property`, the `requires-security-review == "true"` include),
`enforcement: active`, and the `security-review / security-review` required
check — and the property regeneration returns exactly `claude-code-plugins`.
Both halves intact. EXPECTED DOCUMENTED DELTA: github-iac PR #247 (break-glass,
ADR 0010, merge user-gated) adds one bypass actor
(`OrganizationAdmin`, `bypass_mode: pull_request`, `actor_id: 1`) to this
ruleset by design; after it applies, the canonical compare must expect exactly
that delta and nothing else — an empty `bypass_actors` read post-merge would
itself be drift.

**PHASE 3 CLOSURE — the ACTUAL-security-run observation is not reachable from
any wave [ROUTED 2026-07-29 — decision recorded below].** Measured 2026-07-29. Exactly two org
repos run a security lane at all — `claude-code-plugins` and `ci-workflows`;
every other manifest target 404s on
`.github/workflows/claude-security-review.yml`. Neither is reachable as a
managed wave target, and the two reasons are DIFFERENT, so neither is fixed by
addressing the other. claude-code-plugins holds BOTH lane callers
`locally-owned` in `distribution/sync-manifest.yml`, so sync never writes
them. ci-workflows appears in the manifest for neither component: it is the
reusable's home, and its `claude-security-review-self.yml` resolves the lane
with `uses: ./.github/workflows/claude-security-review.yml` — a relative
self-reference, so it is not a pinned consumer of anything. Upstream of both,
`claude-security-review-caller` is PARKED with ZERO managed targets, because
runner-policy admits the governed selector only for a private self-hosted
consumer and BOTH security-lane repos are public. That park, and its unpark
trigger, are recorded in standards — `distribution/sync-manifest.yml` (the
`PARKED:` comment above the component entry) and `distribution/README.md` —
not here. That same fact
retires 3d wave 2's "github-iac FIRST for the security lane" rationale —
github-iac carries no security lane and no security caller, so the ordering is
kept above while only its stated reason is withdrawn.

CONSEQUENCE: as written, Phase 3 cannot close on waves 1 + 2, because its
Sanity Check ANDs in an observation no wave target can produce. The routing is
a DECISION and is deliberately NOT made here. Candidates: (a) take the
observation on claude-code-plugins or ci-workflows and record it explicitly as
evidence from a non-wave repo — this is the cheapest, and it is what widening
3e's population means in practice, BUT it satisfies only the actual-run half
of 3e's guard, not the `paths-file` half: both repos' callers pass the inline
`paths` input and never `paths-file` (ci-workflows'
`claude-security-review-self.yml` jobs block; claude-code-plugins' locally-
owned `claude-security-review.yml`, verified 2026-07-29), so a run there
cannot prove the newly added `paths-file` mechanism doesn't silently filter
everything — closing via (a) still requires either a caller migrated to
`paths-file` or a separate paths-file probe; (b) unpark `claude-security-review-caller`
by admitting a private adopter, which is what its recorded unpark trigger
describes; (c) move the observation to a phase whose scope covers those repos.
Do not resolve this by picking one silently.

ROUTING DECIDED (2026-07-29, delegated decision session; rationale recorded
here): candidate (a), made whole by the claude-code-plugins `paths-file`
migration already in flight on `chore/repin-claude-lanes-v0.9.1` (pushed;
re-pins both lane callers to v0.9.1 =
`c136b27f404dd32ce3873f39a6f3443891d1c16e`, and the security caller drops its
inline `paths` for `paths-file: .github/claude-security-paths` — the pattern
file landed on claude-code-plugins main via #1701 (merged 2026-07-28),
byte-identical on the branch; 26 non-comment pattern lines measured
2026-07-29, correcting 3a's former "27-entry" count, now fixed at source). The migration is
CONTRACT-FORCED, not discretionary: the managed runner-policy component's
approved contract for `claude-security-review.yml@c136b27f…` is
`allowedInputs: ["runner", "paths-file"]` — inline `paths` is excluded at
the v0.9.1 pin, so any consumer re-pinning to v0.9.1 migrates or violates
the contract. That retires (a)'s recorded limitation: the run evidence now
exercises the `paths-file` mechanism itself.
Verified against the reusable at v0.9.1 before deciding: a non-empty inline
`paths` wins over the file (no fetch); the file is fetched from the BASE
branch via the contents API (a PR cannot edit it to skip its own review; a
head lacking the file is irrelevant); an absent or unreadable file FAILS OPEN
to `relevant=true` with a `::warning`; a not-applicable PR yields the
name-stable SKIPPED `security-review` check. Failure modes are therefore
noise (extra reviews), never a wedged required check. EVIDENCE CRITERIA
(record run URLs here when they exist; all post-merge of the repin PR):
(1) a code-touching claude-code-plugins PR whose run references
`claude-security-review.yml@c136b27f…` AND whose `security-review` job RAN,
AND whose `changes` job log carries no `Could not read paths file` warning —
the warning's absence is what distinguishes a working paths-file from a
silent fail-open, so the run alone is not the evidence; (2) one prose-only
claude-code-plugins PR showing the name-stable SKIPPED `security-review`
check — proves the filter filters. Recorded explicitly as evidence from a
NON-WAVE repo (claude-code-plugins holds both callers locally-owned): it
transfers because the reusable bytes and the `paths-file` mechanism are
exactly what the parked component calls; what it does NOT prove —
sync-managed delivery of a security caller — stays parked. (b) NOT taken:
the park and its unpark trigger are unchanged; a private repo adopts the
security lane on its own merits (github-iac and medley are the plausible
first movers), never to manufacture closure evidence. (c) NOT taken: moving
the observation to a later phase relabels (a)'s evidence without producing
it.

### Phase 4: observability — #238 aggregator [DONE]

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

**PHASE 4 CLOSE-OUT LEDGER (2026-08-06; acceptance EXECUTED, tag held at
`[DOING]`).** The acceptance test ran end to end for the first time. It did what
an acceptance test is for: it found three defects and two spec conflicts that
every prior green signal had hidden. The tag is NOT advanced, because SC4
("#228/#238 closed with pointers") is unmet and Phase 4 DELIVERABLES remain
unbuilt — enumerated individually below rather than counted, so the number
cannot drift out of step with the list. Per Phase 3's ENUMERATION FIX, every
deliverable this phase names is dispositioned below, including the ones that are
NOT built and the canary-property targets that were not exercised — checks alone
would certify this phase's own blind spot.

Wiring: `melodic-software/claude-lane-sandbox` was created by the operator's
github-iac apply (run `31068866753`, 2026-08-06T03:35Z; the earlier attempt
`31067896456` failed 03:14Z on an UNRELATED resource — a 422
`Default value must be present` on the `requires-security-review` org custom
property — and nothing sandbox-scoped was implicated). The caller, README, and
probe fixture were wired PR-only via sandbox#1, squash-merged as `d53fcec`
(GitHub-signed). All three blobs are byte-identical to the staged bundle in
the #349 runbook comment. LOCALLY OWNED, not a sync-manifest target; pinned to
v0.9.1 = `c136b27f`, matching claude-code-plugins' caller and the standards
component. The fleet pin has NOT moved, so the fixture is fleet-consistent even
though v0.10.2 is now the latest release; repinning it is a by-hand follow-up.

SATISFIED — all four lane artifacts plus auto-resolve, on real lane output:
(1) the `review / review` check concluded GREEN on the dead credential
(sandbox run `31079823199`); (2) the marker comment posted, carrying
`Failure class: auth` — READ IT IN THAT RUN'S LOG, not on the pull request: the
next successful review ran the lane's own "Clear stale failure comment after
successful review" step and deleted it, exactly as designed, so a reader
checking sandbox#2 today finds no marker and should not read its absence as
fabrication; (3) the check-run annotation carried
`class=auth` with `api_error_status: 401` — the runbook's one empirically
unverified choice, the bad-token VALUE, is now CONFIRMED to reach the API and be
rejected rather than degrading to the non-escalating `other`; (4) incident
issue #361 opened (aggregator run `31082662762`,
`read-errors=0 cycle=incident coverage=complete action=open`). Restore then
auto-resolved it: runs `31083255896` and `31083299991` (`action=update`) and
`31083359365` (`action=close`), each `read-errors=0 cycle=clean
coverage=complete`, closing #361 with a recovery comment. SC2's API-call line is
carried by every one of those deliverable lines. SC3 returns 0, recorded as a
CEILING check only, now paired with the positive `cycle`/`read-errors` signal
the acceptance runs supply. The incident body surfaced the observed
`api_error_status` per #238's fifth criterion.

THAT FIRST PASS PROVED A BRANCH, NOT THE PRODUCT, and the gap was closed rather
than argued away. Every incident WRITE in the runs above executed on the
unmerged branch of #359; on `main` the aggregator could not write an incident at
all, and its single attempt (`31080200369`) failed. #359 merged as `058ed1a`,
and the whole open→close cycle was then RE-DEMONSTRATED ON `main` — this is the
evidence that covers the shipped product:

- forced failure re-armed, head `3052601`: green `review / review` carrying
  `class=auth` with `api_error_status: 401`
- `31095551306` (ref `main`): `read-errors=0 cycle=incident coverage=complete
  action=open` → incident #365 opened
- credential restored, head `81ad1ac`: genuine `claude[bot]` review, zero
  annotations
- `31096144924`, `31096193502` (`action=update`), `31096244305`
  (`action=close`), each `read-errors=0 cycle=clean coverage=complete` — #365
  closed `COMPLETED` with the recovery comment, `cleanCycles: 3`, zero incidents
  left open

Recorded this way deliberately: an acceptance test whose evidence is read as
covering code that never ran it defeats its own purpose.

The three clean cycles completed in under two minutes. The hysteresis is
counter arithmetic, not a temporal soak — three CYCLES however fast they arrive,
not three periods of quiet. The auto-close is therefore evidence that recovery
was OBSERVED three times, never that it HELD for any duration. Nothing in the
spec asks for spacing, so this is a correct pass; it is recorded so a reader
does not infer a soak test that was never run.

A GENUINE-REVIEW BASELINE HAD TO MOVE, and the runbook's Step 1 expectation is
wrong as written: it says the wiring PR's own run will be "GREEN and genuinely
reviewed", which is structurally impossible on the PR that INTRODUCES the
caller. claude-code-action validates that the workflow file matches the default
branch, so sandbox#1's run (`31077349229`) was skipped with a warning
annotation and reviewed nothing. The baseline was therefore taken post-merge on
the probe PR before any credential was broken (run `31079254310`, a real
`claude[bot]` review), which is what makes the later `class=auth` unambiguous
rather than confoundable with a wiring gap. Probe drive is three pushes
(`probe-run: 1/2/3`), not the runbook's two.

FIRST DEFECT — THE WRITE PATH HAD NEVER ONCE EXECUTED. The poll renders the
incident body to `.claude-lane-incident.md`; `actions/upload-artifact` ignores
hidden files unless `include-hidden-files` is set, so the upload collected
nothing, `if-no-files-found: error` failed the step, and the `write` job was
skipped. The step is guarded by `if: action != 'none'`, so it was reachable only
on a cycle with something to write, and no prior cycle ever was. That is
established structurally rather than by sampling, and the corpus is pinned by
CODE STATE rather than by a run count, so it does not drift as the schedule
keeps firing: while `main` carried the pre-fix code, a run reaching
`action != none` MUST have failed at the upload. Every `main` run BEFORE
`058ed1a` succeeded except `31080200369` — the dispatch that forced this
incident — therefore every one of those runs reported `action=none`, and the
write path was never once exercised. Runs at or after `058ed1a` are outside
that corpus by construction: the four `main` re-demo runs recorded above report
`action != none` AND succeed, which is the fix working rather than a
counterexample. (Dated data point, deliberately not load-bearing: 143 such
pre-fix `main` runs as of 2026-08-06.) The sampled deliverable lines
corroborate the pre-fix corpus: each emitted `read-errors=0 cycle=clean` — the
exact positive signal this file identifies as the antidote to the `≤1` ceiling
check — while the write path was dead the entire time.
Fixed in #359 (`include-hidden-files: true`, plus a regression test asserting
the opt-in whenever the body path is dot-prefixed; renaming instead would have
had to change the byte-pinned write job and its pin file, so keeping the fix
outside that region keeps the diff off the one write-scoped surface). MERGED as
`058ed1a`, and
the incident lifecycle re-demonstrated on `main` afterwards — so the write path
is live in production rather than only on a branch. Hardened in #367
(`fe1b880`) after review found the first fix pinned only its own input: three
further ways to break the same round trip SILENTLY are now asserted — `archive`
off (which stores the body under the ARTIFACT name, so the pinned
`content-filepath` never resolves), a non-literal `path:` that made the
hidden-file check degrade quietly, and `if-no-files-found` itself. Every one is
a green run that writes no incident, which is the failure shape this whole
watchdog exists to eliminate.

SECOND DEFECT / UNBUILT DELIVERABLE — LANE ROUTING WAS NEVER IMPLEMENTED.
The #238 Contract requires the incident issue to carry the human-gated role
label PLUS a machine escalation-marker comment (`kind=routed-advisory`) so it
surfaces as `[escalated]` in the attended queue. #361 carried only
`claude-lane-incident` and no escalation comment. Neither `needs-human` nor
`routed-advisory` appears in any WORKFLOW OR SCRIPT in this repository, on
either branch — so this is unbuilt, not misconfigured. (Scoped to sources
deliberately: `needs-human` plainly exists as a GitHub label, worn by every
issue this ledger routes to a human, and this ledger names both strings in
prose. Neither is emitted by code, which is the claim.) The label is applied
inside the byte-pinned write region, so this is deliberately NOT patched here.
Dispositioned NOT BUILT
and tracked-elsewhere in #364, which is what keeps closing #238 from stranding
it. Operationally this is the sharp end: an `auth` incident inherently REQUIRES
a human at the provider layer, and the issue does not wear the label that routes
it to one.

THIRD DEFECT — A SILENT GREEN THE TAXONOMY CANNOT SEE, tracked in #363. A
`claude-code-action` workflow-validation skip exits 0: the check concludes green,
nothing is reviewed, and NO `class=` token is emitted. The aggregator's entire
detection mechanism is that token, so this failure mode is invisible to it by
construction rather than by tuning. Same issue records two lesser findings from
the same run — the review-count comment counted a review that never happened
("reviewed 1 time" on sandbox#1, where the action had skipped), and the marker
comment's copy asserts "A new push does not re-trigger this lane", which is
false for any `synchronize`-wired caller and was disproved by run `31083096934`.

UNBUILT DELIVERABLE — the App credential choice (reuse runner-observer, else a
new minimal App) remains parked behind its [USER-APPROVAL GATE], narrowed but
not retired: cross-repo `checks: read` + `pull-requests: read`. Unchanged by
this round. The observed public cross-repo read stays an OBSERVATION
(`read-errors=0` throughout), never a contract; Approval-record item 6 stands.

CANARY DEFERRAL, with a dated trigger. #238 recorded synthetic canary probes as
"rejected for now, deferred with trigger 'a quiet-period credential death causes
real missed-review harm'". This round STRENGTHENS the case rather than leaving
it neutral, and the reason must not be softened: the acceptance test uncovered a
silent-green shape the class taxonomy CANNOT see at all. A workflow-validation
skip concludes the check green, reviews nothing, and emits NO `class=` token
(observed on run `31077349229`; the outcome action took its `success` path), so
an annotation-based aggregator is structurally incapable of detecting it. A
synthetic canary is the only proposed mechanism that would. RE-EVALUATE
2026-11-06 (three months), or earlier on either original trigger, or on a first
observed no-token silent-green in a consumer repo — a trigger this round ADDS,
and one that by definition arrives with no signal attached. Its anchor today is
issue #228 itself, which stays open; recorded there 2026-08-06. The moment that
issue closes, the deferral needs a home first — the trigger cannot survive only
in the body of a closed issue.

NOT BLOCKING, recorded so it is not mistaken for a gate: org secret
`CLAUDE_CODE_OAUTH_TOKEN` visibility is still `all`, NOT the
selected-repositories flip. That flip is operator-only UI work and remains
PENDING. It blocked nothing here — under `all` the sandbox reads the org
credential and the selected-repositories list is legitimately empty, which is
exactly the runbook's Step 0 disposition. It is a hardening item, not an
acceptance gate. The secret was never edited or re-scoped; `updated_at` stayed
`2026-08-05T13:32:31Z` across the whole exercise, and the forced failure came
from a repo-level override that was set and then deleted.

SPEC-VS-IMPLEMENTATION CONTRADICTION, needing a decision rather than a fix.
The third acceptance criterion in #238 says "a second incident reopens the same
marker-selected issue (no duplicate)". The shipped aggregator DELIBERATELY does
not do that: the lookup step queries `state: "open"` only, and its own comment
states the design — "A closed incident is superseded by a fresh one rather than
reopened, so this never paginates closed history". A second episode therefore
opens a NEW issue. The "no duplicate" half still holds (never more than one
OPEN incident, which is what SC3 ceilings), but "reopens the same issue" is
contradicted by design, not merely unexercised. Not patched here, because which
side is wrong is a decision: amend the criterion to the supersede-not-reopen
shape the implementation documents, or implement reopen. Until that is settled,
closing #238 as "acceptance met" would misreport.

A SECOND SPEC CONFLICT, same shape, recorded on #238 for adjudication: its
Contract says the incident auto-closes on the "first window whose review runs
include a success and no `auth` class", while this phase specifies — and the
code implements — three consecutive clean cycles. The stricter shape is what
ran, so nothing is broken, but two ratified authorities state different
conditions and #238's wording is the stale one.

CANARY-PROPERTY TARGETS, one verdict each. The canary bullet names FOUR, and
its headline ("asserts on REAL lane output") IS satisfied — which is exactly why
the per-target verdicts have to be written down, or the satisfied headline reads
as if all four were covered.

1. Upstream #1501 silent-green plus seat/credential death — COVERED, and it is
   the round's strongest result: a dead credential produced a green check, a
   marker comment, and a `class=auth` annotation carrying `api_error_status:
   401`, which the aggregator escalated into an incident and then auto-resolved.
   One variant of this target is NOT covered and is the THIRD DEFECT above: a
   silent green that emits no class token at all.
2. claude-code-plugins#1327 SDK instant-fail — DETECTED BUT NOT ESCALATING, by
   design. It classifies as `other`, which is tallied and reported and opens no
   incident. So detection is genuinely covered while routing is not, and no
   reader should expect an incident from a repeat of #1327.
3. provisioning#215 runner mismatch — NOT EXERCISED, and it cannot be today:
   `class=runner` is an escalating class in the taxonomy that NOTHING IN
   PRODUCTION EMITS. Its only occurrences are the aggregator's own unit tests.
4. The caller-side `class=runner` selector-failure marker from 3a — NOT SHIPPED,
   so likewise not exercised. Targets 3 and 4 stand or fall together: 4 is the
   emission 3 needs, so caller-side emission is the single unblock for both.

MULTI-REPO SHAPE NOT EXERCISED. #238's first criterion describes auth-class
annotations "across multiple consumer repos in one window" (the #1122 replay);
acceptance drove ONE repo (`repositoriesSeen: 1`). The per-repo tally and
repo-list rendering are unit-tested, but the live multi-repo shape the criterion
literally names is a known coverage gap, recorded rather than claimed.

SIXTH-BULLET DELIVERABLES — the two downstream comment actions this phase names
alongside closing #228/#238, both PERFORMED 2026-08-06 and both left OPEN:
claude-code-plugins#1327 received its root-cause-plus-pointer comment, and the
record states the uncomfortable half rather than implying coverage — that
signature classifies as `other`, which is NON-ESCALATING by design, so
detection is proven while no incident opens. It is NOT comment-closed: it carries
`needs-human`, which bars autonomous resolution, and whether the instant-fail
signature deserves its own escalating class is exactly the human decision left
on it. provisioning#215 received its folded-into-the-taxonomy comment, carrying
the same honesty: `class=runner` is an escalating class in the taxonomy, and
NOTHING IN PRODUCTION EMITS IT — the only occurrences are the aggregator's unit
tests, so that substrate-silence would still be silent today. Its unpark trigger
is caller-side selector-failure emission shipping.

REMAINING TO CLOSE PHASE 4 (the write-path item is DONE — #359 merged, hardened
in #367, and re-demonstrated on `main`; the two sixth-bullet COMMENT halves are
DONE per the block above, and only the closure half of the
claude-code-plugins#1327 item is outstanding):

- land #364 (lane routing)
- settle the two spec conflicts recorded on #238 — reopen-vs-supersede, and the
  close-condition wording
- land the lane defects in #363
- exercise or consciously waive the multi-repo shape
- land caller-side `class=runner` emission, which is the single unblock for
  canary targets 3 and 4, or consciously defer it with provisioning#215's
  trigger recorded
- comment-CLOSE claude-code-plugins#1327, which this phase's sixth bullet
  requires and which is HUMAN-ONLY work
- then close #228/#238 with pointers and advance the tag

Every issue in that list except #363 and #364 carries `needs-human`, which bars
autonomous closure independently of how good the evidence is. So this phase
cannot be closed out by an autonomous session at all — the remaining work is
either code (#363, #364, caller-side emission) or a human's judgement, and no
amount of further acceptance evidence changes that.

**PHASE 4 CLOSE-OUT AMENDMENT (2026-08-08; tag advanced `[DOING]`→`[DONE]`).**
The list above is kept verbatim as the 2026-08-06 record; every item is now
dispositioned. The human judgements were made by the operator in an interactive
session (2026-08-07) and under the operator's goal directive of 2026-08-08
("go with your recommendations"); the code items landed
fresh-context-verifier-gated.

- #364 SHIPPED — PR #385 (merge `bcf48a0`): the incident issue wears
  `needs-human` (re-asserted fail-closed on every open/update — the pinned
  action runs `addLabels` on both branches, and the workflow's prior
  "creation only" comment was corrected as factually wrong) and carries the
  `kind=routed-advisory` escalation marker, published idempotently: at-most-once
  via a bot-authored presence check, with a repair path for a post that failed
  after issue creation (both review lanes caught the open-only gate's
  unrecoverable-failure window independently). The SECOND DEFECT block above is
  thereby resolved. Verification mutation-tested the new assertions and proved
  the fixture corpus' one-property-differs invariant restored. Recorded bound:
  no test distinguishes `startsWith` from `includes` in the presence check.
- The two SPEC CONFLICTS above are SETTLED, adjudication recorded in #238's
  closing comment (2026-08-07, operator-delegated): supersede-not-reopen is
  ratified as shipped, and the three-consecutive-clean-cycles close condition is
  ratified as shipped — #238's wording was the stale side both times: its
  reopen criterion ("a second incident reopens the same marker-selected
  issue") on the first, its "first clean window" close condition on the
  second.
- #363 SHIPPED — PR #387 (merge `7415d4e`, A1) + PR #389 (merge `9f9757e`, A2,
  split per this plan's own PR-A1/PR-A2 convention after verification caught the
  caller gating on an output its pinned composite could not yet produce): a
  validation self-skip now emits `class=skipped-validation` (recognized,
  counted, deliberately NON-escalating — it fires legitimately on caller-edit
  PRs; the check stays green per the advisory contract); the review-count upsert
  and stale-comment clear gate on `review-ran == 'true'` so skips no longer
  inflate the count, burn the max-reviews-per-pr budget, or clear warnings; the
  marker copy states re-triggering accurately for both caller shapes; and a
  wiring test asserts every consumed outcome output is declared by the composite
  at the pinned SHA. The THIRD DEFECT above is visible to the taxonomy now —
  for the review lane. The SECURITY lane's variant (its REQUIRED check goes
  green on a skip; its clear-stale gates on `review-failed` only; its own
  outcome-pin repoint) is #388, where it composes with the fail-closed policy
  decision.
- MULTI-REPO SHAPE WAIVED (operator-authorized): the per-repo tally and
  repo-list rendering are unit-tested; exercising the live shape costs another
  credential dance for marginal evidence. Revisit trigger: the first live
  multi-repo incident anomaly.
- Caller-side `class=runner` EMISSION DEFERRED (operator-authorized), carrying
  provisioning#215's trigger: unpark when caller-side selector-failure emission
  ships. Canary-property targets 3 and 4 above remain not exercised; nothing in
  production emits `class=runner` today.
- SIXTH-BULLET CLOSURES DONE: claude-code-plugins#1327 comment-closed
  2026-08-08 (operator-delegated; root cause + pointer stand in its thread).
  #228 and #238 closed with pointers 2026-08-07 — SC4 met.
- CANARY DEFERRAL REHOMED — this paragraph is now the deferral's home, per the
  CANARY DEFERRAL block's own rule, since #228 (its previous anchor) is closed.
  Synthetic canary probes remain rejected-deferred. RE-EVALUATE 2026-11-06, or
  earlier on any of: (1) a quiet-period credential death causing real
  missed-review harm — the original trigger; (2) real missed-review harm from
  any silent green — recorded here as a deliberate BROADENING of (1), not
  carried from the prior record; (3) a first observed no-token silent-green in
  a consumer repo — the trigger the 2026-08-06 round added. #363's fix narrows
  trigger 3 for the review lane but does not retire it: the security lane's
  outcome pin predates `7415d4e`, every external consumer's does until it
  repins, and the e2e lane consumes no outcome composite at all — all of those
  still produce no token on a skip, and a canary remains the only proposed
  mechanism that catches a no-token green independent of lane
  instrumentation.
- SECRET VISIBILITY ITEM RETIRED — the NOT BLOCKING block above is superseded:
  the operator decided 2026-08-07 to keep org secret `CLAUDE_CODE_OAUTH_TOKEN`
  at visibility `all` (claude reviews enabled for every repo). This was already
  the recorded fleet decision in github-iac: github-iac#269 retired the Pulumi
  selected-repositories binding (changing visibility via the API requires
  re-supplying the encrypted value, so the secret is deliberately not
  IaC-managed), github-iac#270 removed the retirement scaffolding, and
  github-iac#266 (restore selected visibility) is closed. No flip is pending;
  there is nothing left to harden.
- FLEET REPIN DONE (2026-08-08), closing the Wiring paragraph's "by-hand
  follow-up": v0.9.1 → v0.10.2 (`e9443874`) across standards #337 (component +
  runner-policy allowlist), claude-code-plugins #1990 (+ managed-policy sync
  #1992), and claude-lane-sandbox #3. Every merge fresh-context-verifier-gated;
  standards' scheduled `claude-lanes-repin` job still lacks its App credential
  and no-ops daily (operator item, recorded on the batch).
- CROSS-REPO READ CREDENTIAL (the UNBUILT DELIVERABLE above) DISPOSITIONED
  DEFERRED-BEHIND-ITS-GATE, not silently dropped: the App choice (widen
  runner-observer, else the minimal 3g App per standards#314) stays parked
  behind its [USER-APPROVAL GATE] (Approval-record item 6), narrowed to
  cross-repo `checks: read` + `pull-requests: read`. The operational
  consequence is stated plainly rather than implied: while
  `CLAUDE_LANE_INCIDENT_APP_PRIVATE_KEY` is absent, the aggregator polls only
  what the ambient token can read — this repo plus public consumers — so
  failures in PRIVATE consumer repositories are unobserved, and each run
  publishes the scope it actually observed (the `coverage=` deliverable token)
  precisely so that gap stays visible instead of reading as fleet health. The
  tag advances with this recorded because the item is the same class as the
  retired secret item — hardening parked behind a human gate, not an
  acceptance criterion (SC1–SC4 are met; acceptance never depended on private
  reads) — and it is already queued on the operator batch. Unpark trigger: the
  operator's App decision; on landing, the credential wiring is the shipped
  mint step plus the org-owner installation grant, nothing new to design.
- SECURITY-LANE POSTURE SUPERSEDED (2026-08-09, operator-directed) — #392's
  single-tier fail-closed is replaced by #397's two-tier ruling (merge
  `ba3e2e76de048932aade21950f4aa511a4afcd6d`, spelled in full because the
  abbreviation trips the spell-check word splitter): the required check
  reddens ONLY on the caller-drift validation skip,
  and loud-opens (a `::warning` annotation, conclusion SUCCESS) on any
  classified failure. The driver is availability, stated by the operator: an
  account or usage rotation must never lock merges fleet-wide, which is what a
  required context reddening for the length of an outage does. The compensating
  control is this phase's own deliverable — the aggregator reads lane
  annotations REGARDLESS of check-run conclusion, so the `class=<token>`
  annotation, the marker comment, and the auth escalation to the attended queue
  all survive the conclusion flip untouched; the advisory review lane had
  already proven that path. What the trade costs is recorded in the workflow's
  POSTURE and the README rather than implied: on the loud-open tier merges can
  land unreviewed, and the floor covers only failures the lane can CLASSIFY —
  a runner fault, the job timeout, or a pre-ruling step throwing still reddens.
  Note for the CANARY DEFERRAL above: this deliberately BROADENS its
  silent-green surface, which trigger (2) already covers as written.
- SECURITY-REVIEW-GATE ENFORCEMENT ACTIVE (2026-08-10, operator-directed) —
  org ruleset `19388547` flipped `enforcement: disabled` to `active` on the
  operator's explicit "enable", closing the availability hold that kept it
  disabled since the two-tier ruling. Pre-flip state verified this turn:
  required status check `security-review / security-review` (integration
  15368, non-strict), conditions `~DEFAULT_BRANCH` plus repository property
  `requires-security-review == "true"`, empty `bypass_actors`; the property
  set at flip time is still exactly `{claude-code-plugins}`. The operator's
  standing concern (account/usage rotation locking merges) is answered by the
  #397 posture the bullet above records: classified failures loud-open, only
  the caller-drift validation skip reddens, and that red self-clears on the
  offending PR's own merge. Residual accepted as-is: failures the lane cannot
  CLASSIFY (runner fault, job timeout, pre-ruling step throw) and an Actions
  platform outage leaving the required context unreported still block, as
  with any required check. This resolves operator-checklist item 2 from the
  2026-08-10 handoff as ENABLED, not declined.
- DESIGN A PROBE DROPPED (2026-08-10, operator decision) — the exploratory
  second-account credential fallback (second Max account login plus `claude
  setup-token`) is dropped as moot: manual account rotation on usage
  exhaustion is the operator's standing practice, and the two-tier posture
  keeps merges open through a rotation window, so an automated fallback
  credential buys nothing the posture does not already cover. This was the
  last unresolved operator-batch item; with it and the two items above (repin
  App pem deleted from Downloads 2026-08-10; gate enabled), the operator
  checklist from the 2026-08-10 handoff chain is CLOSED and the program has
  no open items beyond its recorded date/event triggers (ciw#400 canary
  re-evaluation 2026-11-06; medley label declarations at the next
  label-touching github-iac change).

**Phase 4 acceptance — what gates it, and what stopped gating it
(2026-07-31).** Acceptance was blocked on the aggregator being unable to WRITE,
for two reasons at once: repo secret `CLAUDE_LANE_INCIDENT_APP_PRIVATE_KEY`
does not exist (`gh secret list` on this repo returns nothing at all), so no
App token is minted; and the `aggregate` job's `permissions:` block grants only
read scopes (`checks`, `contents`, `issues`, `pull-requests` — all `read`, and
deliberately so per the block's own comment).

THE FINDING THAT RESHAPES THIS: the incident issue targets
`context.repo.owner`/`context.repo.repo` — the SAME repo the workflow runs in —
so maintaining it needs only `issues: write` on the ambient `GITHUB_TOKEN`. No
App, no secret, no cross-repo credential. GitHub documents exactly this shape:
its "Automatic token authentication" example workflow declares `permissions:
contents: read` + `issues: write` and creates an issue in its own repository
via `gh issue --repo ${{ github.repository }} create`. The App credential is
needed ONLY for the READ half, and only for PRIVATE consumer repos.

That read boundary is verified live rather than reasoned about, and the cleanest
evidence is a SINGLE run rather than a pair, which removes the between-run
confound: run `30574504350` polled standards and medley in one execution on one
token — `repositories=2`, and the log carries
`read failed (melodic-software/medley pulls page 1): Not Found` with
`read-errors=1`, the 404 falling on the PRIVATE repo while the PUBLIC one read
clean. Run `30574672188` (standards alone) corroborates with `read-errors=0`.

IMPORTANT QUALIFIER, and it must not be softened: GitHub does NOT document a
public-repository exemption for `GITHUB_TOKEN`. The docs say only "The token's
permissions are limited to the repository that contains your workflow." The
observed public cross-repo read is CONSISTENT with public data being readable
without any granted permission, but that reconciliation is INFERENCE, not a
documented guarantee. Treat it as UNVERIFIED and build no guarantee on it — in
particular, do not conclude from it that a future public-only polling scope is
credential-free by contract.

This NARROWS Approval-record item 6 rather than retiring it: the App must still
be chosen (reuse runner-observer, else a new minimal App) and its
[USER-APPROVAL GATE] stands, but the permission set it has to satisfy drops to
cross-repo `checks: read` + `pull-requests: read`, with `issues: write` no
longer part of the cross-repo ask. The shipped mint has since narrowed
accordingly: ci-workflows#331 (merged, `a90ff43`) moved the incident write to
the ambient token, and `claude-lane-incident-aggregator.yml`'s mint step now
requests `permission-issues: read`.

The API-call-count deliverable this phase names is SATISFIED. Scheduled run
`30571900637` emitted, verbatim:
`claude-lane-incident: api-calls=24 repositories=1 pull-requests=21 lane-check-runs=49 read-errors=0 cycle=clean action=none`

The `claude-lane-incident` label NOW EXISTS — github-iac#252 merged
2026-07-31T03:58Z, color `ededed` — which removes ONE of the `--label` query's
two ambiguities, not both. Before the label existed the query returned an empty
set whether the system was healthy or entirely absent, because `gh issue list
--label <nonexistent>` exits 0 and prints nothing rather than erroring
(confirmed by running it against a made-up label on this repo). That failure
mode is gone.

The REMAINING ambiguity is not fixed by the label and must not be recorded as
if it were: a count of zero still satisfies `≤1` whether the fleet is clean OR
the aggregator never ran, never polled, or ran and could not write. Absence of
an incident is not evidence of health — it is the same observation either way.
So the `≤1` query is a CEILING check (never more than one incident item open),
never a liveness check, and it must be paired with a positive signal to mean
anything. The positive signal is the aggregator's own deliverable line, which
is emitted per run and states what it actually did:
`claude-lane-incident: api-calls=<n> repositories=<n> pull-requests=<n> lane-check-runs=<n> read-errors=<n> cycle=<clean|incident|indeterminate> coverage=<complete|incomplete> action=<none|open|update|close>`
(CORRECTED 2026-08-06 against the shipped emitter, observed live during Phase 4
acceptance: `cycle` has a third value `incident`, which this line had omitted,
and a `coverage=` field this line had never carried at all. The omission
mattered — `incident` is the value that says the watchdog FIRED, so a reader
checking their run against the documented enum would have found the one
outcome that matters missing from it.)
Read `cycle` and `read-errors` together: `cycle=clean` with `read-errors=0`
means the poll actually reached its scope and found nothing; `cycle=indeterminate`
means at least one repository could not be read, so a zero incident count that
round is uninformative rather than reassuring (this is the state private
consumers produce today under the ambient token — see the Phase 4 write
findings above). Phase 4's acceptance test is what closes the gap end-to-end,
because it forces a real incident open and then requires it to auto-close after
three consecutive clean cycles — exercising the write path the `≤1` query can
never observe on its own.

### Phase 5: close-out [DOING]

- ci-workflows README lane-contract section updated (new inputs, cadence,
  kill-switches, caller-component pointer, kill-switch visibility deviation,
  fleet-propagation SLA if 3g's alternative chosen); CLAUDE.md ground rules
  checked for drift. Sanity: `grep -c "max-reviews-per-pr" README.md` ≥ 1 and
  `grep -c "CLAUDE_LANES_DISABLED" README.md` ≥ 1.
- medley REVIEW.md content-equivalence check (locally-owned vs restructured
  managed source); standards repo-local caller equivalence vs component source
  MODULO DOCUMENTED DEVIATIONS — byte equality is impossible by design, since
  standards is public and cannot call the governed selector; file issues on
  drift. Verification:
  `git -C <standards> diff --unified=0 'origin/main:components/claude-lanes/claude-review.yml' 'origin/main:.github/workflows/claude-review.yml'`
  and classify every hunk.
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

- **Phase 5 evidence (updated 2026-07-30; the 2026-07-29 block below predates
  it):** four of five bullets fully closed — README/CLAUDE.md lane contract
  (ci-workflows#285 MERGED 2026-07-29T13:20Z; both sanity greps return 1 at
  origin/main — the 07-29 "two outstanding" claim below was stale on this
  point at write time), trailer note, do-not-break sweep, and equivalence
  (medley drift filed as medley#1671; standards-side check complete with the
  component drift filed as standards#298, companion reusable-header claim as
  ci-workflows#311). Remaining: the final bullet — tags advanced + topic
  close-out — which this PR performs for everything except Phase 3's own tag
  (then `[DOING]` pending its closure evidence; closed 2026-08-03) and Phase 4.
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
  - **standards repo-local caller equivalence — CHECK DONE, DRIFT in the
    component (not the caller); filed.** The blocker cleared: standards#286
    merged 2026-07-29T16:12Z and #296 merged 2026-07-29T22:04Z. Reframed from
    "blob-hash equivalence": byte equality is impossible by design, because
    standards is PUBLIC and `components/runner-policy/README.md:113` bars a
    public repo from calling the selector the component uses. The check is
    equivalence modulo documented deviations. Component blob
    `a9dfe7f45a5697693298e86db221067fc4d008af`, caller blob
    `89a73c1741172588cb63547a2079e059e7a491a5`; the diff is 11 hunks at
    `--unified=0`, all classified, none of them undocumented drift (a
    difference that changes behavior or contradicts documented intent and
    carries no citation). FOUR documented deviations, behavior-affecting only
    in the first: D1 runner hardcoded `ubuntu-24.04` with the `select-review`
    job deleted (runner-policy README:113; the same constraint the manifest
    records for claude-code-plugins' `locally-owned` callers); D2 the
    workflow-level concurrency group in the `${{ github.workflow }}`-prefixed
    canonical form that standards' own `concurrency-policy` enforces via
    `ci.yml`'s "Enforce concurrency policy on standards" — runtime-identical,
    since the workflow is named `claude-review`; D3 the trigger comment drops
    the component's false "re-run the job for a fresh review" claim; D4 the
    header states repo-local ownership instead of the SYNC-MANAGED banner, per
    the manifest's "standards: manifest source, not a target". #296 enumerates
    D1-D3; the manifest documents D4. Two hunks are word-identical rewraps and
    one adds a comment-only `skip-actors` explanation — the suspected
    `skip-actors` deviation is a NON-deviation, since neither file passes the
    input and both inherit the reusable's four-actor default. Byte equivalence
    HOLDS for all four managed targets (dotfiles, github-iac, medley,
    provisioning all at `a9dfe7f4`), confirming the sync renders the component
    verbatim with no templating. The drift found is upstream in the component,
    not in the caller: the false re-run claim and the stale KNOWN CONFLICT
    prescription are both live there and synced to all four targets — filed as
    standards#298 (the reusable's own header carries the same re-run claim,
    filed as ci-workflows#311). The same paragraph's historical deadlock
    statement is TRUE (`ec91c34^` carried the `claude-review-<PR>` inner group
    and `ec91c34` predates `v0.9.0`) and is explicitly excluded from that
    issue.
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
  - **Remaining for Phase 5 (superseded 2026-07-30 — see the updated evidence
    header above):** as of 2026-07-29 this listed the README/CLAUDE.md bullet
    (in fact already merged as ci-workflows#285 at 13:20Z that day) and the
    equivalence check (since completed, drift filed as standards#298 +
    ci-workflows#311). What remains is only the final bullet — tags advanced +
    topic close-out — performed by the PR carrying this edit for every phase
    except Phase 3 (then `[DOING]` pending closure evidence; closed
    2026-08-03) and Phase 4.
    Verification:
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
   ci-runner-canary N/A. — ci-runner leg SUPERSEDED 2026-08-01 by the ratified
   wave-target set (Phase 3d, WAVE-TARGET SET — RATIFIED); its self-block
   concern survives as a merits gate (STILL LIVE). `.github` unaffected.
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
   — TARGET SET SUPERSEDED 2026-08-01 by the ratified wave-target set (Phase
   3d, WAVE-TARGET SET — RATIFIED): both repos are retired as planned targets.
   The App-access ordering and mechanism this item approved are unaffected and
   still govern whichever target lands.
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
  targets change either way, documented in manifest comments. ci-runner leg
  superseded 2026-08-01 — see Approval-record item 1.
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
  precaution: have an org owner hold it). Superseded 2026-08-01 — see
  Approval-record item 5.
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
- [EXEC-SHAPE] Waved rollout (provisioning first — see 3d for the measurement
  that replaced dotfiles) + automerge-off window + rollback
  = revert-component-source procedure.
- [EXEC-SHAPE] 3e verification serialized one repo at a time via kill-switches
  — SUPERSEDED 2026-07-30: serialization is by merge order; the kill-switch
  could not sequence (see the amended 3e bullet).
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
