export function getLookbackWindow(minutes: number): {
  startNs: string;
  endNs: string;
} {
  const endMs = Date.now();
  const startMs = endMs - minutes * 60 * 1000;

  return {
    startNs: String(startMs * 1_000_000),
    endNs: String(endMs * 1_000_000),
  };
}

export function getTimeWindowFromRange(
  startIso: string,
  endIso: string,
): {
  startNs: string;
  endNs: string;
} {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error('Invalid ISO date range');
  }

  if (startMs >= endMs) {
    throw new Error('Start time must be before end time');
  }

  return {
    startNs: String(startMs * 1_000_000),
    endNs: String(endMs * 1_000_000),
  };
}
