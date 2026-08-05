import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLokiQuery } from '../dist/loki/build-loki-query.js';
import { queryLokiErrors } from '../dist/loki/loki-client.js';
import { getLookbackWindow, getTimeWindowFromRange } from '../dist/utils/time-window.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const job = process.argv[2] ?? 'example-app';
const startIso = process.argv[3];
const endIso = process.argv[4];

function loadConfig() {
  const configPath = path.join(rootDir, '.deploy', 'local-loki-test.json');
  const lokiBaseUrl = process.env.LOKI_BASE_URL;
  const errorPattern = process.env.DEFAULT_ERROR_PATTERN ?? 'ERROR';
  const lookbackMinutes = Number.parseInt(process.env.LOOKBACK_MINUTES ?? '5', 10);

  if (lokiBaseUrl) {
    return {
      source: 'environment',
      lokiBaseUrl,
      errorPattern,
      lookbackMinutes,
    };
  }

  try {
    const fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));

    return {
      source: configPath,
      lokiBaseUrl: fileConfig.LOKI_BASE_URL,
      errorPattern: fileConfig.DEFAULT_ERROR_PATTERN ?? 'ERROR',
      lookbackMinutes: Number.parseInt(fileConfig.LOOKBACK_MINUTES ?? '5', 10),
    };
  } catch {
    throw new Error(
      'Set LOKI_BASE_URL, create .deploy/local-loki-test.json, or run npm run test:loki:lambda',
    );
  }
}

async function main() {
  const config = loadConfig();

  if (!config.lokiBaseUrl) {
    console.error(JSON.stringify(config, null, 2));
    process.exit(1);
  }

  const query = buildLokiQuery(job, config.errorPattern);
  const window =
    startIso && endIso
      ? getTimeWindowFromRange(startIso, endIso)
      : getLookbackWindow(config.lookbackMinutes);

  console.log(
    JSON.stringify(
      {
        source: config.source,
        lokiOrigin: new URL(config.lokiBaseUrl).origin,
        job,
        errorPattern: config.errorPattern,
        lookbackMinutes: startIso && endIso ? undefined : config.lookbackMinutes,
        start: startIso ?? undefined,
        end: endIso ?? undefined,
        query,
      },
      null,
      2,
    ),
  );

  try {
    const lines = await queryLokiErrors({
      baseUrl: config.lokiBaseUrl,
      job,
      errorPattern: config.errorPattern,
      window,
      limit: 20,
    });

    console.log(
      JSON.stringify(
        {
          success: true,
          lineCount: lines.length,
          sampleLines: lines,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

main();
