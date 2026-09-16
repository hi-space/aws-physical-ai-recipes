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
it('uses strong primary-table scan pages for historical protection even when a page matches no workflows',async()=>{
  const commands:any[]=[];let count=0;
  const proto=(DynamoDBDocumentClient.prototype as any);
  const fake={send:async(command:any)=>{commands.push(command);return ++count===1?{Items:[],LastEvaluatedKey:{pk:'OTHER#row',sk:'META'}}:{Items:[{pk:'WF#old',sk:'META'}]};}};
  // Each test client is supplied before the lazily initialized SDK document client.
  vi.spyOn(proto,'send').mockImplementation(fake.send);
  vi.spyOn(DynamoDBDocumentClient,'from').mockReturnValue(fake as unknown as DynamoDBDocumentClient);
  // The module may already hold the previous test's document-client fake; isolated
  // module loading gives this test its own lazy instance.
  vi.resetModules();const {DynamoKV:FreshKV}=await import('./dynamo');
  const kv=new FreshKV('table'),first=await kv.scanPage();
  expect(first.items).toEqual([]);expect(first.cursor).toBeDefined();
  const last=await kv.scanPage(first.cursor);expect(last.items[0].pk).toBe('WF#old');
  expect(commands.every(c=>c.constructor.name==='ScanCommand'&&c.input.ConsistentRead===true&&!c.input.IndexName)).toBe(true);
  expect(commands[1].input.ExclusiveStartKey).toEqual({pk:'OTHER#row',sk:'META'});
});
