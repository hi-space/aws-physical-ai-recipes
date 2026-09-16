import { beforeEach, describe, expect, it } from 'vitest';
import { fixture, registration, alice, bob, reader, sample } from './fixtures';
let data: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { data = await fixture(); });
const prepare = async (data: Awaited<ReturnType<typeof fixture>>, name = 'test-core-a') => {
  const device = await data.service.register(alice, 'a', registration(name));
  const operation = await data.service.prepare(alice, 'a', { deviceId: device.id, modelId: data.model.id, profileId: device.profiles[0].id, name: 'Fixture rollout' });
  return { device, operation };
};
describe('project devices and deployment evidence', () => {
  it('only project administrators register canonical targets; browser ARNs and aliases cannot bypass ownership', async () => {
    await expect(data.service.register(reader, 'a', registration())).rejects.toMatchObject({ status: 403 });
    await expect(data.service.register(bob, 'a', registration())).rejects.toMatchObject({ status: 403 });
    await expect(data.service.register(alice, 'a', { ...registration(), targetArn: 'arn:forged' })).rejects.toMatchObject({ status: 400 });
    const device = await data.service.register(alice, 'a', registration());
    expect(device.hardwareValidation).toBe('not_tested');
    await expect(data.service.register(alice, 'a', { ...registration(), kind: 'thing' })).rejects.toMatchObject({ status: 409 });
    expect((await data.service.list(bob, 'b')).devices).toEqual([]);
    await expect(data.service.get(bob, 'b', device.id)).rejects.toMatchObject({ status: 404 });
    expect(data.cloud.creates).toHaveLength(0);
  });
  it('requires explicit physical registration and never marks it hardware-tested', async () => {
    await expect(data.service.register(alice, 'a', { ...registration(), physical: true })).rejects.toThrow(/explicitly/);
    const device = await data.service.register(alice, 'a', { ...registration(), physical: true, acknowledgePhysicalRegistration: true });
    expect(device.physical).toBe(true); expect(device.hardwareValidation).toBe('not_tested');
  });
  it('lets project admins register new versions and fences plans using revoked profiles', async () => {
    const { device, operation } = await prepare(data);
    const updated = await data.service.update(alice, 'a', device.id, { profiles: [{ name: 'com.pai.inference', version: '2.3.5' }] });
    expect(updated.profiles[0].version).toBe('2.3.5');
    await expect(data.service.submit(alice, 'a', operation.id)).rejects.toThrow(/no longer registered/);
    expect(data.cloud.creates).toHaveLength(0);
    await expect(data.service.update(reader, 'a', device.id, { profiles: [] })).rejects.toMatchObject({ status: 403 });
  });
  it('can confirm an already-onboarded Thing as a Core without changing target ownership', async () => {
    const thing = await data.service.register(alice, 'a', { ...registration(), kind: 'thing', profiles: [] });
    const core = await data.service.update(alice, 'a', thing.id, { promoteToCore: true, profiles: [{ name: 'com.pai.inference', version: '2.3.4' }] });
    expect(core).toMatchObject({ id: thing.id, targetArn: thing.targetArn, kind: 'core', hardwareValidation: 'not_tested' });
    expect(data.cloud.creates).toHaveLength(0);
  });
  it('requires exact model quality approval for inference and explicit consent for an unapproved benchmark', async () => {
    data = await fixture(false);
    const device = await data.service.register(alice, 'a', registration());
    const base = { deviceId: device.id, modelId: data.model.id, name: 'Benchmark' };
    await expect(data.service.prepare(alice, 'a', { ...base, profileId: device.profiles[0].id })).rejects.toThrow(/quality approval/);
    await expect(data.service.prepare(alice, 'a', { ...base, profileId: device.profiles[1].id })).rejects.toThrow(/explicit/);
    expect((await data.service.prepare(alice, 'a', { ...base, profileId: device.profiles[1].id, allowUnapprovedBenchmark: true })).status).toBe('PREPARED');
    expect(data.cloud.creates).toHaveLength(0);
  });
  it('pins actual artifacts/version and treats AWS acceptance as submitted, not succeeded', async () => {
    const { device, operation } = await prepare(data);
    expect(operation.status).toBe('PREPARED'); expect(data.cloud.creates).toHaveLength(0);
    const execution = JSON.parse(JSON.parse(operation.targets[0].after.components['com.pai.inference'].configurationUpdate!.merge!).execution);
    expect(execution.model.checkpoint).toMatchObject({ versionId: data.model.checkpoint.versionId, sha256: data.model.checkpoint.sha256 });
    expect(execution.profile.version).toBe('2.3.4');
    const sent = await data.service.submit(alice, 'a', operation.id);
    expect(sent.status).toBe('SUBMITTED');
    expect((await data.service.operation(alice, 'a', sent.id, true)).status).toBe('RUNNING');
    const token = data.cloud.creates[0].clientToken;
    await data.service.submit(alice, 'a', sent.id); expect(data.cloud.creates).toHaveLength(1); expect(token).toHaveLength(64);
    data.cloud.statuses.set(sent.targets[0].deploymentId!, 'COMPLETED');
    expect((await data.service.operation(alice, 'a', sent.id, true)).status).toBe('SUCCEEDED');
    expect((await data.service.get(alice, 'a', device.id)).device.activeOperationId).toBeUndefined();
  });
  it('records failed and ambiguous submissions honestly and adopts a timed-out accepted deployment by operation identity', async () => {
    const { operation } = await prepare(data);
    data.cloud.reject = 'ambiguous';
    const uncertain = await data.service.submit(alice, 'a', operation.id);
    expect(uncertain.status).toBe('SUBMISSION_UNKNOWN');
    expect((await data.service.get(alice, 'a', operation.deviceId)).device.activeOperationId).toBe(operation.id);
    data.cloud.reject = undefined;
    const adopted = await data.service.operation(alice, 'a', operation.id, true);
    expect(adopted.targets[0].deploymentId).toBe('deployment-1');
    expect(adopted.status).toBe('RUNNING'); expect(data.cloud.creates).toHaveLength(1);
    data.cloud.statuses.set('deployment-1', 'FAILED');
    expect((await data.service.operation(alice, 'a', operation.id, true)).status).toBe('FAILED');
  });
  it('never overwrites a target changed since preparation', async () => {
    const { operation } = await prepare(data);
    data.cloud.snapshots.set(operation.targets[0].targetArn, { targetArn: operation.targets[0].targetArn, deploymentId: 'external', components: {} });
    await expect(data.service.submit(alice, 'a', operation.id)).rejects.toMatchObject({ status: 409 });
    expect(data.cloud.creates).toHaveLength(0);
  });
  it('requires a verified runtime readiness receipt even after AWS reports completion', async () => {
    const { operation } = await prepare(data); data.cloud.onCreate = undefined;
    const submitted = await data.service.submit(alice, 'a', operation.id);
    data.cloud.statuses.set(submitted.targets[0].deploymentId!, 'COMPLETED');
    const observed = await data.service.operation(alice, 'a', operation.id, true);
    expect(observed.status).toBe('RUNNING');
    expect(observed.targets[0].error).toContain('Runtime readiness not verified');
  });
  it('gates unmanaged prior component configuration instead of claiming a safe rollback', async () => {
    data.cloud.snapshots.set(data.cloud.arn('test-core-a'), { targetArn: data.cloud.arn('test-core-a'), deploymentId: 'external', components: { 'com.pai.inference': { componentVersion: '2.0.0', configurationUpdate: { merge: '{\"unknownOldSetting\":true}' } } } });
    const device = await data.service.register(alice, 'a', registration());
    await expect(data.service.prepare(alice, 'a', { deviceId: device.id, modelId: data.model.id, name: 'unsafe', profileId: device.profiles[0].id })).rejects.toThrow(/rollback baseline/);
  });
  it('rolls back the prior owned desired snapshot and refuses a newer external deployment', async () => {
    const { operation } = await prepare(data);
    const sent = await data.service.submit(alice, 'a', operation.id);
    data.cloud.statuses.set(sent.targets[0].deploymentId!, 'COMPLETED'); await data.service.operation(alice, 'a', sent.id, true);
    const rollback = await data.service.rollback(alice, 'a', sent.id);
    expect(rollback.status).toBe('PREPARED'); expect(rollback.targets[0].after.components).toEqual({});
    expect(rollback.targets[0].priorCloudSnapshot.deploymentId).toBe(sent.targets[0].deploymentId);
    const restored = await data.service.submit(alice, 'a', rollback.id);
    data.cloud.statuses.set(restored.targets[0].deploymentId!, 'COMPLETED');
    expect((await data.service.operation(alice, 'a', rollback.id, true)).status).toBe('SUCCEEDED');
    await expect(data.service.rollback(alice, 'a', sent.id)).rejects.toThrow(/newer deployment/);
  });
  it('restores a prior owned component version/model configuration with a new operation evidence path', async () => {
    const d = await data.service.register(alice, 'a', { ...registration(), profiles: [
      { name: 'com.pai.inference', version: '2.3.4' }, { name: 'com.pai.inference', version: '2.3.5' },
    ] });
    let latest;
    for (const profile of d.profiles) {
      const prepared = await data.service.prepare(alice, 'a', { deviceId: d.id, profileId: profile.id, modelId: data.model.id, name: profile.version });
      latest = await data.service.submit(alice, 'a', prepared.id);
      data.cloud.statuses.set(latest.targets[0].deploymentId!, 'COMPLETED');
      await data.service.operation(alice, 'a', latest.id, true);
    }
    const rollback = await data.service.rollback(alice, 'a', latest!.id);
    const prior = rollback.targets[0].after.components['com.pai.inference'];
    expect(prior.componentVersion).toBe('2.3.4');
    const config = JSON.parse(JSON.parse(prior.configurationUpdate!.merge!).execution);
    expect(config.model.checkpoint).toEqual(data.model.checkpoint);
    expect(config.operationId).toBe(rollback.id);
    expect(config.report.key).toContain(rollback.id);
  });
  it('expands a registered group to fixed registered cores; added members never receive continuous group deployment', async () => {
    await data.service.register(alice, 'a', registration('test-core-a'));
    await data.service.register(alice, 'a', registration('test-core-b'));
    const group = await data.service.register(alice, 'a', { ...registration('test-group'), kind: 'thing-group' });
    const op = await data.service.prepare(alice, 'a', { deviceId: group.id, profileId: group.profiles[0].id, modelId: data.model.id, name: 'Group' });
    data.cloud.groups['test-group'].push('unregistered-core');
    await expect(data.service.submit(alice, 'a', op.id)).rejects.toThrow(/membership changed/);
    data.cloud.groups['test-group'].pop();
    await data.service.submit(alice, 'a', op.id);
    expect(data.cloud.creates).toHaveLength(2);
    expect(data.cloud.creates.every(c => c.targetArn.includes(':thing/test-core-'))).toBe(true);
  });
  it('refreshes group membership only after every new member is separately registered', async () => {
    await data.service.register(alice, 'a', registration('test-core-a'));
    await data.service.register(alice, 'a', registration('test-core-b'));
    const group = await data.service.register(alice, 'a', { ...registration('test-group'), kind: 'thing-group' });
    data.cloud.groups['test-group'].push('test-core-c');
    await expect(data.service.update(alice, 'a', group.id, { refreshMembers: true })).rejects.toThrow(/Register compatible core/);
    await data.service.register(alice, 'a', registration('test-core-c'));
    expect((await data.service.update(alice, 'a', group.id, { refreshMembers: true })).members).toHaveLength(3);
    expect(data.cloud.creates).toHaveLength(0);
  });
});
describe('exclusive HIL leases', () => {
  it('fences concurrent claims, conceals tokens, and rejects stale release after expiry/reclaim', async () => {
    const d = await data.service.register(alice, 'a', { ...registration('local'), kind: 'virtual', profiles: [] });
    const results = await Promise.allSettled([1, 2].map(() => data.service.claimLease(alice, 'a', d.id, { runId: 'active-run', ttlSeconds: 30 })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const first = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
    const publicState = await data.service.get(alice, 'a', d.id);
    expect(publicState.lease).not.toHaveProperty('token'); expect(publicState.lease).not.toHaveProperty('tokenHash');
    await expect(data.service.lease(alice, 'a', d.id, 'validate', { runId: 'other-run', epoch: first.epoch, token: first.token })).rejects.toThrow();
    data.advance(31_000);
    const second = await data.service.claimLease(alice, 'a', d.id, { runId: 'active-run' });
    expect(second.epoch).toBe(first.epoch + 1);
    await expect(data.service.lease(alice, 'a', d.id, 'release', { runId: first.runId, epoch: first.epoch, token: first.token })).rejects.toThrow(/newer fencing epoch/);
    expect(await data.service.lease(alice, 'a', d.id, 'release', { runId: second.runId, epoch: second.epoch, token: second.token })).toMatchObject({ state: 'RELEASED' });
  });
  it('requires an active accessible workflow and blocks deployment while the lease is live', async () => {
    const { device, operation } = await prepare(data);
    await expect(data.service.claimLease(alice, 'a', device.id, { runId: 'train-run' })).rejects.toThrow(/active/);
    const lease = await data.service.claimLease(alice, 'a', device.id, { runId: 'active-run' });
    await expect(data.service.submit(alice, 'a', operation.id)).rejects.toThrow(/HIL lease/);
    await data.service.lease(alice, 'a', device.id, 'release', { runId: lease.runId, epoch: lease.epoch, token: lease.token });
    await data.service.submit(alice, 'a', operation.id);
    await expect(data.service.claimLease(alice, 'a', device.id, { runId: 'active-run' })).rejects.toThrow(/exclusively held/);
  });
});
describe('benchmark provenance', () => {
  it('labels client measurements imported and preserves failures rather than manufacturing TRT results', async () => {
    const d = await data.service.register(alice, 'a', registration());
    const imported = await data.service.benchmark(alice, 'a', d.id, { source: 'imported', modelId: data.model.id,
      engine: { name: 'pytorch', version: 'unknown' }, platform: { architecture: 'amd64', description: 'manual workshop log' },
      payload: [sample, { mode: 'trt', status: 'failed', error: 'engine missing' }] });
    expect(imported).toMatchObject({ verification: 'imported', identityVerified: false, modelId: data.model.id });
    expect(imported.results[1]).not.toHaveProperty('avg_ms');
    await expect(data.service.benchmark(alice, 'a', d.id, { source: 'imported', engine: { name: 'pytorch' }, platform: { architecture: 'amd64', description: 'x' }, payload: [{ ...sample, hz: Infinity }] })).rejects.toMatchObject({ status: 400 });
  });
  it('loads server-selected versioned operation artifacts and verifies model/engine/platform identity', async () => {
    const d = await data.service.register(alice, 'a', registration());
    const prepared = await data.service.prepare(alice, 'a', { deviceId: d.id, modelId: data.model.id, name: 'Bench', profileId: d.profiles[1].id });
    await data.service.submit(alice, 'a', prepared.id);
    const execution = JSON.parse(JSON.parse(prepared.targets[0].after.components['com.pai.benchmark'].configurationUpdate!.merge!).execution);
    const report = { schemaVersion: 1, type: 'inference_benchmark', operationId: prepared.id, deviceId: d.id,
      modelId: data.model.id, checkpointDigest: data.model.checkpoint.sha256,
      engine: { name: 'sb3-ppo', version: '2.6.0', runtimeImage: d.profiles[1].runtimeImage },
      platform: { architecture: 'amd64', system: 'Linux', machine: 'x86_64' }, results: [sample] };
    data.objects.add(execution.report.key, report, 'bench-version-1');
    const evidence = await data.service.benchmark(alice, 'a', d.id, { source: 'operation-artifact', operationId: prepared.id });
    expect(evidence).toMatchObject({ verification: 'operation_artifact', identityVerified: true, source: { versionId: 'bench-version-1' }, checkpointDigest: data.model.checkpoint.sha256 });
    data.objects.add(execution.report.key, { ...report, checkpointDigest: '0'.repeat(64) }, 'tampered-version');
    await expect(data.service.benchmark(alice, 'a', d.id, { source: 'operation-artifact', operationId: prepared.id })).rejects.toThrow(/identity/);
  });
});
