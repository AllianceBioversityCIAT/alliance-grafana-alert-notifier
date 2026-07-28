import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';

export interface BedrockConverseInput {
  region: string;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface BedrockConverseResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

function extractText(output: ConverseCommandOutput): string {
  const content = output.output?.message?.content ?? [];
  const parts: string[] = [];

  for (const block of content) {
    if ('text' in block && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }

  return parts.join('\n').trim();
}

export async function converseJson(input: BedrockConverseInput): Promise<BedrockConverseResult> {
  const client = new BedrockRuntimeClient({ region: input.region });

  const command = new ConverseCommand({
    modelId: input.modelId,
    system: [{ text: input.systemPrompt }],
    messages: [
      {
        role: 'user',
        content: [{ text: input.userPrompt }],
      },
    ],
    inferenceConfig: {
      maxTokens: input.maxTokens,
      temperature: 0,
    },
  });

  const started = Date.now();
  const response = await Promise.race([
    client.send(command),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Bedrock converse timed out after ${input.timeoutMs}ms`));
      }, input.timeoutMs);
    }),
  ]);

  const text = extractText(response);
  if (!text) {
    throw new Error('Bedrock returned an empty response');
  }

  return {
    text,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    latencyMs: Date.now() - started,
  };
}
