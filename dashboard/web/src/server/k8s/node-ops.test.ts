import { describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({ k8sJson: vi.fn() }));
vi.mock('./resources', () => ({ listNodes: vi.fn(), listPods: vi.fn() }));
import { listNodes, listPods } from './resources';
import { extractInstanceId, findNodeByInstanceId, listPodsOnNode } from './node-ops';

describe('extractInstanceId', () => {
  it('reads the trailing instance id from both EKS and HyperPod providerID shapes', () => {
    expect(extractInstanceId('aws:///use1-az4/sagemaker/cluster/hyperpod-tqci9uwuwqiz-i-00f3cbe8dfee6b675')).toBe('i-00f3cbe8dfee6b675');
    expect(extractInstanceId('aws:///us-east-1a/i-0123456789abcdef0')).toBe('i-0123456789abcdef0');
    expect(extractInstanceId('gce://x/y')).toBeUndefined();
    expect(extractInstanceId(undefined)).toBeUndefined();
  });
});
describe('node lookups', () => {
  it('matches a node by providerID suffix and lists pods with a nodeName field selector', async () => {
    vi.mocked(listNodes).mockResolvedValue([{ metadata: { name: 'a' }, spec: { providerID: 'aws:///x/sagemaker/cluster/c-i-0000000000000000a' } }, { metadata: { name: 'b' }, spec: { providerID: 'aws:///x/i-0000000000000000b' } }] as never);
    vi.mocked(listPods).mockResolvedValue([]);
    expect((await findNodeByInstanceId('i-0000000000000000b'))?.metadata.name).toBe('b');
    expect(await findNodeByInstanceId('i-0000000000000000c')).toBeUndefined();
    await listPodsOnNode('b');
    expect(listPods).toHaveBeenCalledWith(undefined, undefined, 'spec.nodeName=b');
  });
});
