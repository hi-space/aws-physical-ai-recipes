import { expect, it } from 'vitest';
import { assertGroupIdle, assertScaleBaseline } from './scaling';
import type { ClusterInstanceGroupDetails } from '@aws-sdk/client-sagemaker';
import type { Node, Pod } from '../k8s/resources';
import type { Workflow } from '../store/types';

const group: ClusterInstanceGroupDetails = { InstanceGroupName: 'gpu', InstanceType: 'ml.g5.8xlarge', CurrentCount: 1, TargetCount: 1 };
const nodes: Node[] = [{ metadata: { name: 'hyperpod-i-123' } }];
const pod = (namespace: string, phase: string): Pod => ({ metadata: { name: 'training', namespace }, spec: { nodeName: 'hyperpod-i-123', containers: [] }, status: { phase } });
it('rejects a stale count rather than resetting another actor’s capacity', () => {
  expect(() => assertScaleBaseline([group], 'gpu', 0)).toThrow(/노드 수가 변경/);
  expect(assertScaleBaseline([group], 'gpu', 1)).toBe(group);
});
it('keeps a node with an active user workload or workspace', () => {
  expect(() => assertGroupIdle(group, nodes, [pod('team-a', 'Running')], [], ['i-123'])).toThrow(/작업 또는 세션/);
});
it('protects pending and finalizing work even after its Pod has exited', () => {
  for (const status of ['PENDING', 'FINALIZING', 'CANCELLING'] as const) {
    const workflow = { id: 'run', status, spec: { workflow: { resources: { gpu: { gpu: 1 } }, tasks: [{ name: 'train', resource: 'gpu' }] } } } as unknown as Workflow;
    expect(() => assertGroupIdle(group, nodes, [pod('team-a', 'Succeeded')], [workflow], ['i-123'])).toThrow(/작업 또는 세션/);
  }
});
it('requires a verified node mapping and allows completed work on idle capacity', () => {
  expect(() => assertGroupIdle(group, [], [], [], ['i-123'])).toThrow(/노드와 인스턴스/);
  expect(() => assertGroupIdle(group, nodes, [pod('kube-system', 'Running'), pod('team-a', 'Succeeded')], [], ['i-123'])).not.toThrow();
});
