import { describe, it, expect, vi } from 'vitest';
import type { HistoryConfig, ParsedGrafanaAlert } from '../src/grafana/grafana-payload.types.js';
import type { PreprocessedLogEvent } from '../src/types/normalized-log-event.js';
import {
  buildAlertHistoryItem,
  queryAlertHistory,
  recordAlertEvent,
  summarizeBySignature,
  type AlertHistoryItem,
} from '../src/history/alert-history-store.js';

const config: HistoryConfig = {
  enabled: true,
  tableName: 'grafana-alert-history',
  region: 'us-east-1',
  retentionDays: 90,
};

const alert: ParsedGrafanaAlert = {
  alertname: 'PRMS Test - Loki Error Alert',
  job: 'prms-test',
  status: 'firing',
  errorCount: 312,
  filename: '/var/lib/docker/containers/abc123/container.log',
};

const preprocessed: PreprocessedLogEvent = {
  alertName: alert.alertname,
  status: 'firing',
  job: alert.job,
  application: 'PRMS',
  environment: 'Test',
  timezone: 'America/Bogota',
  dateFormat: 'MM/DD/YYYY',
  occurrences: 4,
  firstOccurrence: '07/09/2026, 2:00:46 PM',
  lastOccurrence: '07/09/2026, 2:01:12 PM',
  firstOccurrenceNs: '1719086500000000000',
  lastOccurrenceNs: '1719086526000000000',
  representativeLogs: [
    'ERROR [ClarisaTaskService] [15] Error saving item with id/code: 39',
  ],
};

const analysis = {
  usuario: 'system',
  modulo: 'ClarisaTaskService',
  momento: '07/09/2026, 2:00:46 PM',
  caso: 'Fallo al guardar un item',
  tipoError: 'QueryFailedError',
  confianza: { usuario: 0.9, modulo: 0.95, momento: 0.9, caso: 0.8 },
  evidencia: { usuario: null, modulo: null, momento: null, caso: null },
};

const now = new Date('2026-08-11T15:30:00.000Z');

function baseInput() {
  return {
    alert,
    config,
    outcome: 'notified' as const,
    slackDelivered: true,
    preprocessed,
    analysis,
    usedBedrock: true,
    now,
  };
}

describe('buildAlertHistoryItem', () => {
  it('keys by UTC day and carries the Bedrock fields under their real names', () => {
    const item = buildAlertHistoryItem(baseInput());

    expect(item.pk).toBe('DAY#2026-08-11');
    expect(item.sk.startsWith('2026-08-11T15:30:00.000Z#')).toBe(true);
    expect(item.modulo).toBe('ClarisaTaskService');
    expect(item.tipoError).toBe('QueryFailedError');
    expect(item.caso).toBe('Fallo al guardar un item');
    expect(item.usuario).toBe('system');
    expect(item.application).toBe('PRMS');
    expect(item.environment).toBe('Test');
    expect(item.occurrences).toBe(4);
    expect(item.errorCount).toBe(312);
    expect(item.usedBedrock).toBe(true);
    expect(item.signature).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stores absolute instants, never display text', () => {
    const item = buildAlertHistoryItem(baseInput());

    expect(item.firstOccurrenceNs).toBe('1719086500000000000');
    expect(item.lastOccurrenceNs).toBe('1719086526000000000');
    expect(JSON.stringify(item)).not.toContain('2:00:46 PM');
  });

  it('computes ttl from the retention window', () => {
    const item = buildAlertHistoryItem(baseInput());

    expect(item.ttl).toBe(Math.floor(now.getTime() / 1000) + 90 * 86_400);
  });

  it('truncates representative logs', () => {
    const item = buildAlertHistoryItem({
      ...baseInput(),
      preprocessed: {
        ...preprocessed,
        representativeLogs: [`ERROR ${'x'.repeat(5000)}`],
      },
    });

    expect(item.representativeLogs.length).toBeLessThanOrEqual(2001);
    expect(item.representativeLogs.endsWith('…')).toBe(true);
  });

  it('nulls the optional fields when Bedrock did not run', () => {
    const item = buildAlertHistoryItem({
      alert: { alertname: 'A', job: 'j', status: 'firing' },
      config,
      outcome: 'skipped_no_lines',
      slackDelivered: false,
      now,
    });

    expect(item.modulo).toBeNull();
    expect(item.tipoError).toBeNull();
    expect(item.errorCount).toBeNull();
    expect(item.filename).toBeNull();
    // Metadata extraction is best-effort: the job label yields an application
    // even from a free-form name, but there is no environment token to find.
    expect(item.environment).toBeNull();
    expect(item.occurrences).toBe(0);
    expect(item.outcome).toBe('skipped_no_lines');
    expect(item.usedBedrock).toBe(false);
  });

  it('records the Loki error on the skipped path', () => {
    const item = buildAlertHistoryItem({
      alert,
      config,
      outcome: 'skipped_loki_error',
      slackDelivered: false,
      lokiError: 'fetch failed: ECONNREFUSED',
      now,
    });

    expect(item.outcome).toBe('skipped_loki_error');
    expect(item.lokiError).toBe('fetch failed: ECONNREFUSED');
    expect(item.bedrockFallbackReason).toBeNull();
  });

  it('still fills application and environment on the skipped paths', () => {
    // Skipped alerts never reach preprocessLogs, so these used to be stored as
    // null and the weekly report dropped them into an "unknown" bucket.
    for (const outcome of ['skipped_no_lines', 'skipped_loki_error'] as const) {
      const item = buildAlertHistoryItem({
        alert,
        config,
        outcome,
        slackDelivered: false,
        now,
      });

      expect(item.application).toBe('PRMS');
      expect(item.environment).toBe('test');
      expect(item.occurrences).toBe(0);
    }
  });

  it('prefers the preprocessed metadata over the derived fallback', () => {
    const item = buildAlertHistoryItem({
      ...baseInput(),
      preprocessed: {
        ...preprocessed,
        application: 'FromPreprocessing',
        environment: 'staging',
      },
    });

    expect(item.application).toBe('FromPreprocessing');
    expect(item.environment).toBe('staging');
  });
});

describe('recordAlertEvent', () => {
  it('writes the item through the injected put', async () => {
    const put = vi.fn().mockResolvedValue(undefined);

    const written = await recordAlertEvent({ ...baseInput(), put });

    expect(written).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toMatchObject({
      region: 'us-east-1',
      tableName: 'grafana-alert-history',
    });
    expect(put.mock.calls[0][0].item.pk).toBe('DAY#2026-08-11');
  });

  it('skips the write entirely when history is disabled', async () => {
    const put = vi.fn();

    const written = await recordAlertEvent({
      ...baseInput(),
      config: { ...config, enabled: false },
      put,
    });

    expect(written).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  it('surfaces a write failure as a handled error, never a thrown exception', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const put = vi.fn().mockRejectedValue(new Error('ResourceNotFoundException'));

    const written = await recordAlertEvent({ ...baseInput(), put });

    expect(written).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('summarizeBySignature', () => {
  const item = (signature: string, alertname: string, recordedAt: string) =>
    ({
      signature,
      signatureText: `text-${signature}`,
      alertname,
      recordedAt,
      outcome: 'notified',
    }) as AlertHistoryItem;

  it('groups by signature and orders by frequency', () => {
    const summaries = summarizeBySignature([
      item('aaa', 'Alert A', '2026-08-10T10:00:00.000Z'),
      item('bbb', 'Alert B', '2026-08-10T11:00:00.000Z'),
      item('aaa', 'Alert C', '2026-08-11T09:00:00.000Z'),
      item('aaa', 'Alert A', '2026-08-09T09:00:00.000Z'),
    ]);

    expect(summaries).toHaveLength(2);
    expect(summaries[0].signature).toBe('aaa');
    expect(summaries[0].count).toBe(3);
    expect(summaries[0].alertnames).toEqual(['Alert A', 'Alert C']);
    expect(summaries[0].firstSeen).toBe('2026-08-09T09:00:00.000Z');
    expect(summaries[0].lastSeen).toBe('2026-08-11T09:00:00.000Z');
    expect(summaries[1].count).toBe(1);
  });
});

describe('queryAlertHistory', () => {
  it('queries one partition per day and returns newest first', async () => {
    const query = vi.fn().mockImplementation(({ partitionKey }) => {
      if (partitionKey === 'DAY#2026-08-11') {
        return Promise.resolve([
          {
            signature: 'aaa',
            signatureText: 'text',
            alertname: 'Alert A',
            recordedAt: '2026-08-11T09:00:00.000Z',
            outcome: 'notified',
          },
        ]);
      }
      if (partitionKey === 'DAY#2026-08-10') {
        return Promise.resolve([
          {
            signature: 'aaa',
            signatureText: 'text',
            alertname: 'Alert A',
            recordedAt: '2026-08-10T09:00:00.000Z',
            outcome: 'notified',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = await queryAlertHistory({ config, days: 3, query, now });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.map((call) => call[0].partitionKey)).toEqual([
      'DAY#2026-08-11',
      'DAY#2026-08-10',
      'DAY#2026-08-09',
    ]);
    expect(result.items[0].recordedAt).toBe('2026-08-11T09:00:00.000Z');
    expect(result.signatures[0].count).toBe(2);
  });
});
