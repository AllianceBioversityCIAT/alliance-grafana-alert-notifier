import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    constructor(public config: unknown) {}
  },
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({ send: (...args: unknown[]) => mockSend(...args) }),
  },
  PutCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  QueryCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

import { putHistoryItem, queryHistoryDay } from '../src/history/dynamodb-client.js';

const target = {
  region: 'us-east-1',
  tableName: 'grafana-alert-history-test',
  partitionKey: 'DAY#2026-08-11',
};

describe('queryHistoryDay', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('follows LastEvaluatedKey until the partition is exhausted', async () => {
    // A single page would silently truncate a busy day at DynamoDB's 1 MB cap,
    // which would make the weekly report undercount without any error.
    mockSend
      .mockResolvedValueOnce({
        Items: [{ signature: 'aaa' }, { signature: 'bbb' }],
        LastEvaluatedKey: { pk: 'DAY#2026-08-11', sk: 'cursor-1' },
      })
      .mockResolvedValueOnce({
        Items: [{ signature: 'ccc' }],
        LastEvaluatedKey: { pk: 'DAY#2026-08-11', sk: 'cursor-2' },
      })
      .mockResolvedValueOnce({ Items: [{ signature: 'ddd' }] });

    const items = await queryHistoryDay(target);

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.signature)).toEqual([
      'aaa',
      'bbb',
      'ccc',
      'ddd',
    ]);
  });

  it('passes the cursor forward and starts without one', async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [],
        LastEvaluatedKey: { pk: 'DAY#2026-08-11', sk: 'cursor-1' },
      })
      .mockResolvedValueOnce({ Items: [] });

    await queryHistoryDay(target);

    expect(mockSend.mock.calls[0][0].input.ExclusiveStartKey).toBeUndefined();
    expect(mockSend.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      pk: 'DAY#2026-08-11',
      sk: 'cursor-1',
    });
  });

  it('queries the requested partition and returns an empty day as empty', async () => {
    mockSend.mockResolvedValueOnce({});

    const items = await queryHistoryDay(target);

    expect(items).toEqual([]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input).toMatchObject({
      TableName: 'grafana-alert-history-test',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeValues: { ':pk': 'DAY#2026-08-11' },
    });
  });

  it('propagates a query failure to the caller', async () => {
    mockSend.mockRejectedValueOnce(new Error('AccessDeniedException'));

    await expect(queryHistoryDay(target)).rejects.toThrow('AccessDeniedException');
  });
});

describe('putHistoryItem', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('writes the item to the requested table', async () => {
    mockSend.mockResolvedValueOnce({});

    await putHistoryItem({
      region: 'us-east-1',
      tableName: 'grafana-alert-history-test',
      item: { pk: 'DAY#2026-08-11', sk: '2026-08-11T00:00:00.000Z#abc' },
    });

    expect(mockSend.mock.calls[0][0].input).toMatchObject({
      TableName: 'grafana-alert-history-test',
      Item: { pk: 'DAY#2026-08-11' },
    });
  });
});
