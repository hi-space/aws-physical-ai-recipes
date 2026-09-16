import type { Item } from './dynamo';
export type Condition = {
  absent: true;
} | {
  equals: Record<string, unknown>;
  after?: Record<string, number>;
};
export type Write = {
  kind: 'put';
  item: Item;
  condition?: Condition;
} | {
  kind: 'delete';
  pk: string;
  sk: string;
  condition?: Condition;
} | {
  kind: 'check';
  pk: string;
  sk: string;
  condition: Condition;
};
export function matches(item: Item | undefined, condition?: Condition): boolean {
  if (!condition) return true;
  if ('absent' in condition) return item === undefined;
  return !!item && Object.entries(condition.equals).every(([key, value]) => item[key] === value) && Object.entries(condition.after ?? {}).every(([key, value]) => typeof item[key] === 'number' && item[key] as number > value);
}
export function expression(condition?: Condition): {
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
} {
  if (!condition) return {};
  if ('absent' in condition) return {
    ConditionExpression: 'attribute_not_exists(pk)'
  };
  const names: Record<string, string> = {},
    values: Record<string, unknown> = {},
    parts: string[] = [];
  for (const [key, value] of Object.entries(condition.equals)) {
    const i = parts.length;
    names[`#c${i}`] = key;
    if (value === undefined) parts.push(`attribute_not_exists(#c${i})`);
    else {
      values[`:c${i}`] = value;
      parts.push(`#c${i} = :c${i}`);
    }
  }
  for (const [key, value] of Object.entries(condition.after ?? {})) {
    const i = parts.length;
    names[`#c${i}`] = key;
    values[`:c${i}`] = value;
    parts.push(`#c${i} > :c${i}`);
  }
  return {
    ConditionExpression: parts.length ? parts.join(' AND ') : 'attribute_exists(pk)',
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {})
  };
}
export function isConflict(error: unknown): boolean {
  const e = error as {
    name?: string;
    CancellationReasons?: {
      Code?: string;
    }[];
  };
  return e.name === 'ConditionalCheckFailedException' || e.name === 'TransactionConflictException' || e.name === 'TransactionCanceledException' && !!e.CancellationReasons?.some(r => r.Code === 'ConditionalCheckFailed' || r.Code === 'TransactionConflict');
}
