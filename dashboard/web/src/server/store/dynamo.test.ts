import { afterEach, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoKV } from './dynamo';
afterEach(() => vi.restoreAllMocks());
it('follows service pagination and emits strongly consistent primary-key reads', async () => {
  const commands: {
    constructor: {
      name: string;
    };
    input: Record<string, unknown>;
  }[] = [];
  let query = 0;
  vi.spyOn(DynamoDBDocumentClient, 'from').mockReturnValue({
    send: async (command: typeof commands[number]) => {
      commands.push(command);
      if (command.constructor.name === 'GetCommand') return {
        Item: {
          pk: 'WF#r',
          sk: 'META',
          status: 'RUNNING'
        }
      };
      return ++query === 1 ? {
        Items: [{
          pk: 'WF#r',
          sk: 'TASK#a'
        }],
        LastEvaluatedKey: {
          pk: 'WF#r',
          sk: 'TASK#a'
        }
      } : {
        Items: [{
          pk: 'WF#r',
          sk: 'TASK#b'
        }]
      };
    }
  } as unknown as DynamoDBDocumentClient);
  const kv = new DynamoKV('table');
  expect((await kv.get('WF#r', 'META'))?.status).toBe('RUNNING');
  expect((await kv.query('WF#r', 'TASK#')).map(i => i.sk)).toEqual(['TASK#a', 'TASK#b']);
  expect(commands[0].input.ConsistentRead).toBe(true);
  expect(commands[2].input.ExclusiveStartKey).toEqual({
    pk: 'WF#r',
    sk: 'TASK#a'
  });
  expect(commands[1].input.ConsistentRead).toBe(true);
});
