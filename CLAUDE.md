# grafana-alert-lambda

Node 20 / TypeScript ESM Lambda. Receives Grafana Alertmanager webhooks through an API Gateway
HTTP API, queries Loki for recent error lines, optionally normalizes them with Amazon Bedrock
(Nova Micro via the Converse API), and posts to Slack. No web framework — only AWS SDK v3.

Design rationale lives in `docs/bedrock-enrichment-plan.md`; operational docs in `README.md`.
`docs/alert-history-plan.md` holds the not-yet-started plan for persisting alerts in DynamoDB and
the weekly recurring-pattern report, plus a backlog of known rough edges.

## Commands

```bash
npm test              # vitest run
npm run test:watch
npm run build          # tsc -> dist/
npm run package        # build + grafana-alert-lambda.zip
npm run deploy:stack   # CloudFormation (infra only)
npm run deploy         # package + upload code to Lambda
npm run deploy:all     # stack + code
```

If `npm` fails with `EPERM: operation not permitted, lstat '.../AppData'`, npm's prefix
resolution is broken on that machine, not the project. Run the tool directly instead:

```bash
node node_modules/vitest/vitest.mjs run
```

Diagnostics without Grafana: `npm run test:loki:local`, `npm run test:loki:lambda`,
`npm run test:slack:preview:local`, `npm run test:history:lambda`,
`npm run test:report:lambda` (dry run; pass `-SendReport` to actually post).

## Request flow (`src/handler.ts`)

The handler dispatches on the JSON body shape:

1. `{"diagnostic":"loki"}` → `testLokiConnection`, returns raw (unsanitized) sample lines.
   Useful for inspecting Docker framing bytes in the JSON response.
2. `{"diagnostic":"slack-preview"}` → builds the Slack message without sending it.
   Note this runs the **full** pipeline, Bedrock inference included.
3. `{"diagnostic":"history","days":7}` → reads the stored alerts of the last N days
   (default 7) grouped by signature, most frequent first. Answers 200 with
   `enabled:false` when `HISTORY_ENABLED` is off, without querying DynamoDB.
4. `{"report":"weekly"}` → builds and posts the weekly report. Checked **first**, so a
   scheduled invocation can never fall through to the alert path.
5. `{"diagnostic":"report"}` → same report, returned without posting. `dryRun` defaults
   to true; only an explicit `dryRun:false` sends.
6. Anything else → Grafana payload.

The handler accepts both the API Gateway shape (payload as a JSON string in `event.body`)
and a direct invocation, where the payload **is** the event — that is how EventBridge
Scheduler calls it. `normalizeEventPayload` reconciles the two. An event carrying
`requestContext` but no body is still a malformed webhook, not a direct invocation, and
still answers 400.

Grafana path: `parseGrafanaAlert` → `deduplicateAlerts` → per alert `previewSlackMessage`
(Loki query → sanitize → redact → group stack traces → semantic dedupe → Bedrock) →
`buildSlackWebhookPayload` → `sendSlackMessage`.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/config/get-config.ts` | Reads and validates the Secrets Manager JSON; module-level cache |
| `src/secrets/get-secret.ts` | Secrets Manager access, required-key validation |
| `src/grafana/` | Payload types, parsing, alert deduplication |
| `src/loki/` | LogQL construction, `query_range` client, connection diagnostic |
| `src/utils/` | Sanitizing, redaction, dedupe, preprocessing, metadata extraction, time window |
| `src/bedrock/` | Converse client, analyzer orchestration, prompts, response validation |
| `src/history/` | Error signature, DynamoDB client, alert-history store and aggregation |
| `src/report/` | ISO week window, weekly aggregation, report orchestration and message |
| `src/slack/` | Message construction (legacy + enriched), webhook shape selection, sending |
| `src/types/` | `LokiLogEntry`, `PreprocessedLogEvent`, `BedrockNormalizedEvent` |

## Invariants

Break these and you break production behavior or security:

- **Configuration comes only from Secrets Manager.** The single Lambda env var is
  `ALERTING_SECRET_NAME`. Never hardcode model IDs, regions, thresholds, timezones, or
  date formats in application code, and never add them as Lambda env vars.
- **A Bedrock failure must never block Slack delivery.** Every failure path falls back to
  the legacy message whenever Loki lines are available. The weekly report holds the same
  line: the numbers are computed in code and Bedrock only writes the paragraph above them,
  over aggregates and never over log text. `narrateSafely` in the handler exists because
  one rejected promise inside `Promise.all` would abort *every* application's message.
- **Never log secrets or webhook URLs.** `src/utils/diagnostic-log.ts` logs a host and a
  `slackConfigured` boolean, never the URL. Redaction happens before logs reach Bedrock.
- **A DynamoDB failure must never affect Slack delivery.** The history write is the last
  thing `processAlert` does, after the send, and it cannot throw: `recordAlertEvent`
  swallows its own errors and `recordSafely` wraps the assembly too. Errors go only to
  CloudWatch and the webhook still returns 200. The write was added *additively* — no
  existing Loki or Slack line was rewritten — precisely so this stays easy to verify.
- **`resolved` alerts are ignored** — respond 200 without querying Loki or Slack.
- **Loki or Slack failures still return 200.** Errors go to CloudWatch; the webhook never
  reports failure back to Grafana.
- **ESM with `nodejs20.x`:** relative imports must carry the `.js` extension, including
  from `.ts` files.

## Gotchas worth knowing

- **Loki returns newest-first.** `queryLokiErrors` sorts descending because
  `direction=BACKWARD`. `preprocessLogs` re-sorts ascending before grouping, since index
  order drives first/last occurrence, stack-trace grouping, and which line represents a
  group. A previous bug inverted first/last occurrence in every alert because the test
  fixture fed entries in ascending order — an order production never produces. **Test
  fixtures must preserve production ordering.**
- **The weekly report schedule ships disarmed.** `ReportScheduleState` defaults to
  `DISABLED` so the stack can be deployed long before the data exists to report on. Arm it
  with `-ReportScheduleState ENABLED` once `{"diagnostic":"report"}` shows the grouping is
  right. It is an `AWS::Scheduler::Schedule`, not an `AWS::Events::Rule`, because only
  Scheduler is timezone-aware — a Rule is UTC-only and "Monday 8am Bogotá" would drift with
  daylight saving. Scheduler assumes a role instead of using the function's resource
  policy, so it needs no `AWS::Lambda::Permission`.
- **`LambdaTimeout` is shared by both paths and defaults to 120s.** The report fans
  DynamoDB queries across several weeks and then calls Bedrock, so it must exceed
  `REPORT_BEDROCK_TIMEOUT_MS` with margin. Raising it costs nothing — a Lambda is billed
  for time used, not for the ceiling. Note the report diagnostic over **HTTP** is still
  bounded by API Gateway's 29s integration limit; `npm run test:report:lambda` passes
  `-UseLambdaInvoke` and bypasses it.
- **The config cache has no TTL, by design.** Cost of per-invocation Secrets Manager calls
  is not worth it. Consequence: secret changes — including the `BEDROCK_ENABLED=false` kill
  switch — only take effect on new containers. Recycle with `npm run deploy` or any
  `aws lambda update-function-configuration` call. Do not add a TTL.
- **The weekly report needs an incoming webhook, not a Workflow trigger.** It posts
  mrkdwn in `{text}`, which only an incoming webhook understands; a Workflow trigger
  expects the alert-shaped variables declared on that trigger. When
  `SLACK_REPORT_WEBHOOK_URL` is unset the report falls back to `SLACK_WEBHOOK_URL`, so if
  *that* is a Workflow URL the handler answers 409 instead of publishing an empty message.
  To land the report in the same channel as the alerts, create a plain incoming webhook
  pointing at that channel — Slack allows both to post to one channel. The
  `{"diagnostic":"report"}` preview reports `webhookUsable` so this surfaces before a
  scheduled run finds it.
- **Two Slack payload shapes.** A webhook URL containing `/triggers/` gets a flat Workflow
  payload (`alertname`, `job`, `latestErrors`, `message`, `logsUrl`, …); anything else gets
  `{text}`. In the Workflow shape, raw log lines travel in `latestErrors` separately from
  `message`, which is built with `omitLogLines: true` so the block never prints twice — a
  previous bug rendered the identical list in both fields. The `{text}` shape has no second
  field, so there the lines stay inside the message.
- **Loki's nanosecond timestamp outranks the one inside the log line.** Containers log in
  UTC and Nest prints a bare wall clock with no zone, so that text cannot be converted to
  `LOG_TIMEZONE` — only reprinted, which showed readers 7:01 PM when their clock said 2:01
  PM. `preprocessLogs` therefore formats `timestampNs` first and falls back to
  `extractTimestampFromLogLine` only when no timezone is configured (Bedrock disabled).
  Do not restore the old precedence. Fixtures must keep `timestampNs` consistent with the
  clock embedded in the line, or they hide which source is being displayed.
- **The Explore deep link is best-effort.** `buildLokiExploreUrl` returns `null` unless both
  an origin (`GRAFANA_BASE_URL`, or inferred from `generatorURL`) and `LOKI_DATASOURCE_UID`
  are available; the message then simply carries no `Logs:` line. It encodes params with
  `encodeURIComponent`, not `URLSearchParams`, because the latter emits `+` for spaces and
  a `decodeURIComponent` consumer would corrupt the LogQL expression.
- **Grafana's own links are re-homed onto `GRAFANA_BASE_URL`.** Grafana derives
  `generatorURL` and `panelURL` from its `root_url`, which behind a reverse proxy is the
  internal address (`http://host:3000/...`) while developers browse `https://host/...`.
  `processAlert` runs `applyGrafanaBaseUrl` before anything reads the alert, so every URL
  in the message shares one origin. Path, query and fragment are preserved, a configured
  sub-path is kept, and with no `GRAFANA_BASE_URL` set the URLs pass through untouched.
- **`occurrences` is not the true error count.** It counts log lines returned by Loki,
  capped at `LOKI_LINE_LIMIT = 10`. The real count from Grafana is `alert.values.B`,
  carried as `errorCount` in the Workflow payload.
- **The signature is computed from the log line alone — never from the Bedrock analysis.**
  An earlier version folded in `modulo` and `tipoError`, and production showed why that
  fails: Bedrock failed to parse its own response on roughly one alert in six, those fields
  came back null, and the *same* line produced a second signature that split the pattern and
  broke its streak. A signature that depends on a model answering is not a signature. Nothing
  is lost — the line already carries `[Module]` and the exception class, and both fields stay
  on the item for the report to name the pattern with.
- **The history signature is not `normalizeMessageKey`.** `src/history/error-signature.ts`
  builds on it but substitutes identifiers (UUIDs, quoted numbers, `id/code: N`, bracketed
  indices, `attempt N/M`, container hashes, IPs) so the same defect matches across weeks.
  `normalizeMessageKey` is left alone because it drives the visible `(xN)` grouping in
  Slack. The bias is to **under-normalize**: bare numbers survive, so `status code 500`
  and `status code 404` stay distinct problems. Merging two real problems into one report
  line makes both invisible; the inverse error is merely noisy.
- **The DynamoDB SDK is imported lazily**, inside `recordAlertEvent`/`queryAlertHistory`.
  With the kill switch off — the default — it never enters the cold start, and tests that
  inject `put`/`query` never load it.
- **`application`/`environment` are derived on every outcome, not just `notified`.** The
  skipped paths never reach `preprocessLogs`, so `buildAlertHistoryItem` falls back to
  `extractApplicationMetadata` over the alert name and job — the same two strings
  `preprocessLogs` feeds it. Without that fallback every skipped record stored nulls and
  the weekly report would drop them into an "unknown application" bucket.
- **`queryHistoryDay` must paginate.** DynamoDB caps a Query response at 1 MB; a single
  page would silently truncate a busy day. For a feature whose purpose is counting,
  undercounting with no error is the worst failure mode — do not remove the
  `LastEvaluatedKey` loop.
- **Report weeks are local; partitions are UTC.** `pk` is the UTC date of `recordedAt`,
  but a week is Monday-to-Sunday in `LOG_TIMEZONE`, so an offset week touches *eight* UTC
  partitions. `getReportWeek` returns the exact partition set the window spans plus the
  window's absolute bounds; callers must then `filterToWindow`, because the edge
  partitions also hold the neighbouring weeks' items. Every date computation stays on
  absolute instants — `Intl` is used to read a zone offset, never to do arithmetic.
- **`occurrences` is not the error count, and the report must not present it as one.**
  It is capped at `LOKI_LINE_LIMIT` per alert and is `0` on skipped alerts. Grafana's
  `errorCount` is the real number. `report-aggregator.ts` sums both and labels them apart.
- **Alerts dedupe by `alertname + job`**, deliberately ignoring `filename`: Grafana emits
  one series per Docker container, which produced duplicate Slack posts.
- **Application and environment are declared in the Grafana rule name**, not derived from
  the job. `extractApplicationMetadata` intentionally prefers `alertname` over `job`; the
  convention is `<App> <Env> - Loki Error Alert`. `parseAlertName` only attempts extraction
  when the name contains `Alert` or ends in an environment token, and the environment must
  be the last word before the suffix. Accepted risk: a rule cloned from test to prod
  without renaming reports the wrong environment.

## Testing conventions

`vitest`, specs in `test/`, one spec per module. No real AWS, Loki, or Slack calls — inject
mocks (`analyzeLogsWithBedrock` accepts a `converse` override; `getSecretJson` and `fetch`
are mocked). Fixtures are synthetic: never commit real tokens, webhook URLs, or hostnames.
Call `resetConfigCache()` when a test depends on config loading.
