import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/utils/log-redactor.js';

describe('log-redactor', () => {
  it('redacts bearer tokens and authorization headers', () => {
    const input =
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example';
    expect(redactSecrets(input)).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts api keys, passwords, cookies, and connection strings', () => {
    expect(redactSecrets('api_key=sk-example-secret-value')).toContain(
      '[REDACTED]',
    );
    expect(redactSecrets('password=SuperSecret123')).toContain('[REDACTED]');
    expect(redactSecrets('Cookie: session=abc123')).toContain('[REDACTED]');
    expect(
      redactSecrets('postgres://user:secretpass@db.example.internal:5432/app'),
    ).toBe('postgres://[REDACTED]@db.example.internal:5432/app');
  });

  it('keeps non-sensitive technical identifiers', () => {
    const input =
      '[Nest] 24 - 07/09/2026, 9:00:46 PM ERROR [System] HttpException: Authorization token is required';
    expect(redactSecrets(input)).toBe(input);
  });
});
