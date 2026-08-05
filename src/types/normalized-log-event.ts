export interface LokiLogEntry {
  timestampNs: string;
  line: string;
  labels?: Record<string, string>;
}

export interface PreprocessedLogEvent {
  alertName: string;
  status: string;
  job: string;
  application: string | null;
  environment: string | null;
  filename?: string;
  timezone: string;
  dateFormat: string;
  occurrences: number;
  firstOccurrence: string | null;
  lastOccurrence: string | null;
  firstOccurrenceNs: string | null;
  lastOccurrenceNs: string | null;
  representativeLogs: string[];
}

export interface FieldConfidence {
  usuario: number;
  modulo: number;
  momento: number;
  caso: number;
  tipoError?: number;
}

export interface FieldEvidence {
  usuario: string | null;
  modulo: string | null;
  momento: string | null;
  caso: string | null;
  tipoError?: string | null;
}

export interface BedrockNormalizedEvent {
  usuario: string | null;
  modulo: string | null;
  momento: string | null;
  caso: string | null;
  tipoError: string | null;
  confianza: FieldConfidence;
  evidencia: FieldEvidence;
}

export interface EnrichedAlertContext {
  preprocessed: PreprocessedLogEvent;
  analysis: BedrockNormalizedEvent | null;
  usedBedrock: boolean;
  bedrockFallbackReason?: string;
}
