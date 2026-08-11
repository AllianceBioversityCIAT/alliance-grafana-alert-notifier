import { converseJson } from '../bedrock/bedrock-client.js';
import type {
  BedrockConfig,
  ReportConfig,
} from '../grafana/grafana-payload.types.js';
import type { ApplicationReport } from './report-aggregator.js';
import {
  buildReportUserPrompt,
  REPORT_SYSTEM_PROMPT,
} from './report-prompts.js';
import type { ReportWeek } from './report-window.js';

/** A narrative longer than this is not a paragraph; it is a second report. */
const MAX_NARRATIVE_CHARS = 1200;

export interface ReportNarrativeResult {
  narrative: string | null;
  usedBedrock: boolean;
  fallbackReason?: string;
}

/**
 * Writes the opening paragraph of one application's report.
 *
 * Mirrors `analyzeLogsWithBedrock`: one object argument, an injectable
 * `converse` so tests never reach AWS, and every failure swallowed into a
 * fallback reason. The report must go out whether or not the model answers —
 * the numbers below the paragraph are the report, and they are computed in
 * code.
 */
export async function writeReportNarrative(input: {
  report: ApplicationReport;
  week: ReportWeek;
  bedrock: BedrockConfig;
  reportConfig: ReportConfig;
  converse?: typeof converseJson;
}): Promise<ReportNarrativeResult> {
  if (!input.bedrock.enabled) {
    return { narrative: null, usedBedrock: false, fallbackReason: 'bedrock_disabled' };
  }

  if (!input.bedrock.modelId) {
    console.error('Bedrock enabled but BEDROCK_MODEL_ID is missing');
    return { narrative: null, usedBedrock: false, fallbackReason: 'missing_model_id' };
  }

  if (input.report.alertCount === 0) {
    // Nothing happened. Asking a model to narrate an empty week invites it to
    // invent something to say.
    return { narrative: null, usedBedrock: false, fallbackReason: 'empty_week' };
  }

  const converse = input.converse ?? converseJson;

  try {
    console.info('Report narrative requested', {
      modelId: input.bedrock.modelId,
      application: input.report.application,
      patterns: input.report.patternCount,
    });

    const result = await converse({
      region: input.bedrock.region,
      modelId: input.bedrock.modelId,
      systemPrompt: REPORT_SYSTEM_PROMPT,
      userPrompt: buildReportUserPrompt({
        report: input.report,
        week: input.week,
      }),
      // Deliberately the report's own budget, not the per-alert one: this
      // answer is prose over aggregates, not a field extraction.
      maxTokens: input.reportConfig.bedrockMaxTokens,
      timeoutMs: input.reportConfig.bedrockTimeoutMs,
    });

    const narrative = result.text.trim().slice(0, MAX_NARRATIVE_CHARS);

    if (!narrative) {
      return {
        narrative: null,
        usedBedrock: false,
        fallbackReason: 'empty_narrative',
      };
    }

    console.info('Report narrative written', {
      application: input.report.application,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
    });

    return { narrative, usedBedrock: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Report narrative failed; posting the deterministic report', {
      application: input.report.application,
      error: message,
    });

    return { narrative: null, usedBedrock: false, fallbackReason: message };
  }
}
