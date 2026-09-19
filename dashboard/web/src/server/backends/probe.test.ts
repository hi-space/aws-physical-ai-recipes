import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../k8s/client', () => ({ k8sJson: transport.request }));

import { resetConfigForTests } from '../config';
import { MemoryKV } from '../store/dynamo';
import { Repo } from '../store/repo';
import { probeBackend } from './probe';
import { inspectBackend, readBackend, refreshBackendChecks, registerBackend } from './registry';
import { admin, profile } from './test-fixtures';

type Rule = { apiGroups: string[]; resources: string[]; verbs: string[] };
type Resource = {
  kind: string;
  metadata: { name: string; namespace?: string };
  rules?: Rule[];
  subjects?: { kind: string; name: string }[];
  roleRef?: { kind: string; name: string };
};
type Attributes = { group: string; resource: string; subresource?: string; verb: string; namespace?: string };

// Exercise the installer output used by CDK, rather than a second
// handwritten copy of the roles that could drift from production.
const manifest = JSON.parse(execFileSync('python3', [
  fileURLToPath(new URL('../../../../infra/ops/apply_addons.py', import.meta.url)), '--render-only',
], { encoding: 'utf8' })) as { items: Resource[] };

function allows(identity: string, attributes: Attributes): boolean {
  const resource = attributes.resource + (attributes.subresource ? `/${attributes.subresource}` : '');
  return manifest.items.filter(item =>
    ['RoleBinding', 'ClusterRoleBinding'].includes(item.kind) &&
    (!item.metadata.namespace || item.metadata.namespace === attributes.namespace) &&
    item.subjects?.some(subject => subject.kind === 'Group' && subject.name === `physical-ai:${identity}`),
  ).some(binding => {
    const role = manifest.items.find(item => item.kind === binding.roleRef?.kind &&
      item.metadata.name === binding.roleRef.name &&
      (item.kind === 'ClusterRole' || item.metadata.namespace === binding.metadata.namespace));
    return role?.rules?.some(rule => rule.apiGroups.includes(attributes.group) &&
      rule.resources.includes(resource) && rule.verbs.includes(attributes.verb)) === true;
  });
}

describe('backend probe with the installed split roles', () => {
  let repo: Repo;
  let identity: 'web' | 'controller';
  let deniedResource: string | undefined;
  const now = () => new Date('2026-09-16T12:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now());
    vi.stubEnv('AUTH_MODE', 'alb'); vi.stubEnv('TABLE_NAME', 'home-table');
    vi.stubEnv('ACCOUNT_ID', '123456789012'); vi.stubEnv('AWS_REGION', 'us-east-1');
    vi.stubEnv('BACKEND_HOME_VPC_ID', 'vpc-1234');
    vi.stubEnv('EKS_CLUSTER_NAME', 'home'); vi.stubEnv('HYPERPOD_EKS_CLUSTER_NAME', 'hp-home');
    vi.stubEnv('EKS_DATA_BUCKET', 'data-home');
    vi.stubEnv('EKS_BACKENDS_JSON', JSON.stringify([profile('alpha')]));
    resetConfigForTests(); repo = new Repo(new MemoryKV()); identity = 'web'; deniedResource = undefined;
    transport.request.mockReset().mockImplementation(async (path: string, init?: { body?: { spec: { resourceAttributes: Attributes } } }) => {
      if (path.endsWith('/selfsubjectaccessreviews')) {
        const attributes = init!.body!.spec.resourceAttributes;
        return { status: { allowed: attributes.resource !== deniedResource && allows(identity, attributes) } };
      }
      if (path === '/version') return { gitVersion: 'v1.34.2-eks' };
      if (path === '/apis/jobset.x-k8s.io/v1alpha2') return { resources: [{ name: 'jobsets' }] };
      if (path === '/api/v1/namespaces/hyperpod-ns-team-a') return { status: { phase: 'Active' } };
      if (path.endsWith('/localqueues/hyperpod-ns-team-a-localqueue')) return { spec: { clusterQueue: 'team-a' } };
      if (path.endsWith('/persistentvolumeclaims/fsx-pvc')) return { status: { phase: 'Bound' }, spec: { volumeName: 'fsx-alpha' } };
      if (path === '/api/v1/persistentvolumes/fsx-alpha') return { spec: {
        csi: { driver: 'fsx.csi.aws.com', volumeHandle: 'fs-alpha', volumeAttributes: { dnsname: 'alpha.fsx.test', mountname: 'mount' } },
        claimRef: { namespace: 'hyperpod-ns-team-a', name: 'fsx-pvc' },
      } };
      if (path.endsWith('/serviceaccounts/pai-workload')) return { metadata: { annotations: {} } };
      throw new Error(`Unexpected Kubernetes request: ${path}`);
    });
  });

  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetConfigForTests(); });

  it('can register and refresh workload readiness without granting gateway permissions to web/controller', async () => {
    await registerBackend(admin, { id: 'alpha', expectedVersion: 0, enabled: true }, repo, now);
    const checked = await inspectBackend(admin, 'alpha', 1, repo, probeBackend, now);
    expect(checked.status, JSON.stringify(checked.findings)).toBe('READY');
    identity = 'controller';
    expect(await refreshBackendChecks(repo, probeBackend, now)).toEqual([{ id: 'alpha', status: 'READY' }]);
    for (const subresource of ['exec', 'portforward']) {
      const request = { group: '', resource: 'pods', subresource, verb: 'create', namespace: 'hyperpod-ns-team-a' };
      expect(allows('web', request)).toBe(false);
      expect(allows('controller', request)).toBe(false);
      expect(allows('gateway', request)).toBe(true);
    }
  });

  it.each(['missing', 'unknown', 'expired'] as const)('never substitutes its own successful probe for %s gateway evidence', async state => {
    const candidate = profile('alpha');
    if (state === 'missing') delete candidate.evidence['gateway-eks-access'];
    else if (state === 'unknown') candidate.evidence['gateway-eks-access']!.status = 'unknown';
    else candidate.evidence['gateway-eks-access']!.expiresAt = '2026-09-16T11:59:00Z';
    vi.stubEnv('EKS_BACKENDS_JSON', JSON.stringify([candidate]));
    await registerBackend(admin, { id: 'alpha', expectedVersion: 0, enabled: true }, repo, now);
    expect(await probeBackend(candidate)).toEqual({ ok: true, findings: [] });
    await inspectBackend(admin, 'alpha', 1, repo, probeBackend, now);
    const result = await readBackend('alpha', repo, now);
    expect(result.status).toBe('UNREADY');
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'gateway-eks-access' }));
  });

  it('keeps denied workload permissions unready even when deployment evidence is present', async () => {
    deniedResource = 'jobs';
    await registerBackend(admin, { id: 'alpha', expectedVersion: 0, enabled: true }, repo, now);
    const result = await inspectBackend(admin, 'alpha', 1, repo, probeBackend, now);
    expect(result.status).toBe('UNREADY');
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'rbac:hyperpod-ns-team-a:jobs:create' }));
  });
});
