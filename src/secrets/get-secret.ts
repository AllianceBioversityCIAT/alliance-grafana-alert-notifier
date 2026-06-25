const REQUIRED_SECRET_KEYS = [
  'LOKI_BASE_URL',
  'SLACK_WEBHOOK_URL',
  'LOOKBACK_MINUTES',
  'DEFAULT_ERROR_PATTERN',
] as const;

function sanitizeSecretName(secretName: string): string {
  return secretName.replace(/[\r\n]/g, '');
}

export async function getSecretJson<T extends Record<string, string>>(
  secretName: string,
): Promise<T> {
  if (!secretName.trim()) {
    throw new Error('ALERTING_SECRET_NAME environment variable is required');
  }

  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );

  const client = new SecretsManagerClient({});
  const command = new GetSecretValueCommand({
    SecretId: sanitizeSecretName(secretName),
  });

  let response;
  try {
    response = await client.send(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load secret "${sanitizeSecretName(secretName)}": ${message}`,
    );
  }

  const secretString = response.SecretString;
  if (!secretString) {
    throw new Error(
      `Secret "${sanitizeSecretName(secretName)}" does not contain SecretString`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(secretString) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Secret "${sanitizeSecretName(secretName)}" must contain valid JSON`,
    );
  }

  for (const key of REQUIRED_SECRET_KEYS) {
    const value = parsed[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `Secret "${sanitizeSecretName(secretName)}" is missing required key: ${key}`,
      );
    }
  }

  return parsed as T;
}
