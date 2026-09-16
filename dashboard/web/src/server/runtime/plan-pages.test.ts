import { expect, it } from 'vitest';
import { selectPlanPage, parsePlanPage } from './plan-pages';
import type { AuthContext } from './ledger';
const context = { claims: { workflowId: 'run', task: 'train', projectId: 'p', namespace: 'n', epoch: 'epoch', attempt: 1, backendId: 'default' } } as AuthContext;
const group = (index: number, count: number) => ({ index, destination: `/fsx/input/${index}`, manifestHash: 'hash',
  files: Array.from({ length: count }, (_, i) => ({ path: `${i}.bin`, size: 1, versionId: 'v1', checksumSHA256: 'checksum' })) });
it('pages file descriptors across group boundaries without dropping data', () => {
  const groups = [group(0, 70), group(1, 10)];
  const first = selectPlanPage(groups, context, 'secret', 'inputs', { pageSize: 64 });
  expect(first.groups[0].files).toHaveLength(64);
  expect(first.nextCursor).toBeTruthy();
  const second = selectPlanPage(groups, context, 'secret', 'inputs', { pageSize: 64, cursor: first.nextCursor });
  expect(second.groups.map(group => group.files.length)).toEqual([6, 10]);
  expect(second.nextCursor).toBeUndefined();
  expect([...first.groups[0].files, ...second.groups[0].files]).toEqual(groups[0].files);
});
it('binds cursors to manifest/file versions and current task/epoch, never accepting a changed plan', () => {
  const groups = [group(0, 65)];
  const first = selectPlanPage(groups, context, 'secret', 'inputs', { pageSize: 64 });
  groups[0].files[64].versionId = 'replacement';
  expect(() => selectPlanPage(groups, context, 'secret', 'inputs', { pageSize: 64, cursor: first.nextCursor })).toThrow(/identity changed/);
  groups[0].files[64].versionId = 'v1';
  expect(() => selectPlanPage(groups, { ...context, claims: { ...context.claims, epoch: 'next' } }, 'secret', 'inputs',
    { pageSize: 64, cursor: first.nextCursor })).toThrow(/identity changed/);
  expect(() => selectPlanPage(groups, context, 'other-key', 'inputs',
    { pageSize: 64, cursor: first.nextCursor })).toThrow(/signature/);
});
it('admits no oversized v2 aggregate, while preserving bounded unpaged legacy responses', () => {
  const groups = [group(0, 600), group(1, 600)];
  expect(selectPlanPage(groups, context, 'secret', 'inputs').groups).toEqual(groups);
  expect(() => selectPlanPage(groups, context, 'secret', 'inputs', { pageSize: 64 })).toThrow(/admission limits/);
});
it.each(['?pageSize=0', '?pageSize=65', '?pageSize=01', '?cursor=x', '?pageSize=64&pageSize=64', '?pageSize=64&cursor=x&cursor=y'])('rejects invalid pagination %s', query => {
  expect(() => parsePlanPage(new URL('http://runtime/runtime/inputs' + query))).toThrow();
});
