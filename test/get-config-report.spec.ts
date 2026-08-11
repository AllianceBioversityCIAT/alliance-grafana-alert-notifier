import { describe, it, expect } from 'vitest';
import { getReportConfigFromSecret } from '../src/config/get-config.js';

const baseSecret = {
  LOKI_BASE_URL: 'https://loki.example.com',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/XXX/YYY/ZZZ',
  LOOKBACK_MINUTES: '5',
  DEFAULT_ERROR_PATTERN: 'ERROR',
};

const enabledSecret = {
  ...baseSecret,
  REPORT_ENABLED: 'true',
  REPORT_STREAK_WEEKS: '4',
  REPORT_BEDROCK_MAX_TOKENS: '1200',
  REPORT_BEDROCK_TIMEOUT_MS: '20000',
};

describe('getReportConfigFromSecret', () => {
  it('disables the report when the flag is missing', () => {
    const config = getReportConfigFromSecret(baseSecret);
    expect(config.enabled).toBe(false);
    expect(config.streakWeeks).toBe(0);
    expect(config.webhookUrl).toBeUndefined();
  });

  it('loads report settings only from the secret when enabled', () => {
    const config = getReportConfigFromSecret(enabledSecret);
    expect(config.enabled).toBe(true);
    expect(config.streakWeeks).toBe(4);
    expect(config.bedrockMaxTokens).toBe(1200);
    expect(config.bedrockTimeoutMs).toBe(20000);
  });

  it('treats the report webhook as optional so it falls back to the main one', () => {
    expect(getReportConfigFromSecret(enabledSecret).webhookUrl).toBeUndefined();

    const withOwnChannel = getReportConfigFromSecret({
      ...enabledSecret,
      SLACK_REPORT_WEBHOOK_URL: 'https://hooks.slack.com/services/AAA/BBB/CCC',
    });
    expect(withOwnChannel.webhookUrl).toBe(
      'https://hooks.slack.com/services/AAA/BBB/CCC',
    );
  });

  it('requires all report keys when enabled', () => {
    expect(() =>
      getReportConfigFromSecret({
        ...baseSecret,
        REPORT_ENABLED: 'true',
        REPORT_STREAK_WEEKS: '4',
      }),
    ).toThrow(/REPORT_BEDROCK_MAX_TOKENS/);
  });

  it('names the right key in the boolean error', () => {
    expect(() =>
      getReportConfigFromSecret({ ...baseSecret, REPORT_ENABLED: 'sometimes' }),
    ).toThrow(/REPORT_ENABLED/);
  });

  it('rejects a non-positive streak window', () => {
    expect(() =>
      getReportConfigFromSecret({ ...enabledSecret, REPORT_STREAK_WEEKS: '0' }),
    ).toThrow(/REPORT_STREAK_WEEKS/);
  });
});
