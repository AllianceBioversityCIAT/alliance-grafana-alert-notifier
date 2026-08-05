# grafana-alert-lambda

Node 20 / TypeScript ESM Lambda. Receives Grafana Alertmanager webhooks through an API Gateway
HTTP API, queries Loki for recent error lines, optionally normalizes them with Amazon Bedrock
(Nova Micro via the Converse API), and posts to Slack. No web framework — only AWS SDK v3.

Design rationale lives in `docs/bedrock-enrichment-plan.md`; operational docs in `README.md`.

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
`npm run test:slack:preview:local`.

## Request flow (`src/handler.ts`)

The handler dispatches on the JSON body shape:

1. `{"diagnostic":"loki"}` → `testLokiConnection`, returns raw (unsanitized) sample lines.
   Useful for inspecting Docker framing bytes in the JSON response.
2. `{"diagnostic":"slack-preview"}` → builds the Slack message without sending it.
   Note this runs the **full** pipeline, Bedrock inference included.
3. Anything else → Grafana payload.

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
- **The Explore deep link is best-effort.** `buildLokiExploreUrl` returns `null` unless both
  an origin (`GRAFANA_BASE_URL`, or inferred from `generatorURL`) and `LOKI_DATASOURCE_UID`
  are available; the message then simply carries no `Logs:` line. It encodes params with
  `encodeURIComponent`, not `URLSearchParams`, because the latter emits `+` for spaces and
  a `decodeURIComponent` consumer would corrupt the LogQL expression.
- **`occurrences` is not the true error count.** It counts log lines returned by Loki,
  capped at `LOKI_LINE_LIMIT = 10`. The real count from Grafana is `alert.values.B`,
  carried as `errorCount` in the Workflow payload.
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
