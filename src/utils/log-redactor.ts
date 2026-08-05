const REDACTED = '[REDACTED]';

const PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
  {
    pattern: /(Authorization\s*:\s*Bearer\s+)\S+/gi,
    replace: `$1${REDACTED}`,
  },
  {
    pattern: /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
    replace: `$1${REDACTED}`,
  },
  {
    pattern: /(api[_-]?key\s*[=:]\s*)["']?[^\s"',;]+["']?/gi,
    replace: `$1${REDACTED}`,
  },
  {
    pattern: /(x-api-key\s*[=:]\s*)["']?[^\s"',;]+["']?/gi,
    replace: `$1${REDACTED}`,
  },
  {
    pattern: /(password\s*[=:]\s*)["']?[^\s"',;]+["']?/gi,
    replace: `$1${REDACTED}`,
  },
  {
    pattern: /(passwd\s*[=:]\s*)["']?[^\s"',;]+["']?/gi,
    replace: `$1${REDACTED}`,
  },
  {
    pattern: /(secret\s*[=:]\s*)["']?[^\s"',;]+["']?/gi,
    replace: `$1${REDACTED}`,
  },
  {
    pattern: /(cookie\s*[=:]\s*)[^\s;]+/gi,
    replace: `$1${REDACTED}`,
  },
  {
    pattern: /(Authorization\s*[=:]\s*)(?!Bearer\b)[^\s"',;]+/gi,
    replace: `$1${REDACTED}`,
  },
  {
    pattern:
      /((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|https?):\/\/)([^/\s]+)(@)/gi,
    replace: `$1${REDACTED}$3`,
  },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replace } of PATTERNS) {
    result = result.replace(pattern, replace);
  }
  return result;
}

export function redactSecretLines(lines: string[]): string[] {
  return lines.map(redactSecrets);
}
