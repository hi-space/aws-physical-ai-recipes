import { fixture as modelFixture, alice, bob, reader, admin } from '@/server/evaluations/test-fixtures';
import { ModelsService, DEFAULT_POLICY } from '@/server/services/models';
import { DevicesService } from '@/server/services/devices';
import type { CloudTarget, ComponentProfile, CoreObservation, DeploymentRequest, DeploymentSnapshot, EdgeCloud } from '@/server/aws/greengrass';
export { alice, bob, reader, admin };
export const sample = { mode: 'sb3-ppo', avg_ms: 20, p50_ms: 18, p95_ms: 30, p99_ms: 40, std_ms: 3, hz: 50, iterations: 50 };

export class FakeCloud implements EdgeCloud {
  creates: DeploymentRequest[] = [];
  snapshots = new Map<string, DeploymentSnapshot>();
  groups: Record<string, string[]> = { 'test-group': ['test-core-a', 'test-core-b'] };
  statuses = new Map<string, string>();
  reject?: 'denied' | 'ambiguous';
  onCreate?: (request: DeploymentRequest) => void;
  architecture: 'amd64' | 'arm64' = 'amd64';
  arn(name: string) { return `arn:aws:iot:us-east-1:123456789012:thing/${name}`; }
  async target(kind: CloudTarget['kind'], name: string): Promise<CloudTarget> {
    return { kind, name, arn: kind === 'thing-group' ? `arn:aws:iot:us-east-1:123456789012:thinggroup/${name}` : this.arn(name),
      ...(kind === 'core' ? { architecture: this.architecture } : {}), ...(kind === 'thing-group' ? { members: [...(this.groups[name] ?? [])] } : {}) };
  }
  async component(name: string, version: string, architecture: 'amd64' | 'arm64'): Promise<ComponentProfile> {
    const communication = name.includes('communication'); const benchmark = name.includes('benchmark');
    return { id: `profile-${name.replace(/\./g, '-')}-${version.replace(/\./g, '-')}`, name, version, architecture,
      purpose: communication ? 'communication' : benchmark ? 'benchmark' : 'inference',
      engine: communication ? 'virtual-communication' : 'sb3-ppo', modelFormat: communication ? 'none' : 'mujoco-ppo-bundle',
      recipeHash: name + ':' + version, ...(communication ? {} : { runtimeImage: 'fixture/mujoco@sha256:' + '1'.repeat(64) }) };
  }
  async current(targetArn: string) { return structuredClone(this.snapshots.get(targetArn) ?? { targetArn, components: {} }); }
  async create(request: DeploymentRequest) {
    this.creates.push(structuredClone(request));
    if (this.reject === 'denied') throw Object.assign(new Error('Access denied'), { name: 'AccessDeniedException' });
    const existing = this.snapshots.get(request.targetArn);
    if (existing?.tags?.['pai:operation'] === request.operationId) return { deploymentId: existing.deploymentId! };
    const deploymentId = `deployment-${this.creates.length}`;
    this.snapshots.set(request.targetArn, { targetArn: request.targetArn, deploymentId, components: request.components,
      tags: { 'pai:operation': request.operationId, 'pai:device': request.deviceId } });
    this.statuses.set(deploymentId, 'IN_PROGRESS');
    this.onCreate?.(request);
    if (this.reject === 'ambiguous') throw Object.assign(new Error('Connection lost after AWS accepted request'), { name: 'TimeoutError' });
    return { deploymentId };
  }
  async inspect(name: string, deploymentId?: string): Promise<CoreObservation> {
    const snapshot = this.snapshots.get(this.arn(name));
    return { coreStatus: 'HEALTHY', executionStatus: deploymentId ? this.statuses.get(deploymentId) ?? 'UNKNOWN' : 'UNKNOWN',
      installed: Object.entries(snapshot?.components ?? {}).map(([name, spec]) => ({ name, version: spec.componentVersion!, state: 'RUNNING' })) };
  }
}
export async function fixture(approved = true) {
  const base = await modelFixture();
  const wf = (await base.repo.getWorkflow('train-run'))!;
  await base.repo.putWorkflow({ ...wf, id: 'active-run', name: 'active-run', status: 'RUNNING' });
  const models = new ModelsService({ repo: base.repo, objects: base.objects, artifactBucket: 'archive' });
  let model = await models.register(alice, 'a', { name: 'Edge fixture', dataset: 'weights-run', version: 1, checkpointPath: 'final/model.zip' });
  if (approved) {
    const evaluation = await models.ingest(alice, 'a', { modelId: model.id, dataset: 'evaluation-run', version: 1 });
    model = (await models.promote(alice, 'a', model.id, { evaluationId: evaluation.id, policy: DEFAULT_POLICY, approve: true })).model;
  }
  const cloud = new FakeCloud(); let milliseconds = Date.parse('2026-09-16T00:00:00Z');
  cloud.onCreate = request => {
    for (const spec of Object.values(request.components)) if (spec.configurationUpdate?.merge) {
      const config = JSON.parse(spec.configurationUpdate.merge);
      if (!config.execution) continue;
      const execution = JSON.parse(config.execution);
      base.objects.add(execution.report.key.replace(/benchmark\.json$/, 'readiness.json'), {
        status: 'ready', kind: execution.purpose === 'communication' ? 'communication-only' : 'model-ready',
        operationId: execution.operationId, deviceId: execution.deviceId, modelId: execution.model?.id,
        checkpointDigest: execution.model?.checkpoint.sha256, recipeHash: execution.profile.recipeHash,
        normalizationDigest: execution.model?.normalization?.sha256,
        componentVersion: execution.profile.version, architecture: execution.profile.architecture,
      });
    }
  };
  const service = new DevicesService({ repo: base.repo, objects: base.objects, models, cloud, artifactBucket: 'archive', now: () => new Date(milliseconds) });
  return { ...base, cloud, service, model, models, advance: (ms: number) => { milliseconds += ms; } };
}
export const registration = (targetName = 'test-core-a') => ({ label: targetName, kind: 'core', targetName, architecture: 'amd64', physical: false,
  profiles: [{ name: 'com.pai.inference', version: '2.3.4' }, { name: 'com.pai.benchmark', version: '2.3.4' }] });
