import { k8sJson as request, type K8sRequestInit } from '../k8s/client';
import { inspectOnBackend } from './context';
import type { BackendProbe, Finding } from './registry';
const k8sJson = <T>(path: string, init: K8sRequestInit = {}) => request<T>(path, { ...init, signal: AbortSignal.timeout(10_000) });

/**
 * Inspect the workload permissions held by web/controller without provisioning.
 * The registry separately requires current deployment evidence for gateway
 * identity/network access; this principal cannot prove another role's access.
 */
export const probeBackend: BackendProbe = async profile => inspectOnBackend(profile, async () => {
  const findings: Finding[] = [];
  const check = async (code: string, action: () => Promise<boolean>) => {
    try { if (!await action()) findings.push({ code, message: `${code}: 필요한 실행 조건이 확인되지 않았습니다.` }); }
    catch { findings.push({ code, message: `${code}: 접근 또는 조회에 실패했습니다.` }); }
  };
  await check('eks-api', async () => Boolean((await k8sJson<{ gitVersion?: string }>('/version')).gitVersion));
  await check('jobset-api', async () => (await k8sJson<{ resources?: Array<{ name: string }> }>('/apis/jobset.x-k8s.io/v1alpha2')).resources?.some(r => r.name === 'jobsets') === true);
  const permission = async (group: string, resource: string, verb: string, namespace?: string) => {
    const [name, subresource] = resource.split('/');
    const review = await k8sJson<{ status?: { allowed: boolean } }>('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
      method: 'POST', body: { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', spec: { resourceAttributes: { namespace, group, resource: name, subresource, verb } } },
    });
    return review.status?.allowed === true;
  };
  for (const [group, resource] of [
    ['', 'nodes'], ['', 'namespaces'], ['', 'persistentvolumes'], ['scheduling.k8s.io', 'priorityclasses'],
    ['kueue.x-k8s.io', 'clusterqueues'], ['kueue.x-k8s.io', 'resourceflavors'],
  ]) for (const verb of ['get', 'list']) await check(`rbac:cluster:${resource}:${verb}`, () => permission(group, resource, verb));
  for (const namespace of profile.namespaces) {
    const prefix = `/api/v1/namespaces/${namespace}`;
    await check(`namespace:${namespace}`, async () => (await k8sJson<{ status?: { phase: string } }>(prefix)).status?.phase === 'Active');
    await check(`queue:${namespace}`, async () => !!(await k8sJson<{ spec?: { clusterQueue: string } }>(`/apis/kueue.x-k8s.io/v1beta1/namespaces/${namespace}/localqueues/${namespace}-localqueue`)).spec?.clusterQueue);
    await check(`fsx:${namespace}`, async () => {
      const claim = await k8sJson<{ spec?: { volumeName?: string }; status?: { phase: string } }>(`${prefix}/persistentvolumeclaims/fsx-pvc`);
      if (claim.status?.phase !== 'Bound' || !claim.spec?.volumeName) return false;
      const volume = await k8sJson<{ spec?: { csi?: { driver: string; volumeHandle: string; volumeAttributes?: { dnsname?: string; mountname?: string } }; claimRef?: { namespace: string; name: string } } }>(`/api/v1/persistentvolumes/${encodeURIComponent(claim.spec.volumeName)}`);
      return volume.spec?.csi?.driver === 'fsx.csi.aws.com' && volume.spec.csi.volumeHandle === profile.eks.fsxFileSystemId &&
        volume.spec.csi.volumeAttributes?.dnsname === profile.eks.fsxDnsName && volume.spec.csi.volumeAttributes?.mountname === profile.eks.fsxMountName &&
        volume.spec.claimRef?.namespace === namespace && volume.spec.claimRef.name === 'fsx-pvc';
    });
    await check(`service-account:${namespace}`, async () => {
      const sa = await k8sJson<{ metadata?: { annotations?: Record<string, string> } }>(`${prefix}/serviceaccounts/pai-workload`);
      return !sa.metadata?.annotations?.['eks.amazonaws.com/role-arn'];
    });
    for (const [group, resource, verbs] of [
      ['batch', 'jobs', ['get', 'list', 'create', 'delete']],
      ['jobset.x-k8s.io', 'jobsets', ['get', 'list', 'create', 'delete']],
      ['', 'pods', ['get', 'list', 'delete']], ['', 'pods/log', ['get']],
      ['', 'configmaps', ['get', 'list', 'create', 'update', 'delete']], ['', 'secrets', ['get', 'list', 'create', 'update', 'delete']],
      ['', 'events', ['get', 'list']], ['', 'persistentvolumeclaims', ['get']], ['', 'serviceaccounts', ['get']],
      ['kueue.x-k8s.io', 'localqueues', ['get', 'list']], ['kueue.x-k8s.io', 'workloads', ['get', 'list']],
      ['networking.k8s.io', 'networkpolicies', ['get', 'patch']],
    ] as const) for (const verb of verbs) await check(`rbac:${namespace}:${resource}:${verb}`, () => permission(group, resource, verb, namespace));
  }
  return { ok: findings.length === 0, findings };
});
