// Pure logic for the Claude lane incident aggregator
// (.github/workflows/claude-lane-incident-aggregator.yml). Everything here is
// deterministic and network-free so it can be unit-tested; the workflow keeps
// only the octokit calls and the counted API budget around it.
//
// PUBLIC-SAFETY CONTRACT — this repository is public and the aggregator's only
// output is an issue body in it. Check-run annotation text is UNTRUSTED input:
// any workflow in any consumer repository, and any GitHub App installed there,
// can put arbitrary text in an annotation, and the lane's own annotation embeds
// a projection of a model-authored SDK result. So NOTHING derived from
// annotation text is ever rendered. Two independent gates stand between an
// annotation and the issue body:
//
//   1. a pattern that can only match a narrow character class, and
//   2. a frozen allowlist / numeric-range membership test on what it captured.
//
// A capture that fails gate 2 is counted, never stored and never rendered — not
// even truncated. The same discipline covers repository names (validated
// against the GitHub name grammar) and every number (coerced to a bounded
// integer). `renderIssueBody` therefore emits only: allowlisted class tokens,
// validated `owner/name` strings, integers, and timestamps this module
// generated. Adding a render path that reads any other API string reopens the
// leak this note exists to prevent.
"use strict";

// The token vocabulary is owned by .github/actions/claude-lane-outcome/classify.cjs
// — that module is the only emitter, and this set mirrors what it can produce.
// `runner` is the caller-side selector-failure token the review lanes will emit
// once the select-runner surfacing lands; it is listed now so the aggregator
// recognises it the moment it appears rather than counting it as unrecognised.
// PLAN.md's early sketch also names a `concurrency` token; classify.cjs never
// emits one, so it is deliberately absent — an aspirational token in a
// narrative paragraph is not a contract, and an unemitted allowlist entry is
// indistinguishable from a forged one.
const RECOGNIZED_CLASSES = Object.freeze(
  new Set(["auth", "rate-limit", "overloaded", "other", "runner"]),
);

// Classes that by themselves open (or hold open) the incident. Both are dead
// until a human acts: `auth` is a credential that cannot be used until it is
// rotated, re-entitled, or re-permissioned, and `runner` is a fleet
// misconfiguration no retry resolves. `rate-limit`, `overloaded`, and `other`
// are transient or benign — they self-heal, so escalating them would page a
// human for weather. They are still counted and rendered whenever an incident
// is open, which is what makes a storm visible in context.
const ESCALATING_CLASSES = Object.freeze(new Set(["auth", "runner"]));

// Gate 1 for the class token: a bounded lowercase-and-hyphen run, anchored on
// word boundaries so it matches the emitter's bare `class=<token>` term.
const CLASS_TOKEN_PATTERN = /\bclass=([a-z][a-z-]{0,20})\b/gu;

// Gate 1 for the API status: the emitter folds classify.cjs's safe projection
// into the annotation, and `api_error_status` is the one further field #238
// requires (401 vs 402 vs 403 prescribe different remedies). Only a bare
// three-digit number matches; a string-valued or absent field cannot.
const API_ERROR_STATUS_PATTERN = /"api_error_status":(\d{3})[,}]/u;

// GitHub's repository-name grammar. Applied to every `owner/name` before it can
// reach the body, so an API response cannot smuggle markdown or a link.
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

// The lane jobs whose check runs carry the `class=` annotation: the inner job
// ids of the three reusables (claude-review.yml `review`,
// claude-security-review.yml `security-review`, claude-e2e-verify.yml
// `e2e-verify`), which the Phase 3a caller components mirror as their own job
// ids for required-check continuity.
//
// A reusable-called job's check run is named `<caller job> / <inner job>`, so
// the match is per `/`-separated segment rather than on the whole string: it
// holds for `review / review` and for a caller that named its job something
// else. This constant is the aggregator's single point of failure — a name it
// cannot match makes `laneRunsObserved` permanently zero, which classifies
// every cycle `indeterminate` and leaves an incident that never opens and never
// auto-closes.
//
// Matching by name alone is not sufficient on its own, and the poll does not
// rely on it being so. A fork pull request ships its own workflow files, so an
// outside contributor can declare a job named `review` that emits any
// annotation it likes; the poll therefore skips fork heads outright before this
// ever runs. Within the base repository, a same-named non-lane job carries no
// `class=` annotation, so it can only cast a liveness vote — and only if it
// also completed with a real conclusion.
const LANE_CHECK_RUN_JOB_IDS = Object.freeze(
  new Set(["review", "security-review", "e2e-verify"]),
);

const STATE_SCHEMA_VERSION = 1;
const SELECTOR_MARKER = "<!-- ci-workflows:claude-lane-incident:v1:active -->";
const STATE_MARKER_PREFIX = "<!-- ci-workflows:claude-lane-incident:state ";
const STATE_MARKER_SUFFIX = " -->";
const CLEAN_CYCLES_TO_CLOSE = 3;

// Bounds on the rendered body. GitHub rejects an issue body over 65536
// characters, and a fleet-wide incident can name every repository and every
// open PR; truncating with an explicit remainder line keeps the write from
// failing exactly when the incident is largest. The repository table is
// budgeted in CHARACTERS against this ceiling — the row count is only an upper
// cap on how much detail is worth reading — because a row's size scales with
// the repository's name length. See renderIssueBody.
const MAX_BODY_CHARACTERS = 65536;
const REMAINDER_LINE_RESERVE = 80;
const MAX_RENDERED_REPOSITORIES = 40;
const MAX_RENDERED_PULLS_PER_REPOSITORY = 10;

// Bounds on the TRACKED index, which the state block serializes into that same
// body and which grows across cycles. Set above the rendered bounds so the
// "+N more" remainders stay truthful for a while, and low enough that the state
// block cannot approach the body limit — see mergeRepositories.
const MAX_TRACKED_REPOSITORIES = 60;
const MAX_TRACKED_PULLS_PER_REPOSITORY = 30;

/**
 * Extract the machine-readable signals from one annotation message.
 *
 * Returns only allowlisted class tokens and a range-checked status; every other
 * capture is folded into `unrecognized` as a count.
 */
function extractSignals(message) {
  const text = typeof message === "string" ? message : "";
  const classes = [];
  let unrecognized = 0;

  for (const match of text.matchAll(CLASS_TOKEN_PATTERN)) {
    const token = match[1];
    if (RECOGNIZED_CLASSES.has(token)) {
      classes.push(token);
    } else {
      unrecognized += 1;
    }
  }

  const statusMatch = API_ERROR_STATUS_PATTERN.exec(text);
  const parsedStatus = statusMatch ? Number(statusMatch[1]) : Number.NaN;
  const apiErrorStatus =
    parsedStatus >= 100 && parsedStatus <= 599 ? parsedStatus : null;

  return { classes, unrecognized, apiErrorStatus };
}

function isLaneCheckRun(name) {
  if (typeof name !== "string") return false;
  return name
    .split("/")
    .some((segment) => LANE_CHECK_RUN_JOB_IDS.has(segment.trim()));
}

function isValidRepository(fullName) {
  return typeof fullName === "string" && REPOSITORY_NAME_PATTERN.test(fullName);
}

function toPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function toTimestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * Fold this cycle's observations into per-class counts, an affected-repository
 * index, and the observed API statuses.
 *
 * An observation is `{ repository, pullNumber, classes, unrecognized,
 * apiErrorStatus }` — the shape the workflow builds from one annotation.
 *
 * Counts are DISTINCT AFFECTED PULL REQUESTS, not annotations seen. The same
 * failure is re-observed every cycle for as long as its pull request stays in
 * the lookback window, and a lane can annotate a head more than once, so a raw
 * tally measures polling cadence rather than blast radius — "auth: 24" after a
 * day of one stuck PR. Deduplicating on `<repository>#<pull>` makes the number
 * mean what the incident body says it means, and makes it comparable to the
 * affected-repository table beside it.
 */
function tallyObservations(observations) {
  const classPulls = {};
  const statusPulls = {};
  const repositories = {};
  const unrecognizedPulls = new Set();

  for (const observation of observations ?? []) {
    const repository = isValidRepository(observation?.repository)
      ? observation.repository
      : null;
    const pullNumber = toPositiveInteger(observation?.pullNumber);
    // Anything lacking a usable identity still has to count, or a single
    // unattributable failure would vanish; a per-observation fallback key keeps
    // it distinct without pretending to know which pull request it came from.
    const pullKey =
      repository && pullNumber !== null
        ? `${repository}#${pullNumber}`
        : `unattributed:${observations.indexOf(observation)}`;

    if ((toPositiveInteger(observation?.unrecognized) ?? 0) > 0) {
      unrecognizedPulls.add(pullKey);
    }

    for (const token of observation?.classes ?? []) {
      if (!RECOGNIZED_CLASSES.has(token)) continue;
      classPulls[token] ??= new Set();
      classPulls[token].add(pullKey);
      if (!repository) continue;
      repositories[repository] ??= { classes: [], pulls: [] };
      const entry = repositories[repository];
      if (!entry.classes.includes(token)) entry.classes.push(token);
      if (pullNumber !== null && !entry.pulls.includes(pullNumber)) {
        entry.pulls.push(pullNumber);
      }
    }

    const status = observation?.apiErrorStatus;
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      statusPulls[status] ??= new Set();
      statusPulls[status].add(pullKey);
    }
  }

  const sizes = (bucket) =>
    Object.fromEntries(
      Object.entries(bucket).map(([key, pulls]) => [key, pulls.size]),
    );

  return {
    classCounts: sizes(classPulls),
    statusCounts: sizes(statusPulls),
    repositories,
    unrecognized: unrecognizedPulls.size,
    escalating: Object.keys(classPulls).some((token) =>
      ESCALATING_CLASSES.has(token),
    ),
  };
}

/**
 * Carry a per-key count across cycles by taking the PEAK, never the sum.
 *
 * Each cycle re-counts everything still inside the 24h lookback window, so the
 * current cycle already subsumes the previous one for any pull request still in
 * view. Summing would re-add the same failures once an hour; the peak answers
 * "how wide did this incident ever get" and stays put when pull requests age
 * out of the window.
 */
function mergeCounts(previous, addition) {
  const merged = { ...(previous ?? {}) };
  for (const [key, count] of Object.entries(addition ?? {})) {
    merged[key] = Math.max(merged[key] ?? 0, count);
  }
  return merged;
}

function mergeRepositories(previous, addition) {
  const merged = {};
  for (const [name, entry] of Object.entries(previous ?? {})) {
    if (!isValidRepository(name)) continue;
    merged[name] = {
      classes: [
        ...new Set(
          (entry?.classes ?? []).filter((token) =>
            RECOGNIZED_CLASSES.has(token),
          ),
        ),
      ],
      pulls: [
        ...new Set(
          (entry?.pulls ?? []).filter(
            (pull) => toPositiveInteger(pull) !== null,
          ),
        ),
      ],
      // How many pull requests this repository has ever had in the incident,
      // which is NOT `pulls.length` once the bound below bites.
      pullsSeen: toPositiveInteger(entry?.pullsSeen) ?? 0,
    };
  }
  for (const [name, entry] of Object.entries(addition ?? {})) {
    if (!isValidRepository(name)) continue;
    merged[name] ??= { classes: [], pulls: [], pullsSeen: 0 };
    const target = merged[name];
    for (const token of entry.classes) {
      if (!target.classes.includes(token)) target.classes.push(token);
    }
    for (const pull of entry.pulls) {
      if (!target.pulls.includes(pull)) target.pulls.push(pull);
    }
  }

  // The index is serialized into the issue body's state block, which GitHub
  // caps at 65536 characters, and it ACCUMULATES across cycles — so bounding
  // only what is rendered would still let the state block outgrow the body and
  // 422 the update on the largest incident. Bounding here caps both. The kept
  // slice is the sorted head, so the same repositories and pull requests stay
  // in view cycle after cycle instead of churning.
  //
  // Each bound carries a count of what it dropped, so the rendered "+N more"
  // remainders describe the INCIDENT rather than the surviving slice — an
  // operator reading "40 shown, +20 more" when 200 repositories are affected
  // would badly misjudge the blast radius. Two integers cost nothing to
  // serialize; two hundred repository names do.
  const names = Object.keys(merged).sort();
  const repositories = {};
  for (const name of names.slice(0, MAX_TRACKED_REPOSITORIES)) {
    const entry = merged[name];
    const pulls = entry.pulls.sort((a, b) => a - b);
    repositories[name] = {
      classes: entry.classes,
      pulls: pulls.slice(0, MAX_TRACKED_PULLS_PER_REPOSITORY),
      pullsSeen: Math.max(entry.pullsSeen, pulls.length),
    };
  }
  return { repositories, repositoriesSeen: names.length };
}

/**
 * Classify one polling cycle.
 *
 * `clean` requires positive evidence — at least one lane check run observed,
 * no escalating class, AND a poll that read everything it meant to read.
 * Absence of failure is not health: the lanes conclude green on an
 * infrastructure failure by design, and a window with no lane runs at all (a
 * quiet night, or every lane wedged before it could report) proves nothing.
 *
 * `readErrors` is the same argument in a second guise. A consumer repository
 * the poll could not read — a 403 under a narrowed credential, a rate limit, a
 * transient 5xx — is a repository whose lanes might be the ones on fire, and
 * counting that silence as health is how a live incident gets auto-closed
 * three cycles later. Any read error therefore caps the cycle at
 * `indeterminate`, which neither advances the clean-cycle counter nor resets
 * it. An escalating class still wins outright: a failure that WAS observed is
 * real regardless of what else the poll missed.
 */
function classifyCycle({ laneRunsObserved, escalating, readErrors }) {
  if (escalating) return "incident";
  if ((toPositiveInteger(readErrors) ?? 0) > 0) return "indeterminate";
  return (toPositiveInteger(laneRunsObserved) ?? 0) > 0
    ? "clean"
    : "indeterminate";
}

/**
 * Name what an open incident implicates that this cycle did not observe.
 *
 * A clean cycle is a claim about the fleet, and that claim is only ever as wide
 * as the poll that produced it. Polling scope is not fixed: it IS the App
 * installation's repository list, and it narrows — to this repository alone —
 * the moment the App credential goes missing (see the workflow's POLLING
 * SCOPE). That narrowing raises no read error, because nothing failed; the poll
 * simply asked a smaller question and got a clean answer to it. So a clean
 * verdict from a narrowed poll is not evidence that the incident's root cause
 * recovered, it is evidence that nobody looked — and letting it advance the
 * clean-cycle counter is how an incident caused by private consumer
 * repositories auto-closes three cycles after those repositories stopped being
 * read at all. `classifyCycle` cannot see this: scope is not an error, and the
 * incident's own evidence is not in its inputs.
 *
 * Coverage is therefore proven against the incident's OWN persisted evidence:
 * every repository its index names must appear in this cycle's polled scope.
 * Three ways that proof fails, all of which hold the incident open:
 *
 *   - `unobserved` — a named implicated repository was not polled this cycle.
 *   - `unlisted` — the persisted index is bounded (MAX_TRACKED_REPOSITORIES)
 *     while `repositoriesSeen` counts the whole incident, so a truncated index
 *     cannot name what it dropped and coverage over it cannot be established.
 *   - `namesNothing` — the incident's index names no repository at all, so no
 *     cycle can contradict it and none may count toward closing it.
 *
 * `namesNothing` turns on what the index CONTAINS, never on why: a state block
 * that did not parse (hand-edited, or written by an older schema, both of which
 * `parseStateBlock` degrades to null) and one that parsed to an empty index are
 * the same claim — nothing — and get the same answer. Rebuilding either from an
 * empty state and counting toward close from zero would be the same silent
 * close by another route. An incident whose durable record was lost is one a
 * human closes; the escalating path still rebuilds the block, so a live
 * incident's body self-repairs.
 *
 * A gap holds the incident open indefinitely, and three cases make that a
 * standing operator cost rather than a transient one: an implicated repository
 * that is legitimately gone (archived, or dropped from the installation, which
 * is not distinguishable here from a credential that vanished); an incident
 * wider than MAX_TRACKED_REPOSITORIES, whose `unlisted` remainder never
 * resolves; and a STATE_SCHEMA_VERSION bump, which strands every incident open
 * at the time. Each is the deliberate direction to fail: a held incident is
 * visible and a human closes it, whereas the silent close this prevents looks
 * exactly like recovery.
 *
 * Returns `null` when coverage is complete.
 */
function coverageGap({ previous, polledRepositories }) {
  const implicated = Object.keys(previous?.repositories ?? {});
  if (implicated.length === 0) {
    return { unobserved: [], unlisted: 0, namesNothing: true };
  }
  // Case-insensitive for the same reason the poll's fork check is: GitHub
  // repository names are, and the `repositories` dispatch input is typed by a
  // human, so an exact compare would report every smoke run as a coverage gap.
  const polled = new Set(
    (Array.isArray(polledRepositories) ? polledRepositories : [])
      .filter((name) => typeof name === "string")
      .map((name) => name.trim().toLowerCase()),
  );
  const unobserved = implicated.filter(
    (name) => !polled.has(name.toLowerCase()),
  );
  const unlisted = Math.max(
    0,
    (toPositiveInteger(previous.repositoriesSeen) ?? 0) - implicated.length,
  );
  if (unobserved.length === 0 && unlisted === 0) return null;
  return { unobserved, unlisted, namesNothing: false };
}

/**
 * Render a coverage gap as the warning the workflow annotates the run with.
 * Takes a gap, never `null` — there is nothing to say about complete coverage.
 *
 * A held cycle otherwise logs `cycle=clean action=none` and nothing says why,
 * which is precisely the diagnosis an operator needs on the cycles that go
 * wrong.
 */
function describeCoverageGap(gap) {
  if (gap.namesNothing) {
    return (
      "the open incident's state names no repository, so this cycle cannot " +
      "prove it observed what the incident implicates; holding it open for a " +
      "human to close."
    );
  }
  const parts = [];
  if (gap.unobserved.length > 0) {
    parts.push(`not polled this cycle: ${gap.unobserved.join(", ")}`);
  }
  if (gap.unlisted > 0) {
    parts.push(
      `${gap.unlisted} further implicated repositories are not named in the incident's bounded index`,
    );
  }
  return (
    "this cycle did not observe every repository the open incident " +
    `implicates (${parts.join("; ")}), so it does not count toward the ` +
    "auto-close."
  );
}

/**
 * Advance the persisted incident state by one cycle and name the write the
 * workflow should perform.
 *
 * `action` is one of:
 *   - `open`   — no incident issue is open and an escalating class was seen.
 *   - `update` — an incident issue is open and its body must change.
 *   - `close`  — the third consecutive clean cycle; close with a recovery note.
 *   - `none`   — nothing changed; write nothing. Transition-edge writes only,
 *                which is also what keeps this inside GitHub's secondary
 *                content-creation limits.
 *
 * `issueOpen` is the only issue-state input because the workflow searches open
 * issues only: a previously closed incident is superseded by a fresh one rather
 * than reopened, which keeps the "at most one OPEN incident item" contract
 * without paginating the repository's closed-issue history every cycle.
 *
 * `polledRepositories` is this cycle's polling scope, and it gates the clean
 * path: a clean cycle advances the counter only when it observed what the
 * incident implicates. Omitting it proves nothing and so closes nothing, which
 * is the direction a plumbing mistake should fail. See coverageGap.
 */
function nextState({
  previous,
  tally,
  cycle,
  now,
  issueOpen,
  polledRepositories,
}) {
  const timestamp = now;

  if (cycle === "incident") {
    const carried = issueOpen ? previous : null;
    const { repositories, repositoriesSeen } = mergeRepositories(
      carried?.repositories,
      tally.repositories,
    );
    const state = {
      v: STATE_SCHEMA_VERSION,
      // Normalized on the way in as well as out, so the state a cycle writes
      // and the state parsed back from the issue body are byte-identical.
      firstSeen: carried?.firstSeen ?? toTimestamp(timestamp),
      lastSeen: toTimestamp(timestamp),
      cleanCycles: 0,
      classCounts: mergeCounts(carried?.classCounts, tally.classCounts),
      statusCounts: mergeCounts(carried?.statusCounts, tally.statusCounts),
      repositories,
      repositoriesSeen: Math.max(
        carried?.repositoriesSeen ?? 0,
        repositoriesSeen,
      ),
      unrecognized: Math.max(carried?.unrecognized ?? 0, tally.unrecognized),
    };
    return { state, action: issueOpen ? "update" : "open" };
  }

  if (!issueOpen) return { state: null, action: "none" };

  if (cycle === "indeterminate") return { state: previous, action: "none" };

  // A clean cycle counts toward the auto-close only if it actually observed
  // what the incident implicates. A gap holds — it neither advances the counter
  // nor resets it, exactly as `indeterminate` does — and is returned so the
  // workflow can say why on a cycle that would otherwise log `cycle=clean
  // action=none` with no explanation.
  const gap = coverageGap({ previous, polledRepositories });
  if (gap !== null)
    return { state: previous, action: "none", coverageGap: gap };

  // Coverage cannot hold for a null `previous`, so everything below has a
  // parsed state block to advance.
  const cleanCycles = previous.cleanCycles + 1;
  const state = { ...previous, v: STATE_SCHEMA_VERSION, cleanCycles };
  return {
    state,
    action: cleanCycles >= CLEAN_CYCLES_TO_CLOSE ? "close" : "update",
  };
}

function emptyState() {
  return {
    v: STATE_SCHEMA_VERSION,
    firstSeen: null,
    lastSeen: null,
    cleanCycles: 0,
    classCounts: {},
    statusCounts: {},
    repositories: {},
    repositoriesSeen: 0,
    unrecognized: 0,
  };
}

function renderStateBlock(state) {
  return `${STATE_MARKER_PREFIX}${JSON.stringify(state)}${STATE_MARKER_SUFFIX}`;
}

/**
 * Recover the persisted state from an issue body.
 *
 * The issue body is the durable store, so a body a human edited by hand — or
 * one written by an older schema — must degrade to "no prior state" rather than
 * throwing: a parse failure would otherwise wedge the aggregator on exactly the
 * cycle it needs to report. Every recovered field is re-validated, because the
 * body is world-writable by anyone with issue-edit rights in this repository.
 */
function parseStateBlock(body) {
  const text = typeof body === "string" ? body : "";
  const start = text.indexOf(STATE_MARKER_PREFIX);
  if (start < 0) return null;
  const end = text.indexOf(STATE_MARKER_SUFFIX, start);
  if (end < 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start + STATE_MARKER_PREFIX.length, end));
  } catch {
    return null;
  }
  if (parsed?.v !== STATE_SCHEMA_VERSION) return null;

  const cleanCycles = Number.isSafeInteger(parsed.cleanCycles)
    ? Math.max(0, Math.min(CLEAN_CYCLES_TO_CLOSE, parsed.cleanCycles))
    : 0;

  const { repositories, repositoriesSeen } = mergeRepositories(
    parsed.repositories,
    {},
  );
  return {
    v: STATE_SCHEMA_VERSION,
    // Re-serialized from a parsed instant, never echoed. A bare typeof check
    // would let a hand-edited body put an arbitrary string — a link, a script
    // tag, or 100k characters that push every future update past GitHub's body
    // limit and wedge the aggregator permanently — straight into the rendered
    // "First seen" line, which is exactly the class of leak the module header
    // says cannot happen.
    firstSeen: toTimestamp(parsed.firstSeen),
    lastSeen: toTimestamp(parsed.lastSeen),
    cleanCycles,
    classCounts: sanitizeCounts(parsed.classCounts, (key) =>
      RECOGNIZED_CLASSES.has(key),
    ),
    statusCounts: sanitizeCounts(parsed.statusCounts, (key) => {
      const status = Number(key);
      return Number.isInteger(status) && status >= 100 && status <= 599;
    }),
    repositories,
    // A recovered total below what the surviving index already proves is a
    // tampered or truncated body, not a smaller incident.
    repositoriesSeen: Math.max(
      toPositiveInteger(parsed.repositoriesSeen) ?? 0,
      repositoriesSeen,
    ),
    unrecognized: toPositiveInteger(parsed.unrecognized) ?? 0,
  };
}

function sanitizeCounts(counts, keyIsValid) {
  const clean = {};
  for (const [key, value] of Object.entries(counts ?? {})) {
    const count = toPositiveInteger(value);
    if (count !== null && keyIsValid(key)) clean[key] = count;
  }
  return clean;
}

function renderIssueBody(state) {
  const classLines = Object.entries(state.classCounts)
    .filter(([token]) => RECOGNIZED_CLASSES.has(token))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([token, count]) =>
        `| \`${token}\` | ${count} | ${ESCALATING_CLASSES.has(token) ? "yes" : "no"} |`,
    );

  const statusEntries = Object.entries(state.statusCounts).sort(
    ([a], [b]) => Number(a) - Number(b),
  );
  const statusLine =
    statusEntries.length > 0
      ? statusEntries
          .map(([status, count]) => `\`${status}\` (${count})`)
          .join(", ")
      : "unavailable — detection came from the substring path, which carries no numeric status";

  const repositoryNames = Object.keys(state.repositories).sort();
  const untrackedRepositories = Math.max(
    0,
    (state.repositoriesSeen ?? 0) - repositoryNames.length,
  );
  const renderRepositoryLine = (name) => {
    const entry = state.repositories[name];
    const pulls = [...entry.pulls]
      .sort((a, b) => a - b)
      .slice(0, MAX_RENDERED_PULLS_PER_REPOSITORY)
      .map((pull) => `[#${pull}](https://github.com/${name}/pull/${pull})`);
    // Counted against everything the incident ever touched in this repository,
    // not against the slice that survived the tracked bound — "+20 more" when
    // 290 are affected would badly understate the blast radius.
    const hidden = Math.max(
      0,
      (entry.pullsSeen ?? entry.pulls.length) - pulls.length,
    );
    const overflow = hidden > 0 ? ` (+${hidden} more)` : "";
    const classes = [...entry.classes].sort().map((token) => `\`${token}\``);
    return `| \`${name}\` | ${classes.join(", ")} | ${pulls.join(", ")}${overflow} |`;
  };

  const prologue = [
    SELECTOR_MARKER,
    renderStateBlock(state),
    "",
    "## Claude lane infrastructure incident",
    "",
    "The Claude review lanes reported an infrastructure failure that no retry",
    "clears. The lanes are advisory and conclude green by design, so their",
    "checks look healthy — this issue is the only signal that PRs in the",
    "repositories below went **unreviewed**.",
    "",
    `- First seen: ${state.firstSeen ?? "unknown"}`,
    `- Last seen: ${state.lastSeen ?? "unknown"}`,
    `- Consecutive clean cycles: ${state.cleanCycles} of ${CLEAN_CYCLES_TO_CLOSE} (auto-closes at ${CLEAN_CYCLES_TO_CLOSE}; only cycles that polled every repository below count)`,
    `- Observed \`api_error_status\`: ${statusLine}`,
    `- Repositories affected: ${Math.max(state.repositoriesSeen ?? 0, repositoryNames.length)}`,
    `- Unrecognized \`class=\` tokens seen: ${state.unrecognized ?? 0}${
      (state.unrecognized ?? 0) > 0
        ? " — a lane is emitting a class this watchdog does not know; widen RECOGNIZED_CLASSES"
        : ""
    }`,
    "",
    "### Failure classes",
    "",
    "Counts are the peak number of distinct pull requests seen failing this way",
    "in any single polling window, not a running total of annotations.",
    "",
    "| Class | Peak affected pull requests | Escalating |",
    "| --- | --- | --- |",
    ...classLines,
    "",
    "### Affected repositories",
    "",
    "| Repository | Classes | Pull requests |",
    "| --- | --- | --- |",
  ];

  const epilogue = [
    "",
    "### Remediate",
    "",
    "1. `auth` — the org credential is unusable until a human acts. `401`",
    "   rotate or replace the token; `402` fix billing or entitlement in the",
    "   Claude Console; `403` fix key permissions and workspace access.",
    "2. `runner` — the lane could not resolve a runner; check the governed",
    "   runner fleet and the caller's selector inputs.",
    "3. Confirm the lanes are ENABLED before waiting for this to close. A",
    "   kill-switched lane still publishes a name-stable skipped check, and a",
    "   skip is not evidence the lanes ran — so while `CLAUDE_LANES_DISABLED`",
    "   (or a per-lane switch) is set, this issue can never auto-close.",
    "4. A clean cycle only counts if it polled every repository listed above.",
    "   Polling scope is the aggregator App's installation, so a missing App",
    "   credential narrows it to this repository and stops the count without",
    "   failing anything; the run log's `coverage=` field and its warning",
    "   annotation name what went unobserved. A repository that is gone for",
    "   good — archived, or removed from the installation — can never be",
    "   covered again, so close this by hand once you have confirmed recovery.",
    "5. Re-run the affected lane jobs once the cause is fixed, then let this",
    `   watchdog observe ${CLEAN_CYCLES_TO_CLOSE} consecutive covered clean cycles; it closes itself.`,
    "",
    "---",
    "*Maintained automatically by `.github/workflows/claude-lane-incident-aggregator.yml`.*",
    "*Only allowlisted class tokens and validated identifiers are reported here —",
    "no annotation text, and no model-authored content, is ever copied into this issue.*",
    "*Closing this by hand while the failure persists reopens it on the next cycle.*",
  ];

  // A CHARACTER budget, not a row count. Rows are not a fixed size: each one
  // repeats the repository name once per pull-request link, so the same 40 rows
  // span ~48k characters at a 36-character name and blow past GitHub's 65536
  // limit at a 70-character one. Budgeting by rows means the body fits or 422s
  // depending on how the org happens to name its repositories; budgeting by
  // characters means it always fits.
  const fixedLength =
    [...prologue, ...epilogue].reduce(
      (total, line) => total + line.length + 1,
      0,
    ) + REMAINDER_LINE_RESERVE;
  let remaining = MAX_BODY_CHARACTERS - fixedLength;
  const repositoryLines = [];
  let rendered = 0;
  for (const name of repositoryNames.slice(0, MAX_RENDERED_REPOSITORIES)) {
    const line = renderRepositoryLine(name);
    if (line.length + 1 > remaining) break;
    remaining -= line.length + 1;
    repositoryLines.push(line);
    rendered += 1;
  }
  const hiddenRepositories =
    repositoryNames.length - rendered + untrackedRepositories;
  if (hiddenRepositories > 0) {
    repositoryLines.push(`| _+${hiddenRepositories} more repositories_ | | |`);
  }

  const body = [...prologue, ...repositoryLines, ...epilogue].join("\n");
  if (body.length <= MAX_BODY_CHARACTERS) return body;

  // The budget above bounds the TABLE; this bounds the BODY. They differ only
  // when the prologue alone is already over the limit, which no organic input
  // produces — every field it renders is validated and bounded. It is reachable
  // by hand-editing the state block in the issue, and the consequence of
  // getting it wrong is the worst failure this module has: an over-limit body
  // is rejected on every future update, and because the poison lives in the
  // durable store it never clears itself. A last-resort minimal body keeps the
  // watchdog writable, and says why it is wearing one.
  return [
    SELECTOR_MARKER,
    renderStateBlock(emptyState()),
    "",
    "## Claude lane infrastructure incident",
    "",
    "The rendered report exceeded GitHub's issue-body limit and the persisted",
    "state has been reset so this issue stays writable. That state is recovered",
    "from this body, so it was almost certainly hand-edited; the next polling",
    "cycle repopulates it from live data.",
  ].join("\n");
}

module.exports = Object.freeze({
  API_ERROR_STATUS_PATTERN,
  CLASS_TOKEN_PATTERN,
  CLEAN_CYCLES_TO_CLOSE,
  ESCALATING_CLASSES,
  LANE_CHECK_RUN_JOB_IDS,
  RECOGNIZED_CLASSES,
  SELECTOR_MARKER,
  STATE_SCHEMA_VERSION,
  classifyCycle,
  coverageGap,
  describeCoverageGap,
  extractSignals,
  isLaneCheckRun,
  nextState,
  parseStateBlock,
  renderIssueBody,
  renderStateBlock,
  tallyObservations,
});
