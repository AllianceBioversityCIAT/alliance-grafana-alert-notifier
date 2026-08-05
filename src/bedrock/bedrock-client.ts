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

/**
 * Clients are cached per region so warm invocations reuse the connection pool
 * instead of paying a TLS handshake on every alert.
 */
const clientsByRegion = new Map<string, BedrockRuntimeClient>();

function getClient(region: string): BedrockRuntimeClient {
  const cached = clientsByRegion.get(region);
  if (cached) {
    return cached;
  }

  const client = new BedrockRuntimeClient({ region });
  clientsByRegion.set(region, client);
  return client;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    /aborted/i.test(error.message)
  );
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
  const client = getClient(input.region);

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
  let response: ConverseCommandOutput;

  try {
    // AbortSignal.timeout uses an unref'd timer, so it never holds the event
    // loop open, and aborting cancels the in-flight request instead of leaving
    // it to finish and bill for a response nobody reads. Promise.race did
    // neither: it only ignored the loser.
    response = await client.send(command, {
      abortSignal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Bedrock converse timed out after ${input.timeoutMs}ms`);
    }
    throw error;
  }

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
