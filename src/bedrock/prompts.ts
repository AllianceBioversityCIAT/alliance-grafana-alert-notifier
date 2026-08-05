export const BEDROCK_SYSTEM_PROMPT = `You are a log normalization assistant. You extract structured fields from application error logs.

Rules:
- Return ONLY a single JSON object. No markdown. No commentary.
- Never invent information. If a value is not present or not confident enough, use null.
- Do not infer user, endpoint, root cause, responsible application, attacker, or recommended solution without explicit evidence in the logs.
- "caso" must be a short description of the observed event based only on the log content, written in English.
- "modulo" is the bracketed context tag that follows the log level in the line, e.g. "ERROR [BilateralAiConsumer]" gives "BilateralAiConsumer". Never use the application, project, or job name as "modulo". If no bracketed tag follows the log level, use null.
- "tipoError" is the exception or error class name, e.g. "HttpException", "AxiosError", "TypeError". Never use the log level ("ERROR", "WARN", "FATAL") as "tipoError". If no class name appears in the logs, use null.
- Include per-field confidence scores from 0 to 1 and the textual evidence used.

Required JSON shape:
{
  "usuario": string|null,
  "modulo": string|null,
  "momento": string|null,
  "caso": string|null,
  "tipoError": string|null,
  "confianza": {
    "usuario": number,
    "modulo": number,
    "momento": number,
    "caso": number,
    "tipoError": number
  },
  "evidencia": {
    "usuario": string|null,
    "modulo": string|null,
    "momento": string|null,
    "caso": string|null,
    "tipoError": string|null
  }
}`;

export function buildBedrockUserPrompt(input: {
  alertName: string;
  status: string;
  job: string;
  application: string | null;
  environment: string | null;
  timezone: string;
  dateFormat: string;
  occurrences: number;
  firstOccurrence: string | null;
  lastOccurrence: string | null;
  representativeLogs: string[];
}): string {
  return [
    'Normalize the following consolidated alert logs into the required JSON schema.',
    `Timezone: ${input.timezone}`,
    `Date format hint: ${input.dateFormat}`,
    `Alert name: ${input.alertName}`,
    `Status: ${input.status}`,
    `Job: ${input.job}`,
    `Application (deterministic): ${input.application ?? 'null'}`,
    `Environment (deterministic): ${input.environment ?? 'null'}`,
    'Application and environment above are context only. Never reuse them as "modulo".',
    `Occurrences: ${input.occurrences}`,
    `First occurrence: ${input.firstOccurrence ?? 'null'}`,
    `Last occurrence: ${input.lastOccurrence ?? 'null'}`,
    'Prefer deterministic timestamps above when normalizing "momento".',
    'Representative logs:',
    ...input.representativeLogs.map((line) => `- ${line}`),
  ].join('\n');
}
