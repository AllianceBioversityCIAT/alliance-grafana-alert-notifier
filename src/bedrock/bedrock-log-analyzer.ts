import type { BedrockConfig } from '../grafana/grafana-payload.types.js';
import type {
  BedrockNormalizedEvent,
  PreprocessedLogEvent,
} from '../types/normalized-log-event.js';
import { converseJson } from './bedrock-client.js';
import { BEDROCK_SYSTEM_PROMPT, buildBedrockUserPrompt } from './prompts.js';
import {
  applyConfidenceThreshold,
  parseBedrockNormalizedEvent,
} from './structured-output-validator.js';

export interface AnalyzeLogsResult {
  analysis: BedrockNormalizedEvent | null;
  usedBedrock: boolean;
  fallbackReason?: string;
}

export async function analyzeLogsWithBedrock(input: {
  preprocessed: PreprocessedLogEvent;
  config: BedrockConfig;
  converse?: typeof converseJson;
}): Promise<AnalyzeLogsResult> {
  if (!input.config.enabled) {
    return {
      analysis: null,
      usedBedrock: false,
      fallbackReason: 'bedrock_disabled',
    };
  }

  if (!input.config.modelId) {
    console.error('Bedrock enabled but BEDROCK_MODEL_ID is missing');
    return {
      analysis: null,
      usedBedrock: false,
      fallbackReason: 'missing_model_id',
    };
  }

  const converse = input.converse ?? converseJson;

  try {
    console.info('Bedrock invocation started', {
      modelId: input.config.modelId,
      region: input.config.region,
      representativeLogCount: input.preprocessed.representativeLogs.length,
      occurrences: input.preprocessed.occurrences,
    });

    const result = await converse({
      region: input.config.region,
      modelId: input.config.modelId,
      systemPrompt: BEDROCK_SYSTEM_PROMPT,
      userPrompt: buildBedrockUserPrompt(input.preprocessed),
      maxTokens: input.config.maxTokens,
      timeoutMs: input.config.timeoutMs,
    });

    const parsed = parseBedrockNormalizedEvent(result.text);
    const analysis = applyConfidenceThreshold(
      parsed,
      input.config.confidenceThreshold,
    );

    console.info('Bedrock invocation succeeded', {
      modelId: input.config.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
    });

    return {
      analysis,
      usedBedrock: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Bedrock invocation failed; falling back to legacy Slack message', {
      modelId: input.config.modelId,
      region: input.config.region,
      error: message,
    });

    return {
      analysis: null,
      usedBedrock: false,
      fallbackReason: message,
    };
  }
}
