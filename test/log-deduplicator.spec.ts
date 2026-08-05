import { describe, it, expect } from 'vitest';
import {
  deduplicateLogLines,
  normalizeMessageKey,
  removeExactDuplicates,
} from '../src/utils/log-deduplicator.js';

describe('log-deduplicator', () => {
  it('removes exact duplicates', () => {
    const lines = [
      'ERROR same',
      'ERROR same',
      'ERROR other',
      'ERROR same',
    ];

    expect(removeExactDuplicates(lines)).toEqual(['ERROR same', 'ERROR other']);
  });

  it('normalizes message keys by ignoring timestamps', () => {
    const a =
      '[Nest] 24 - 07/09/2026, 9:00:46 PM ERROR [System] HttpException: Authorization token is required';
    const b =
      '[Nest] 24 - 07/09/2026, 9:00:40 PM ERROR [System] HttpException: Authorization token is required';

    expect(normalizeMessageKey(a)).toBe(normalizeMessageKey(b));
  });

  it('groups equivalent messages and counts occurrences', () => {
    const lines = [
      '[Nest] 24 - 07/09/2026, 9:00:31 PM ERROR [System] HttpException: Authorization token is required',
      '[Nest] 24 - 07/09/2026, 9:00:40 PM ERROR [System] HttpException: Authorization token is required',
      '[Nest] 24 - 07/09/2026, 9:00:46 PM ERROR [System] HttpException: Authorization token is required',
      '[Nest] 24 - 07/09/2026, 9:01:00 PM ERROR [System] Other failure',
    ];

    const groups = deduplicateLogLines(lines);

    expect(groups).toHaveLength(2);
    expect(groups[0].occurrences).toBe(3);
    expect(groups[0].firstLine).toContain('9:00:31 PM');
    expect(groups[0].lastLine).toContain('9:00:46 PM');
    expect(groups[1].occurrences).toBe(1);
  });
});
