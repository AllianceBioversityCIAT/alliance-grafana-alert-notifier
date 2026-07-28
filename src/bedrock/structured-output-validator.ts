import type {
  BedrockNormalizedEvent,
  FieldConfidence,
  FieldEvidence,
} from '../types/normalized-log-event.js';

const REQUIRED_FIELDS = [
  'usuario',
  'modulo',
  'momento',
  'caso',
  'tipoError',
] as const;

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Bedrock response is empty');
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    }
    throw new Error('Bedrock response is not valid JSON');
  }
}

export function parseBedrockNormalizedEvent(
  raw: string,
): BedrockNormalizedEvent {
  const parsed = extractJsonObject(raw);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Bedrock response JSON must be an object');
  }

  const record = parsed as Record<string, unknown>;

  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) {
      throw new Error(`Bedrock response missing field: ${field}`);
    }
  }

  const confianzaRaw =
    typeof record.confianza === 'object' && record.confianza !== null
      ? (record.confianza as Record<string, unknown>)
      : {};
  const evidenciaRaw =
    typeof record.evidencia === 'object' && record.evidencia !== null
      ? (record.evidencia as Record<string, unknown>)
      : {};

  const confianza: FieldConfidence = {
    usuario: asConfidence(confianzaRaw.usuario),
    modulo: asConfidence(confianzaRaw.modulo),
    momento: asConfidence(confianzaRaw.momento),
    caso: asConfidence(confianzaRaw.caso),
    tipoError: asConfidence(confianzaRaw.tipoError),
  };

  const evidencia: FieldEvidence = {
    usuario: asNullableString(evidenciaRaw.usuario),
    modulo: asNullableString(evidenciaRaw.modulo),
    momento: asNullableString(evidenciaRaw.momento),
    caso: asNullableString(evidenciaRaw.caso),
    tipoError: asNullableString(evidenciaRaw.tipoError),
  };

  return {
    usuario: asNullableString(record.usuario),
    modulo: asNullableString(record.modulo),
    momento: asNullableString(record.momento),
    caso: asNullableString(record.caso),
    tipoError: asNullableString(record.tipoError),
    confianza,
    evidencia,
  };
}

export function applyConfidenceThreshold(
  event: BedrockNormalizedEvent,
  threshold: number,
): BedrockNormalizedEvent {
  const pick = (
    value: string | null,
    confidence: number | undefined,
  ): string | null => {
    if (value === null) {
      return null;
    }
    if ((confidence ?? 0) < threshold) {
      return null;
    }
    return value;
  };

  return {
    usuario: pick(event.usuario, event.confianza.usuario),
    modulo: pick(event.modulo, event.confianza.modulo),
    momento: pick(event.momento, event.confianza.momento),
    caso: pick(event.caso, event.confianza.caso),
    tipoError: pick(event.tipoError, event.confianza.tipoError),
    confianza: event.confianza,
    evidencia: event.evidencia,
  };
}
