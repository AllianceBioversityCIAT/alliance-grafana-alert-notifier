import { describe, it, expect } from 'vitest';
import { extractApplicationMetadata } from '../src/utils/metadata-extractor.js';

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
