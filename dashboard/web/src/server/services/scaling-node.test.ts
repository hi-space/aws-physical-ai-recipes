import { beforeEach, expect, it, vi } from 'vitest';
import { scalingDeps } from './scaling-plans';
import { Repo, setRepoForTests } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { resetConfigForTests } from '../config';
const mock = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../k8s/client', () => ({ k8sGetOrNull: mock.get, k8sJson: mock.patch, SYSTEM_NAMESPACES: new Set(['kube-system']) }));
const target = { instanceId: 'i-00000000000000001', name: 'node', uid: 'uid-a', resourceVersion: '7' };
beforeEach(() => {
  vi.stubEnv('AUTH_MODE', 'dev'); resetConfigForTests(); setRepoForTests(new Repo(new MemoryKV()));
  mock.get.mockReset(); mock.patch.mockReset().mockResolvedValue({});
});
it('cordons with UID/resourceVersion tests and retains unrelated annotations', async () => {
  mock.get.mockResolvedValue({ metadata: { name: 'node', uid: 'uid-a', resourceVersion: '7', annotations: { keep: 'yes' } }, spec: {} });
  await scalingDeps().cordon(target, 'operation');
  const request = mock.patch.mock.calls[0][1];
  expect(request.body).toContainEqual({ op: 'test', path: '/metadata/uid', value: 'uid-a' });
  expect(request.body).toContainEqual({ op: 'test', path: '/metadata/resourceVersion', value: '7' });
  expect(request.body).toContainEqual({ op: 'add', path: '/metadata/annotations', value: { keep: 'yes', 'pai.aws/scale-operation': 'operation' } });
  expect(request.body).toContainEqual({ op: 'add', path: '/spec/unschedulable', value: true });
});
it('never uncordons another operation or a replacement node', async () => {
  mock.get.mockResolvedValue({ metadata: { uid: 'uid-a', resourceVersion: '8', annotations: { 'pai.aws/scale-operation': 'other' } }, spec: { unschedulable: true } });
  await scalingDeps().restore(target, 'operation'); expect(mock.patch).not.toHaveBeenCalled();
  mock.get.mockResolvedValue({ metadata: { uid: 'replacement', resourceVersion: '8' }, spec: {} });
  await expect(scalingDeps().cordon(target, 'operation')).rejects.toThrow(/UID/);
  expect(mock.patch).not.toHaveBeenCalled();
});
