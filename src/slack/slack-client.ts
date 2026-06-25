const HTTP_TIMEOUT_MS = 10_000;

export interface SlackMessagePayload {
  text: string;
}

export async function sendSlackMessage(
  webhookUrl: string,
  message: SlackMessagePayload,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Slack webhook failed with status ${response.status}: ${body.slice(0, 200)}`,
    );
  }
}
