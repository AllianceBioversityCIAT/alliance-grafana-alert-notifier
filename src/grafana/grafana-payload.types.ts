export interface GrafanaAlert {
  status: string;
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
  values?: {
    B?: number;
    [key: string]: number | undefined;
  };
}

export interface GrafanaWebhookPayload {
  receiver?: string;
  status: 'firing' | 'resolved' | string;
  alerts: GrafanaAlert[];
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  externalURL?: string;
  version?: string;
  groupKey?: string;
  truncatedAlerts?: number;
  orgId?: number;
  title?: string;
  state?: string;
  message?: string;
}

export interface ParsedGrafanaAlert {
  alertname: string;
  job: string;
  status: string;
  errorCount?: number;
  filename?: string;
  panelURL?: string;
  generatorURL?: string;
}

export type ParseGrafanaResult =
  | { kind: 'resolved' }
  | { kind: 'error'; message: string }
  | { kind: 'firing'; alerts: ParsedGrafanaAlert[] };

export interface AlertingSecret {
  LOKI_BASE_URL: string;
  SLACK_WEBHOOK_URL: string;
  LOOKBACK_MINUTES: string;
  DEFAULT_ERROR_PATTERN: string;
  BEDROCK_ENABLED?: string;
  BEDROCK_MODEL_ID?: string;
  BEDROCK_REGION?: string;
  BEDROCK_MAX_TOKENS?: string;
  BEDROCK_CONFIDENCE_THRESHOLD?: string;
  BEDROCK_TIMEOUT_MS?: string;
  BEDROCK_MAX_INPUT_CHARS?: string;
  LOG_DATE_FORMAT?: string;
  LOG_TIMEZONE?: string;
  GRAFANA_BASE_URL?: string;
  LOKI_DATASOURCE_UID?: string;
  HISTORY_ENABLED?: string;
  HISTORY_TABLE_NAME?: string;
  HISTORY_REGION?: string;
  HISTORY_RETENTION_DAYS?: string;
}

export interface BedrockConfig {
  enabled: boolean;
  modelId: string;
  region: string;
  maxTokens: number;
  confidenceThreshold: number;
  timeoutMs: number;
  maxInputChars: number;
  dateFormat: string;
  timezone: string;
}

export interface HistoryConfig {
  enabled: boolean;
  tableName: string;
  region: string;
  retentionDays: number;
}

export interface AlertConfig {
  lokiBaseUrl: string;
  slackWebhookUrl: string;
  lookbackMinutes: number;
  errorPattern: string;
  bedrock: BedrockConfig;
  history: HistoryConfig;
  /** Optional: without both, the Slack message carries no Explore link. */
  grafanaBaseUrl?: string;
  lokiDatasourceUid?: string;
}

export interface TimeWindow {
  startNs: string;
  endNs: string;
}
