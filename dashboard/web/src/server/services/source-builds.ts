import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { requireRole, type Session } from '../auth/session';
import { resolveProject, type Project, type ProjectRole } from '../auth/projects';
import { config } from '../config';
import { badRequest, forbidden, HttpError, notFound } from '../errors';
import { getRepo } from '../store/repo';
import type { Write } from '../store/atomic';
import { createSourceBuildProvider } from '../aws/source-builds';
import { allowedBuildProjects } from './builds';
import { hashBuildValue, parseBuildTargets, sourceCommitSchema, sourceBuildspecHash, SourceBuildProviderError,
  type SourceBuildDeps, type SourceBuildRun, type SourceRegistration, type SourceBuildTarget, type BuildObservation } from './source-builds-contract';

export const sourceRegistrationInput = z.object({ targetId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), name: z.string().trim().min(1).max(80) }).strict();
export const sourceBuildInput = z.object({ sourceId: z.string().regex(/^src-[a-f0-9]{32}$/), commit: sourceCommitSchema.optional() }).strict();
export const sourceRunId = z.string().regex(/^sb-[a-f0-9]{32}$/);
export const sourceBuildActiveIndex = 'TYPE#SOURCE_BUILD_ACTIVE';
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const SHA = /^[a-f0-9]{64}$/;
const sourceKey = (project: string, id: string) => ({ pk: `PROJECT#${project}`, sk: `SOURCE#${id}` });
const runKey = (id: string) => ({ pk: `SOURCE_BUILD#${id}`, sk: 'META' });
const slotKey = (project: string, slot: number) => ({ pk: `PROJECT#${project}`, sk: `SOURCE_BUILD_SLOT#${slot}` });
const targetHash = (target: SourceBuildTarget) => hashBuildValue({ target, sourceBuildspecHash });
const safeCode = (error: unknown) => error instanceof SourceBuildProviderError && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'source_build_unavailable';
const conflict = () => new HttpError(409, 'Source build changed; refresh using the same request key.', 'source_build_conflict');

export function sourceBuildDefaults(): SourceBuildDeps {
  const c = config();
  return { repo: getRepo(), provider: createSourceBuildProvider({ accountId: c.accountId, region: c.region }),
    targets: () => parseBuildTargets(process.env.SOURCE_BUILD_TARGETS_JSON ?? '[]', c.accountId, c.region, allowedBuildProjects()),
    now: Date.now, randomId: randomUUID };
}
function safeRegistration(row: SourceRegistration, current: boolean) {
  return { id: row.id, name: row.name, projectId: row.projectId, targetId: row.target.id,
    sourceType: row.target.sourceType, repositoryUrl: row.target.repositoryUrl, snapshot: row.snapshot,
    dockerfile: row.target.dockerfile, context: row.target.context, contentHash: row.contentHash,
    buildspecSha256: row.buildspecSha256,
    configurationHash: row.configurationHash, codeBuildProjectName: row.target.codeBuildProjectName,
    createdAt: row.createdAt, createdBy: row.createdBy, current };
}
function safeRun(row: SourceBuildRun, cancelRequested = false) {
  return { id: row.id, projectId: row.projectId, registrationId: row.registrationId, actor: row.actor,
    codeBuildProjectName: row.target.codeBuildProjectName,
    sourceType: row.target.sourceType, commit: row.commit, snapshot: row.snapshot, state: row.state,
    buildId: row.buildId, buildStatus: row.buildStatus, phase: row.phase, errorCode: row.errorCode,
    createdAt: row.createdAt, updatedAt: row.updatedAt, provenance: row.provenance, cancelRequested,
    runtimeValidation: 'not-performed' as const };
}
export type SourceRegistrationView = ReturnType<typeof safeRegistration>;
export type SourceBuildView = ReturnType<typeof safeRun>;

export function sourceBuildService(session: Session, d: SourceBuildDeps = sourceBuildDefaults()) {
  async function authorize(project: Project, required: ProjectRole = 'viewer') {
    if (!session.subject) throw forbidden('Verified identity is required');
    if (required !== 'viewer') requireRole(session, 'researcher');
    return resolveProject(session, project.id, d.repo, required);
  }
  async function registration(id: string, project: Project) {
    if (!/^src-[a-f0-9]{32}$/.test(id)) throw notFound('source registration');
    const key = sourceKey(project.id, id), row = await d.repo.kv.get(key.pk, key.sk) as SourceRegistration | undefined;
    if (!row || row.id !== id || row.projectId !== project.id) throw notFound('source registration');
    return row;
  }
  async function read(id: string, project: Project, write = false) {
    const p = await authorize(project, write ? 'researcher' : 'viewer');
    if (!sourceRunId.safeParse(id).success) throw notFound('source build');
    const key = runKey(id), row = await d.repo.kv.get(key.pk, key.sk) as SourceBuildRun | undefined;
    if (!row || row.projectId !== p.id || row.id !== id) throw notFound('source build');
    return { p, row };
  }
  async function catalog(project: Project, cursor?: string) {
    const p = await authorize(project);
    const targets = d.targets().filter(target => target.projectId === p.id);
    const page = await d.repo.kv.queryGsi1Page(`PROJECT#${p.id}#SOURCE_REGISTRATIONS`, { limit: 50, desc: true, cursor });
    const rows = await Promise.all(page.items.map(item => d.repo.kv.get(item.pk, item.sk)));
    return { projectId: p.id, targets: targets.map(target => ({ id: target.id, codeBuildProjectName: target.codeBuildProjectName,
      sourceType: target.sourceType, repositoryUrl: target.repositoryUrl, snapshotLocation: target.snapshotLocation })),
    sources: rows.filter(item => item?.projectId === p.id).map(item => {
      const row = item as SourceRegistration;
      return safeRegistration(row, targets.some(target => target.id === row.target.id && targetHash(target) === row.targetHash));
    }), cursor: page.cursor };
  }
  async function register(input: z.input<typeof sourceRegistrationInput>, project: Project, signal: AbortSignal) {
    const p = await authorize(project, 'project-admin');
    if (session.authMethod === 'token' || session.tokenProjectId) throw forbidden('Register build sources through browser login');
    const parsed = sourceRegistrationInput.safeParse(input);
    if (!parsed.success) throw badRequest('Invalid source registration');
    const target = d.targets().find(value => value.id === parsed.data.targetId && value.projectId === p.id);
    if (!target) throw badRequest('No registered source-build job for this project');
    const checked = await d.provider.checkTarget(target, signal);
    await authorize(p, 'project-admin');
    const payload = { name: parsed.data.name, projectId: p.id, targetHash: targetHash(target), buildspecSha256: sourceBuildspecHash,
      configurationHash: checked.configurationHash, snapshot: checked.snapshot };
    const contentHash = hashBuildValue(payload), id = `src-${contentHash.slice(0, 32)}`, key = sourceKey(p.id, id);
    const old = await d.repo.kv.get(key.pk, key.sk) as SourceRegistration | undefined;
    if (old) return safeRegistration(old, true);
    const at = new Date(d.now()).toISOString();
    const row: SourceRegistration = { ...key, ...payload, id, target, contentHash, createdAt: at, createdBy: session.subject!,
      gsi1pk: `PROJECT#${p.id}#SOURCE_REGISTRATIONS`, gsi1sk: `${at}#${id}` };
    if (!await d.repo.kv.put(row, 'not_exists')) {
      const saved = await d.repo.kv.get(key.pk, key.sk) as SourceRegistration | undefined;
      if (!saved || saved.contentHash !== contentHash) throw conflict();
      return safeRegistration(saved, true);
    }
    return safeRegistration(row, true);
  }
  async function start(input: z.input<typeof sourceBuildInput>, project: Project, requestKey: string, signal: AbortSignal) {
    const p = await authorize(project, 'researcher'), parsed = sourceBuildInput.safeParse(input);
    if (!parsed.success || !/^[A-Za-z0-9_-]{8,128}$/.test(requestKey ?? '')) throw badRequest('A valid source and stable idempotency key are required');
    const token = hashBuildValue([p.id, session.subject, requestKey]), id = `sb-${token.slice(0, 32)}`, key = runKey(id);
    const requestHash = hashBuildValue(parsed.data), old = await d.repo.kv.get(key.pk, key.sk) as SourceBuildRun | undefined;
    if (old) {
      if (old.projectId !== p.id || old.requestHash !== requestHash) throw conflict();
      return safeRun(old);
    }
    const source = await registration(parsed.data.sourceId, p);
    const target = d.targets().find(value => value.id === source.target.id && value.projectId === p.id);
    if (!target || targetHash(target) !== source.targetHash) throw new HttpError(409, 'Registered build configuration changed; register the current target again.');
    if (target.sourceType === 'S3' ? !!parsed.data.commit || !source.snapshot : !parsed.data.commit) throw badRequest('Git builds require a full commit; S3 builds use the registered immutable snapshot');
    const checked = await d.provider.checkTarget(target, signal, source.snapshot);
    if (checked.configurationHash !== source.configurationHash || !isDeepStrictEqual(checked.snapshot, source.snapshot)) throw new HttpError(409, 'Source/job configuration changed; create a new immutable registration.');
    await authorize(p, 'researcher');
    const at = new Date(d.now()).toISOString();
    for (let slot = 0; slot < 2; slot++) {
      const row: SourceBuildRun = { ...key, id, projectId: p.id, registrationId: source.id, registrationHash: source.contentHash,
        target, configurationHash: source.configurationHash, buildspecSha256: source.buildspecSha256,
        commit: parsed.data.commit, snapshot: source.snapshot, actor: session.subject!,
        requestHash, idempotencyToken: token, state: 'STARTING', revision: 0, slot, createdAt: at, updatedAt: at, nextPollAt: d.now(),
        gsi1pk: `PROJECT#${p.id}#SOURCE_BUILDS`, gsi1sk: `${at}#${id}` };
      const accepted = await d.repo.kv.transaction([
        { kind: 'put', item: row, condition: { absent: true } },
        { kind: 'put', item: pollItem(row) },
        { kind: 'put', item: { ...slotKey(p.id, slot), runId: id }, condition: { absent: true } },
      ]);
      if (accepted) return safeRun(row);
      const duplicate = await d.repo.kv.get(key.pk, key.sk) as SourceBuildRun | undefined;
      if (duplicate) {
        if (duplicate.requestHash !== requestHash || duplicate.projectId !== p.id) throw conflict();
        return safeRun(duplicate);
      }
    }
    throw new HttpError(429, 'This project already has two active or unresolved source builds.', 'source_build_limit');
  }
  async function get(id: string, project: Project) {
    const { row } = await read(id, project);
    return safeRun(row, !!await d.repo.kv.get(row.pk, 'CANCEL'));
  }
  async function list(project: Project, cursor?: string) {
    const p = await authorize(project);
    const page = await d.repo.kv.queryGsi1Page(`PROJECT#${p.id}#SOURCE_BUILDS`, { limit: 20, desc: true, cursor });
    const rows = await Promise.all(page.items.map(item => d.repo.kv.get(item.pk, item.sk)));
    return { items: rows.filter(item => item?.projectId === p.id).map(item => safeRun(item as SourceBuildRun)), cursor: page.cursor };
  }
  async function cancel(id: string, project: Project) {
    const { p, row } = await read(id, project, true);
    if (row.actor !== session.subject && session.role !== 'admin' && p.members[session.subject!] !== 'project-admin') throw forbidden('Only the requester or project administrator can stop this build');
    if (!terminal.has(row.state)) await d.repo.kv.put({ pk: row.pk, sk: 'CANCEL', actor: session.subject!, requestedAt: new Date(d.now()).toISOString() }, 'not_exists');
    return get(id, p);
  }
  async function logs(id: string, project: Project, cursor: string | undefined, signal: AbortSignal) {
    const { row } = await read(id, project);
    if (!row.buildId) return { lines: [], truncated: false };
    if (cursor && cursor.length > 2048) throw badRequest('Invalid log cursor');
    return d.provider.logs(row, cursor, signal);
  }
  /** Parent uses this when pinning a built image into an approved profile/workflow. */
  async function provenance(id: string, image: string, project: Project) {
    const { row } = await read(id, project);
    if (row.state !== 'SUCCEEDED' || !row.provenance || row.provenance.output.resolvedImage !== image) {
      throw new HttpError(409, 'The source build has no verified provenance for this exact image digest.', 'source_build_provenance_mismatch');
    }
    return structuredClone(row.provenance);
  }
  async function recover(id: string, buildId: string, project: Project, signal: AbortSignal) {
    const p = await authorize(project, 'project-admin');
    if (session.authMethod === 'token' || session.tokenProjectId) throw forbidden('Recover source build identity through browser login');
    const { row } = await read(id, p, true);
    if (terminal.has(row.state)) return get(id, p);
    if (row.buildId && row.buildId !== buildId) throw conflict();
    if (!/^[A-Za-z0-9_-]+:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(buildId)) throw badRequest('Invalid CodeBuild execution ID');
    const observed = await d.provider.read({ ...row, buildId }, signal);
    if (observed.id !== buildId) throw conflict();
    await authorize(p, 'project-admin');
    const next: SourceBuildRun = { ...row, buildId, state: 'RUNNING', revision: row.revision + 1,
      firstDispatchAt: row.firstDispatchAt ?? Date.parse(row.createdAt),
      updatedAt: new Date(d.now()).toISOString(), nextPollAt: d.now(), errorCode: undefined };
    if (!await d.repo.kv.transaction([{ kind: 'put', item: next, condition: { equals: { revision: row.revision } } },
      { kind: 'put', item: pollItem(next) }])) throw conflict();
    return get(id, p);
  }
  return { catalog, register, start, get, list, cancel, logs, recover, provenance };
}

function pollItem(row: SourceBuildRun) {
  return { pk: row.pk, sk: 'POLL', id: row.id, projectId: row.projectId, nextPollAt: row.nextPollAt,
    gsi1pk: sourceBuildActiveIndex, gsi1sk: `${String(row.nextPollAt).padStart(16, '0')}#${row.id}` };
}
async function reconcileRun(id: string, signal: AbortSignal, d: SourceBuildDeps) {
  const key = runKey(id);
  const initial = await d.repo.kv.get(key.pk, key.sk) as SourceBuildRun | undefined;
  if (!initial || terminal.has(initial.state) || initial.nextPollAt > d.now() || signal.aborted) return;
  let row: SourceBuildRun = initial;
  const leaseKey = { pk: key.pk, sk: 'LEASE' }, oldLease = await d.repo.kv.get(leaseKey.pk, leaseKey.sk);
  if (oldLease && Number(oldLease.expires) > d.now()) return;
  const holder = d.randomId();
  if (!await d.repo.kv.transaction([{ kind: 'put', item: { ...leaseKey, holder, expires: d.now() + 60000 },
    condition: oldLease ? { equals: { holder: oldLease.holder, expires: oldLease.expires } } : { absent: true } }])) return;
  const ctl = new AbortController(), abort = () => ctl.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const leaseCondition = () => ({ equals: { holder }, after: { expires: d.now() } });
  let renewing: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (renewing || ctl.signal.aborted) return;
    renewing = d.repo.kv.transaction([{ kind: 'put', item: { ...leaseKey, holder, expires: d.now() + 60000 }, condition: leaseCondition() }])
      .then(ok => { if (!ok) ctl.abort(); }).catch(() => ctl.abort()).finally(() => { renewing = undefined; });
  }, 10000);
  timer.unref?.();
  const save = async (change: Partial<SourceBuildRun>) => {
    ctl.signal.throwIfAborted();
    const next: SourceBuildRun = { ...row!, ...change, revision: row!.revision + 1, updatedAt: new Date(d.now()).toISOString(), nextPollAt: d.now() + 5000 };
    const writes: Write[] = [{ kind: 'check', ...leaseKey, condition: leaseCondition() },
      { kind: 'put', item: next, condition: { equals: { revision: row!.revision } } }];
    if (terminal.has(next.state)) writes.push({ kind: 'delete', pk: row!.pk, sk: 'POLL' },
      { kind: 'delete', ...slotKey(next.projectId, next.slot), condition: { equals: { runId: next.id } } });
    else writes.push({ kind: 'put', item: pollItem(next) });
    if (!await d.repo.kv.transaction(writes)) { ctl.abort(); throw new SourceBuildProviderError('source_build_lease_lost'); }
    row = next;
  };
  const finish = (state: 'FAILED' | 'CANCELLED', errorCode?: string) => save({ state, errorCode });
  try {
    const cancelled = () => d.repo.kv.get(key.pk, 'CANCEL');
    let cancel = !!await cancelled(), found: BuildObservation | undefined;
    if (!row.buildId && !row.firstDispatchAt && cancel) { await finish('CANCELLED'); return; }
    if (!row.buildId && row.firstDispatchAt === undefined && d.now() - Date.parse(row.createdAt) > 300000) {
      await finish('FAILED', 'dispatch_deadline_exceeded'); return;
    }
    const source = await d.repo.kv.get(`PROJECT#${row.projectId}`, `SOURCE#${row.registrationId}`) as SourceRegistration | undefined;
    const target = d.targets().find(value => value.id === row!.target.id && value.projectId === row!.projectId);
    const current = !!source && source.contentHash === row.registrationHash && !!target && source.targetHash === targetHash(target);
    if (!row.buildId) {
      if (row.firstDispatchAt) {
        found = await d.provider.find(row, ctl.signal);
        if (found) await save({ buildId: found.id, state: 'RUNNING', errorCode: undefined });
      }
      if (!row.buildId) {
        if (!row.firstDispatchAt && (!current || !await d.repo.kv.get(`PROJECT#${row.projectId}`, 'META'))) {
          await finish('FAILED', 'registration_configuration_changed'); return;
        }
        if (row.firstDispatchAt && (cancel || !current || d.now() - row.firstDispatchAt >= 240000)) {
          await save({ state: 'START_UNCERTAIN', errorCode: 'start_unresolved_requires_attention' }); return;
        }
        const checked = await d.provider.checkTarget(row.target, ctl.signal, row.snapshot);
        if (checked.configurationHash !== row.configurationHash || !isDeepStrictEqual(checked.snapshot, row.snapshot)) {
          if (!row.firstDispatchAt) await finish('FAILED', 'registration_configuration_changed');
          else await save({ state: 'START_UNCERTAIN', errorCode: 'registration_configuration_changed' });
          return;
        }
        const retry = row.firstDispatchAt !== undefined;
        if (!retry) await save({ firstDispatchAt: d.now() });
        cancel = !!await cancelled();
        if (cancel) { await save({ state: 'START_UNCERTAIN', errorCode: 'start_unresolved_requires_attention' }); return; }
        try {
          const buildId = await d.provider.start(row, ctl.signal);
          await save({ buildId, state: 'RUNNING', errorCode: undefined });
        } catch (error) {
          if (ctl.signal.aborted) return;
          if (!retry && error instanceof SourceBuildProviderError && error.definitive) await finish('FAILED', safeCode(error));
          else await save({ state: 'START_UNCERTAIN', errorCode: safeCode(error) });
        }
        return;
      }
    }
    const build = found ?? await d.provider.read(row, ctl.signal);
    if (build.id !== row.buildId) throw new SourceBuildProviderError('build_identity_mismatch');
    const sourceMatches = row.snapshot ? build.sourceVersion === row.snapshot.versionId
      : build.sourceVersion === row.commit && (!build.resolvedSourceVersion || build.resolvedSourceVersion === row.commit);
    if (!['SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'].includes(build.status)) {
      cancel = !!await cancelled();
      if (cancel || !build.configurationMatches || !sourceMatches) {
        await save({ state: 'CANCELLING', buildStatus: build.status, phase: build.phase,
          errorCode: cancel ? undefined : 'build_source_configuration_mismatch' });
        await d.provider.stop(row, ctl.signal);
      } else await save({ state: 'RUNNING', buildStatus: build.status, phase: build.phase, errorCode: undefined });
      return;
    }
    if (build.status !== 'SUCCEEDED') {
      await save({ state: build.status === 'STOPPED' && await cancelled() ? 'CANCELLED' : 'FAILED',
        buildStatus: build.status, phase: build.phase, errorCode: build.status === 'STOPPED' ? undefined : 'codebuild_failed' });
      return;
    }
    if (!build.configurationMatches || !sourceMatches || !row.snapshot && build.resolvedSourceVersion !== row.commit ||
        !SHA.test(build.archiveSha256 ?? '') || !SHA.test(build.dockerfileSha256 ?? '') ||
        row.snapshot && build.archiveSha256 !== row.snapshot.sha256) {
      await save({ state: 'FAILED', buildStatus: build.status, errorCode: 'source_provenance_mismatch' }); return;
    }
    if (!row.verificationStartedAt) await save({ state: 'VERIFYING', buildStatus: build.status, verificationStartedAt: d.now() });
    try {
      const output = await d.provider.inspectOutput(row, build, ctl.signal);
      const account = row.target.serviceRoleArn.split(':')[4];
      if (output.accountId !== account || output.region !== 'us-east-1' || output.repository !== row.target.outputRepositoryName ||
        !/^sha256:[a-f0-9]{64}$/.test(output.digest) ||
        output.resolvedImage !== `${account}.dkr.ecr.us-east-1.amazonaws.com/${row.target.outputRepositoryName}@${output.digest}`) {
        throw new SourceBuildProviderError('output_provenance_mismatch', true);
      }
      await save({ state: 'SUCCEEDED', errorCode: undefined, provenance: {
        schemaVersion: 1, projectId: row.projectId, registrationId: row.registrationId, registrationHash: row.registrationHash,
        sourceType: row.target.sourceType, repositoryUrl: row.target.repositoryUrl, commit: row.commit,
        resolvedCommit: row.snapshot ? undefined : build.resolvedSourceVersion, snapshot: row.snapshot,
        sourceArchiveSha256: build.archiveSha256!, dockerfileSha256: build.dockerfileSha256!,
        buildId: build.id, buildArn: build.arn, buildspecSha256: row.buildspecSha256, builderImage: row.target.builderImage,
        builderImagePinned: row.target.builderImage.includes('@sha256:'), configurationHash: row.configurationHash,
        startedAt: build.startedAt, finishedAt: build.finishedAt, verifiedAt: new Date(d.now()).toISOString(), output,
        dependencyResolution: 'not-attested', runtimeValidation: 'not-performed',
      } });
    } catch (error) {
      if (ctl.signal.aborted) return;
      if (error instanceof SourceBuildProviderError && error.definitive || d.now() - row.verificationStartedAt! >= 120000) {
        await finish('FAILED', safeCode(error));
      } else await save({ state: 'VERIFYING', errorCode: safeCode(error) });
    }
  } catch (error) {
    if (!ctl.signal.aborted) {
      if (!row.buildId && row.firstDispatchAt === undefined && error instanceof SourceBuildProviderError && error.definitive) await finish('FAILED', safeCode(error));
      else await save({ errorCode: safeCode(error) });
    }
  } finally {
    clearInterval(timer); signal.removeEventListener('abort', abort); ctl.abort(); await renewing;
    await d.repo.kv.transaction([{ kind: 'delete', ...leaseKey, condition: { equals: { holder } } }]).catch(() => false);
  }
}
/** Parent wires this bounded tick into its existing Fargate worker. */
export async function reconcileSourceBuilds(signal: AbortSignal, d: SourceBuildDeps = sourceBuildDefaults()): Promise<void> {
  const page = await d.repo.kv.queryGsi1Page(sourceBuildActiveIndex, { limit: 20 });
  const due = page.items.filter(item => Number(item.nextPollAt) <= d.now());
  for (let index = 0; index < due.length && !signal.aborted; index += 4) {
    await Promise.all(due.slice(index, index + 4).map(async item => {
      try { await reconcileRun(String(item.id), signal, d); } catch { /* Durable intent/lease remains recoverable. */ }
    }));
  }
}
