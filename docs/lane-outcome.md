# Lane-outcome record

The lane-outcome record is the public contract for how a Claude lane reports
the outcome of one credential attempt, and the one lane record for every lane,
the claude-code-plugins hub lanes included. ci-workflows owns it. Readers outside
this repository, such as claude-code-account-rotation's limit-stop check, build
to this page and to the JSON Schema
[`schemas/lane-outcome.v1.schema.json`](../schemas/lane-outcome.v1.schema.json).

Every lane workflow emits one record per credential attempt. Each handoff
adds one: the attempt that handed off writes its record with
`handoff: true`, and the next attempt writes its own. The next attempt's record is written only when its credential is named
(for the review lanes, `fallback-credential-name` set); otherwise that attempt
writes the legacy tokens and a warning. Intake's key leg hands off to the
subscription leg on a credit stop or a rejected key; a review lane's first
token hands off to its fallback token at a usage limit. On the run-claude-cli
lanes, a subscription leg hands off to the fallback leg, on the org secret
`FALLBACK_CLAUDE_CODE_OAUTH_TOKEN`, at a usage limit, a credit stop or a
rejected token, when the caller passes that secret. The emitter is
[`report-lane-outcome`](../.github/actions/report-lane-outcome/action.yml).

## Public safety

Every record, and every annotation, step summary, artifact or comment that
carries one, is public: the repositories that run lanes are public. An
emitter MUST write only values from a closed enum, a fixed-shape pattern in
the schema, or a count. In particular:

- `credential.secret` and `credential.role` MUST be secret NAMES. A secret's
  value, any part or prefix of it (`sk-ant-`), or any other credential-shaped
  string MUST NOT appear. The schema admits only a Claude credential's secret
  name (`<ROLE>_CLAUDE_API_KEY` or `[<ROLE>_]CLAUDE_CODE_OAUTH_TOKEN`).
- An email address, hostname, machine path, runner name or user name MUST NOT
  appear in any field.
- A class, fallback reason or outcome MUST be one of its enum values. Free
  text, model output and raw error text MUST NOT fill an enum field; an
  emitter maps a value it cannot place to `other` or leaves the field out.
- A field whose source is absent or out of shape is left out, never guessed.

A reader MAY treat a record that breaks this rule as unreadable.

## Format

The record is in a check-run annotation message:

1. One short human sentence. It carries the legacy `key=value` tokens
   (`class=`, `credential=`, `turns=` and the rest).
2. The marker `lane-outcome` and one space, followed by one JSON
   object ([RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)).
3. Any free text, such as `Last SDK result: ...`.

The record always comes before free text. A reader finds the first marker
anywhere in the message and reads exactly one JSON value after it. A reader
does not depend on newlines, because none are required. A success record is
a notice, a `skipped-validation` record a warning, and any other failure an
error, except that a failure record with `handoff: true` is a notice. A
handoff stays a notice when the caller sets `lane-id` but no record can be
written. The `incomplete` and `skipped-validation` records keep their levels
whatever `handoff` says.

A record is at most 1,024 characters. The runner cuts a workflow-command
annotation message at 4,096 characters
([actions/runner `ExecutionContext.cs`](https://github.com/actions/runner/blob/main/src/Runner.Worker/ExecutionContext.cs)).
The record comes before the free text, and the legacy sentence before it is
short, so the cut does not reach the record. The sentence's `models=` token
and the record's `models` list each name at most 8 models; the run's other
models are left out. An emitter whose record would pass 1,024 characters
drops `models`, then `usage`, then `windows`, then `githubCalls`, until it
fits.

## Examples

A key leg that hit a credit stop and handed off to the subscription leg. A
key leg that hands off writes its own record with `handoff: true`:

```json
{
  "v": 1,
  "lane": "intake-triage",
  "outcome": "failure",
  "class": "credit-stop",
  "credential": { "secret": "AUTOMATIONS_CLAUDE_API_KEY", "kind": "api-key", "role": "AUTOMATIONS" },
  "handoff": true,
  "error": { "type": "billing_error", "requestId": "req_fake0000000000000000" },
  "turns": 1, "maxTurns": 30, "models": ["claude-sonnet-5"]
}
```

The subscription leg after that handoff, whose record carries the fallback
reason, then a review lane under the legacy single token:

```json
{"v":1,"lane":"intake-triage","outcome":"success","credential":{"secret":"AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN","kind":"oauth-token","role":"AUTOMATIONS"},"fallback":{"reason":"credit-stop"},"turns":5,"models":["claude-sonnet-5"]}
{"v":1,"lane":"pr-review","outcome":"failure","class":"rate-limit","credential":{"secret":"CLAUDE_CODE_OAUTH_TOKEN","kind":"oauth-token"},"resets":{"at":"2026-10-22T05:00:00Z","window":"five_hour"}}
```

The fallback leg after the subscription leg hit a usage limit. The secret's
`FALLBACK` prefix reads as its role:

```json
{"v":1,"lane":"intake-triage","outcome":"success","credential":{"secret":"FALLBACK_CLAUDE_CODE_OAUTH_TOKEN","kind":"oauth-token","role":"FALLBACK"},"fallback":{"reason":"limit-stop"},"turns":4,"models":["claude-sonnet-5"]}
```

A whole annotation message, with the record between the sentence and the free
text:

```text
AI review skipped: usage limit reached; re-run after it resets (Claude review exited with: failure class=rate-limit resets=2026-10-22T05:00:00Z resets-window=five_hour credential=CLAUDE_CODE_OAUTH_TOKEN). lane-outcome {"v":1,"lane":"pr-review","outcome":"failure","class":"rate-limit","credential":{"secret":"CLAUDE_CODE_OAUTH_TOKEN","kind":"oauth-token"},"resets":{"at":"2026-10-22T05:00:00Z","window":"five_hour"}} Last SDK result: {...}
```

## Fields

Each field's pattern and numeric limit is in the
[schema](../schemas/lane-outcome.v1.schema.json); this table names the fields,
their closed values and where `report-lane-outcome` takes them from.

| Field | Required | Type and values | Source in `report-lane-outcome` |
|---|---|---|---|
| `v` | yes | integer; `1` | constant |
| `lane` | yes | string, stable per lane workflow | `lane-id` input |
| `outcome` | yes | `success`, `failure`, `timeout`, `skip`, `cancellation` or `error`, the OpenTelemetry CICD `cicd.pipeline.task.run.result` values | see [Outcome](#outcome) |
| `class` | when `outcome` is not `success` | one value from [Failure classes](#failure-classes) | the classifier, or `known-failure-class`; a caller class outside the enum is `other` |
| `credential.secret` | yes | string, the secret name the caller mapped, never a slot name or a value; a Claude credential's name only (see [Public safety](#public-safety)) | `credential` input |
| `credential.kind` | yes | `oauth-token` or `api-key` | the secret's suffix: `_CLAUDE_API_KEY` is `api-key`; `CLAUDE_CODE_OAUTH_TOKEN`, alone or as a suffix, is `oauth-token` |
| `credential.role` | no | the `<ROLE>` prefix | `<ROLE>_CLAUDE_API_KEY` or `<ROLE>_CLAUDE_CODE_OAUTH_TOKEN` |
| `handoff` | no | boolean; true when this attempt handed off to another credential | `handoff` input |
| `fallback.reason` | no | `credit-stop`, `auth`, `no-key` or `limit-stop` | `fallback-reason` input, on the record of the leg that ran after a handoff; `limit-stop` only on the fallback leg's |
| `resets.at`, `resets.window` | no | ISO 8601 UTC time; string | the newest rejected `rate_limit_event`, on `rate-limit` only |
| `error.type`, `error.code`, `error.status`, `error.requestId` | no | strings, or null; `status` an integer | type, code and requestId from the API error body in a run with no model output, on a failure; the v1 emitter writes no `status` and omits null values |
| `turns`, `maxTurns` | no | integers | the execution file; `max-turns` input |
| `durationMs` | no | integer, at least 0; the leg's run time in milliseconds | the execution file's result message `duration_ms`, the CLI's own measure |
| `runId`, `runAttempt` | no | integers, at least 1 | `github.run_id`, `github.run_attempt` |
| `traceId` | no | 32 lower-case hex digits, the W3C trace-context `trace-id` shape | see [Run context](#run-context); needs `runId` and `runAttempt` |
| `spanId` | no | 16 lower-case hex digits, the W3C trace-context `parent-id` shape | see [Run context](#run-context); needs `traceId` and `github.job` |
| `githubCalls.githubToken`, `githubCalls.lanesApp` | no | object per token: `requests`, `graphql`, `notModified`, integers at least 0 | the job's api-budget readings for `github-token` and `lanes-app`; see [Run context](#run-context) |
| `costUsd` | no | number, at least 0; US dollars at list price, never what was billed | the execution file's result message `total_cost_usd`, the CLI's own estimate, on every outcome |
| `models` | no | array of strings, at most 8 | the execution file's `modelUsage` keys |
| `usage.input`, `usage.output`, `usage.cacheRead`, `usage.cacheCreation` | no | integers, at least 0; the leg's input, output, cache-read and cache-creation tokens | the `log-file` input, run-claude-cli's credential-scanned log; never the execution file |
| `windows.<window>` | no | object per subscription window: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` or `overage` | the `log-file` input, from the leg's `rate_limit_event` messages |
| `windows.<window>.utilization` | no | number from 0 to 1, rounded to 2 decimals; the highest fraction used during the leg, absent when no event gave one | as above |
| `windows.<window>.resetsAt`, `windows.<window>.status` | `status` yes | ISO 8601 UTC time; `allowed`, `allowed_warning` or `rejected`, from the window's newest event | as above |

The schema allows unknown properties at every level
(`additionalProperties: true`).

## Outcome

| `outcome` input | Class | Record `outcome` |
|---|---|---|
| `success` | none | `success` |
| `success` | `skipped-validation` | `skip` |
| `success` | `incomplete` | `failure` |
| `cancelled` | any | `cancellation` |
| `skipped` | any | `skip` |
| `failure` or anything else | `timeout` | `timeout` |
| `failure` or anything else | any other | `failure` |

`error` is reserved; v1 maps nothing to it.

## Failure classes

`class` is one closed enum. The schema lists it, and `FAILURE_CLASSES` in
[`classify.cjs`](../.github/actions/report-lane-outcome/classify.cjs) is the
emitter's copy; a test holds the two equal.

| Class | Meaning |
|---|---|
| `auth` | the API refused the credential (401, 402 or 403): unusable until a human acts |
| `credit-stop` | an API key's organization is out of credit or at a spend limit; never written as `rate-limit` |
| `rate-limit` | a subscription usage limit (429) |
| `overloaded` | an API 5xx, `api_error`, `timeout_error` or `overloaded_error` |
| `max-turns` | the run used its turn cap |
| `timeout` | the step or leg ran its whole time budget |
| `install-failed` | the CLI install failed, so Claude never started |
| `no-execution` | the step ended before writing an execution file |
| `sandbox-unavailable` | the subprocess sandbox probe kept the run from starting |
| `skipped-validation` | the action skipped itself on its workflow-validation check |
| `incomplete` | the run succeeded but the lane's completion check found no completed review |
| `no-credential` | the leg had no credential to run with |
| `no-outcome` | the leg stopped before its outcome step |
| `other` | anything else, and any caller class outside this enum |

## Run context

`runId` and `runAttempt` are the workflow run's. `traceId` is the first 32 hex
digits of SHA-256 over `lane-outcome:<runId>:<runAttempt>`, so every record
of one run attempt shares it and a reader can compute it from the run alone.
`spanId` is the first 16 hex digits of SHA-256 over
`<traceId>:<github.job>:<lane>:<credential.secret>`; two matrix legs of one
job with the same lane and credential share it. Each is left out when an
input it needs is absent or out of shape.

`githubCalls` counts the job's own GitHub API requests made before the
report step, from the readings
[`report-api-budget`](../.github/actions/report-api-budget/action.yml) and its
`api-budget.cjs` leave in `$RUNNER_TEMP/api-budget/<token>`, counted as its
`api-calls` notice counts them: `requests` is responses other than 304,
`notModified` the 304 answers, which GitHub does not count against the
limit, and `graphql` the GraphQL requests among `requests`. Only the
`github-token` (the job's `GITHUB_TOKEN`) and `lanes-app` token files are
read; a token with no file is left out. Calls after the report step, and calls
no reading recorded, are not counted.

## Usage warning

run-claude-cli writes one `::warning::` annotation per leg when any window's
status is `allowed_warning` or `rejected`, or its utilization is 0.70 or more.
It names the leg's secret (never its value) and, for each such window, the
window, utilization, status and reset time, for example:

```text
AUTOMATIONS_CLAUDE_CODE_OAUTH_TOKEN is near a subscription usage limit: window=five_hour utilization=0.82 status=allowed_warning resets=2026-10-22T05:00:00Z
```

The window fields follow the Agent SDK's
[`RateLimitInfo`](https://code.claude.com/docs/en/agent-sdk/python.md);
each is read in camelCase (`rateLimitType`, `resetsAt`) or snake_case
(`rate_limit_type`, `resets_at`).

## Limit classes

`rate-limit` (a subscription usage limit) and `credit-stop` (an API key's
organization out of credit or at a spend limit) are the limit classes. A
reader that warns about limit stops counts both.

## Emitter rule

`report-lane-outcome` writes the record only when `lane-id` matches its
pattern and `credential` matches its pattern and maps to a kind. Otherwise it
writes the legacy tokens alone. When `lane-id` is set, it also writes a
warning naming what is missing; with `lane-id` empty it writes no warning,
whether or not `credential` is set.

The action also sets its `record` output to the same JSON object it wrote
after the marker, without the marker, and leaves it empty when it wrote no
record. A caller passes it on to a reader that cannot read annotations, such
as a check run the caller posts itself.

## Compatibility

- Fields and `class` values are only added within a major version.
- A reader ignores fields and class values it does not know.
- Removing a field, renaming it, changing its meaning, or adding an `outcome`
  value bumps `v`.
- A reader that meets a `v` it does not know treats the JSON as unreadable and
  uses the legacy tokens.
- Emitters keep writing the legacy `key=value` tokens in the human sentence
  until an org architecture decision retires them.

The run-context fields, `durationMs` and the closed `class` enum are additive
under these rules, so the record stays `v: 1`. Records written before them
still validate: the classifier and every `known-failure-class` its callers
pass produce only enum values, and the emitter wrote a record only for a
secret name that maps to a kind, which is what `credential.secret` now
admits. A reader still ignores a class it does not know, since a later v1 may
add one.

## Retiring the other failure-class spellings

The same failure class is written in several places under different names.
Each maps to the record's `class` with no change of value, except where noted.
They are retired over a deprecation window; none changes in the slice that
adds this section.

| Spelling | Where | Plan |
|---|---|---|
| `class=<token>` | the legacy sentence before the record | kept until the org decision above; readers move to `class` |
| `failure-class` output, `failure_class` step output | `report-lane-outcome` | kept as the action's interface; readers of annotations read `class` |
| `failure-class=` | hub annotation and log text | readers move to `class` |
| hub `CLASSES` and `lane=... activity=... class=` summary line | claude-code-plugins `.github/actions/report-check-run/lane-record.mjs` | replaced by this record on the hub lanes; its set lacks `credit-stop` |
| `known-failure-class` mapped from `credit-stop` to `rate-limit` | hub lane workflows | pass `credit-stop` through, so the record says `credit-stop` |
| `outcome=` | the hub work-resolve-issue lane | replaced by this record |

The window closes when no reader in the org reads a retired spelling; the
claude-code-plugins decision record for one public-safe lane record sets the
order.
