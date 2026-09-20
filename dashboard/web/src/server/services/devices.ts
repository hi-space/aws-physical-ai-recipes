import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canReadResource, canWriteIn, isProjectAdmin, resolveProject } from '../auth/projects';
import { requireRole, type Session } from '../auth/session';
import { badRequest, HttpError, notFound } from '../errors';
import { getRepo, type Repo } from '../store/repo';
import type { Item } from '../store/dynamo';
import type { Write } from '../store/atomic';
import { edgeCloud, type ComponentProfile, type CoreObservation, type DeploymentSnapshot, type EdgeArchitecture, type EdgeCloud, type EdgePurpose } from '../aws/greengrass';
import { modelsService, type ModelsService } from './models';
import type { ObjectPin } from '../evaluations/types';
import { EvidenceReader, digest, scopedS3, type ObjectStorage } from '../evaluations/evidence';
import { S3EvidenceStorage } from '../evaluations/s3-storage';
import { evaluatePromotion } from '../evaluations/promotion-policy';
import { parseBenchmark, type BenchmarkMeasurement } from '../evaluations/benchmark';

export interface Device {
  id: string; projectId: string; ownerSubject: string; label: string;
  kind: 'thing' | 'core' | 'thing-group' | 'virtual'; targetName: string; targetArn?: string;
  architecture: EdgeArchitecture; physical: boolean; hardwareValidation: 'not_tested';
  members: string[]; profiles: ComponentProfile[]; revision: number; leaseEpoch: number;
  createdAt: string; activeOperationId?: string; lastOperationId?: string;
}
export interface DeviceLease {
  deviceId: string; projectId: string; ownerSubject: string; runId: string; epoch: number;
  expiresAt: number; state: 'ACTIVE' | 'RELEASED'; tokenHash: string;
}
export type PublicLease = Omit<DeviceLease, 'tokenHash'>;
export interface EdgeExecution {
  edgeContract: 'physical-ai-pinned-v1'; operationId: string; deviceId: string; projectId: string;
  purpose: EdgePurpose; profile: ComponentProfile;
  model?: { id: string; checkpoint: ObjectPin; normalization?: ObjectPin; bundleManifest?: ObjectPin };
  report: { bucket: string; key: string }; iterations: number; warmup: number;
}
export interface OperationTarget {
  deviceId: string; targetName: string; targetArn: string; before: DeploymentSnapshot; after: DeploymentSnapshot;
  priorCloudSnapshot: DeploymentSnapshot; deploymentId?: string; state: 'PENDING' | 'SUBMITTED' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';
  observation?: CoreObservation; readiness?: ObjectPin[]; error?: string;
}
export interface EdgeOperation {
  id: string; projectId: string; ownerSubject: string; deviceId: string; name: string;
  kind: 'deploy' | 'rollback'; profile?: ComponentProfile; modelId?: string;
  status: 'PREPARED' | 'SUBMITTING' | 'SUBMISSION_UNKNOWN' | 'SUBMITTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  targets: OperationTarget[]; allowUnapprovedBenchmark: boolean; revision: number;
  createdAt: string; firstSubmittedAt?: string; checkedAt?: string; error?: string; rollbackOf?: string;
}
export interface BenchmarkEvidence {
  id: string; projectId: string; ownerSubject: string; deviceId: string; createdAt: string;
  verification: 'imported' | 'operation_artifact'; kind: 'inference-performance' | 'communication';
  modelId?: string; checkpointDigest?: string; operationId?: string;
  engine: Record<string, unknown>; platform: Record<string, unknown>; identityVerified: boolean;
  results: BenchmarkMeasurement[]; source?: ObjectPin; note?: string;
}
const objectId = z.string().regex(/^[a-z0-9-]{1,100}$/);
const name = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const component = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/) }).strict();
export const deviceRegistrationSchema = z.object({
  label: z.string().trim().min(1).max(100), kind: z.enum(['thing', 'core', 'thing-group', 'virtual']), targetName: name,
  architecture: z.enum(['amd64', 'arm64']), physical: z.boolean(), acknowledgePhysicalRegistration: z.boolean().default(false),
  profiles: z.array(component).max(10).default([]),
}).strict();
export const deploymentSchema = z.object({ deviceId: objectId, profileId: objectId, modelId: objectId.optional(),
  name: z.string().trim().min(1).max(100), allowUnapprovedBenchmark: z.boolean().default(false),
  iterations: z.number().int().min(1).max(10000).default(50), warmup: z.number().int().min(0).max(1000).default(5),
}).strict();
export const deviceUpdateSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  profiles: z.array(component).max(10).optional(),
  refreshMembers: z.boolean().default(false),
  promoteToCore: z.boolean().default(false),
}).strict();
export const leaseClaimSchema = z.object({ runId: objectId, ttlSeconds: z.number().int().min(30).max(3600).default(300) }).strict();
export const leaseProofSchema = z.object({ runId: objectId, epoch: z.number().int().positive(), token: z.string().regex(/^[a-f0-9]{64}$/), ttlSeconds: z.number().int().min(30).max(3600).optional() }).strict();
export const benchmarkSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('imported'), modelId: objectId.optional(), payload: z.unknown(),
    engine: z.object({ name: z.string().min(1).max(100), version: z.string().max(200).optional(), digest: z.string().max(200).optional() }).strict(),
    platform: z.object({ architecture: z.enum(['amd64', 'arm64']), description: z.string().min(1).max(500) }).strict(), note: z.string().max(1000).optional() }).strict(),
  z.object({ source: z.literal('operation-artifact'), operationId: objectId }).strict(),
]);
type ModelsAccess = Pick<ModelsService, 'get' | 'getEvaluation' | 'list'>;
interface Dependencies { repo: Repo; models: ModelsAccess; cloud: EdgeCloud; objects: ObjectStorage; artifactBucket: string; now?: () => Date }
const principal = (s: Session) => s.subject ?? s.user;
const dkey = (p: string, id: string) => `DEVICE#${p}#${id}`;
const okey = (p: string, id: string) => `EDGE_OP#${p}#${id}`;
const clean = <T>(item: Item): T => { const { pk: _pk, sk: _sk, gsi1pk: _g, gsi1sk: _s, ...value } = item; return value as T; };
const publicLease = (lease?: DeviceLease): PublicLease | undefined => { if (!lease) return; const { tokenHash: _token, ...value } = lease; return value; };
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw badRequest('Invalid edge request', { issues: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }); return result.data; }
function ditem(d: Device): Item { return { ...d, pk: dkey(d.projectId, d.id), sk: 'META', gsi1pk: `PROJECT#${d.projectId}#DEVICES`, gsi1sk: `${d.createdAt}#${d.id}` }; }
function oitem(o: EdgeOperation): Item { return { ...o, pk: okey(o.projectId, o.id), sk: 'META', gsi1pk: `PROJECT#${o.projectId}#EDGE_OPS`, gsi1sk: `${o.createdAt}#${o.id}` }; }
const live = (lease: DeviceLease | undefined, now: number) => lease?.state === 'ACTIVE' && lease.expiresAt > now;
const terminal = (op: EdgeOperation) => op.status === 'SUCCEEDED' || op.status === 'FAILED';
function executions(snapshot: DeploymentSnapshot): EdgeExecution[] {
  const result: EdgeExecution[] = [];
  for (const component of Object.values(snapshot.components)) {
    if (!component.configurationUpdate?.merge) continue;
    const config = JSON.parse(component.configurationUpdate.merge);
    if (typeof config.execution === 'string') {
      const execution = JSON.parse(config.execution);
      if (execution.edgeContract === 'physical-ai-pinned-v1') result.push(execution);
    }
  }
  return result;
}

export class DevicesService {
  private readonly evidence: EvidenceReader;
  constructor(private readonly deps: Dependencies) { this.evidence = new EvidenceReader(deps.objects, deps.artifactBucket); }
  private now() { return this.deps.now?.() ?? new Date(); }
  private async access(session: Session, projectId: string, role: 'viewer' | 'researcher' | 'project-admin' = 'viewer') {
    parse(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), projectId);
    if (role !== 'viewer') requireRole(session, 'researcher');
    return resolveProject(session, projectId, this.deps.repo, role);
  }
  private async device(p: string, id: string) { parse(objectId, id); const value = await this.deps.repo.kv.get(dkey(p, id), 'META'); if (!value || value.projectId !== p) throw notFound('device'); return clean<Device>(value); }
  private async operationRecord(p: string, id: string) { parse(objectId, id); const value = await this.deps.repo.kv.get(okey(p, id), 'META'); if (!value || value.projectId !== p) throw notFound('operation'); return clean<EdgeOperation>(value); }
  private async leaseRecord(p: string, id: string) { const value = await this.deps.repo.kv.get(dkey(p, id), 'LEASE'); return value ? clean<DeviceLease>(value) : undefined; }
  private leaseCheck(p: string, id: string, lease?: DeviceLease): Write { return { kind: 'check', pk: dkey(p, id), sk: 'LEASE', condition: lease ? { equals: { epoch: lease.epoch, expiresAt: lease.expiresAt, state: lease.state, tokenHash: lease.tokenHash } } : { absent: true } }; }
  private async targets(device: Device): Promise<Device[]> {
    if (device.kind === 'virtual' || device.kind === 'thing') throw badRequest('Greengrass deployment requires a registered core; virtual/Thing-only targets remain communication or lease targets');
    if (device.kind === 'core') {
      const current = await this.deps.cloud.target('core', device.targetName);
      if (current.arn !== device.targetArn || current.architecture !== device.architecture) throw new HttpError(409, 'Core identity/architecture changed since registration');
      return [device];
    }
    const current = await this.deps.cloud.target('thing-group', device.targetName);
    const members = await Promise.all(device.members.map(id => this.device(device.projectId, id)));
    if (JSON.stringify((current.members ?? []).sort()) !== JSON.stringify(members.map(d => d.targetName).sort())) throw new HttpError(409, 'Thing group membership changed; project-admin registration must be reviewed again');
    if (members.some(d => d.kind !== 'core' || d.architecture !== device.architecture)) throw badRequest('Group requires registered same-architecture cores');
    for (const member of members) await this.targets(member);
    return members;
  }
  async register(session: Session, p: string, value: unknown) {
    await this.access(session, p, 'project-admin');
    const input = parse(deviceRegistrationSchema, value);
    if (input.physical && !input.acknowledgePhysicalRegistration) throw badRequest('Physical hardware must be explicitly acknowledged at registration');
    if (input.kind === 'virtual' && (input.physical || input.profiles.length)) throw badRequest('Local virtual devices are communication-only and have no cloud deployment profiles');
    const resolved = input.kind === 'virtual' ? undefined : await this.deps.cloud.target(input.kind, input.targetName);
    if (resolved?.architecture && resolved.architecture !== input.architecture) throw badRequest('Reported core architecture does not match registration');
    let members: Device[] = [];
    if (input.kind === 'thing-group') {
      const names = resolved!.members ?? [];
      if (!names.length || names.length > 8) throw badRequest('A group must contain 1–8 explicitly registered cores');
      const registered = (await this.deps.repo.kv.queryGsi1(`PROJECT#${p}#DEVICES`)).map(i => clean<Device>(i));
      members = names.map(name => { const d = registered.find(d => d.kind === 'core' && d.targetName === name); if (!d) throw badRequest(`Group member ${name} is not a registered project core`); return d; });
      if (members.some(d => d.architecture !== input.architecture) || members.some(d => d.physical) !== input.physical) throw badRequest('Group architecture/physical classification must match registered members');
    }
    const profiles = await Promise.all(input.profiles.map(profile => this.deps.cloud.component(profile.name, profile.version, input.architecture)));
    if (input.physical && profiles.some(profile => profile.purpose === 'communication')) throw badRequest('The virtual communication harness cannot target physical hardware');
    const identity = resolved?.arn ?? `virtual:${p}:${input.targetName}`;
    const id = `dev-${digest(identity).slice(0, 24)}`;
    const device: Device = { id, projectId: p, ownerSubject: principal(session), label: input.label, kind: input.kind,
      targetName: input.targetName, ...(resolved ? { targetArn: resolved.arn } : {}), architecture: input.architecture,
      physical: input.physical, hardwareValidation: 'not_tested', members: members.map(d => d.id), profiles,
      revision: 1, leaseEpoch: 0, createdAt: this.now().toISOString() };
    if (!(await this.deps.repo.kv.transaction([
      { kind: 'put', item: ditem(device), condition: { absent: true } },
      { kind: 'put', item: { pk: `DEVICE_TARGET#${digest(identity)}`, sk: 'OWNER', projectId: p, deviceId: id, ownerSubject: principal(session) }, condition: { absent: true } },
    ]))) throw new HttpError(409, 'Target is already registered; it cannot be registered again under another project or alias');
    return device;
  }
  async list(session: Session, p: string) {
    const project = await this.access(session, p);
    const [items, operations, models, runs] = await Promise.all([
      this.deps.repo.kv.queryGsi1(`PROJECT#${p}#DEVICES`, { limit: 100, desc: true }),
      this.deps.repo.kv.queryGsi1(`PROJECT#${p}#EDGE_OPS`, { limit: 100, desc: true }),
      this.deps.models.list(session, p), this.deps.repo.listWorkflows({ projectId: p, limit: 100 }),
    ]);
    const devices = items.filter(i => i.projectId === p).map(i => clean<Device>(i));
    const leases = await Promise.all(devices.map(async d => publicLease(await this.leaseRecord(p, d.id))));
    return { projectId: p, devices, leases: leases.filter((lease): lease is PublicLease => !!lease), operations: operations.map(i => clean<EdgeOperation>(i)), models: models.models,
      runs: runs.filter(r => r.projectId === p && ['PENDING', 'RUNNING'].includes(r.status)).map(r => ({ id: r.id, name: r.name })),
      canWrite: session.role === 'admin' || session.role === 'researcher' && canWriteIn(session, project),
      canRegister: session.role === 'admin' || session.role === 'researcher' && isProjectAdmin(session, project) };
  }
  async update(session: Session, p: string, id: string, value: unknown) {
    await this.access(session, p, 'project-admin'); const request = parse(deviceUpdateSchema, value); const d = await this.device(p, id);
    const lease = await this.leaseRecord(p, id);
    if (d.activeOperationId || live(lease, this.now().getTime())) throw new HttpError(409, 'Cannot change profiles while a deployment or lease owns the device');
    if (d.kind === 'virtual' && request.profiles?.length) throw badRequest('Local virtual devices cannot receive cloud component profiles');
    let kind = d.kind;
    if (request.promoteToCore) {
      if (d.kind !== 'thing') throw badRequest('Only an existing Thing registration can be confirmed as a Core');
      const core = await this.deps.cloud.target('core', d.targetName);
      if (core.arn !== d.targetArn || core.architecture !== d.architecture) throw badRequest('Core identity/architecture does not match the registered Thing');
      kind = 'core';
    }
    const profiles = request.profiles ? await Promise.all(request.profiles.map(profile => this.deps.cloud.component(profile.name, profile.version, d.architecture))) : d.profiles;
    let members = d.members, physical = d.physical;
    if (request.refreshMembers) {
      if (d.kind !== 'thing-group') throw badRequest('Only registered groups have members to refresh');
      const group = await this.deps.cloud.target('thing-group', d.targetName);
      if (!group.members?.length || group.members.length > 8) throw badRequest('Group requires 1–8 registered cores');
      const registered = (await this.deps.repo.kv.queryGsi1(`PROJECT#${p}#DEVICES`)).map(i => clean<Device>(i));
      const selected = group.members.map(name => {
        const core = registered.find(value => value.kind === 'core' && value.targetName === name && value.architecture === d.architecture);
        if (!core) throw badRequest(`Register compatible core ${name} before refreshing this group`);
        return core;
      });
      members = selected.map(core => core.id); physical = selected.some(core => core.physical);
    }
    if (physical && profiles.some(profile => profile.purpose === 'communication')) throw badRequest('Virtual harness cannot target physical hardware');
    const updated = { ...d, kind, label: request.label ?? d.label, profiles, members, physical, revision: d.revision + 1 };
    if (!(await this.deps.repo.kv.transaction([this.leaseCheck(p, id, lease),
      { kind: 'put', item: ditem(updated), condition: { equals: { revision: d.revision } } }]))) throw new HttpError(409, 'Device changed concurrently');
    return updated;
  }
  async get(session: Session, p: string, id: string) {
    await this.access(session, p); const device = await this.device(p, id);
    const benchmarks = (await this.deps.repo.kv.query(dkey(p, id), 'BENCHMARK#', { desc: true, limit: 100 })).map(i => clean<BenchmarkEvidence>(i));
    let observation: CoreObservation | undefined; let sourceError: string | undefined;
    if (device.kind === 'core') try { observation = await this.deps.cloud.inspect(device.targetName); } catch (error) { sourceError = `Core status unavailable: ${(error as Error).message}`; }
    return { device, lease: publicLease(await this.leaseRecord(p, id)), benchmarks, observation, sourceError };
  }
  private async modelFor(session: Session, p: string, id: string, purpose: EdgePurpose, allowUnapproved: boolean) {
    const model = (await this.deps.models.get(session, p, id)).model;
    if (!model.checkpoint.sha256 || model.checkpoint.checksumType !== 'FULL_OBJECT') throw badRequest('A verified full-object checkpoint checksum is required on the device');
    let approved = false;
    if (model.qualityApproval?.approved && model.qualityApproval.decision.status === 'pass') {
      const evaluation = await this.deps.models.getEvaluation(session, p, model.qualityApproval.evaluationId);
      approved = evaluation.modelId === model.id && evaluation.checkpointDigest === model.checkpoint.sha256 &&
        evaluation.verification === 'published_runtime_report' && evaluatePromotion(evaluation.metrics, model.qualityApproval.policy).status === 'pass';
    }
    if (purpose === 'inference' && !approved) throw badRequest('Inference requires application quality approval of this exact registered checkpoint');
    if (purpose === 'benchmark' && !approved && !allowUnapproved) throw badRequest('Benchmarking an unapproved model requires explicit allowUnapprovedBenchmark');
    for (const pin of [model.checkpoint, model.normalization, model.bundle?.manifest].filter((pin): pin is ObjectPin => !!pin)) {
      scopedS3(`s3://${pin.bucket}/${pin.key}`, p, this.deps.artifactBucket); await this.evidence.verify(pin);
    }
    return model;
  }
  private async verifyExecution(session: Session, p: string, execution: EdgeExecution, architecture: EdgeArchitecture, allowUnapproved: boolean) {
    const profile = await this.deps.cloud.component(execution.profile.name, execution.profile.version, architecture);
    if (profile.recipeHash !== execution.profile.recipeHash || profile.purpose !== execution.purpose) throw new HttpError(409, 'Registered component recipe/version changed');
    if (execution.purpose === 'communication') { if (execution.model) throw badRequest('Communication is not model inference'); return; }
    if (!execution.model) throw badRequest('A registered model is required');
    const model = await this.modelFor(session, p, execution.model.id, execution.purpose, allowUnapproved);
    if (model.checkpoint.versionId !== execution.model.checkpoint.versionId || model.checkpoint.sha256 !== execution.model.checkpoint.sha256 || model.checkpoint.key !== execution.model.checkpoint.key) throw new HttpError(409, 'Model artifact changed after operation preparation');
    if (model.normalization?.sha256 !== execution.model.normalization?.sha256 ||
        model.normalization?.versionId !== execution.model.normalization?.versionId ||
        model.normalization?.key !== execution.model.normalization?.key) throw new HttpError(409, 'Model normalization changed after operation preparation');
  }
  async prepare(session: Session, p: string, value: unknown) {
    await this.access(session, p, 'researcher');
    const request = parse(deploymentSchema, value); const device = await this.device(p, request.deviceId);
    const profile = device.profiles.find(profile => profile.id === request.profileId); if (!profile) throw badRequest('Select a registered component profile');
    const cores = await this.targets(device);
    if (profile.purpose === 'communication' && cores.some(d => d.physical)) throw badRequest('Virtual harness cannot deploy to physical devices');
    const model = profile.purpose === 'communication' ? undefined : request.modelId ? await this.modelFor(session, p, request.modelId, profile.purpose, request.allowUnapprovedBenchmark) : undefined;
    if (profile.purpose !== 'communication' && !model) throw badRequest('Select an actual registered modelId');
    if (profile.purpose === 'communication' && request.modelId) throw badRequest('Communication-only operations cannot claim a model');
    if (profile.modelFormat === 'mujoco-ppo-bundle' && !model?.bundle) throw badRequest('Profile requires a verified MuJoCo PPO/VecNormalize bundle');
    if (profile.modelFormat === 'groot-directory-tar' && !model?.checkpoint.path.endsWith('.tar.gz')) throw badRequest('GR00T profile requires a registered directory archive, not an arbitrary device model path');
    const id = `edge-${randomUUID()}`; const targets: OperationTarget[] = [];
    for (const core of cores) {
      const beforeCloud = await this.deps.cloud.current(core.targetArn!);
      const previous = core.lastOperationId ? await this.operationRecord(p, core.lastOperationId) : undefined;
      const prior = previous?.targets.find(t => t.deviceId === core.id && t.deploymentId === beforeCloud.deploymentId);
      const observed = await this.deps.cloud.inspect(core.targetName);
      const occupied = Boolean(beforeCloud.components[profile.name] || observed.installed.some(c => c.name === profile.name));
      if (occupied && !prior?.after.components[profile.name]?.configurationUpdate) throw new HttpError(409, 'Component has unmanaged pre-existing configuration; a safe rollback baseline is unavailable');
      const before: DeploymentSnapshot = { ...beforeCloud, components: prior?.after.components ?? Object.fromEntries(Object.entries(beforeCloud.components).map(([name, c]) => [name, { componentVersion: c.componentVersion }])) };
      const execution: EdgeExecution = { edgeContract: 'physical-ai-pinned-v1', operationId: id, projectId: p, deviceId: core.id,
        purpose: profile.purpose, profile, ...(model ? { model: { id: model.id, checkpoint: model.checkpoint, normalization: model.normalization, bundleManifest: model.bundle?.manifest } } : {}),
        report: { bucket: this.deps.artifactBucket, key: `projects/${p}/edge/${core.id}/operations/${id}/benchmark.json` }, iterations: request.iterations, warmup: request.warmup };
      await this.verifyExecution(session, p, execution, core.architecture, request.allowUnapprovedBenchmark);
      const components = { ...before.components };
      // One managed model workload per core prevents benchmark/inference contention and port collisions.
      // Unrelated components remain intact; removals are visible in the reviewable before/after plan.
      if (profile.purpose !== 'communication') for (const existing of executions(before)) {
        if (['inference', 'benchmark'].includes(existing.purpose) && existing.profile.name !== profile.name) delete components[existing.profile.name];
      }
      targets.push({ deviceId: core.id, targetName: core.targetName, targetArn: core.targetArn!, before, priorCloudSnapshot: beforeCloud,
        after: { targetArn: core.targetArn!, components: { ...components, [profile.name]: { componentVersion: profile.version, configurationUpdate: { reset: [''], merge: JSON.stringify({ execution: JSON.stringify(execution) }) } } } }, state: 'PENDING' });
    }
    const operation: EdgeOperation = { id, projectId: p, ownerSubject: principal(session), deviceId: device.id, name: request.name, kind: 'deploy', profile,
      modelId: model?.id, status: 'PREPARED', targets, allowUnapprovedBenchmark: request.allowUnapprovedBenchmark, revision: 1, createdAt: this.now().toISOString() };
    await this.deps.repo.kv.put(oitem(operation), 'not_exists'); return operation;
  }
  private async save(op: EdgeOperation, changes: Partial<EdgeOperation>) {
    const next = { ...op, ...changes, revision: op.revision + 1 };
    if (!(await this.deps.repo.kv.transaction([{ kind: 'put', item: oitem(next), condition: { equals: { revision: op.revision, projectId: op.projectId } } }]))) throw new HttpError(409, 'Operation changed concurrently; refresh its actual status');
    return next;
  }
  private affected(op: EdgeOperation) { return [...new Set([op.deviceId, ...op.targets.map(t => t.deviceId)])]; }
  private async releaseLocks(op: EdgeOperation) {
    const writes: Write[] = [];
    for (const id of this.affected(op)) {
      const d = await this.device(op.projectId, id);
      if (d.activeOperationId !== op.id) continue;
      const { activeOperationId: _active, ...rest } = d;
      const submitted = op.targets.some(t => t.deploymentId && (t.deviceId === id || id === op.deviceId));
      writes.push({ kind: 'put', item: ditem({ ...rest, revision: d.revision + 1, ...(submitted ? { lastOperationId: op.id } : {}) }), condition: { equals: { revision: d.revision, activeOperationId: op.id } } });
    }
    if (writes.length && !(await this.deps.repo.kv.transaction(writes))) throw new HttpError(409, 'Device ownership changed during operation finalization');
  }
  async submit(session: Session, p: string, id: string) {
    await this.access(session, p, 'researcher'); let op = await this.operationRecord(p, id);
    if (!['PREPARED', 'SUBMISSION_UNKNOWN'].includes(op.status)) return op;
    if (op.firstSubmittedAt && this.now().getTime() - Date.parse(op.firstSubmittedAt) > 7 * 3600_000) throw new HttpError(409, 'Unknown submission exceeded the safe retry window; reconcile AWS state before creating another deployment');
    const root = await this.device(p, op.deviceId);
    const cores = op.kind === 'rollback'
      ? (await Promise.all(op.targets.map(async target => this.targets(await this.device(p, target.deviceId))))).flat()
      : await this.targets(root);
    if (op.profile && !root.profiles.some(profile => profile.id === op.profile!.id && profile.recipeHash === op.profile!.recipeHash)) throw new HttpError(409, 'Prepared component profile is no longer registered');
    if (op.targets.some(t => !cores.some(c => c.id === t.deviceId)) ||
        op.kind !== 'rollback' && cores.length !== op.targets.length) throw new HttpError(409, 'Registered deployment target set changed');
    for (const target of op.targets) {
      const current = await this.deps.cloud.current(target.targetArn);
      if (current.tags?.['pai:operation'] === op.id && current.tags?.['pai:device'] === target.deviceId && current.deploymentId) {
        target.deploymentId = current.deploymentId; target.state = 'SUBMITTED';
      } else if ((current.deploymentId ?? '') !== (target.deploymentId ?? target.before.deploymentId ?? '')) throw new HttpError(409, 'Target desired deployment changed after preparation; no overwrite was sent');
      for (const execution of executions(target.after)) {
        await this.verifyExecution(session, p, execution, cores.find(c => c.id === target.deviceId)!.architecture, op.allowUnapprovedBenchmark);
      }
    }
    const writes: Write[] = [];
    for (const deviceId of this.affected(op)) {
      const d = await this.device(p, deviceId); const lease = await this.leaseRecord(p, deviceId);
      if (d.activeOperationId && d.activeOperationId !== op.id) throw new HttpError(409, 'Another operation owns this device');
      if (live(lease, this.now().getTime())) throw new HttpError(409, 'An exclusive HIL lease owns this device');
      writes.push(this.leaseCheck(p, deviceId, lease), { kind: 'put', item: ditem({ ...d, activeOperationId: op.id, revision: d.revision + 1 }), condition: { equals: { revision: d.revision } } });
    }
    const submitting: EdgeOperation = { ...op, status: 'SUBMITTING', firstSubmittedAt: op.firstSubmittedAt ?? this.now().toISOString(), revision: op.revision + 1 };
    writes.push({ kind: 'put', item: oitem(submitting), condition: { equals: { revision: op.revision, status: op.status } } });
    if (!(await this.deps.repo.kv.transaction(writes))) throw new HttpError(409, 'Concurrent device operation/lease claim');
    op = submitting;
    for (const target of op.targets) {
      if (target.deploymentId || target.state === 'FAILED') continue;
      try {
        const result = await this.deps.cloud.create({ ...target.after, name: op.name, clientToken: digest(`${op.id}:${target.deviceId}`),
          projectId: p, operationId: op.id, deviceId: target.deviceId });
        target.deploymentId = result.deploymentId; target.state = 'SUBMITTED'; target.error = undefined;
        op = await this.save(op, { targets: op.targets });
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) throw error;
        const knownRejected = ['AccessDeniedException', 'ValidationException', 'InvalidRequestException', 'ResourceNotFoundException'].includes((error as Error).name);
        target.state = knownRejected ? 'FAILED' : 'UNKNOWN'; target.error = (error as Error).message.slice(0, 2000);
        if (knownRejected) for (const pending of op.targets) if (pending.state === 'PENDING') { pending.state = 'FAILED'; pending.error = 'Not submitted after a rejected target'; }
        op = await this.save(op, { targets: op.targets, status: knownRejected ? op.targets.some(t => t.deploymentId) ? 'SUBMITTED' : 'FAILED' : 'SUBMISSION_UNKNOWN', error: target.error });
        if (op.status === 'FAILED') await this.releaseLocks(op);
        return op;
      }
    }
    return this.save(op, { status: 'SUBMITTED', error: undefined });
  }
  async operation(session: Session, p: string, id: string, refresh = false) {
    await this.access(session, p); let op = await this.operationRecord(p, id);
    if (!refresh || op.status === 'PREPARED') return op;
    if (terminal(op)) { await this.releaseLocks(op); return op; }
    let uncertain = false;
    for (const target of op.targets) {
      if (target.state === 'FAILED') continue;
      try {
        if (!target.deploymentId) {
          const current = await this.deps.cloud.current(target.targetArn);
          if (current.tags?.['pai:operation'] === op.id && current.tags?.['pai:device'] === target.deviceId) target.deploymentId = current.deploymentId;
        }
        if (!target.deploymentId) { uncertain = true; continue; }
        const observation = await this.deps.cloud.inspect(target.targetName, target.deploymentId);
        target.observation = observation;
        if (['FAILED', 'REJECTED', 'TIMED_OUT', 'CANCELED'].includes(observation.executionStatus)) { target.state = 'FAILED'; target.error = observation.message ?? observation.executionStatus; continue; }
        const desired = Object.entries(target.after.components);
        const ready = desired.every(([name, spec]) => observation.installed.some(c => c.name === name && c.version === spec.componentVersion && ['RUNNING', 'FINISHED'].includes(c.state)));
        const broken = desired.some(([name]) => observation.installed.some(c => c.name === name && ['BROKEN', 'ERRORED'].includes(c.state)));
        const removed = executions(target.before).filter(e => !target.after.components[e.profile.name]);
        const removedStillRunning = removed.some(e => observation.installed.some(c => c.name === e.profile.name && c.state === 'RUNNING'));
        if (broken) { target.state = 'FAILED'; target.error = 'A desired component reports a failed lifecycle state'; }
        else if (['SUCCEEDED', 'COMPLETED'].includes(observation.executionStatus) && ready && !removedStillRunning && observation.coreStatus === 'HEALTHY') {
          try {
            target.readiness = [];
            for (const execution of executions(target.after)) {
              const { pin, value } = await this.operationJson(p, execution.report.bucket, execution.report.key.replace(/benchmark\.json$/, 'readiness.json'));
              const report = value as Record<string, unknown>;
              if (report.status !== 'ready' || report.operationId !== execution.operationId || report.deviceId !== target.deviceId ||
                  report.recipeHash !== execution.profile.recipeHash || report.componentVersion !== execution.profile.version ||
                  report.architecture !== execution.profile.architecture ||
                  report.kind !== (execution.model ? 'model-ready' : 'communication-only') ||
                  (execution.model ? report.modelId !== execution.model.id || report.checkpointDigest !== execution.model.checkpoint.sha256 ||
                    execution.model.normalization && report.normalizationDigest !== execution.model.normalization.sha256
                    : report.modelId != null || report.checkpointDigest != null)) throw badRequest('Runtime readiness identity does not match the pinned operation');
              target.readiness.push(pin);
            }
            target.state = 'SUCCEEDED'; target.error = undefined;
          } catch (error) {
            target.state = error instanceof HttpError && error.status === 400 ? 'FAILED' : 'SUBMITTED';
            target.error = `Runtime readiness not verified: ${(error as Error).message}`;
          }
        }
        else { target.state = 'SUBMITTED'; target.error = observation.message ?? (removedStillRunning ? 'Removed component is still effective on the device' : undefined); }
      } catch (error) { target.error = `Status source unavailable: ${(error as Error).message}`; uncertain = true; }
    }
    const allFinished = op.targets.every(t => t.state === 'SUCCEEDED' || t.state === 'FAILED');
    const status: EdgeOperation['status'] = uncertain ? 'SUBMISSION_UNKNOWN' : allFinished ? op.targets.every(t => t.state === 'SUCCEEDED') ? 'SUCCEEDED' : 'FAILED' : 'RUNNING';
    op = await this.save(op, { targets: op.targets, status, checkedAt: this.now().toISOString(), error: uncertain ? 'Actual deployment outcome is not yet confirmed' : undefined });
    if (terminal(op)) await this.releaseLocks(op);
    return op;
  }
  async rollback(session: Session, p: string, id: string, allowUnapprovedBenchmark = false) {
    await this.access(session, p, 'researcher'); const prior = await this.operationRecord(p, id);
    if (!terminal(prior)) throw new HttpError(409, 'Wait for a confirmed terminal deployment before rollback');
    const root = await this.device(p, prior.deviceId);
    const targets: OperationTarget[] = [];
    const rollbackId = `edge-${randomUUID()}`;
    for (const previous of prior.targets) {
      if (!previous.deploymentId) continue;
      const current = await this.deps.cloud.current(previous.targetArn);
      if (current.deploymentId !== previous.deploymentId) throw new HttpError(409, 'A newer deployment exists; rollback will not overwrite it');
      const d = await this.device(p, previous.deviceId);
      for (const execution of executions(previous.before)) {
        if (!root.profiles.some(profile => profile.id === execution.profile.id && profile.recipeHash === execution.profile.recipeHash)) throw new HttpError(409, 'Re-register the prior version before rolling back to it');
        await this.verifyExecution(session, p, execution, d.architecture, allowUnapprovedBenchmark);
      }
      const components = structuredClone(previous.before.components);
      for (const component of Object.values(components)) if (component.configurationUpdate?.merge) {
        const configuration = JSON.parse(component.configurationUpdate.merge);
        if (typeof configuration.execution === 'string') {
          const execution = JSON.parse(configuration.execution) as EdgeExecution;
          if (execution.edgeContract === 'physical-ai-pinned-v1') {
            execution.operationId = rollbackId;
            execution.report.key = `projects/${p}/edge/${previous.deviceId}/operations/${rollbackId}/benchmark.json`;
            configuration.execution = JSON.stringify(execution);
            component.configurationUpdate.merge = JSON.stringify(configuration);
          }
        }
      }
      targets.push({ deviceId: previous.deviceId, targetArn: previous.targetArn, targetName: previous.targetName,
        before: { ...current, components: previous.after.components }, priorCloudSnapshot: current,
        after: { targetArn: previous.targetArn, components }, state: 'PENDING' });
    }
    if (!targets.length) throw badRequest('No submitted target configuration is available to roll back');
    const op: EdgeOperation = { id: rollbackId, projectId: p, ownerSubject: principal(session), deviceId: prior.deviceId,
      kind: 'rollback', name: `Rollback ${prior.name}`.slice(0, 100), targets, allowUnapprovedBenchmark,
      status: 'PREPARED', revision: 1, createdAt: this.now().toISOString(), rollbackOf: prior.id };
    await this.deps.repo.kv.put(oitem(op), 'not_exists'); return op;
  }
  private async leaseRun(session: Session, p: string, id: string) {
    const run = await this.deps.repo.getWorkflow(id);
    if (!run || run.projectId !== p || !(await canReadResource(session, run, this.deps.repo))) throw notFound('lease workflow');
    if (!['PENDING', 'RUNNING'].includes(run.status)) throw badRequest('HIL lease requires an active accessible workflow run');
    return run;
  }
  async claimLease(session: Session, p: string, id: string, value: unknown) {
    await this.access(session, p, 'researcher'); const request = parse(leaseClaimSchema, value);
    const d = await this.device(p, id); if (d.kind === 'thing-group') throw badRequest('Claim an individual device, not a group');
    await this.leaseRun(session, p, request.runId);
    const previous = await this.leaseRecord(p, id);
    if (d.activeOperationId || live(previous, this.now().getTime())) throw new HttpError(409, 'Device is exclusively held by a deployment or HIL lease');
    const token = randomBytes(32).toString('hex');
    const lease: DeviceLease = { deviceId: id, projectId: p, ownerSubject: principal(session), runId: request.runId,
      epoch: d.leaseEpoch + 1, expiresAt: this.now().getTime() + request.ttlSeconds * 1000, state: 'ACTIVE', tokenHash: digest(token) };
    if (!(await this.deps.repo.kv.transaction([
      { kind: 'put', item: ditem({ ...d, leaseEpoch: lease.epoch, revision: d.revision + 1 }), condition: { equals: { revision: d.revision } } },
      { kind: 'put', item: { ...lease, pk: dkey(p, id), sk: 'LEASE' }, condition: previous ? { equals: { epoch: previous.epoch, expiresAt: previous.expiresAt, state: previous.state, tokenHash: previous.tokenHash } } : { absent: true } },
    ]))) throw new HttpError(409, 'Another claimant acquired the device');
    return { ...publicLease(lease)!, token };
  }
  async lease(session: Session, p: string, id: string, action: 'validate' | 'renew' | 'release', value: unknown) {
    await this.access(session, p, 'researcher'); const request = parse(leaseProofSchema, value); const d = await this.device(p, id);
    const lease = await this.leaseRecord(p, id); const hashed = digest(request.token);
    if (!lease || !live(lease, this.now().getTime()) || lease.ownerSubject !== principal(session) || lease.runId !== request.runId || lease.epoch !== request.epoch ||
        lease.tokenHash.length !== hashed.length || !timingSafeEqual(Buffer.from(lease.tokenHash), Buffer.from(hashed))) throw new HttpError(409, 'Lease expired, is not owned by this run, or has a newer fencing epoch');
    if (action !== 'release') await this.leaseRun(session, p, lease.runId);
    if (action === 'validate') return { valid: true, ...publicLease(lease) };
    const updated = { ...lease, ...(action === 'release' ? { state: 'RELEASED' as const, expiresAt: this.now().getTime() } : { expiresAt: this.now().getTime() + (request.ttlSeconds ?? 300) * 1000 }) };
    if (!(await this.deps.repo.kv.transaction([
      { kind: 'put', item: { ...updated, pk: dkey(p, id), sk: 'LEASE' }, condition: { equals: { epoch: lease.epoch, tokenHash: lease.tokenHash, expiresAt: lease.expiresAt, state: 'ACTIVE' } } },
      { kind: 'put', item: ditem({ ...d, revision: d.revision + 1 }), condition: { equals: { revision: d.revision } } },
    ]))) throw new HttpError(409, 'A newer lease/device revision replaced this request');
    return publicLease(updated);
  }
  private async operationJson(p: string, bucket: string, key: string) {
    const ref = scopedS3(`s3://${bucket}/${key}`, p, this.deps.artifactBucket);
    const head = await this.deps.objects.head(ref);
    const bytes = Buffer.from(head.checksumSHA256 ?? '', 'base64');
    if (!head.versionId || head.versionId === 'null' || head.checksumType === 'COMPOSITE' || bytes.length !== 32 || bytes.toString('base64') !== head.checksumSHA256) throw badRequest('Operation artifact needs an immutable VersionId and full SHA256');
    const pin: ObjectPin = { ...ref, path: key.split('/').pop()!, versionId: head.versionId, checksumSHA256: head.checksumSHA256!, checksumType: 'FULL_OBJECT', bytes: head.bytes, sha256: bytes.toString('hex') };
    return { pin, value: await this.evidence.json(pin) };
  }
  async benchmark(session: Session, p: string, id: string, value: unknown) {
    await this.access(session, p, 'researcher'); const request = parse(benchmarkSchema, value); const device = await this.device(p, id);
    let record: BenchmarkEvidence;
    if (request.source === 'imported') {
      let parsed: ReturnType<typeof parseBenchmark>;
      try { parsed = parseBenchmark(request.payload); } catch (error) { throw badRequest((error as Error).message); }
      if (request.modelId) await this.deps.models.get(session, p, request.modelId);
      const communication = parsed.envelope?.type === 'communication' || parsed.results.every(row => row.mode === 'virtual-communication');
      if (communication && request.modelId) throw badRequest('Communication measurements cannot claim model inference');
      record = { id: `bench-${randomUUID()}`, projectId: p, deviceId: id, ownerSubject: principal(session), createdAt: this.now().toISOString(),
        verification: 'imported', kind: communication ? 'communication' : 'inference-performance', modelId: request.modelId,
        engine: request.engine, platform: request.platform, identityVerified: false, results: parsed.results, note: request.note };
    } else {
      const op = await this.operationRecord(p, request.operationId); const target = op.targets.find(t => t.deviceId === id);
      if (!target?.deploymentId) throw badRequest('Benchmark operation was not submitted to this registered device');
      const execution = executions(target.after).find(e => e.operationId === op.id && ['benchmark', 'communication'].includes(e.purpose));
      if (!execution) throw badRequest('Operation did not declare a benchmark/communication artifact');
      const { pin, value: artifact } = await this.operationJson(p, execution.report.bucket, execution.report.key);
      let parsed: ReturnType<typeof parseBenchmark>;
      try { parsed = parseBenchmark(artifact); } catch (error) { throw badRequest((error as Error).message); }
      const envelope = parsed.envelope;
      const identity = z.object({ schemaVersion: z.literal(1), type: z.enum(['inference_benchmark', 'communication']), operationId: z.string(), deviceId: z.string(),
        modelId: z.string().optional(), checkpointDigest: z.string().optional(),
        engine: z.object({ name: z.string().max(100), version: z.string().min(1).max(200), runtimeImage: z.string().max(2048).optional() }),
        platform: z.object({ architecture: z.enum(['amd64', 'arm64']), system: z.string().min(1).max(100), machine: z.string().min(1).max(100), gpu: z.string().max(256).nullable().optional() }),
      }).safeParse(envelope);
      if (!identity.success) throw badRequest('Runtime identity envelope is missing; legacy log arrays may be imported but are not verified model/device evidence');
      const data = identity.data;
      if (data.operationId !== op.id || data.deviceId !== id || data.platform.architecture !== device.architecture || data.engine.name !== execution.profile.engine ||
          data.engine.runtimeImage !== execution.profile.runtimeImage || (execution.model && (data.modelId !== execution.model.id || data.checkpointDigest !== execution.model.checkpoint.sha256)) ||
          (execution.purpose === 'communication' ? data.type !== 'communication' || !!data.modelId : data.type !== 'inference_benchmark')) throw badRequest('Benchmark model/engine/platform identity does not match the operation');
      if (data.platform.system.toLowerCase() !== 'linux' || parsed.results.some(row => row.status === 'measured' &&
          (row.mode !== execution.profile.engine || row.iterations !== execution.iterations))) throw badRequest('Measured mode/iterations/platform do not match the configured execution');
      record = { id: `bench-${digest(`${op.id}:${id}:${pin.versionId}:${pin.sha256}`).slice(0, 24)}`, projectId: p, deviceId: id, ownerSubject: principal(session), createdAt: this.now().toISOString(),
        verification: 'operation_artifact', kind: execution.purpose === 'communication' ? 'communication' : 'inference-performance', modelId: data.modelId, checkpointDigest: data.checkpointDigest,
        operationId: op.id, engine: data.engine, platform: data.platform, identityVerified: true, results: parsed.results, source: pin };
    }
    const key = { pk: dkey(p, id), sk: `BENCHMARK_ID#${record.id}` };
    if (!(await this.deps.repo.kv.transaction([
      { kind: 'put', item: { ...record, ...key }, condition: { absent: true } },
      { kind: 'put', item: { ...record, pk: key.pk, sk: `BENCHMARK#${record.createdAt}#${record.id}` }, condition: { absent: true } },
    ]))) return clean<BenchmarkEvidence>((await this.deps.repo.kv.get(key.pk, key.sk))!);
    return record;
  }
}
export function devicesService() {
  return new DevicesService({ repo: getRepo(), models: modelsService(), cloud: edgeCloud(), objects: new S3EvidenceStorage(), artifactBucket: process.env.DASHBOARD_ARTIFACT_BUCKET ?? '' });
}
