import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getNode, setNodeHealthLabel, extractInstanceId, listPodsOnNode } from '../k8s/node-ops';
import { planNodeRecovery, executeNodeRecovery } from './node-recovery';
import type { Node, Pod } from '../k8s/resources';
import type { DescribeClusterResponse } from '@aws-sdk/client-sagemaker';

vi.mock('../k8s/node-ops', async () => {
  const actual = await vi.importActual<typeof import('../k8s/node-ops')>('../k8s/node-ops');
  return {
    getNode: vi.fn(),
    listPodsOnNode: vi.fn(),
    setNodeHealthLabel: vi.fn(),
    extractInstanceId: actual.extractInstanceId, // Real implementation
    requiresHyperPodLabel: actual.requiresHyperPodLabel, // Real implementation
  };
});
vi.mock('../k8s/client');

const mockGetNode = vi.mocked(getNode);
const mockListPodsOnNode = vi.mocked(listPodsOnNode);
const mockSetNodeHealthLabel = vi.mocked(setNodeHealthLabel);

const mockCluster = {
  ClusterArn: 'arn:aws:sagemaker:us-east-1:123456789012:cluster/test',
  ClusterName: 'test',
  ClusterStatus: 'InService',
  NodeRecovery: 'Automatic',
} as unknown as DescribeClusterResponse;

const mockNode: Node = {
  metadata: {
    name: 'node1',
    uid: 'uid-123',
    labels: {
      'sagemaker.amazonaws.com/instance-group-name': 'gpu',
      'node.kubernetes.io/instance-type': 'ml.g4dn.xlarge',
    },
  },
  spec: {
    providerID: 'aws:///us-east-1a/i-1234567890abcdef0',
    unschedulable: false,
  },
  status: {
    capacity: { 'nvidia.com/gpu': '1', cpu: '4', memory: '16Gi' },
    allocatable: { 'nvidia.com/gpu': '1', cpu: '4', memory: '16Gi' },
    conditions: [{ type: 'Ready', status: 'True' }],
  },
};

describe('node-recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNode.mockResolvedValue(mockNode);
    mockListPodsOnNode.mockResolvedValue([]);
    mockSetNodeHealthLabel.mockResolvedValue(mockNode);
  });

  describe('planNodeRecovery', () => {
    it('returns a plan with node info, empty pods list when ready', async () => {
      mockGetNode.mockResolvedValueOnce(mockNode);
      mockListPodsOnNode.mockResolvedValueOnce([]);

      const plan = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      expect(plan.node.name).toBe('node1');
      expect(plan.node.instanceId).toBe('i-1234567890abcdef0');
      expect(plan.node.group).toBe('gpu');
      expect(plan.node.gpuCapacity).toBe(1);
      expect(plan.pods).toEqual([]);
      expect(plan.blockers).toEqual([]);
      expect(plan.warnings).toEqual([]);
      expect(plan.token).toBeTruthy();
    });

    it('includes running_pods warning when non-DaemonSet pods are on the node', async () => {
      mockGetNode.mockResolvedValueOnce(mockNode);
      const pod: Pod = {
        metadata: {
          name: 'my-job-abc',
          namespace: 'default',
          uid: 'pod-uid-1',
          labels: { 'pai.aws/workflow-id': 'workflow-1' },
          ownerReferences: [{ kind: 'Job', name: 'my-job' }],
        },
        spec: { containers: [{ name: 'job', image: 'image:latest' }], nodeName: 'node1' },
        status: { phase: 'Running' },
      };
      mockListPodsOnNode.mockResolvedValueOnce([pod]);

      const plan = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      expect(plan.pods).toHaveLength(1);
      expect(plan.pods[0].namespace).toBe('default');
      expect(plan.pods[0].workflowId).toBe('workflow-1');
      expect(plan.warnings).toContainEqual(
        expect.objectContaining({
          code: 'running_pods',
          message: expect.stringContaining('1 running pod(s)'),
        }),
      );
    });

    it('excludes DaemonSet pods and system-namespace pods from running_pods warning', async () => {
      mockGetNode.mockResolvedValueOnce(mockNode);
      const daemonsetPod: Pod = {
        metadata: {
          name: 'daemon-abc',
          namespace: 'default',
          uid: 'pod-uid-1',
          ownerReferences: [{ kind: 'DaemonSet', name: 'daemon' }],
        },
        spec: { containers: [{ name: 'daemon', image: 'image:latest' }], nodeName: 'node1' },
        status: { phase: 'Running' },
      };
      const systemPod: Pod = {
        metadata: {
          name: 'coredns-abc',
          namespace: 'kube-system',
          uid: 'pod-uid-2',
          ownerReferences: [{ kind: 'Deployment', name: 'coredns' }],
        },
        spec: { containers: [{ name: 'coredns', image: 'image:latest' }], nodeName: 'node1' },
        status: { phase: 'Running' },
      };
      mockListPodsOnNode.mockResolvedValueOnce([daemonsetPod, systemPod]);

      const plan = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      expect(plan.warnings.filter((w) => w.code === 'running_pods')).toHaveLength(0);
    });

    it('includes node_recovery_disabled blocker when cluster NodeRecovery is not Automatic', async () => {
      mockGetNode.mockResolvedValueOnce(mockNode);
      mockListPodsOnNode.mockResolvedValueOnce([]);

      const manualCluster = { ...mockCluster, NodeRecovery: 'Manual' } as unknown as DescribeClusterResponse;
      const plan = await planNodeRecovery(manualCluster, 'node1', 'reboot');

      expect(plan.blockers).toContainEqual(
        expect.objectContaining({
          code: 'node_recovery_disabled',
          message: expect.stringContaining('Manual'),
        }),
      );
    });

    it('includes not_hyperpod_node blocker when node lacks group label', async () => {
      const nonHyperPodNode = { ...mockNode, metadata: { ...mockNode.metadata, labels: {} } };
      mockGetNode.mockResolvedValueOnce(nonHyperPodNode);
      mockListPodsOnNode.mockResolvedValueOnce([]);

      const plan = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      expect(plan.blockers).toContainEqual(
        expect.objectContaining({
          code: 'not_hyperpod_node',
        }),
      );
    });

    it('includes already_pending blocker when node already has target label', async () => {
      const labeledNode = {
        ...mockNode,
        metadata: {
          ...mockNode.metadata,
          labels: {
            ...mockNode.metadata.labels,
            'sagemaker.amazonaws.com/node-health-status': 'UnschedulablePendingReboot',
          },
        },
      };
      mockGetNode.mockResolvedValueOnce(labeledNode);
      mockListPodsOnNode.mockResolvedValueOnce([]);

      const plan = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      expect(plan.blockers).toContainEqual(
        expect.objectContaining({
          code: 'already_pending',
          message: expect.stringContaining('UnschedulablePendingReboot'),
        }),
      );
    });

    it('generates a different token when node state changes', async () => {
      mockGetNode.mockResolvedValueOnce(mockNode);
      mockListPodsOnNode.mockResolvedValueOnce([]);
      const plan1 = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      // Change labels
      mockGetNode.mockResolvedValueOnce({
        ...mockNode,
        metadata: {
          ...mockNode.metadata,
          labels: {
            ...mockNode.metadata.labels,
            'sagemaker.amazonaws.com/node-health-status': 'UnschedulablePendingReplacement',
          },
        },
      });
      mockListPodsOnNode.mockResolvedValueOnce([]);
      const plan2 = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      expect(plan1.token).not.toBe(plan2.token);
    });
  });

  describe('executeNodeRecovery', () => {
    it('succeeds when plan is clean and applies the label', async () => {
      mockGetNode.mockResolvedValueOnce(mockNode);
      mockListPodsOnNode.mockResolvedValueOnce([]);
      const plan = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      // Second call: getNode for re-verify
      mockGetNode.mockResolvedValueOnce(mockNode);
      mockListPodsOnNode.mockResolvedValueOnce([]);

      // Third call: setNodeHealthLabel
      const updatedNode = {
        ...mockNode,
        metadata: {
          ...mockNode.metadata,
          labels: {
            ...mockNode.metadata.labels,
            'sagemaker.amazonaws.com/node-health-status': 'UnschedulablePendingReboot',
          },
        },
      };
      mockSetNodeHealthLabel.mockResolvedValueOnce(updatedNode);

      const result = await executeNodeRecovery(mockCluster, 'node1', 'reboot', plan.token, false);

      expect(result.label).toBe('UnschedulablePendingReboot');
      expect(result.node.name).toBe('node1');
      expect(mockSetNodeHealthLabel).toHaveBeenCalledWith('node1', 'UnschedulablePendingReboot');
    });

    it('throws 409 node_state_changed when token mismatch', async () => {
      mockGetNode.mockResolvedValueOnce(mockNode);
      mockListPodsOnNode.mockResolvedValueOnce([]);
      const plan = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      // Re-verify with changed state
      mockGetNode.mockResolvedValueOnce({
        ...mockNode,
        metadata: {
          ...mockNode.metadata,
          labels: {
            ...mockNode.metadata.labels,
            'sagemaker.amazonaws.com/node-health-status': 'UnschedulablePendingReplacement',
          },
        },
      });
      mockListPodsOnNode.mockResolvedValueOnce([]);

      await expect(executeNodeRecovery(mockCluster, 'node1', 'reboot', plan.token, false)).rejects.toMatchObject({
        code: 'node_state_changed',
        status: 409,
      });
    });

    it('throws 409 blocker when re-verified plan has blockers', async () => {
      mockGetNode.mockResolvedValueOnce(mockNode);
      mockListPodsOnNode.mockResolvedValueOnce([]);
      const plan = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      // Re-verify with cluster NodeRecovery disabled
      mockGetNode.mockResolvedValueOnce(mockNode);
      mockListPodsOnNode.mockResolvedValueOnce([]);

      const manualCluster = { ...mockCluster, NodeRecovery: 'Manual' } as unknown as DescribeClusterResponse;

      await expect(executeNodeRecovery(manualCluster, 'node1', 'reboot', plan.token, false)).rejects.toMatchObject({
        code: 'node_recovery_disabled',
        status: 409,
      });
    });

    it('throws 400 ack_required when running_pods warning and not acknowledged', async () => {
      mockGetNode.mockResolvedValueOnce(mockNode);
      const pod: Pod = {
        metadata: {
          name: 'job-abc',
          namespace: 'default',
          uid: 'pod-uid-1',
          ownerReferences: [{ kind: 'Job', name: 'job' }],
        },
        spec: { containers: [{ name: 'job', image: 'image' }], nodeName: 'node1' },
        status: { phase: 'Running' },
      };
      mockListPodsOnNode.mockResolvedValueOnce([pod]);
      const plan = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      // Re-verify (same state)
      mockGetNode.mockResolvedValueOnce(mockNode);
      mockListPodsOnNode.mockResolvedValueOnce([pod]);

      await expect(executeNodeRecovery(mockCluster, 'node1', 'reboot', plan.token, false)).rejects.toMatchObject({
        code: 'ack_required',
        status: 400,
      });
    });

    it('succeeds when running_pods warning is acknowledged', async () => {
      mockGetNode.mockResolvedValueOnce(mockNode);
      const pod: Pod = {
        metadata: {
          name: 'job-abc',
          namespace: 'default',
          uid: 'pod-uid-1',
          ownerReferences: [{ kind: 'Job', name: 'job' }],
        },
        spec: { containers: [{ name: 'job', image: 'image' }], nodeName: 'node1' },
        status: { phase: 'Running' },
      };
      mockListPodsOnNode.mockResolvedValueOnce([pod]);
      const plan = await planNodeRecovery(mockCluster, 'node1', 'reboot');

      // Re-verify (same state)
      mockGetNode.mockResolvedValueOnce(mockNode);
      mockListPodsOnNode.mockResolvedValueOnce([pod]);

      // setNodeHealthLabel
      const updatedNode = {
        ...mockNode,
        metadata: {
          ...mockNode.metadata,
          labels: {
            ...mockNode.metadata.labels,
            'sagemaker.amazonaws.com/node-health-status': 'UnschedulablePendingReboot',
          },
        },
      };
      mockSetNodeHealthLabel.mockResolvedValueOnce(updatedNode);

      const result = await executeNodeRecovery(mockCluster, 'node1', 'reboot', plan.token, true);

      expect(result.label).toBe('UnschedulablePendingReboot');
    });
  });
});
