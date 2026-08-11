import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

/**
 * Clients are cached per region so warm invocations reuse the connection pool,
 * mirroring `src/bedrock/bedrock-client.ts`.
 */
const clientsByRegion = new Map<string, DynamoDBDocumentClient>();

function getClient(region: string): DynamoDBDocumentClient {
  const cached = clientsByRegion.get(region);
  if (cached) {
    return cached;
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    // Nullable analysis fields arrive as undefined when Bedrock did not run;
    // dropping them keeps the item free of empty attributes.
    marshallOptions: { removeUndefinedValues: true },
  });
  clientsByRegion.set(region, client);
  return client;
}

export async function putHistoryItem(input: {
  region: string;
  tableName: string;
  item: Record<string, unknown>;
}): Promise<void> {
  const client = getClient(input.region);

  await client.send(
    new PutCommand({
      TableName: input.tableName,
      Item: input.item,
    }),
  );
}

export async function queryHistoryDay(input: {
  region: string;
  tableName: string;
  partitionKey: string;
}): Promise<Record<string, unknown>[]> {
  const client = getClient(input.region);

  const response = await client.send(
    new QueryCommand({
      TableName: input.tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': input.partitionKey },
    }),
  );

  return (response.Items ?? []) as Record<string, unknown>[];
}
