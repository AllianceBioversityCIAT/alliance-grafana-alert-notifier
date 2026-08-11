import { createHash } from 'node:crypto';
import { normalizeMessageKey } from '../utils/log-deduplicator.js';

/**
 * Identifier substitutions applied on top of `normalizeMessageKey`.
 *
 * Deliberate bias: under-normalize rather than over-normalize. Bare numbers are
 * left alone, so `status code 500` and `status code 404` stay distinct patterns
 * — they are distinct problems. The cost is occasionally seeing two signatures
 * where there was one cause; that error is preferable to its inverse, since
 * merging two real problems into one report line makes both invisible.
 */
const SUBSTITUTIONS: Array<{ pattern: RegExp; replacement: string }> = [
  // Container hashes first: the 64-hex path segment would otherwise be eaten by
  // narrower rules further down.
  {
    pattern: /\/var\/lib\/docker\/containers\/[0-9a-f]{12,}/gi,
    replacement: '/var/lib/docker/containers/<CONTAINER>',
  },
  {
    pattern:
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: '<UUID>',
  },
  { pattern: /\battempt\s+\d+\s*\/\s*\d+/gi, replacement: 'attempt <N>/<N>' },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '<IP>' },
  // Numbers introduced by an identifier-ish word: `id/code: 39`, `key = 7`.
  // The separator is mandatory on purpose. Making it optional would also rewrite
  // `status code 500` into `status code <ID>`, collapsing it with `status code
  // 404` — two genuinely distinct problems the bias above exists to keep apart.
  {
    pattern: /\b(id\/code|id|code|key)(\s*[:=]\s*)\d+/gi,
    replacement: '$1$2<ID>',
  },
  { pattern: /#\d+/g, replacement: '#<ID>' },
  // Bracketed bare numbers are worker/attempt indices, not values: the
  // motivating pair `[ClarisaTaskService] [15]` and `[ClarisaTaskService] [28]`
  // is the same defect and must collapse. Narrow enough not to touch the
  // `status code 500` case, which carries no brackets.
  { pattern: /\[\d+\]/g, replacement: '[<N>]' },
  // Quoted numbers are identifiers often enough that collapsing them wins:
  // `'6259'` and `'39'` are the same defect.
  { pattern: /'(\d+)'/g, replacement: "'<ID>'" },
  { pattern: /"(\d+)"/g, replacement: '"<ID>"' },
];

export interface ErrorSignatureInput {
  representativeLine: string;
}

export interface ErrorSignature {
  /** sha256 truncated to 16 hex characters — cheap, stable equality. */
  signature: string;
  /** The readable normalized text, so a report can *name* a pattern. */
  signatureText: string;
}

/** Applies the identifier substitutions without touching `normalizeMessageKey`. */
export function normalizeSignatureText(line: string): string {
  let text = normalizeMessageKey(line);

  for (const { pattern, replacement } of SUBSTITUTIONS) {
    text = text.replace(pattern, replacement);
  }

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Builds the signature that lets the same underlying error be recognized across
 * different weeks.
 *
 * **It is computed from the log line alone, on purpose.** An earlier version
 * also folded in the Bedrock-derived `modulo` and `tipoError`, and production
 * data showed why that was wrong: when Bedrock failed to parse its own response
 * — around one alert in six — those fields were null and the *same* line
 * produced a second signature, splitting the pattern and breaking its streak.
 * A signature that depends on a model answering is not a signature.
 *
 * Nothing is lost by dropping them. The normalized line already carries the
 * bracketed module and the exception class deterministically, as in
 * `ERROR [System] HttpException: ...`, and both fields remain stored on the
 * item for the report to name the pattern with.
 */
export function buildErrorSignature(
  input: ErrorSignatureInput,
): ErrorSignature {
  const signatureText = normalizeSignatureText(input.representativeLine);

  const signature = createHash('sha256')
    .update(signatureText)
    .digest('hex')
    .slice(0, 16);

  return { signature, signatureText };
}
