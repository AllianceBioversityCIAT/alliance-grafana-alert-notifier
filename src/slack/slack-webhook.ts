import {
  buildSlackMessage,
  buildSlackWorkflowPayload,
  type BuildSlackMessageInput,
  type SlackWorkflowPayload,
} from './build-slack-message.js';

export type SlackIncomingPayload = { text: string };
export type SlackWebhookPayload = SlackIncomingPayload | SlackWorkflowPayload;

export function isSlackWorkflowWebhook(webhookUrl: string): boolean {
  try {
    return new URL(webhookUrl).pathname.includes('/triggers/');
  } catch {
    return false;
  }
}

export function buildSlackWebhookPayload(
  input: BuildSlackMessageInput,
  webhookUrl: string,
): SlackWebhookPayload {
  if (isSlackWorkflowWebhook(webhookUrl)) {
    return buildSlackWorkflowPayload(input);
  }

  return { text: buildSlackMessage(input) };
}
