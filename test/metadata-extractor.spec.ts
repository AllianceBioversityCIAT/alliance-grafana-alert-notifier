import { describe, it, expect } from 'vitest';
import {
  extractApplicationMetadata,
  formatDisplayTime,
  formatNsTimestamp,
} from '../src/utils/metadata-extractor.js';

describe('extractApplicationMetadata', () => {
  it('extracts application and environment from alert name', () => {
    expect(
      extractApplicationMetadata({
        alertName: 'PRMS Test - Loki Error Alert',
        job: 'other',
      }),
    ).toEqual({ application: 'PRMS', environment: 'test' });
  });

  it('extracts application and environment from job when alert has none', () => {
    expect(
      extractApplicationMetadata({
        alertName: 'Loki Error Alert',
        job: 'docker_prms_test',
      }),
    ).toEqual({ application: 'PRMS', environment: 'test' });
  });

  it('strips Loki/Error Alert suffixes without a separator dash', () => {
    expect(
      extractApplicationMetadata({
        alertName: 'Billing Prod Loki Error Alert',
        job: 'unknown',
      }),
    ).toEqual({ application: 'Billing', environment: 'prod' });
  });

  it('supports other projects and environments from job tokens', () => {
    expect(
      extractApplicationMetadata({
        alertName: 'High error rate',
        job: 'docker_scheduler_staging',
      }),
    ).toEqual({ application: 'SCHEDULER', environment: 'staging' });
  });

  it('prefers alert-name application over job when both are present', () => {
    expect(
      extractApplicationMetadata({
        alertName: 'Portal QA - Loki Error Alert',
        job: 'docker_prms_test',
      }),
    ).toEqual({ application: 'Portal', environment: 'qa' });
  });

  it('returns nulls when neither alert nor job yield metadata', () => {
    expect(
      extractApplicationMetadata({
        alertName: 'Something happened',
        job: 'docker',
      }),
    ).toEqual({ application: null, environment: null });
  });
});

describe('formatNsTimestamp', () => {
  it('renders the instant in the requested zone with its offset', () => {
    expect(
      formatNsTimestamp('1783630831000000000', 'America/Bogota'),
    ).toBe('07/09/2026, 4:00:31 PM GMT-5');
  });

  it('returns null when no timezone is configured', () => {
    expect(formatNsTimestamp('1783630831000000000', '')).toBeNull();
    expect(formatNsTimestamp('1783630831000000000', '   ')).toBeNull();
  });

  it('returns null for an unparseable timestamp instead of throwing', () => {
    expect(formatNsTimestamp('not-a-number', 'UTC')).toBeNull();
  });
});

describe('formatDisplayTime', () => {
  it('keeps the zone label attached to the clock', () => {
    expect(formatDisplayTime('07/09/2026, 4:00:31 PM GMT-5')).toBe(
      '4:00:31 PM GMT-5',
    );
  });

  it('drops the date from a value carrying no zone label', () => {
    expect(formatDisplayTime('07/09/2026, 9:00:31 PM')).toBe('9:00:31 PM');
  });

  it('handles a bare clock with no date', () => {
    expect(formatDisplayTime('9:00:31 PM')).toBe('9:00:31 PM');
  });

  it('passes through values with no recognizable time', () => {
    expect(formatDisplayTime('unknown')).toBe('unknown');
    expect(formatDisplayTime(null)).toBeNull();
  });
});
