import { describe, it, expect } from 'vitest';
import { buildLokiQuery } from '../src/loki/build-loki-query.js';

describe('buildLokiQuery', () => {
  it('builds a LogQL query with job and error pattern', () => {
    expect(buildLokiQuery('example-app', 'ERROR')).toBe(
      '{job="example-app"} |= "ERROR"',
    );
  });

  it('escapes double quotes in job and pattern', () => {
    expect(buildLokiQuery('job"with"quotes', 'ERR"OR')).toBe(
      '{job="job\\"with\\"quotes"} |= "ERR\\"OR"',
    );
  });

  it('escapes backslashes in values', () => {
    expect(buildLokiQuery('job\\path', 'ERROR')).toBe(
      '{job="job\\\\path"} |= "ERROR"',
    );
  });
});
