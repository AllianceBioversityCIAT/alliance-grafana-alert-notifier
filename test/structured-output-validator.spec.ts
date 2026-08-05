import { describe, it, expect } from 'vitest';
import {
  applyConfidenceThreshold,
  parseBedrockNormalizedEvent,
} from '../src/bedrock/structured-output-validator.js';

const validJson = JSON.stringify({
  usuario: null,
  modulo: 'System',
  momento: '2026-07-09T21:00:46-05:00',
  caso: 'Authorization token is required',
  tipoError: 'HttpException',
  confianza: {
    usuario: 0,
    modulo: 1,
    momento: 1,
    caso: 0.98,
    tipoError: 1,
  },
  evidencia: {
    usuario: null,
    modulo: '[System]',
    momento: '07/09/2026, 9:00:46 PM',
    caso: 'HttpException: Authorization token is required',
    tipoError: 'HttpException',
  },
});

describe('structured-output-validator', () => {
  it('parses a valid Bedrock JSON response', () => {
    const parsed = parseBedrockNormalizedEvent(validJson);
    expect(parsed.modulo).toBe('System');
    expect(parsed.usuario).toBeNull();
    expect(parsed.tipoError).toBe('HttpException');
  });

  it('accepts null fields', () => {
    const parsed = parseBedrockNormalizedEvent(
      JSON.stringify({
        usuario: null,
        modulo: null,
        momento: null,
        caso: null,
        tipoError: null,
        confianza: {},
        evidencia: {},
      }),
    );

    expect(parsed.usuario).toBeNull();
    expect(parsed.caso).toBeNull();
  });

  it('rejects invalid JSON', () => {
    expect(() => parseBedrockNormalizedEvent('not-json')).toThrow(/valid JSON/i);
  });

  it('nulls fields below the confidence threshold', () => {
    const parsed = parseBedrockNormalizedEvent(validJson);
    const filtered = applyConfidenceThreshold(parsed, 0.99);

    expect(filtered.modulo).toBe('System');
    expect(filtered.caso).toBeNull();
    expect(filtered.tipoError).toBe('HttpException');
  });
});
