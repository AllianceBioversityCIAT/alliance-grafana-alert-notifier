import type { GrafanaWebhookPayload } from "../src/grafana/grafana-payload.types.js";

export const firingPayload: GrafanaWebhookPayload = {
  receiver: "webhook",
  status: "firing",
  alerts: [
    {
      status: "firing",
      labels: {
        alertname: "Example Loki Error Alert",
        job: "example-app",
        filename: "/var/lib/docker/containers/abc123/container-cached.log",
      },
      annotations: {},
      startsAt: "2026-06-22T20:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL:
        "https://grafana.example.com/alerting/grafana/test/uid/view",
      values: { B: 8 },
    },
  ],
  groupLabels: { alertname: "Example Loki Error Alert" },
  commonLabels: { alertname: "Example Loki Error Alert" },
  commonAnnotations: {},
  externalURL: "https://grafana.example.com/",
  version: "1",
  groupKey: '{}:{alertname="Example Loki Error Alert"}',
  title: "[FIRING:1] Example Loki Error Alert",
  state: "alerting",
  message: "Something is firing",
};

export const resolvedPayload: GrafanaWebhookPayload = {
  ...firingPayload,
  status: "resolved",
  alerts: [
    {
      ...firingPayload.alerts[0],
      status: "resolved",
    },
  ],
  title: "[RESOLVED] Example Loki Error Alert",
  state: "ok",
};

export const payloadWithoutJob: GrafanaWebhookPayload = {
  ...firingPayload,
  alerts: [
    {
      status: "firing",
      labels: {
        alertname: "Example Loki Error Alert",
      },
      annotations: {},
      startsAt: "2026-06-22T20:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
    },
  ],
};

export const multiAlertPayload: GrafanaWebhookPayload = {
  ...firingPayload,
  alerts: [
    firingPayload.alerts[0],
    {
      ...firingPayload.alerts[0],
      labels: {
        ...firingPayload.alerts[0].labels,
        filename: "/var/lib/docker/containers/def456/other.log",
      },
      values: { B: 3 },
    },
    {
      ...firingPayload.alerts[0],
      labels: {
        ...firingPayload.alerts[0].labels,
        filename: "/var/lib/docker/containers/abc123/container-cached.log",
      },
      values: { B: 8 },
    },
  ],
};

export const alertSecret = {
  LOKI_BASE_URL: "https://loki.example.com",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/XXX/YYY/ZZZ",
  LOOKBACK_MINUTES: "5",
  DEFAULT_ERROR_PATTERN: "ERROR",
};

export const bedrockConfig = {
  enabled: false,
  modelId: 'amazon.nova-micro-v1:0',
  region: 'us-east-1',
  maxTokens: 500,
  confidenceThreshold: 0.6,
  timeoutMs: 8000,
  maxInputChars: 6000,
  dateFormat: 'MM/DD/YYYY',
  timezone: 'America/Bogota',
};

export const historyConfig = {
  enabled: false,
  tableName: 'grafana-alert-history-test',
  region: 'us-east-1',
  retentionDays: 90,
};

export const reportConfig = {
  enabled: false,
  streakWeeks: 4,
  bedrockMaxTokens: 1200,
  bedrockTimeoutMs: 20000,
};

export const alertConfig = {
  lokiBaseUrl: alertSecret.LOKI_BASE_URL,
  slackWebhookUrl: alertSecret.SLACK_WEBHOOK_URL,
  lookbackMinutes: 5,
  errorPattern: alertSecret.DEFAULT_ERROR_PATTERN,
  bedrock: bedrockConfig,
  history: historyConfig,
  report: reportConfig,
};

export const lokiQueryRangeResponse = {
  status: "success",
  data: {
    resultType: "streams",
    result: [
      {
        stream: { job: "example-app" },
        values: [
          ["1719086500000000000", "2026-06-22T20:01:40Z ERROR something bad"],
          ["1719086498000000000", "2026-06-22T20:01:38Z ERROR another issue"],
        ],
      },
    ],
  },
};
