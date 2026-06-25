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
}

export interface AlertConfig {
  lokiBaseUrl: string;
  slackWebhookUrl: string;
  lookbackMinutes: number;
  errorPattern: string;
}

export interface TimeWindow {
  startNs: string;
  endNs: string;
}
