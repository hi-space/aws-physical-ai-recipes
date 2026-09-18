import { describe, it, expect, vi } from 'vitest';
import { extractInstanceId, requiresHyperPodLabel, setNodeHealthLabel, setCordon } from './node-ops';
import * as client from './client';
import type { Node } from './resources';

vi.mock('./client');

const mockK8sJson = vi.fn();
vi.mocked(client).k8sJson = mockK8sJson;

describe('node-ops', () => {
  describe('extractInstanceId', () => {
    it('extracts instance ID from aws:///az/i-xxx providerID', () => {
      expect(extractInstanceId('aws:///us-east-1a/i-0123456789abcdef0')).toBe('i-0123456789abcdef0');
      expect(extractInstanceId('aws:///eu-west-1b/i-0abc12345')).toBe('i-0abc12345');
    });

    it('returns undefined for missing or invalid providerID', () => {
      expect(extractInstanceId(undefined)).toBeUndefined();
      expect(extractInstanceId('')).toBeUndefined();
      expect(extractInstanceId('invalid')).toBeUndefined();
    });
  });

  describe('requiresHyperPodLabel', () => {
    it('passes when node has HyperPod group label', () => {
      const node: Node = {
        metadata: { name: 'node1', labels: { 'sagemaker.amazonaws.com/instance-group-name': 'gpu' } },
      };
      expect(() => requiresHyperPodLabel(node)).not.toThrow();
    });

    it('throws forbidden when node lacks HyperPod group label', () => {
      const node: Node = { metadata: { name: 'node1' } };
      expect(() => requiresHyperPodLabel(node)).toThrow(/not part of a HyperPod/);
    });
  });

  describe('setNodeHealthLabel', () => {
    it('PATCHes the label merge-patch on the node', async () => {
      const node: Node = {
        metadata: {
          name: 'node1',
          labels: { 'sagemaker.amazonaws.com/instance-group-name': 'gpu' },
        },
      };
      mockK8sJson.mockResolvedValueOnce(node);
      mockK8sJson.mockResolvedValueOnce(node);

      await setNodeHealthLabel('node1', 'UnschedulablePendingReboot');

      // First call: getNode; second call: PATCH with merge-patch body
      expect(mockK8sJson).toHaveBeenCalledWith(`/api/v1/nodes/node1`, {
        method: 'PATCH',
        body: {
          metadata: {
            labels: {
              'sagemaker.amazonaws.com/instance-group-name': 'gpu',
              'sagemaker.amazonaws.com/node-health-status': 'UnschedulablePendingReboot',
            },
          },
        },
      });
    });

    it('rejects node without HyperPod group label', async () => {
      mockK8sJson.mockResolvedValueOnce({ metadata: { name: 'node1' } });

      await expect(setNodeHealthLabel('node1', 'UnschedulablePendingReplacement')).rejects.toThrow(/not part of a HyperPod/);
    });
  });

  describe('setCordon', () => {
    it('PATCHes the unschedulable flag', async () => {
      mockK8sJson.mockResolvedValueOnce({ metadata: { name: 'node1' }, spec: { unschedulable: true } });

      await setCordon('node1', true);

      expect(mockK8sJson).toHaveBeenCalledWith(`/api/v1/nodes/node1`, {
        method: 'PATCH',
        body: { spec: { unschedulable: true } },
      });
    });
  });
});

describe('extractInstanceId (HyperPod providerID)', () => {
  it('reads the trailing instance id from the HyperPod providerID shape observed on a live cluster', async () => {
    const { extractInstanceId } = await import('./node-ops');
    expect(extractInstanceId('aws:///use1-az4/sagemaker/cluster/hyperpod-tqci9uwuwqiz-i-00f3cbe8dfee6b675')).toBe('i-00f3cbe8dfee6b675');
    expect(extractInstanceId('aws:///us-east-1a/i-0123456789abcdef0')).toBe('i-0123456789abcdef0');
    expect(extractInstanceId('gce://x/y')).toBeUndefined();
  });
});
