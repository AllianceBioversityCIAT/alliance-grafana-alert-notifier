# Plan: alert history in DynamoDB and weekly pattern report

Pre-implementation design document. Describes what will be built, what will not change, and how it will be validated.

**Status:** phase 1 implemented on 2026-08-11, not yet deployed. Phase 2 remains deliberately
deferred until real data exists.

**Date:** 2026-08-05 (plan), 2026-08-11 (phase 1 implementation)

### Where the implementation departs from this document

Verified against the code before building; five points had drifted, and one design decision was
changed by the user.

1. **§2.2 field names.** `module`, `errorType`, `summary`, `user` do not exist.
   `BedrockNormalizedEvent` uses Spanish: `modulo`, `tipoError`, `caso`, `usuario`. There is no
   `summary` — `caso` is the closest. The stored item uses the real names.
2. **§2.3 is now additive, not a restructure.** The record is *not* assembled across the function
   and written once at the end. Three `recordSafely(...)` calls were inserted before the existing
   exit points instead, so no existing Loki or Slack line was rewritten. The criterion was to
   leave the working notification flow untouched.
3. **§2.1 normalization.** `normalizeMessageKey` strips only the `[Nest] <pid>` prefix, not PIDs
   generally. A rule the table omits proved **required**: bracketed bare numbers (`[15]`, `[28]`)
   must collapse, or the motivating `ClarisaTaskService` pair would not share a signature.
   Conversely the `code` substitution demands an explicit `:` or `=` separator, otherwise
   `status code 500` would collapse into `status code 404` — the exact merge §2.1 forbids.
4. **§2.4 also touches** the `AlertingSecret` type and `parseBoolean`, whose error message had
   `BEDROCK_ENABLED` hardcoded.
5. **§2.6** additionally required widening the `ValidateSet` in `scripts/test-loki-lambda.ps1`.
6. **§2.5's fixed `grafana-alert-history` default was wrong.** DynamoDB table names are unique
   per account and region, and this project deploys several stacks into one region
   (`grafana-alert-lambda` for test, `grafana-alert-lambda-prod` for prod). A shared default
   would have made the second stack fail to create. `HistoryTableName` now defaults to empty
   and the template derives `grafana-alert-history-<environment>`, matching the convention
   already used for the `Project` tag. An explicit value still overrides it.

`alert.errorCount` is optional, so the stored attribute is nullable. The DynamoDB SDK is imported
lazily, so the disabled default never pays for it at cold start.

---

## 1. Objective

The Lambda is memoryless today: it processes an alert, posts to Slack, and forgets the event
happened. It can only answer *"what is failing right now?"* — never *"what fails every week?"*,
which is the question that prioritizes engineering work.

The investigation on 2026-08-05 made the gap concrete. `ClarisaTaskService` emitted
`QueryFailedError: Field 'name' doesn't have a default value` about twenty times inside a single
second, and it had most likely been happening for weeks. Nobody could tell, because every alert is
read as an isolated event.

**Phase 1 goal:** persist every processed alert in DynamoDB with a *normalized signature* that
lets the same underlying error be recognized across different weeks. Nothing else.

**Phase 2 goal:** a weekly Slack report built on that history, answering one question —
which error patterns are recurring and which are new.

### Decisions already settled

| Decision | Rationale |
| --- | --- |
| The report is a **Slack mrkdwn message**, not an attached `.md` | Slack incoming and Workflow webhooks cannot upload files. A real attachment needs a bot token with `files:write`, a credential the project does not have and would have to guard. |
| The only pattern of interest is **recurring vs new** | Keeps the aggregation honest and makes the signature the one component that matters. |
| **Persistence ships first** | The aggregation cannot be validated against an empty table. Designing the analysis blind risks rewriting it once real data arrives. |

---

## 2. Phase 1 — Persistence

### 2.1 The normalized signature

Recurrence detection is only as good as the signature. These two lines are the same defect and
must produce the same signature:

```
ERROR [ClarisaTaskService] [15] Error saving item with id/code: 39
ERROR [ClarisaTaskService] [28] Error saving item with id/code: 6259
```

New module `src/history/error-signature.ts`:

```ts
buildErrorSignature({ module, errorType, representativeLine })
  → { signature: string; signatureText: string }
```

It starts from `normalizeMessageKey` (`src/utils/log-deduplicator.ts`), which already strips
timestamps and PIDs, then substitutes identifiers:

| Pattern | Replacement |
| --- | --- |
| UUID | `<UUID>` |
| Quoted numbers (`'6259'`) | `'<ID>'` |
| Numbers following `id`, `code`, `id/code`, `#`, `key` | `<ID>` |
| `attempt 1/3` | `attempt <N>/<N>` |
| Container hash in `/var/lib/docker/containers/…` | `<CONTAINER>` |
| IP addresses | `<IP>` |

`signatureText` is the readable normalized text, so the report can *name* a pattern.
`signature` is a sha256 truncated to 16 hex characters, for cheap stable equality. Uses
`node:crypto` — no new dependency.

**Deliberate bias: under-normalize rather than over-normalize.** Bare numbers are left alone, so
`status code 500` and `status code 404` stay distinct patterns — correct, they are distinct
problems. The cost is occasionally seeing two signatures where there was one cause. That error is
preferable to its inverse: merging two real problems into one report line makes both invisible.

**`normalizeMessageKey` is not modified.** It currently drives the visible grouping in Slack (the
`(x4)` counters); changing it would change the message. The stronger normalization lives separately
and only feeds storage.

### 2.2 What gets stored

One item per processed alert, written after secret redaction — `redactSecrets` already runs inside
`preprocessLogs`, so `representativeLogs` arrives clean.

| Attribute | Source |
| --- | --- |
| `pk` | `DAY#<yyyy-mm-dd>` (UTC date) |
| `sk` | `<recordedAtIso>#<random suffix>` |
| `signature`, `signatureText` | `buildErrorSignature` |
| `alertname`, `job`, `filename` | `ParsedGrafanaAlert` |
| `application`, `environment` | `preprocessed` (deterministic, from the rule name) |
| `module`, `errorType`, `summary`, `user` | Bedrock `analysis` (nullable) |
| `occurrences`, `errorCount` | `preprocessed.occurrences` and `alert.errorCount` |
| `firstOccurrenceNs`, `lastOccurrenceNs` | absolute instants, never display text |
| `representativeLogs` | truncated to ~2000 chars |
| `outcome` | `notified` \| `skipped_no_lines` \| `skipped_loki_error` |
| `usedBedrock`, `bedrockFallbackReason` | which path the alert actually took |
| `ttl` | epoch seconds, from `HISTORY_RETENTION_DAYS` |

**Why a per-day partition.** A weekly report is 7 `Query` calls — trivial at this volume — and
"last N days" works for any N, with no partition growing without bound. A per-week bucket would
force a key redesign for any other window.

**Why skipped alerts are stored too.** `processAlert` returns early today when Loki fails or
returns nothing, leaving no trace. Recording those with their `outcome` lets phase 2 report
"N alerts arrived with nothing to show", which is a real signal about pipeline health rather than
noise.

### 2.3 Where the write happens

In `processAlert` (`src/handler.ts`), restructured so the record is assembled on every path and
written once at the end, after the Slack send attempt, capturing `slackDelivered`.

> **New invariant, in the spirit of the Bedrock one:** a DynamoDB failure must never affect Slack
> delivery. The write sits in its own `try/catch`, after the send, and its error goes only to
> CloudWatch. The webhook still returns 200.

New module `src/history/alert-history-store.ts` exposing `recordAlertEvent(...)`, which accepts an
override for the write function — the same pattern `analyzeLogsWithBedrock` uses for `converse`
(`src/bedrock/bedrock-log-analyzer.ts`) — so tests never touch AWS.

### 2.4 Configuration

Secrets Manager only, following the `BEDROCK_SECRET_KEYS_WHEN_ENABLED` pattern in
`src/config/get-config.ts`.

| Key | Notes |
| --- | --- |
| `HISTORY_ENABLED` | Defaults to `false`. Kill switch, like `BEDROCK_ENABLED`. |
| `HISTORY_TABLE_NAME` | Required when enabled. |
| `HISTORY_REGION` | Required when enabled, mirroring `BEDROCK_REGION`. |
| `HISTORY_RETENTION_DAYS` | Required when enabled. Suggested: `90`. |

The config cache has no TTL by design, so these keys only take effect on new containers.

### 2.5 Infrastructure

`infra/cloudformation/template.yaml`:

- `AWS::DynamoDB::Table` with `pk`/`sk` as String, `BillingMode: PAY_PER_REQUEST`,
  `TimeToLiveSpecification` on `ttl`, and the same `Project` tag as every other resource.
- A statement on `LambdaExecutionRole` granting `dynamodb:PutItem` and `dynamodb:Query`, scoped to
  the table ARN. `Query` is needed immediately by the diagnostic in §2.6.
- Parameter `HistoryTableName` (default `grafana-alert-history`) and a matching `Output`.

`scripts/deploy.ps1` — add `HistoryTableName` to `--parameter-overrides` and to the script's
parameters.

`package.json` — add `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` to `dependencies`.
`scripts/package.mjs` already runs `npm install --omit=dev`, so packaging picks them up unchanged.

**Operational note.** The table name ends up in two places: CloudFormation and the secret. That
duplication is an unavoidable consequence of the "configuration comes only from Secrets Manager"
invariant. After deploying a stack, read the `HistoryTableName` output and copy it into *that
environment's* secret — each environment gets its own table, so each secret carries its own
`HISTORY_TABLE_NAME`.

### 2.6 Diagnostic for validating the data

A new branch in the `src/handler.ts` dispatcher, alongside `loki` and `slack-preview`:

```json
{"diagnostic":"history","days":7}
```

Returns the items stored over the last N days, grouped by signature and ordered by frequency.

This is the instrument for deciding — with real data, after two or three weeks — whether the
normalization groups correctly, *before* building the report on top of it. A companion
`test:history:lambda` script follows the existing `test:loki:lambda` pattern.

### 2.7 Tests

`vitest`, one spec per module, no real AWS calls.

| Spec | Covers |
| --- | --- |
| `test/error-signature.spec.ts` | Two `ClarisaTaskService` lines with different ids share a signature; `status code 500` and `404` do **not**; UUIDs and `attempt N/M` collapse. Fixtures come from real samples captured on 2026-08-05. |
| `test/alert-history-store.spec.ts` | Item shape, `ttl` computation, log truncation, and that a write failure surfaces as a handled error rather than a thrown exception. |
| `test/handler-history.spec.ts` | A failed write neither blocks the Slack send nor changes the 200; `HISTORY_ENABLED=false` skips DynamoDB entirely; skipped paths record their `outcome`. |
| `test/get-config-history.spec.ts` | Required-key validation when enabled. |

### 2.8 Verification

1. `npm test` and `npx tsc --noEmit` green.
2. `npm run deploy:stack` creates the table. Copy `HISTORY_TABLE_NAME` into the secret alongside
   `HISTORY_ENABLED=true`, `HISTORY_REGION`, and `HISTORY_RETENTION_DAYS=90`.
3. `npm run deploy` to recycle containers so the config cache picks up the new keys.
4. Trigger a real alert and confirm in CloudWatch that no DynamoDB error appears and that Slack
   still arrives unchanged.
5. `{"diagnostic":"history"}` returns the freshly written item with its signature.
6. **Invariant test:** temporarily point `HISTORY_TABLE_NAME` at a non-existent table and verify
   the alert still reaches Slack with a 200 response, the error appearing only in CloudWatch.

---

## 3. Phase 2 — Weekly report

Deferred until two or three weeks of data exist and the signature has been tuned with §2.6.

EventBridge Scheduler invokes the same Lambda with `{"report":"weekly"}`. This needs one small
change in `handler`: it currently expects an `APIGatewayProxyEventV2` and reads `event.body`, while
a direct invocation delivers the payload as the event itself. Both shapes must be normalized.

Aggregation is **deterministic, in code** — 7+7 `Query` calls for the current and previous week —
grouping by `signature` and classifying each one as *new*, *recurring* with its streak of
consecutive weeks, or *disappeared*. Bedrock only writes the narrative from those aggregates, never
from raw logs, with its own `maxTokens` and timeout distinct from the per-alert path. If Bedrock
fails, the deterministic report is posted: delivery must not depend on the model.

Anticipated keys: `REPORT_ENABLED`, `SLACK_REPORT_WEBHOOK_URL` (optional, falling back to the main
webhook, so the report can live in its own channel), `REPORT_BEDROCK_MAX_TOKENS`,
`REPORT_BEDROCK_TIMEOUT_MS`.

Approved message shape. **Note the corrected date range:** the original example read
`2026-W32 (Jul 28 – Aug 3)`, which is a Tuesday-to-Monday span, not an ISO week. 2026-08-03 is
a Monday, so ISO week 32 of 2026 runs Aug 3 – Aug 9. `src/report/report-window.ts` implements
ISO weeks (Monday-based, with the week-numbering year), so the rendered label differs from the
sketch below by design.

```
📊 Weekly report · PRMS Test
Week 2026-W32 (Aug 3 – Aug 9)

*Summary*
47 alerts · 312 errors · 9 distinct patterns

*Recurring (top 3)*
1. ClarisaTaskService · QueryFailedError
   18 alerts · 5 consecutive weeks ⚠️
2. BilateralAiTextMiningService · ETIMEDOUT
   11 alerts · new this week 🆕
3. System · HttpException
   8 alerts · steady

*Stopped occurring*
· ClarisaApiConnection · AxiosError 500 ✅

<https://…|View logs in Grafana>
```

---

## 4. Out of scope

Identified during the 2026-08-05 investigation. Unrelated to this feature, recorded so they are
not lost.

| # | Item | Notes |
| --- | --- | --- |
| 1 | Residual sanitizer garbage | `requiredb`, `500r`, `).@`, `resultTocResultId.u` leak into every alert. Contained in `src/utils/sanitize-log-line.ts`; four real samples available for tests. |
| 2 | Group causal chains | `attempt 1/3`, `2/3`, `failed after 3 attempts` occupy five lines for a single incident. Can reuse the normalization from `buildErrorSignature`. |
| 3 | Shorten `Filename` | The 64-character container hash serves no reader. |
| 4 | Contact point NoData | Deferred by the user. With a 10-minute query range, NoData is now the healthy state, and each episode produces a 400 from the webhook — the alert instance carries no `job` label, so `parseGrafanaAlert` rejects it. Those delivery errors accumulate on `test_webhook` and could mask a real failure. Fixed either by setting NoData → Normal in Grafana, or by hardening the handler to answer 200 for non-actionable payloads. |
| 5 | Grafana `root_url` | Does not match the public URL. Mitigated for our alerts by `applyGrafanaBaseUrl`, but it affects every outbound link Grafana generates. |
