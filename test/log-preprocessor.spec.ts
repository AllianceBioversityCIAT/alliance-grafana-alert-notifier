import { describe, it, expect } from 'vitest';
import { preprocessLogs } from '../src/utils/log-preprocessor.js';
import type { ParsedGrafanaAlert } from '../src/grafana/grafana-payload.types.js';

const alert: ParsedGrafanaAlert = {
  alertname: 'PRMS Test - Loki Error Alert',
  job: 'docker_prms_test',
  status: 'firing',
};

describe('log-preprocessor', () => {
  it('cleans ANSI, deduplicates, and counts occurrences', () => {
    const result = preprocessLogs({
      alert,
      timezone: 'America/Bogota',
      dateFormat: 'MM/DD/YYYY',
      maxInputChars: 6000,
      entries: [
        {
          timestampNs: '100',
          line:
            '\x1B[31m[Nest] 24 - 07/09/2026, 9:00:31 PM ERROR [System] HttpException: Authorization token is required\x1B[39m',
        },
        {
          timestampNs: '200',
          line:
            '[Nest] 24 - 07/09/2026, 9:00:40 PM ERROR [System] HttpException: Authorization token is required',
        },
        {
          timestampNs: '300',
          line:
            '[Nest] 24 - 07/09/2026, 9:00:46 PM ERROR [System] HttpException: Authorization token is required',
        },
      ],
    });

    expect(result.application).toBe('PRMS');
    expect(result.environment).toBe('test');
    expect(result.occurrences).toBe(3);
    expect(result.firstOccurrence).toContain('9:00:31 PM');
    expect(result.lastOccurrence).toContain('9:00:46 PM');
    expect(result.representativeLogs).toHaveLength(1);
    expect(result.representativeLogs[0]).not.toContain('\x1B[');
    expect(result.representativeLogs[0]).toContain('HttpException');
  });

  it('redacts secrets before producing representative logs', () => {
    const result = preprocessLogs({
      alert,
      timezone: 'America/Bogota',
      dateFormat: 'MM/DD/YYYY',
      maxInputChars: 6000,
      entries: [
        {
          timestampNs: '1',
          line: 'ERROR Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example',
        },
      ],
    });

    expect(result.representativeLogs[0]).toContain('[REDACTED]');
    expect(result.representativeLogs[0]).not.toContain('eyJhbGciOi');
  });
});
