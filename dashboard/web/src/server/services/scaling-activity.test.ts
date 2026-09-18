import { beforeEach, expect, it } from 'vitest';
import type { ClusterInstanceGroupDetails, ClusterNodeSummary } from '@aws-sdk/client-sagemaker';
import { inspectActivity, SCALE_ANNOTATION, type ScaleNode } from './scaling-activity';

const instanceId = 'i-0f190b8fa232cef49';
const providerID = 'aws:///use1-az4/sagemaker/cluster/hyperpod-tqci9uwuwqiz-i-0f190b8fa232cef49';
const now = new Date('2026-09-18T08:00:00Z');
const group: ClusterInstanceGroupDetails = {
  InstanceGroupName: 'gpu', InstanceType: 'ml.g5.8xlarge', CurrentCount: 1, TargetCount: 1, Status: 'InService',
};
let node: ScaleNode, instance: ClusterNodeSummary;
beforeEach(() => {
  // Audit provider/name/instance shape, with synthetic Kubernetes revision and UID.
  node = {
    metadata: {
      name: `hyperpod-${instanceId}`, uid: '8d109632-509f-4678-81d4-79a3c1f5e284', resourceVersion: '487162',
      labels: { 'node.kubernetes.io/instance-type': 'ml.g5.8xlarge', 'topology.k8s.aws/zone-id': 'use1-az4',
        'sagemaker.amazonaws.com/node-health-status': 'Schedulable' },
    },
    spec: { providerID, unschedulable: false, taints: [] },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      capacity: { cpu: '32', memory: '131072Mi', 'nvidia.com/gpu': '1' },
      allocatable: { cpu: '31500m', memory: '125000Mi', 'nvidia.com/gpu': '1' },
      addresses: [{ type: 'InternalIP', address: '192.0.2.10' }],
    },
  };
  instance = { InstanceId: instanceId, InstanceGroupName: 'gpu', InstanceType: 'ml.g5.8xlarge',
    InstanceStatus: { Status: 'Running' }, LaunchTime: new Date('2026-09-14T00:00:00Z') };
});
const inspect = (nodes = [node], instances = [instance], operationId?: string) =>
  inspectActivity('default', group, nodes, [], instances, { items: [], complete: true, observedAt: now.toISOString() }, now, operationId);
const expectUnknown = (nodes = [node], instances = [instance]) => {
  const result = inspect(nodes, instances);
  expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'node_mapping_unknown' }));
};

it('maps the audited HyperPod provider to the running instance and Ready node UID/version', () => {
  const result = inspect();
  expect(result.blockers).toEqual([]);
  expect(result.targets).toEqual([{ instanceId, name: `hyperpod-${instanceId}`,
    uid: '8d109632-509f-4678-81d4-79a3c1f5e284', resourceVersion: '487162' }]);
});
it.each(['i-0f190b8fa232cef49', 'i-1234abcd'])('supports the standard EC2 provider format for %s', id => {
  instance.InstanceId = id;
  node.metadata.name = 'ip-192-0-2-10.ec2.internal';
  node.spec!.providerID = `aws:///us-east-1a/${id}`;
  expect(inspect().blockers).toEqual([]);
  expect(inspect().targets[0].instanceId).toBe(id);
});
it('retains exact HyperPod node-name fallback only when provider identity is absent', () => {
  delete node.spec!.providerID;
  expect(inspect().blockers).toEqual([]);
  node.metadata.name = 'ip-192-0-2-10.ec2.internal';
  expectUnknown();
});
it.each([
  `gce:///us-east-1a/${instanceId}`,
  `aws://us-east-1a/${instanceId}`,
  `aws:////${instanceId}`,
  `aws:///us-east-1a/unexpected/${instanceId}`,
  `prefix-aws:///us-east-1a/${instanceId}`,
  `aws:///us-east-1a/${instanceId}\n`,
  `${providerID}/`,
  `${providerID}-extra`,
  providerID.replace('tqci9uwuwqiz', 'tqci9uwuwqiz-too-long'),
  providerID.replace(instanceId, 'i-0f190b8fa232cef4'),
  providerID.replace(instanceId, 'i-0f190b8fa232cef4g'),
  '',
])('rejects malformed provider identity despite a matching node name: %j', provider => {
  node.spec!.providerID = provider;
  expectUnknown();
  expect(inspect().targets).toEqual([]);
});
it.each([
  'aws:///us-east-1a/i-fffffffffffffffff',
  'aws:///use1-az4/sagemaker/cluster/hyperpod-tqci9uwuwqiz-i-fffffffffffffffff',
])('never overrides a conflicting provider with a matching node name: %s', provider => {
  node.spec!.providerID = provider;
  expectUnknown();
  expect(inspect().targets).toEqual([]);
});
it.each(['provider', 'name', 'uid'] as const)('rejects duplicate node %s evidence', duplicate => {
  node.spec!.providerID = `aws:///us-east-1a/${instanceId}`;
  const other = structuredClone(node);
  if (duplicate !== 'name') other.metadata.name = 'another-node';
  if (duplicate !== 'uid') other.metadata.uid = 'another-uid';
  if (duplicate !== 'provider') other.spec!.providerID = 'aws:///us-east-1a/i-fffffffffffffffff';
  expectUnknown([node, other]);
});
it.each(['uid', 'resourceVersion', 'deleting', 'not-ready', 'unknown-ready', 'no-ready'] as const)(
  'requires unchanged node safety evidence with the live provider format: %s', missing => {
    if (missing === 'uid' || missing === 'resourceVersion') delete node.metadata[missing];
    if (missing === 'deleting') node.metadata.deletionTimestamp = now.toISOString();
    if (missing === 'not-ready') node.status!.conditions![0].status = 'False';
    if (missing === 'unknown-ready') node.status!.conditions![0].status = 'Unknown';
    if (missing === 'no-ready') node.status!.conditions = [];
    expectUnknown();
    expect(inspect().targets).toEqual([]);
  },
);
it('still blocks unhealthy inventory and reused instance identities', () => {
  instance.InstanceStatus = { Status: 'Failure' };
  expect(inspect().blockers).toContainEqual(expect.objectContaining({ code: 'inventory_unknown' }));
  instance.InstanceStatus = { Status: 'Running' };
  expectUnknown([node], [instance, structuredClone(instance)]);
});
it('preserves cordon ownership and host-execution safety gates for HyperPod providers', () => {
  node.spec!.unschedulable = true;
  node.metadata.annotations = { [SCALE_ANNOTATION]: 'another-operation' };
  expect(inspect().blockers).toContainEqual(expect.objectContaining({ code: 'node_already_cordoned' }));
  expect(inspect([node], [instance], 'another-operation').blockers).toEqual([]);
  node.spec!.unschedulable = false;
  node.metadata.labels!['pai.aws.node-restriction.kubernetes.io/execution-profile'] = 'trusted-host';
  expect(inspect().blockers).toContainEqual(expect.objectContaining({ code: 'host_execution_unobserved' }));
});
