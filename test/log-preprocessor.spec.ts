import { describe, it, expect } from 'vitest';
import { preprocessLogs } from '../src/utils/log-preprocessor.js';
import type { ParsedGrafanaAlert } from '../src/grafana/grafana-payload.types.js';

const alert: ParsedGrafanaAlert = {
  alertname: 'PRMS Test - Loki Error Alert',
  job: 'docker_prms_test',
  status: 'firing',
};

describe('log-preprocessor', () => {
  // Entries arrive newest-first, the way queryLokiErrors returns them
  // (direction=BACKWARD). An ascending fixture hides first/last inversion.
  it('cleans ANSI, deduplicates, and counts occurrences', () => {
    const result = preprocessLogs({
      alert,
      timezone: 'America/Bogota',
      dateFormat: 'MM/DD/YYYY',
      maxInputChars: 6000,
      // Nanosecond values match the UTC clock embedded in each line, the way
      // promtail produces them. A fixture where the two disagree hides which
      // of the two sources the displayed time actually comes from.
      entries: [
        {
          timestampNs: '1783630846000000000',
          line:
            '[Nest] 24 - 07/09/2026, 9:00:46 PM ERROR [System] HttpException: Authorization token is required',
        },
        {
          timestampNs: '1783630840000000000',
          line:
            '[Nest] 24 - 07/09/2026, 9:00:40 PM ERROR [System] HttpException: Authorization token is required',
        },
        {
          timestampNs: '1783630831000000000',
          line:
            '\x1B[31m[Nest] 24 - 07/09/2026, 9:00:31 PM ERROR [System] HttpException: Authorization token is required\x1B[39m',
        },
      ],
    });

    expect(result.application).toBe('PRMS');
    expect(result.environment).toBe('test');
    expect(result.occurrences).toBe(3);
    // Rendered in America/Bogota (UTC-5), not reprinted as the 9:00 PM UTC
    // wall clock the log line carries.
    expect(result.firstOccurrence).toContain('4:00:31 PM');
    expect(result.lastOccurrence).toContain('4:00:46 PM');
    expect(result.firstOccurrenceNs).toBe('1783630831000000000');
    expect(result.lastOccurrenceNs).toBe('1783630846000000000');
    expect(result.representativeLogs).toHaveLength(1);
    expect(result.representativeLogs[0]).not.toContain('\x1B[');
    expect(result.representativeLogs[0]).toContain('HttpException');
    // The representative line is the most recent occurrence of the group.
    expect(result.representativeLogs[0]).toContain('9:00:46 PM');
  });

  it('keeps first/last occurrence chronological when logs carry no embedded timestamp', () => {
    const result = preprocessLogs({
      alert,
      timezone: 'UTC',
      dateFormat: 'MM/DD/YYYY',
      maxInputChars: 6000,
      entries: [
        { timestampNs: '1719086502000000000', line: 'ERROR newest failure' },
        { timestampNs: '1719086500000000000', line: 'ERROR oldest failure' },
      ],
    });

    expect(result.firstOccurrenceNs).toBe('1719086500000000000');
    expect(result.lastOccurrenceNs).toBe('1719086502000000000');
    expect(result.firstOccurrence).toContain('8:01:40 PM');
    expect(result.lastOccurrence).toContain('8:01:42 PM');
  });

  it('converts the UTC clock in the log line to the configured timezone', () => {
    const entries = [
      {
        timestampNs: '1783630831000000000',
        line:
          '[Nest] 25 - 07/09/2026, 9:00:31 PM ERROR [System] HttpException: Authorization token is required',
      },
    ];

    const bogota = preprocessLogs({
      alert,
      timezone: 'America/Bogota',
      dateFormat: 'MM/DD/YYYY',
      maxInputChars: 6000,
      entries,
    });

    const tokyo = preprocessLogs({
      alert,
      timezone: 'Asia/Tokyo',
      dateFormat: 'MM/DD/YYYY',
      maxInputChars: 6000,
      entries,
    });

    // Same instant, two zones: proof the embedded 9:00 PM is not just reprinted.
    expect(bogota.firstOccurrence).toContain('4:00:31 PM');
    expect(bogota.firstOccurrence).not.toContain('9:00:31 PM');
    expect(tokyo.firstOccurrence).toContain('6:00:31 AM');

    // The offset travels with the time so the reader cannot misread the zone.
    expect(bogota.firstOccurrence).toContain('GMT-5');
  });

  it('falls back to the log line clock when no timezone is configured', () => {
    // Bedrock disabled leaves LOG_TIMEZONE empty; showing the raw clock beats
    // showing nothing.
    const result = preprocessLogs({
      alert,
      timezone: '',
      dateFormat: '',
      maxInputChars: 6000,
      entries: [
        {
          timestampNs: '1783630831000000000',
          line:
            '[Nest] 25 - 07/09/2026, 9:00:31 PM ERROR [System] HttpException: token required',
        },
      ],
    });

    expect(result.firstOccurrence).toContain('9:00:31 PM');
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
