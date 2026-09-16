import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../k8s/client', async importOriginal => ({
  ...(await importOriginal<typeof import('../k8s/client')>()),
  k8sJson: vi.fn(),
  k8sGetOrNull: vi.fn()
}));
import { k8sJson, K8sError } from '../k8s/client';
import { createJobSet, deleteJobSet, listJobSets, listPods } from '../k8s/resources';
beforeEach(() => vi.mocked(k8sJson).mockReset());
it('paginates JobSets and pods with the exact namespace/label selectors on every page', async () => {
  vi.mocked(k8sJson).mockResolvedValueOnce({
    items: [{
      metadata: {
        name: 'one'
      }
    }],
    metadata: {
      continue: 'next/token'
    }
  }).mockResolvedValueOnce({
    items: [{
      metadata: {
        name: 'two'
      }
    }]
  });
  expect((await listJobSets('team', 'pai.aws/epoch=e,pai.aws/workflow-id=w')).map(j => j.metadata.name)).toEqual(['one', 'two']);
  const path = vi.mocked(k8sJson).mock.calls[1][0];
  expect(path).toContain('/namespaces/team/jobsets?');
  expect(new URL(path, 'http://k').searchParams.get('labelSelector')).toBe('pai.aws/epoch=e,pai.aws/workflow-id=w');
  expect(new URL(path, 'http://k').searchParams.get('continue')).toBe('next/token');
  vi.mocked(k8sJson).mockReset().mockResolvedValueOnce({
    items: [{
      metadata: {
        name: 'a'
      }
    }],
    metadata: {
      continue: 'more'
    }
  }).mockResolvedValueOnce({
    items: [{
      metadata: {
        name: 'b'
      }
    }]
  });
  expect(await listPods('team', 'pai.aws/epoch=e')).toHaveLength(2);
});
it('checks namespace and preserves required ownership labels on JobSet creation', async () => {
  const body = {
    apiVersion: 'jobset.x-k8s.io/v1alpha2',
    kind: 'JobSet',
    metadata: {
      name: 'group',
      namespace: 'team',
      labels: {
        'pai.aws/workflow-id': 'w',
        'pai.aws/epoch': 'e'
      }
    },
    spec: {
      replicatedJobs: []
    }
  };
  await createJobSet('team', body);
  expect(vi.mocked(k8sJson).mock.calls[0][1]).toMatchObject({
    method: 'POST',
    body: {
      metadata: {
        namespace: 'team',
        labels: {
          'pai.aws/workflow-id': 'w',
          'pai.aws/epoch': 'e'
        }
      }
    }
  });
  await expect(createJobSet('other', body)).rejects.toThrow(/namespace/i);
});
it('ignores only a real 404 on deletion and preserves other external failures', async () => {
  vi.mocked(k8sJson).mockRejectedValueOnce(new K8sError(404, 'gone'));
  await expect(deleteJobSet('team', 'group')).resolves.toBeUndefined();
  vi.mocked(k8sJson).mockRejectedValueOnce(new K8sError(503, 'upstream not found'));
  await expect(deleteJobSet('team', 'group')).rejects.toMatchObject({
    status: 503
  });
});
