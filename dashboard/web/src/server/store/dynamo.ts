import { expression, isConflict, matches, type Write } from './atomic';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
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
  transaction(writes: Write[]): Promise<boolean>;
  queryGsi1Page(gsi1pk: string, opts?: QueryOpts & {
    cursor?: string;
  }): Promise<{
    items: Item[];
    cursor?: string;
  }>;
  acquireLease(pk: string, sk: string, holder: string, ttlSec: number): Promise<boolean>;
}
let doc: DynamoDBDocumentClient | undefined;
const client = () => doc ??= DynamoDBDocumentClient.from(dynamo(), {
  marshallOptions: {
    removeUndefinedValues: true
  }
});
export class DynamoKV implements KV {
  constructor(private readonly table = config().tableName) {}
  async get(pk: string, sk: string) {
    const out = await client().send(new GetCommand({
      TableName: this.table,
      Key: {
        pk,
        sk
      },
      ConsistentRead: true
    }));
    return out.Item as Item | undefined;
  }
  async put(item: Item, condition?: 'not_exists') {
    try {
      await client().send(new PutCommand({
        TableName: this.table,
        Item: item,
        ConditionExpression: condition ? 'attribute_not_exists(pk)' : undefined
      }));
      return true;
    } catch (e) {
      if ((e as {
        name?: string;
      }).name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }
  async del(pk: string, sk: string) {
    await client().send(new DeleteCommand({
      TableName: this.table,
      Key: {
        pk,
        sk
      }
    }));
  }
  private async paged(input: {
    index?: string;
    keyExpr: string;
    values: Record<string, unknown>;
  }, opts: QueryOpts) {
    const items: Item[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const out = await client().send(new QueryCommand({
        TableName: this.table,
        IndexName: input.index,
        ConsistentRead: input.index ? undefined : true,
        KeyConditionExpression: input.keyExpr,
        ExpressionAttributeValues: input.values,
        ScanIndexForward: !opts.desc,
        Limit: opts.limit,
        ExclusiveStartKey: key
      }));
      items.push(...((out.Items ?? []) as Item[]));
      key = out.LastEvaluatedKey;
    } while (key && (!opts.limit || items.length < opts.limit));
    return opts.limit ? items.slice(0, opts.limit) : items;
  }
  query(pk: string, skPrefix?: string, opts: QueryOpts = {}) {
    return this.paged(skPrefix ? {
      keyExpr: 'pk = :pk AND begins_with(sk, :sk)',
      values: {
        ':pk': pk,
        ':sk': skPrefix
      }
    } : {
      keyExpr: 'pk = :pk',
      values: {
        ':pk': pk
      }
    }, opts);
  }
  queryGsi1(gsi1pk: string, opts: QueryOpts = {}) {
    return this.paged(opts.skPrefix ? {
      index: 'gsi1',
      keyExpr: 'gsi1pk = :pk AND begins_with(gsi1sk, :sk)',
      values: {
        ':pk': gsi1pk,
        ':sk': opts.skPrefix
      }
    } : {
      index: 'gsi1',
      keyExpr: 'gsi1pk = :pk',
      values: {
        ':pk': gsi1pk
      }
    }, opts);
  }
  async transaction(writes: Write[]) {
    try {
      await client().send(new TransactWriteCommand({
        TransactItems: writes.map(w => {
          const common = {
            TableName: this.table,
            ...expression(w.condition)
          };
          if (w.kind === 'put') return {
            Put: {
              ...common,
              Item: w.item
            }
          };
          if (w.kind === 'delete') return {
            Delete: {
              ...common,
              Key: {
                pk: w.pk,
                sk: w.sk
              }
            }
          };
          return {
            ConditionCheck: {
              ...common,
              Key: {
                pk: w.pk,
                sk: w.sk
              },
              ConditionExpression: expression(w.condition).ConditionExpression!
            }
          };
        })
      }));
      return true;
    } catch (e) {
      if (isConflict(e)) return false;
      throw e;
    }
  }
  async queryGsi1Page(gsi1pk: string, opts: QueryOpts & {
    cursor?: string;
  } = {}) {
    const key = decodeCursor(opts.cursor, gsi1pk);
    const out = await client().send(new QueryCommand({
      TableName: this.table,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: {
        ':pk': gsi1pk
      },
      ScanIndexForward: !opts.desc,
      Limit: opts.limit ?? 200,
      ExclusiveStartKey: key
    }));
    return {
      items: (out.Items ?? []) as Item[],
      cursor: out.LastEvaluatedKey ? encodeCursor(out.LastEvaluatedKey) : undefined
    };
  }
  async acquireLease(pk: string, sk: string, holder: string, ttlSec: number) {
    const now = Math.floor(Date.now() / 1000);
    try {
      await client().send(new UpdateCommand({
        TableName: this.table,
        Key: {
          pk,
          sk
        },
        UpdateExpression: 'SET holder = :h, expires = :e',
        ConditionExpression: 'attribute_not_exists(expires) OR expires < :now OR holder = :h',
        ExpressionAttributeValues: {
          ':h': holder,
          ':e': now + ttlSec,
          ':now': now
        }
      }));
      return true;
    } catch (e) {
      if ((e as {
        name?: string;
      }).name === 'ConditionalCheckFailedException') return false;
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
    const item = this.items.get(this.key(pk, sk));
    return item ? structuredClone(item) : undefined;
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
    const out = [...this.items.values()].filter(i => i.pk === pk && i.sk.startsWith(skPrefix)).sort((a, b) => a.sk.localeCompare(b.sk));
    if (opts.desc) out.reverse();
    return opts.limit ? out.slice(0, opts.limit) : out;
  }
  async queryGsi1(gsi1pk: string, opts: QueryOpts = {}) {
    const out = [...this.items.values()].filter(i => i.gsi1pk === gsi1pk && (!opts.skPrefix || (i.gsi1sk ?? '').startsWith(opts.skPrefix))).sort((a, b) => (a.gsi1sk ?? '').localeCompare(b.gsi1sk ?? ''));
    if (opts.desc) out.reverse();
    return opts.limit ? out.slice(0, opts.limit) : out;
  }
  async transaction(writes: Write[]) {
    if (!writes.every(w => matches(this.items.get(this.key(w.kind === 'put' ? w.item.pk : w.pk, w.kind === 'put' ? w.item.sk : w.sk)), w.condition))) return false;
    for (const w of writes) {
      if (w.kind === 'put') this.items.set(this.key(w.item.pk, w.item.sk), structuredClone(w.item));
      if (w.kind === 'delete') this.items.delete(this.key(w.pk, w.sk));
    }
    return true;
  }
  async queryGsi1Page(gsi1pk: string, opts: QueryOpts & {
    cursor?: string;
  } = {}) {
    const key = decodeCursor(opts.cursor, gsi1pk);
    let all = await this.queryGsi1(gsi1pk, {
      desc: opts.desc
    });
    if (key) all = all.filter(i => opts.desc ? String(i.gsi1sk) < String(key.gsi1sk) : String(i.gsi1sk) > String(key.gsi1sk));
    const items = all.slice(0, opts.limit ?? 200);
    const last = items.at(-1);
    return {
      items: structuredClone(items),
      cursor: all.length > items.length && last ? encodeCursor({
        pk: last.pk,
        sk: last.sk,
        gsi1pk,
        gsi1sk: last.gsi1sk
      }) : undefined
    };
  }
  async acquireLease(pk: string, sk: string, holder: string, ttlSec: number) {
    const now = Math.floor(Date.now() / 1000);
    const cur = this.items.get(this.key(pk, sk)) as (Item & {
      holder?: string;
      expires?: number;
    }) | undefined;
    if (cur && cur.expires !== undefined && cur.expires >= now && cur.holder !== holder) return false;
    this.items.set(this.key(pk, sk), {
      pk,
      sk,
      holder,
      expires: now + ttlSec
    });
    return true;
  }
}
const encodeCursor = (key: Record<string, unknown>) => Buffer.from(JSON.stringify(key)).toString('base64url');
function decodeCursor(cursor: string | undefined, partition: string): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 4096) throw new Error();
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (key.gsi1pk !== partition || ['pk', 'sk', 'gsi1sk'].some(k => typeof key[k] !== 'string')) throw new Error();
    return {
      pk: key.pk,
      sk: key.sk,
      gsi1pk: key.gsi1pk,
      gsi1sk: key.gsi1sk
    };
  } catch {
    throw new Error('invalid pagination cursor');
  }
}
