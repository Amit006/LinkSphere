import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ShortenedUrl } from '@linksphere/core';

/**
 * DynamoDB Document client singleton.
 * Same warm-start pattern as Redis — reuse connection across invocations.
 */
const ddbClient = new DynamoDBClient({
  region: process.env['AWS_REGION'] ?? 'ap-south-1',
  maxAttempts: 3,
});

const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
});

const URLS_TABLE = process.env['DYNAMODB_TABLE_URLS']!;
const COUNTERS_TABLE = process.env['DYNAMODB_TABLE_COUNTERS']!;

// ─── URL Repository ────────────────────────────────────────────────────────

export const UrlRepository = {
  /**
   * Get a URL by short code.
   * Called on every redirect — must be fast.
   */
  async getByCode(shortCode: string): Promise<ShortenedUrl | null> {
    const result = await docClient.send(
      new GetCommand({
        TableName: URLS_TABLE,
        Key: { shortCode },
        // Only fetch what we need for redirect (not analytics fields)
        ProjectionExpression: 'shortCode, originalUrl, isActive, expiresAt, userId',
      })
    );

    if (!result.Item) return null;
    return result.Item as ShortenedUrl;
  },

  /**
   * Create a new shortened URL.
   * Uses ConditionExpression to prevent overwriting an existing code.
   */
  async create(url: ShortenedUrl): Promise<void> {
    await docClient.send(
      new PutCommand({
        TableName: URLS_TABLE,
        Item: {
          ...url,
          // DynamoDB TTL: Unix timestamp in seconds
          ...(url.expiresAt && { ttl: Math.floor(new Date(url.expiresAt).getTime() / 1000) }),
        },
        // Fail if the short code already exists (collision safety)
        ConditionExpression: 'attribute_not_exists(shortCode)',
      })
    );
  },

  /**
   * Atomically increment click count.
   * We don't wait for this on the redirect path — fire and forget.
   */
  async incrementClickCount(shortCode: string): Promise<void> {
    await docClient.send(
      new UpdateCommand({
        TableName: URLS_TABLE,
        Key: { shortCode },
        UpdateExpression: 'ADD clickCount :inc',
        ExpressionAttributeValues: { ':inc': 1 },
      })
    );
  },

  /**
   * Get all URLs for a user, sorted by creation time descending.
   */
  async getByUserId(userId: string, limit = 50): Promise<ShortenedUrl[]> {
    const result = await docClient.send(
      new QueryCommand({
        TableName: URLS_TABLE,
        IndexName: 'userId-createdAt-index',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ScanIndexForward: false, // descending by createdAt
        Limit: limit,
      })
    );

    return (result.Items ?? []) as ShortenedUrl[];
  },

  /**
   * Soft-delete a URL by marking it inactive.
   */
  async deactivate(shortCode: string): Promise<void> {
    await docClient.send(
      new UpdateCommand({
        TableName: URLS_TABLE,
        Key: { shortCode },
        UpdateExpression: 'SET isActive = :false',
        ExpressionAttributeValues: { ':false': false },
      })
    );
  },
};

// ─── Counter Repository ────────────────────────────────────────────────────

export const CounterRepository = {
  /**
   * Atomically increment a named counter and return the new value.
   *
   * Interview talking point: "I use a DynamoDB atomic counter to generate
   * globally unique monotonic IDs. DynamoDB ADD is atomic — no two Lambdas
   * can get the same value, even running concurrently."
   */
  async increment(counterName: string): Promise<bigint> {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: COUNTERS_TABLE,
        Key: { counterName },
        UpdateExpression: 'ADD #val :inc',
        ExpressionAttributeNames: { '#val': 'value' },
        ExpressionAttributeValues: { ':inc': 1 },
        ReturnValues: 'UPDATED_NEW',
      })
    );

    return BigInt(result.Attributes!['value'] as number);
  },
};
