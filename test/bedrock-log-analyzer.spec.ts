import { describe, it, expect, vi } from 'vitest';
import { analyzeLogsWithBedrock } from '../src/bedrock/bedrock-log-analyzer.js';
import type { PreprocessedLogEvent } from '../src/types/normalized-log-event.js';
import { bedrockConfig } from './fixtures/grafana-payloads.js';

const preprocessed: PreprocessedLogEvent = {
  alertName: 'PRMS Test - Loki Error Alert',
  status: 'firing',
  job: 'docker_prms_test',
  application: 'PRMS',
  environment: 'test',
  timezone: 'America/Bogota',
  dateFormat: 'MM/DD/YYYY',
  occurrences: 3,
  firstOccurrence: '07/09/2026, 9:00:31 PM',
  lastOccurrence: '07/09/2026, 9:00:46 PM',
  firstOccurrenceNs: '1',
  lastOccurrenceNs: '3',
  representativeLogs: [
    '[Nest] 24 - 07/09/2026, 9:00:46 PM ERROR [System] HttpException: Authorization token is required',
  ],
};

const validResponse = JSON.stringify({
  usuario: null,
  modulo: 'System',
  momento: '2026-07-09T21:00:46-05:00',
  caso: 'Authorization token is required',
  tipoError: 'HttpException',
  confianza: {
    usuario: 0,
    modulo: 1,
    momento: 1,
    caso: 0.98,
    tipoError: 1,
  },
  evidencia: {
    usuario: null,
    modulo: '[System]',
    momento: '07/09/2026, 9:00:46 PM',
    caso: 'HttpException: Authorization token is required',
    tipoError: 'HttpException',
  },
});

describe('bedrock-log-analyzer', () => {
  it('returns analysis for a valid Bedrock response', async () => {
    const converse = vi.fn().mockResolvedValue({
      text: validResponse,
      inputTokens: 100,
      outputTokens: 80,
      latencyMs: 200,
    });

    const result = await analyzeLogsWithBedrock({
      preprocessed,
      config: { ...bedrockConfig, enabled: true },
      converse,
    });

    expect(result.usedBedrock).toBe(true);
    expect(result.analysis?.modulo).toBe('System');
    expect(converse).toHaveBeenCalledOnce();
  });

  it('skips Bedrock when disabled', async () => {
    const converse = vi.fn();
    const result = await analyzeLogsWithBedrock({
      preprocessed,
      config: { ...bedrockConfig, enabled: false },
      converse,
    });

    expect(result.usedBedrock).toBe(false);
    expect(result.fallbackReason).toBe('bedrock_disabled');
    expect(converse).not.toHaveBeenCalled();
  });

  it('falls back on timeout / converse failure', async () => {
    const converse = vi.fn().mockRejectedValue(new Error('Bedrock converse timed out after 8000ms'));

    const result = await analyzeLogsWithBedrock({
      preprocessed,
      config: { ...bedrockConfig, enabled: true },
      converse,
    });

    expect(result.usedBedrock).toBe(false);
    expect(result.analysis).toBeNull();
    expect(result.fallbackReason).toMatch(/timed out/i);
  });

  it('falls back on invalid JSON', async () => {
    const converse = vi.fn().mockResolvedValue({ text: 'not-json' });

    const result = await analyzeLogsWithBedrock({
      preprocessed,
      config: { ...bedrockConfig, enabled: true },
      converse,
    });

    expect(result.usedBedrock).toBe(false);
    expect(result.analysis).toBeNull();
  });
});
