const ANSI_ESCAPE_PATTERN = /\x1B\[[0-9;]*m/g;
const DOCKER_STDOUT_PREFIX = /^\x06?stdout[\x10-\x1F]*/i;
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const PRINTABLE_ASCII_PATTERN = /[^\x20-\x7E]/g;

function normalizeWhitespace(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

function looksLikeDockerFramedLog(line: string): boolean {
  return (
    line.startsWith('\x06') ||
    line.includes('\x06stdout') ||
    DOCKER_STDOUT_PREFIX.test(line)
  );
}

function extractReadableLogFragment(line: string): string {
  const nestIndex = line.indexOf('[Nest]');
  if (nestIndex >= 0) {
    return line.slice(nestIndex);
  }

  const bracketMatch = line.match(/\[[A-Za-z][^\]]*\]/);
  if (bracketMatch?.index !== undefined && bracketMatch.index > 0) {
    return line.slice(bracketMatch.index);
  }

  return line;
}

export function sanitizeLogLine(line: string): string {
  const withoutAnsi = line.replace(ANSI_ESCAPE_PATTERN, '').replace(/\r/g, '');

  if (
    !looksLikeDockerFramedLog(withoutAnsi) &&
    !CONTROL_CHAR_PATTERN.test(withoutAnsi)
  ) {
    return normalizeWhitespace(withoutAnsi);
  }

  const withoutDockerPrefix = withoutAnsi.replace(DOCKER_STDOUT_PREFIX, '');
  const readableFragment = extractReadableLogFragment(withoutDockerPrefix);

  return normalizeWhitespace(
    readableFragment.replace(PRINTABLE_ASCII_PATTERN, ''),
  );
}

export function sanitizeLogLines(lines: string[]): string[] {
  return lines.map(sanitizeLogLine).filter((line) => line.length > 0);
}
