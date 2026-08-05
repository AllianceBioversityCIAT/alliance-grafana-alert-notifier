export function escapeLogqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildLokiQuery(job: string, errorPattern: string): string {
  const escapedJob = escapeLogqlString(job);
  const escapedPattern = escapeLogqlString(errorPattern);
  return `{job="${escapedJob}"} |= "${escapedPattern}"`;
}
