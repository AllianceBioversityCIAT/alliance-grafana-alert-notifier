import { describe, it, expect } from 'vitest';
import { getBedrockConfigFromSecret } from '../src/config/get-config.js';

const baseSecret = {
  LOKI_BASE_URL: 'https://loki.example.com',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/XXX/YYY/ZZZ',
  LOOKBACK_MINUTES: '5',
  DEFAULT_ERROR_PATTERN: 'ERROR',
};

const enabledSecret = {
  ...baseSecret,
  BEDROCK_ENABLED: 'true',
  BEDROCK_MODEL_ID: 'amazon.nova-micro-v1:0',
  BEDROCK_REGION: 'us-east-1',
  BEDROCK_MAX_TOKENS: '500',
  BEDROCK_CONFIDENCE_THRESHOLD: '0.60',
  BEDROCK_TIMEOUT_MS: '8000',
  BEDROCK_MAX_INPUT_CHARS: '6000',
  LOG_DATE_FORMAT: 'MM/DD/YYYY',
  LOG_TIMEZONE: 'America/Bogota',
};

describe('getBedrockConfigFromSecret', () => {
  it('disables Bedrock when the flag is missing', () => {
    const config = getBedrockConfigFromSecret(baseSecret);
    expect(config.enabled).toBe(false);
    expect(config.modelId).toBe('');
  });

  it('loads Bedrock settings only from the secret when enabled', () => {
    const config = getBedrockConfigFromSecret(enabledSecret);
    expect(config.enabled).toBe(true);
    expect(config.modelId).toBe('amazon.nova-micro-v1:0');
    expect(config.region).toBe('us-east-1');
    expect(config.maxTokens).toBe(500);
    expect(config.confidenceThreshold).toBe(0.6);
    expect(config.timeoutMs).toBe(8000);
    expect(config.maxInputChars).toBe(6000);
    expect(config.dateFormat).toBe('MM/DD/YYYY');
    expect(config.timezone).toBe('America/Bogota');
  });

  it('requires all Bedrock keys when enabled', () => {
    expect(() =>
      getBedrockConfigFromSecret({
        ...baseSecret,
        BEDROCK_ENABLED: 'true',
        BEDROCK_MODEL_ID: 'amazon.nova-micro-v1:0',
      }),
    ).toThrow(/BEDROCK_REGION/);
  });
});
