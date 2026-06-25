import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreviewAlert } from '../dist/slack/slack-preview-diagnostic.js';
import { previewSlackMessage } from '../dist/slack/preview-slack-message.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const job = process.argv[2] ?? 'example-app';

function loadConfig() {
  const configPath = path.join(rootDir, '.deploy', 'local-loki-test.json');
  const lokiBaseUrl = process.env.LOKI_BASE_URL;

  if (lokiBaseUrl) {
    return {
      lokiBaseUrl,
      errorPattern: process.env.DEFAULT_ERROR_PATTERN ?? 'ERROR',
      lookbackMinutes: Number.parseInt(process.env.LOOKBACK_MINUTES ?? '5', 10),
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? 'https://example.invalid',
    };
  }

  const fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  return {
    lokiBaseUrl: fileConfig.LOKI_BASE_URL,
    errorPattern: fileConfig.DEFAULT_ERROR_PATTERN ?? 'ERROR',
    lookbackMinutes: Number.parseInt(fileConfig.LOOKBACK_MINUTES ?? '5', 10),
    slackWebhookUrl: fileConfig.SLACK_WEBHOOK_URL ?? 'https://example.invalid',
  };
}

async function main() {
  const config = loadConfig();
  const alert = buildPreviewAlert({
    diagnostic: 'slack-preview',
    job,
    alertname: 'Example Loki Error Alert',
    errorCount: 8,
    filename: '/var/lib/docker/containers/example/container.log',
  });

  const preview = await previewSlackMessage({ alert, config });

  console.log('--- Slack message preview ---');
  console.log(preview.slackMessage);
  console.log('--- End preview ---');
  console.log('');
  console.log(
    JSON.stringify(
      {
        lokiLineCount: preview.lokiLines.length,
        lokiLines: preview.lokiLines,
        lokiError: preview.lokiError,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
