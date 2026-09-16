import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo } from '../aws/clients';
import { config } from '../config';

export interface Item {
  pk: string;
  sk: string;
  gsi1pk?: string;
  gsi1sk?: string;
  ttl?: number;
  [k: string]: unknown;
}

export interface QueryOpts {
  limit?: number;
  desc?: boolean;
  skPrefix?: string;
}

/** Minimal key-value + query interface so tests can swap an in-memory fake. */
export interface KV {
  get(pk: string, sk: string): Promise<Item | undefined>;
  put(item: Item, condition?: 'not_exists'): Promise<boolean>;
  del(pk: string, sk: string): Promise<void>;
  query(pk: string, skPrefix?: string, opts?: QueryOpts): Promise<Item[]>;
  queryGsi1(gsi1pk: string, opts?: QueryOpts): Promise<Item[]>;
  acquireLease(pk: string, sk: string, holder: string, ttlSec: number): Promise<boolean>;
}

let doc: DynamoDBDocumentClient | undefined;
const client = () => (doc ??= DynamoDBDocumentClient.from(dynamo(), { marshallOptions: { removeUndefinedValues: true } }));

export class DynamoKV implements KV {
  constructor(private readonly table = config().tableName) {}

  async get(pk: string, sk: string) {
    const out = await client().send(new GetCommand({ TableName: this.table, Key: { pk, sk } }));
    return out.Item as Item | undefined;
  }

  async put(item: Item, condition?: 'not_exists') {
    try {
      await client().send(new PutCommand({ TableName: this.table, Item: item, ConditionExpression: condition ? 'attribute_not_exists(pk)' : undefined }));
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  async del(pk: string, sk: string) {
    await client().send(new DeleteCommand({ TableName: this.table, Key: { pk, sk } }));
  }

  private async paged(input: { index?: string; keyExpr: string; values: Record<string, unknown> }, opts: QueryOpts) {
    const items: Item[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const out = await client().send(
        new QueryCommand({
          TableName: this.table,
          IndexName: input.index,
          KeyConditionExpression: input.keyExpr,
          ExpressionAttributeValues: input.values,
          ScanIndexForward: !opts.desc,
          Limit: opts.limit,
          ExclusiveStartKey: key,
        }),
      );
      items.push(...((out.Items ?? []) as Item[]));
      key = out.LastEvaluatedKey;
    } while (key && (!opts.limit || items.length < opts.limit));
    return opts.limit ? items.slice(0, opts.limit) : items;
  }

  query(pk: string, skPrefix?: string, opts: QueryOpts = {}) {
    return this.paged(
      skPrefix ? { keyExpr: 'pk = :pk AND begins_with(sk, :sk)', values: { ':pk': pk, ':sk': skPrefix } } : { keyExpr: 'pk = :pk', values: { ':pk': pk } },
      opts,
    );
  }

  queryGsi1(gsi1pk: string, opts: QueryOpts = {}) {
    return this.paged(
      opts.skPrefix
        ? { index: 'gsi1', keyExpr: 'gsi1pk = :pk AND begins_with(gsi1sk, :sk)', values: { ':pk': gsi1pk, ':sk': opts.skPrefix } }
        : { index: 'gsi1', keyExpr: 'gsi1pk = :pk', values: { ':pk': gsi1pk } },
      opts,
    );
  }

  async acquireLease(pk: string, sk: string, holder: string, ttlSec: number) {
    const now = Math.floor(Date.now() / 1000);
    try {
      await client().send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk, sk },
          UpdateExpression: 'SET holder = :h, expires = :e',
          ConditionExpression: 'attribute_not_exists(expires) OR expires < :now OR holder = :h',
          ExpressionAttributeValues: { ':h': holder, ':e': now + ttlSec, ':now': now },
        }),
      );
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }
}

/** In-memory implementation for unit tests and `AUTH_MODE=dev` without a table. */
export class MemoryKV implements KV {
  items = new Map<string, Item>();

  private key(pk: string, sk: string) {
    return `${pk} ${sk}`;
  }

  async get(pk: string, sk: string) {
    return this.items.get(this.key(pk, sk));
  }

  async put(item: Item, condition?: 'not_exists') {
    const k = this.key(item.pk, item.sk);
    if (condition === 'not_exists' && this.items.has(k)) return false;
    this.items.set(k, structuredClone(item));
    return true;
  }

  async del(pk: string, sk: string) {
    this.items.delete(this.key(pk, sk));
  }

  async query(pk: string, skPrefix = '', opts: QueryOpts = {}) {
    const out = [...this.items.values()].filter((i) => i.pk === pk && i.sk.startsWith(skPrefix)).sort((a, b) => a.sk.localeCompare(b.sk));
    if (opts.desc) out.reverse();
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  async queryGsi1(gsi1pk: string, opts: QueryOpts = {}) {
    const out = [...this.items.values()]
      .filter((i) => i.gsi1pk === gsi1pk && (!opts.skPrefix || (i.gsi1sk ?? '').startsWith(opts.skPrefix)))
      .sort((a, b) => (a.gsi1sk ?? '').localeCompare(b.gsi1sk ?? ''));
    if (opts.desc) out.reverse();
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  async acquireLease(pk: string, sk: string, holder: string, ttlSec: number) {
    const now = Math.floor(Date.now() / 1000);
    const cur = this.items.get(this.key(pk, sk)) as (Item & { holder?: string; expires?: number }) | undefined;
    if (cur && cur.expires !== undefined && cur.expires >= now && cur.holder !== holder) return false;
    this.items.set(this.key(pk, sk), { pk, sk, holder, expires: now + ttlSec });
    return true;
  }
}
