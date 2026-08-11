import { describe, it, expect } from 'vitest';
import { getHistoryConfigFromSecret } from '../src/config/get-config.js';

const baseSecret = {
  LOKI_BASE_URL: 'https://loki.example.com',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/XXX/YYY/ZZZ',
  LOOKBACK_MINUTES: '5',
  DEFAULT_ERROR_PATTERN: 'ERROR',
};

const enabledSecret = {
  ...baseSecret,
  HISTORY_ENABLED: 'true',
  HISTORY_TABLE_NAME: 'grafana-alert-history',
  HISTORY_REGION: 'us-east-1',
  HISTORY_RETENTION_DAYS: '90',
};

describe('getHistoryConfigFromSecret', () => {
  it('disables history when the flag is missing', () => {
    const config = getHistoryConfigFromSecret(baseSecret);
    expect(config.enabled).toBe(false);
    expect(config.tableName).toBe('');
    expect(config.retentionDays).toBe(0);
  });

  it('honours the kill switch when explicitly disabled', () => {
    const config = getHistoryConfigFromSecret({
      ...enabledSecret,
      HISTORY_ENABLED: 'false',
    });
    expect(config.enabled).toBe(false);
  });

  it('loads history settings only from the secret when enabled', () => {
    const config = getHistoryConfigFromSecret(enabledSecret);
    expect(config.enabled).toBe(true);
    expect(config.tableName).toBe('grafana-alert-history');
    expect(config.region).toBe('us-east-1');
    expect(config.retentionDays).toBe(90);
  });

  it('requires all history keys when enabled', () => {
    expect(() =>
      getHistoryConfigFromSecret({
        ...baseSecret,
        HISTORY_ENABLED: 'true',
        HISTORY_TABLE_NAME: 'grafana-alert-history',
      }),
    ).toThrow(/HISTORY_REGION/);
  });

  it('names the right key in the boolean error, not BEDROCK_ENABLED', () => {
    expect(() =>
      getHistoryConfigFromSecret({ ...baseSecret, HISTORY_ENABLED: 'maybe' }),
    ).toThrow(/HISTORY_ENABLED/);
  });

  it('rejects a non-positive retention', () => {
    expect(() =>
      getHistoryConfigFromSecret({
        ...enabledSecret,
        HISTORY_RETENTION_DAYS: '0',
      }),
    ).toThrow(/HISTORY_RETENTION_DAYS/);
  });
});
