import { describe, it, expect, vi } from 'vitest';
import { getLookbackWindow, getTimeWindowFromRange } from '../src/utils/time-window.js';

describe('getLookbackWindow', () => {
  it('returns nanosecond start/end for the requested lookback', () => {
    const now = 1_719_086_500_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const window = getLookbackWindow(5);

    expect(window.endNs).toBe(String(now * 1_000_000));
    expect(window.startNs).toBe(String((now - 5 * 60 * 1000) * 1_000_000));

    vi.useRealTimers();
  });

  it('builds a window from ISO start and end times', () => {
    const window = getTimeWindowFromRange(
      '2026-06-25T07:00:00Z',
      '2026-06-25T07:10:00Z',
    );

    expect(window.startNs).toBe(String(Date.parse('2026-06-25T07:00:00Z') * 1_000_000));
    expect(window.endNs).toBe(String(Date.parse('2026-06-25T07:10:00Z') * 1_000_000));
  });
});
