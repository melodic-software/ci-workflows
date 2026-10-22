# Lane-outcome record

The lane-outcome record is the public contract for how a Claude lane reports
the outcome of one credential attempt. ci-workflows owns it. Readers outside
this repository, such as claude-code-account-rotation's limit-stop check, build
to this page and to the JSON Schema
[`schemas/lane-outcome.v1.schema.json`](../schemas/lane-outcome.v1.schema.json).

Every lane workflow emits one record per credential attempt. A key-to-subscription
handoff writes two records: the key leg's, with `handoff: true`, and the
subscription leg's. The emitter is
[`report-lane-outcome`](../.github/actions/report-lane-outcome/action.yml).

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
error, except that a failure record with `handoff: true` is a notice. The
`incomplete` and `skipped-validation` records keep their levels whatever
`handoff` says.

A record is at most 1,024 characters. The runner cuts a workflow-command
annotation message at 4,096 characters
([actions/runner `ExecutionContext.cs`](https://github.com/actions/runner/blob/main/src/Runner.Worker/ExecutionContext.cs)).
The record comes before the free text, and the legacy sentence before it is
short, so the cut does not reach the record. The one exception is the
sentence's `models=` token, which has no length cap yet; a later change caps
it. An emitter whose record would pass 1,024 characters drops `models` from
the record.

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
| `class` | when `outcome` is not `success` | string; an open set | the classifier, or `known-failure-class` |
| `credential.secret` | yes | string, the secret name the caller mapped, never a slot name | `credential` input |
| `credential.kind` | yes | `oauth-token` or `api-key` | the secret's suffix: `_CLAUDE_API_KEY` is `api-key`; `CLAUDE_CODE_OAUTH_TOKEN`, alone or as a suffix, is `oauth-token` |
| `credential.role` | no | the `<ROLE>` prefix | `<ROLE>_CLAUDE_API_KEY` or `<ROLE>_CLAUDE_CODE_OAUTH_TOKEN` |
| `handoff` | no | boolean; true on a key leg's record when this attempt handed off to another credential | `handoff` input |
| `fallback.reason` | no | `credit-stop`, `auth` or `no-key` | `fallback-reason` input, on the fallback leg's record |
| `resets.at`, `resets.window` | no | ISO 8601 UTC time; string | the newest rejected `rate_limit_event`, on `rate-limit` only |
| `error.type`, `error.code`, `error.status`, `error.requestId` | no | strings, or null; `status` an integer | type, code and requestId from the API error body in a run with no model output, on a failure; the v1 emitter writes no `status` and omits null values |
| `turns`, `maxTurns` | no | integers | the execution file; `max-turns` input |
| `models` | no | array of strings | the execution file's `modelUsage` keys |

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

## Compatibility

- Fields and `class` values are only added within a major version.
- A reader ignores fields and class values it does not know.
- Removing a field, renaming it, changing its meaning, or adding an `outcome`
  value bumps `v`.
- A reader that meets a `v` it does not know treats the JSON as unreadable and
  uses the legacy tokens.
- Emitters keep writing the legacy `key=value` tokens in the human sentence
  until an org architecture decision retires them.

The check-run summary record claude-code-plugins' activity lanes write
(`lane=... activity=...`) is a separate record. This contract does not change
it.
