import { describe, it, expect } from 'vitest';
import {
  buildErrorSignature,
  normalizeSignatureText,
} from '../src/history/error-signature.js';

function signatureOf(representativeLine: string): string {
  return buildErrorSignature({ representativeLine }).signature;
}

describe('buildErrorSignature', () => {
  it('collapses the motivating ClarisaTaskService pair into one signature', () => {
    // The two lines that made the gap concrete: same defect, different ids.
    const first = signatureOf(
      'ERROR [ClarisaTaskService] [15] Error saving item with id/code: 39',
    );
    const second = signatureOf(
      'ERROR [ClarisaTaskService] [28] Error saving item with id/code: 6259',
    );

    expect(first).toBe(second);
  });

  it('keeps distinct HTTP status codes apart', () => {
    // Under-normalize rather than over-normalize: these are distinct problems,
    // and merging them would make both invisible in the report.
    expect(signatureOf('AxiosError: Request failed with status code 500')).not.toBe(
      signatureOf('AxiosError: Request failed with status code 404'),
    );
  });

  it('collapses UUIDs', () => {
    expect(
      signatureOf('Result 3f2504e0-4f89-11d3-9a0c-0305e82c3301 not found'),
    ).toBe(signatureOf('Result 8a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d not found'));

    expect(
      normalizeSignatureText('Result 3f2504e0-4f89-11d3-9a0c-0305e82c3301 not found'),
    ).toContain('<UUID>');
  });

  it('collapses retry counters', () => {
    expect(signatureOf('ETIMEDOUT on attempt 1/3')).toBe(
      signatureOf('ETIMEDOUT on attempt 3/3'),
    );
    expect(normalizeSignatureText('ETIMEDOUT on attempt 2/3')).toContain(
      'attempt <N>/<N>',
    );
  });

  it('collapses container hashes and IP addresses', () => {
    expect(
      normalizeSignatureText(
        'read /var/lib/docker/containers/9f8e7d6c5b4a3210fedcba9876543210 failed',
      ),
    ).toContain('<CONTAINER>');

    expect(signatureOf('connect ECONNREFUSED 10.0.1.23')).toBe(
      signatureOf('connect ECONNREFUSED 192.168.4.7'),
    );
  });

  it('collapses quoted numeric identifiers', () => {
    expect(signatureOf("Entity '6259' is missing")).toBe(
      signatureOf("Entity '39' is missing"),
    );
  });

  it('strips timestamps through normalizeMessageKey without modifying it', () => {
    expect(
      signatureOf('[Nest] 24 - 07/09/2026, 9:00:46 PM ERROR [System] HttpException'),
    ).toBe(
      signatureOf('[Nest] 31 - 07/10/2026, 4:15:02 AM ERROR [System] HttpException'),
    );
  });

  it('separates patterns that differ by module or error type via the line itself', () => {
    // The bracketed module and the exception class live in the line, so they
    // still discriminate — deterministically, without Bedrock.
    expect(
      signatureOf('ERROR [ClarisaTaskService] Error saving item with id: 39'),
    ).not.toBe(
      signatureOf('ERROR [BilateralAiTextMiningService] Error saving item with id: 39'),
    );

    expect(signatureOf('ERROR [System] QueryFailedError: write failed')).not.toBe(
      signatureOf('ERROR [System] ETIMEDOUT: write failed'),
    );
  });

  it('does not depend on whether Bedrock answered', () => {
    // Observed in production on 2026-08-11: the same line was stored under two
    // signatures because Bedrock failed to parse its own response on one alert,
    // leaving modulo and tipoError null. That split the pattern and would have
    // broken its streak. The signature must not move for that reason.
    const line =
      '[Nest] 25 - 08/11/2026, 7:45:55 PM ERROR [System] HttpException: Authorization token is required';

    const result = buildErrorSignature({ representativeLine: line });

    expect(result.signature).toMatch(/^[0-9a-f]{16}$/);
    expect(result.signatureText).toBe(
      '[Nest] PID - <TIMESTAMP> ERROR [System] HttpException: Authorization token is required',
    );
    // Both the module and the exception class survive in the text, so the
    // report can still name the pattern without the analysis.
    expect(result.signatureText).toContain('[System]');
    expect(result.signatureText).toContain('HttpException');
  });

  it('names the pattern in readable text and hashes to 16 hex characters', () => {
    const result = buildErrorSignature({
      representativeLine:
        'ERROR [ClarisaTaskService] [15] Error saving item with id/code: 39',
    });

    expect(result.signature).toMatch(/^[0-9a-f]{16}$/);
    expect(result.signatureText).toContain('ClarisaTaskService');
    expect(result.signatureText).toContain('<ID>');
    // Stable across calls: the report depends on equality holding over weeks.
    expect(
      buildErrorSignature({
        representativeLine:
          'ERROR [ClarisaTaskService] [28] Error saving item with id/code: 6259',
      }).signature,
    ).toBe(result.signature);
  });
});
