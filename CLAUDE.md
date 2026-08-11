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
`npm run test:slack:preview:local`, `npm run test:history:lambda`.

## Request flow (`src/handler.ts`)

The handler dispatches on the JSON body shape:

1. `{"diagnostic":"loki"}` → `testLokiConnection`, returns raw (unsanitized) sample lines.
   Useful for inspecting Docker framing bytes in the JSON response.
2. `{"diagnostic":"slack-preview"}` → builds the Slack message without sending it.
   Note this runs the **full** pipeline, Bedrock inference included.
3. `{"diagnostic":"history","days":7}` → reads the stored alerts of the last N days
   (default 7) grouped by signature, most frequent first. Answers 200 with
   `enabled:false` when `HISTORY_ENABLED` is off, without querying DynamoDB.
4. Anything else → Grafana payload.

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
| `src/slack/` | Message construction (legacy + enriched), webhook shape selection, sending |
| `src/types/` | `LokiLogEntry`, `PreprocessedLogEvent`, `BedrockNormalizedEvent` |

## Invariants

Break these and you break production behavior or security:

- **Configuration comes only from Secrets Manager.** The single Lambda env var is
  `ALERTING_SECRET_NAME`. Never hardcode model IDs, regions, thresholds, timezones, or
  date formats in application code, and never add them as Lambda env vars.
- **A Bedrock failure must never block Slack delivery.** Every failure path falls back to
  the legacy message whenever Loki lines are available.
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
- **The config cache has no TTL, by design.** Cost of per-invocation Secrets Manager calls
  is not worth it. Consequence: secret changes — including the `BEDROCK_ENABLED=false` kill
  switch — only take effect on new containers. Recycle with `npm run deploy` or any
  `aws lambda update-function-configuration` call. Do not add a TTL.
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
