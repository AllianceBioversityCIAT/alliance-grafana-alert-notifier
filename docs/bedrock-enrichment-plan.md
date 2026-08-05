# Plan: Grafana alert enrichment with Amazon Bedrock

Pre-implementation design document. Describes what will be built, what will not change, and how it will be validated.

**Status:** implemented. Bedrock settings are loaded only from Secrets Manager (not Lambda env / not hardcoded in app config).

**Date:** 2026-07-21

---

## 1. Objective

Extend the existing Grafana/Loki → Slack alert Lambda so that, in addition to the current flow, logs are intelligently normalized with **Amazon Bedrock** and Slack receives a clearer, structured alert.

Backward compatibility is mandatory: with Bedrock disabled, behavior must match today.

---

## 2. AI model

| Field | Value |
| --- | --- |
| Family | Amazon Nova |
| Model | **Amazon Nova Micro** |
| Model ID | `amazon.nova-micro-v1:0` |
| API | Amazon Bedrock Runtime — **Converse API** |
| SDK | AWS SDK for JavaScript v3 (`@aws-sdk/client-bedrock-runtime`) |
| Validated region | `us-east-1` (N. Virginia) |
| Manual test | Successful `converse` call (2026-07-21): OK response, ~14 tokens, ~383 ms |

The Model ID is **not** hardcoded in application logic: it is configured only in Secrets Manager (`BEDROCK_MODEL_ID`). Lambda env only needs `ALERTING_SECRET_NAME`.

Temperature: `0`. Output limit: configurable (`BEDROCK_MAX_TOKENS`, default `500`).

Credentials: Lambda execution role IAM (no access keys in the repository or environment variables).

---

## 3. Resulting flow

```text
Grafana Alert
    ↓
API Gateway
    ↓
Existing Lambda
    ↓
Query recent errors in Loki
    ↓
Clean, group, and deduplicate (+ secret redaction)
    ↓
Amazon Bedrock (Nova Micro) — only if BEDROCK_ENABLED=true
    ↓
Structured JSON response (validated)
    ↓
Build enriched alert (or fall back to current message)
    ↓
Slack
```

**Primary rule:** a Bedrock failure must never block sending the Slack alert.

---

## 4. Current baseline

Today the flow is:

1. Grafana webhook → API Gateway → Lambda.
2. Config from Secrets Manager (`LOKI_*`, `SLACK_*`, lookback, error pattern).
3. Loki `query_range` query (up to 10 lines).
4. Slack message with metadata + latest error lines.
5. `resolved` alerts: respond `200` and **do not** process (this behavior is kept unless explicitly changed).

Current sanitization: ANSI / Docker framing. There is **no** semantic deduplication, secret redaction, or Bedrock.

---

## 5. What will be implemented

### 5.1 Deterministic preprocessing (before Bedrock)

1. Strip ANSI escape codes and control characters.
2. Ignore empty lines.
3. Separate Grafana metadata from log lines.
4. Remove exact duplicates.
5. Group equivalent messages when only the timestamp changes.
6. Count occurrences; capture first/last occurrence.
7. Keep representative logs (and full stack traces when they belong to the same error).
8. Cap the maximum size sent to Bedrock.
9. Redact secrets (Bearer tokens, API keys, passwords, cookies, Authorization headers, connection strings).
10. Do not mutate the original stored/received content (work on a copy).

Approximate preprocessor output:

```json
{
  "alertName": "PRMS Test - Loki Error Alert",
  "status": "firing",
  "job": "docker_prms_test",
  "application": "PRMS",
  "environment": "test",
  "timezone": "America/Bogota",
  "dateFormat": "MM/DD/YYYY",
  "occurrences": 10,
  "firstOccurrence": "07/09/2026, 9:00:31 PM",
  "lastOccurrence": "07/09/2026, 9:00:46 PM",
  "representativeLogs": [
    "[Nest] 24 - 07/09/2026, 9:00:46 PM ERROR [System] HttpException: Authorization token is required"
  ]
}
```

### 5.2 Deterministic metadata

Before asking Bedrock to interpret logs, use:

- Grafana payload (alertname, status, job, filename, etc.).
- Loki timestamps (the current client drops timestamps; it will be updated to keep them).
- Loki labels when present.
- Documented heuristics for application/environment from alertname/job.

Bedrock is used mainly for unstructured fields (`caso`, `tipoError`, `usuario` when present in the text, etc.).

### 5.3 Bedrock invocation

- Converse API with `amazon.nova-micro-v1:0` (configurable).
- Request structured JSON.
- Validate the response before use.
- On invalid/empty JSON, timeout, throttling, permissions errors, etc. → **fallback** to the current Slack message.
- Do not invent data: fields without evidence → `null`.
- Per-field confidence; below threshold → treat as unidentified in Slack.

Expected fields (minimum):

- `usuario`, `modulo`, `momento`, `caso`
- When evidence exists: `tipoError`, `confianza`, `evidencia`

### 5.4 Enriched Slack message

Approximate format (product copy in English):

```text
🚨 PRMS Test – Error detected

Status: Active
Application: PRMS
Environment: Test
Job: docker_prms_test

Module: System
User: Unidentified
Error type: HttpException

Summary:
The request was rejected because the required authorization token was not provided.

Occurrences: 10
First occurrence: 9:00:31 PM
Last occurrence: 9:00:46 PM
```

Rules:

- `null` → `Unidentified`.
- Confidence below threshold → do not show as a confirmed value.
- `BEDROCK_ENABLED=false` → legacy format unchanged.
- Bedrock failure → legacy format (or preprocess without AI), without blocking Slack.

### 5.5 Modular design

Clear separation (names adapted to `src/`):

```text
src/utils/log-redactor.ts
src/utils/log-deduplicator.ts
src/utils/log-preprocessor.ts
src/utils/metadata-extractor.ts
src/types/normalized-log-event.ts
src/bedrock/bedrock-client.ts
src/bedrock/bedrock-log-analyzer.ts
src/bedrock/structured-output-validator.ts
```

Orchestration stays in the existing flow (`preview-slack-message` / handler) without putting all logic in one file.

---

## 6. Secrets Manager keys (Bedrock)

Bedrock settings live in the same secret as Loki/Slack. Example keys (values belong only in the secret):

| Key | Required when Bedrock enabled |
| --- | --- |
| `BEDROCK_ENABLED` | Yes (`true` / `false`; missing ⇒ disabled) |
| `BEDROCK_MODEL_ID` | Yes |
| `BEDROCK_REGION` | Yes |
| `BEDROCK_MAX_TOKENS` | Yes |
| `BEDROCK_CONFIDENCE_THRESHOLD` | Yes |
| `BEDROCK_TIMEOUT_MS` | Yes |
| `BEDROCK_MAX_INPUT_CHARS` | Yes |
| `LOG_DATE_FORMAT` | Yes |
| `LOG_TIMEZONE` | Yes |

Lambda environment variable:

| Variable | Required |
| --- | --- |
| `ALERTING_SECRET_NAME` | Yes |

---

## 7. Infrastructure and IAM

Primary file: `infra/cloudformation/template.yaml`.

Add to the Lambda execution role (least privilege), for example:

- `bedrock:InvokeModel`
- `bedrock:Converse`

Scope the resource to the model/region when possible, e.g. foundation model `amazon.nova-micro-v1:0` in `us-east-1`.

Possible increase of `LambdaTimeout` / memory for Loki + Bedrock + Slack latency.

---

## 8. Dependencies

- Add: `@aws-sdk/client-bedrock-runtime`
- Keep: `@aws-sdk/client-secrets-manager`

---

## 9. Planned files

### Create

- `src/types/normalized-log-event.ts`
- `src/utils/log-redactor.ts`
- `src/utils/log-deduplicator.ts`
- `src/utils/log-preprocessor.ts`
- `src/utils/metadata-extractor.ts`
- `src/bedrock/*`
- Related unit tests under `test/`

### Modify

- `src/handler.ts` (minimal orchestration)
- `src/slack/preview-slack-message.ts`
- `src/slack/build-slack-message.ts`
- `src/loki/loki-client.ts` (preserve timestamps)
- `src/config/get-config.ts`
- `infra/cloudformation/template.yaml`
- `scripts/deploy.ps1` (if Bedrock env vars need to be passed)
- `package.json` / lockfile
- `README.md` (operational docs after implementation)

---

## 10. Security

- No credentials in the repo.
- Synthetic test fixtures only (never real tokens/URLs).
- Redact before sending logs to Bedrock.
- CloudWatch logs: enough technical detail for diagnosis, without secrets or full sensitive log dumps.
- Mask at least: Bearer tokens, API keys, passwords, cookies, Authorization headers, secrets, connection strings.

---

## 11. Cost controls

- ~500 alerts/day expected.
- One Bedrock analysis per consolidated alert.
- Deduplicate and truncate before invocation.
- `BEDROCK_ENABLED=false` to stop AI cost immediately.
- Metrics/logs: invocations, failures, fallback usage.
- Cache/DB: **not** in this iteration (future recommendation).

Pricing reference: [Amazon Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/). Nova Micro is the lowest-cost classic Nova text model; the public pricing page may highlight Nova 2 — the model ID in use remains `amazon.nova-micro-v1:0` while it is available and accessible.

---

## 12. Agreed decisions / assumptions

| Topic | Decision |
| --- | --- |
| Initial model | `amazon.nova-micro-v1:0` |
| Test region | `us-east-1` |
| Bedrock access | Validated with successful `converse` call |
| Bedrock default | Disabled (`BEDROCK_ENABLED=false`) until enabled on deploy |
| `resolved` alerts | Remain ignored as today |
| Fallback | Legacy Slack message if Bedrock fails |

Confirm only if scope should change:

- Send Slack when Loki returned no lines? (today: no Slack)
- Add new fields to Slack Workflow payload keys, or only inside the `message` text?

---

## 13. Test plan

Unit tests with mocks (no real AWS calls):

1. Exact duplicate removal  
2. Grouping by message ignoring timestamps  
3. Occurrence counting  
4. First / last occurrence  
5. ANSI cleanup  
6. Secret redaction  
7. Valid Bedrock response  
8. `null` fields  
9. Invalid JSON  
10. Bedrock timeout  
11. Confidence below threshold  
12. Bedrock disabled  
13. Fallback to current message  
14. Enriched Slack message construction  
15. `firing` status  
16. `resolved` status (no-regression)

---

## 14. Post-implementation documentation

Update `README.md` (and this doc if needed) with:

- Architecture and flow  
- Environment variables  
- IAM permissions  
- Model in use  
- Fallback behavior  
- Input/output examples  
- Deployment  
- Tests  
- Monitoring and approximate cost  
- How to disable Bedrock  

---

## 15. Document location

This file lives under `docs/` to separate the **design/plan** from the project’s operational README.

```text
docs/bedrock-enrichment-plan.md   ← this plan
README.md                         ← usage/deploy guide (updated after implementation)
```

---

## 16. Next step

1. Deploy stack + code (`npm run deploy:all` or `deploy:stack` then `deploy`).
2. Keep `BEDROCK_ENABLED=false` until ready.
3. Enable with `-BedrockEnabled true` after confirming model access in the region.
4. Monitor CloudWatch for Bedrock success/fallback logs.
