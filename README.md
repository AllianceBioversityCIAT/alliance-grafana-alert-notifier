# Grafana Alert Lambda

Lightweight Node.js/TypeScript Lambda that receives Grafana alerts via API Gateway, queries Loki for the latest error log lines, optionally enriches them with Amazon Bedrock, and sends a summary to Slack.

## Architecture

```text
Grafana Alertmanager Webhook
        |
        v
   API Gateway (HTTP API)
        |
        v
   Lambda handler
   +--> AWS Secrets Manager (Loki/Slack config)
   +--> Loki /loki/api/v1/query_range
   +--> Log preprocess (sanitize, redact, dedupe)
   +--> Amazon Bedrock Converse (optional)
   +--> Slack Incoming Webhook
```

Design details: [docs/bedrock-enrichment-plan.md](docs/bedrock-enrichment-plan.md).

## Requirements

- Node.js 20 or 22
- AWS Secrets Manager access from the Lambda execution role
- Loki reachable from the Lambda VPC/network
- Slack Incoming Webhook configured
- (Optional) Amazon Bedrock model access for `amazon.nova-micro-v1:0` (or configured model)

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `ALERTING_SECRET_NAME` | Yes | Name or ARN of the secret in AWS Secrets Manager |

Bedrock and log-normalization settings are **not** Lambda environment variables. They are loaded only from the Secrets Manager JSON (see below). Do not hardcode model IDs, regions, or thresholds in application code.

Do not put AWS access keys or real secrets in the repository.

## Secret format

Recommended secret name (replace with your own path):

```text
grafana-alert/env
```

Create a JSON secret in AWS Secrets Manager with this structure:

```json
{
  "LOKI_BASE_URL": "https://loki.example.com",
  "SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/XXX/YYY/ZZZ",
  "LOOKBACK_MINUTES": "5",
  "DEFAULT_ERROR_PATTERN": "ERROR",
  "BEDROCK_ENABLED": "true",
  "BEDROCK_MODEL_ID": "amazon.nova-micro-v1:0",
  "BEDROCK_REGION": "us-east-1",
  "BEDROCK_MAX_TOKENS": "500",
  "BEDROCK_CONFIDENCE_THRESHOLD": "0.60",
  "BEDROCK_TIMEOUT_MS": "8000",
  "BEDROCK_MAX_INPUT_CHARS": "6000",
  "LOG_DATE_FORMAT": "MM/DD/YYYY",
  "LOG_TIMEZONE": "America/Bogota"
}
```

Required always:

- `LOKI_BASE_URL`
- `SLACK_WEBHOOK_URL`
- `LOOKBACK_MINUTES`
- `DEFAULT_ERROR_PATTERN`

Required when `BEDROCK_ENABLED` is `"true"`:

- `BEDROCK_MODEL_ID`
- `BEDROCK_REGION`
- `BEDROCK_MAX_TOKENS`
- `BEDROCK_CONFIDENCE_THRESHOLD`
- `BEDROCK_TIMEOUT_MS`
- `BEDROCK_MAX_INPUT_CHARS`
- `LOG_DATE_FORMAT`
- `LOG_TIMEZONE`

If `BEDROCK_ENABLED` is missing or `"false"`, Bedrock is skipped and the legacy Slack message is used. Values above are examples for the secret only — they are not hardcoded in the Lambda source.

## Grafana payload example

```json
{
  "receiver": "webhook",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "Example Loki Error Alert",
        "job": "example-app",
        "filename": "/var/lib/docker/containers/abc123/container-cached.log"
      },
      "annotations": {},
      "startsAt": "2026-06-22T20:00:00Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "generatorURL": "https://grafana.example.com/alerting/grafana/test/uid/view",
      "values": {
        "B": 8
      }
    }
  ],
  "groupLabels": {
    "alertname": "Example Loki Error Alert"
  },
  "commonLabels": {
    "alertname": "Example Loki Error Alert"
  },
  "title": "[FIRING:1] Example Loki Error Alert",
  "state": "alerting"
}
```

## Behavior

1. If `status = "resolved"`, respond with `200` and do not query Loki or Slack.
2. If `status = "firing"`, validate that at least one alert includes `labels.job`.
3. Deduplicate alerts by `job + filename`.
4. Query Loki with:

```logql
{job="<job>"} |= "<DEFAULT_ERROR_PATTERN>"
```

5. Use `query_range` with:
   - `direction=BACKWARD`
   - `start` / `end` as Unix nanoseconds
   - a maximum of 10 lines per alert
6. Sanitize logs, redact secrets, deduplicate/group equivalent messages.
7. If `BEDROCK_ENABLED=true`, call Amazon Bedrock (Nova Micro by default) for structured normalization. On any Bedrock failure, fall back to the legacy Slack message.
8. Build and send a Slack message (enriched or legacy).
9. If Loki fails or returns no lines, skip Slack and still respond with `200`.
10. If Slack fails, still respond with `200` and log the error to CloudWatch Logs.
11. Do not print Slack webhook URLs or secrets in logs.

## Bedrock enrichment

- Model / region / limits: configured **only** in Secrets Manager (`BEDROCK_*`, `LOG_*`)
- API: Bedrock Runtime **Converse** (`temperature=0`)
- Auth: Lambda IAM role (`bedrock:InvokeModel`, `bedrock:Converse`) — no access keys
- Kill switch: set `"BEDROCK_ENABLED": "false"` in the secret (or omit the key)
- Fallback: Bedrock errors never block Slack delivery when Loki lines are available

### Enable after deploy

1. Add the Bedrock keys to your secret (for example `dev/app/devops/grafana-alert/env`).
2. Set `"BEDROCK_ENABLED": "true"`.
3. Ensure the model is enabled in Bedrock for that region.
4. No Lambda env vars are required beyond `ALERTING_SECRET_NAME`.

### Approximate cost

~500 alerts/day with short deduplicated prompts on Nova Micro is typically low (cents/day). Confirm current rates at [Amazon Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/).

## Project structure

```text
src/
  handler.ts
  config/get-config.ts
  secrets/get-secret.ts
  grafana/
  loki/
  slack/
  bedrock/
  utils/
  types/
test/
  *.spec.ts
docs/
  bedrock-enrichment-plan.md
```

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Watch mode:

```bash
npm run test:watch
```

Compile TypeScript:

```bash
npm run build
```

## Package for Lambda

```bash
npm run package
```

This generates:

- `dist/` with compiled JavaScript
- `grafana-alert-lambda.zip` ready to upload to Lambda

## Local deployment from PowerShell

Infrastructure is managed with **CloudFormation**. Application code is uploaded separately with the AWS CLI.

### Prerequisites

1. AWS CLI installed and configured (`aws sts get-caller-identity` should work)
2. Node.js 20+ and npm working locally
3. Secret configured in AWS Secrets Manager (see secret format above)
4. IAM permissions for CloudFormation, Lambda, IAM, API Gateway, and CloudWatch Logs
5. (Optional) Bedrock model access enabled for the chosen model in the target region

### 1. Create the secret (one time)

Secret name example (replace with your own):

```text
grafana-alert/env
```

Example JSON value:

```json
{
  "LOKI_BASE_URL": "https://loki.example.com",
  "SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/XXX/YYY/ZZZ",
  "LOOKBACK_MINUTES": "5",
  "DEFAULT_ERROR_PATTERN": "ERROR"
}
```

### 2. Deploy infrastructure with CloudFormation

From the project root:

```powershell
npm run deploy:stack
```

This creates or updates the stack `grafana-alert-lambda` with:

- IAM role for Lambda (Secrets Manager + optional Bedrock)
- Lambda function (placeholder code)
- HTTP API Gateway route `POST /grafana/webhook`
- CloudWatch log group
- Tag `Project=grafana-alert-<environment>` on taggable resources (default environment: `dev`)

Template: `infra/cloudformation/template.yaml`

Optional overrides:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy.ps1 `
  -Action stack `
  -Region us-east-1 `
  -StackName grafana-alert-lambda `
  -SecretName "dev/app/devops/grafana-alert/env" `
  -Environment dev
```

The stack applies tag `Project=grafana-alert-<Environment>` (for example `grafana-alert-dev`) to Lambda, IAM role, log group, HTTP API, and API stage.

### 3. Deploy application code

```powershell
npm run deploy
```

This builds the zip and runs:

- `aws lambda update-function-code`
- `aws lambda update-function-configuration`

Handler used after deploy:

```text
dist/handler.handler
```

### 4. First-time full deploy (stack + code)

```powershell
npm run deploy:all
```

### 5. Deploy code updates later

```powershell
npm test
npm run deploy
```

### Test Loki connectivity without Grafana alerts

**From your local machine** (tests whether Loki is reachable from your PC):

```powershell
npm run test:loki:local
```

**From the deployed Lambda** (tests whether Lambda can reach Loki):

```powershell
npm run test:loki:lambda
```

Or call the webhook directly (replace with your stack output URL):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-loki-lambda.ps1 `
  -WebhookUrl "https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/grafana/webhook" `
  -Job example-app
```

Diagnostic request body:

```json
{
  "diagnostic": "loki",
  "job": "example-app"
}
```

### CloudFormation outputs

After the stack is deployed, read the webhook URL:

```powershell
aws cloudformation describe-stacks `
  --stack-name grafana-alert-lambda `
  --query "Stacks[0].Outputs" `
  --region us-east-1
```

Use `WebhookUrl` in Grafana as the Alertmanager webhook target.

### Minimum IAM permissions for deploy user

- `cloudformation:*`
- `iam:CreateRole`, `iam:PutRolePolicy`, `iam:GetRole`, `iam:PassRole`
- `lambda:*`
- `apigateway:*`
- `logs:CreateLogGroup`

The Lambda execution role permission to read the secret is created by CloudFormation:

```text
arn:aws:secretsmanager:REGION:ACCOUNT:secret:YOUR_SECRET_NAME*
```

Bedrock (foundation models / inference profiles in the stack region; model ID comes from the secret at runtime):

```text
bedrock:InvokeModel
bedrock:Converse
arn:aws:bedrock:REGION::foundation-model/*
arn:aws:bedrock:REGION:ACCOUNT:inference-profile/*
```

### Troubleshooting CloudFormation failures

If `npm run deploy:stack` fails, inspect the events:

```powershell
aws cloudformation describe-stack-events `
  --stack-name grafana-alert-lambda `
  --region us-east-1 `
  --max-items 10
```

Common fixes:

1. **Stack in `ROLLBACK_COMPLETE`** — delete it and retry:

```powershell
aws cloudformation delete-stack --stack-name grafana-alert-lambda --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name grafana-alert-lambda --region us-east-1
npm run deploy:stack
```

2. **Orphan IAM role from an earlier manual deploy** — delete the old role:

```powershell
aws iam list-role-policies --role-name grafana-alert-lambda-role
aws iam delete-role-policy --role-name grafana-alert-lambda-role --policy-name grafana-alert-lambda-role-policy
aws iam delete-role --role-name grafana-alert-lambda-role
```

Then delete the failed stack and run `npm run deploy:stack` again.

### Manual AWS CLI alternative

If you prefer not to use the script:

```powershell
npm run package

aws lambda update-function-code `
  --function-name grafana-alert-lambda `
  --zip-file fileb://grafana-alert-lambda.zip `
  --region us-east-1
```

### Useful checks

```powershell
aws lambda get-function --function-name grafana-alert-lambda --region us-east-1
aws logs tail /aws/lambda/grafana-alert-lambda --follow --region us-east-1
```

Recommended handler:

```text
dist/handler.handler
```

Recommended runtime:

```text
nodejs20.x
```

## Minimum IAM permissions

The Lambda execution role needs at least:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:YOUR_SECRET*"
    },
    {
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:Converse"],
      "Resource": [
        "arn:aws:bedrock:REGION::foundation-model/*",
        "arn:aws:bedrock:REGION:ACCOUNT:inference-profile/*"
      ]
    }
  ]
}
```

If Loki runs in a private network, configure VPC, security groups, and a sufficient timeout (for example 15–45 seconds).

## API Gateway integration

Create an HTTP API with:

- Method: `POST`
- Route: for example `/grafana/webhook`
- Integration: Lambda proxy
- No authentication, or an authorizer according to your security policy

## Slack message examples

Legacy (Bedrock disabled or fallback):

```text
:rotating_light: Example Loki Error Alert
Status: firing
Job: example-app
Error count: 8
Window: last 5 minutes
Filename: /var/lib/docker/containers/abc123/container-cached.log

Latest Loki errors:
2026-06-22T20:01:40Z ERROR something bad
2026-06-22T20:01:38Z ERROR another issue

Panel: https://grafana.example.com/d/panel/1
Alert: https://grafana.example.com/alerting/grafana/test/uid/view
```

Enriched (Bedrock enabled and successful):

```text
🚨 PRMS Test – Error detectado

Estado: Activo
Aplicación: PRMS
Ambiente: Test
Job: docker_prms_test

Módulo: System
Usuario: No identificado
Tipo de error: HttpException

Caso:
Authorization token is required

Ocurrencias: 10
Primera ocurrencia: 9:00:31 PM
Última ocurrencia: 9:00:46 PM
```

## Test coverage

- Grafana payload parsing
- Loki query construction
- Loki client (`query_range`, timestamps preserved)
- Log redaction / deduplication / preprocessing
- Bedrock response validation and fallback
- Slack message construction (legacy + enriched)
- Main handler (`firing`, `resolved`, Bedrock on/off, Loki/Slack error handling)
