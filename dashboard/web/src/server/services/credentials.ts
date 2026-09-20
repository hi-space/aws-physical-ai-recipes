import { createHash, randomBytes } from 'node:crypto';
import { DeleteParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { z } from 'zod';
import { ssm } from '../aws/clients';
import { badRequest, forbidden, HttpError, notFound } from '../errors';
import { getRepo } from '../store/repo';
import type { KV, Item } from '../store/dynamo';
import { memberRole, type Project } from '../auth/projects';
import type { Session } from '../auth/session';

export type CredentialPrincipal = Session & { authMethod?: string; tokenProjectId?: string };
export interface CredentialMetadata {
  id: string; projectId: string; name: string; kind: 'hf' | 'ngc' | 'generic'; scope: 'private' | 'project';
  ownerSubject: string; ownerUsername: string; ref: string; managed: boolean;
  status: 'CREATING' | 'READY' | 'REGISTERED' | 'ROTATING' | 'DELETING' | 'ERROR';
  revision: number; createdAt: string; updatedAt: string; parameterVersion?: number;
}
export interface CredentialDeps {
  kv: KV; now(): number; randomId(): string;
  parameters: { put(ref: string, value: string, overwrite: boolean): Promise<number>; delete(ref: string): Promise<void> };
}
const description = { name: z.string().trim().min(1).max(80), kind: z.enum(['hf', 'ngc', 'generic']), scope: z.enum(['private', 'project']).default('private') };
export const credentialInputSchema = z.object({ ...description, value: z.string().min(1).refine((v) => Buffer.byteLength(v, 'utf8') <= 4096, 'Secret must be at most 4096 UTF-8 bytes') }).strict();
export const legacyCredentialSchema = z.object({ ...description, ref: z.string().min(1).max(1024) }).strict();
export const rotateCredentialSchema = z.object({ value: credentialInputSchema.shape.value }).strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (project: string, id: string) => ({ pk: `PROJECT#${project}`, sk: `CREDENTIAL#${id}` });
const refKey = (project: string, ref: string) => ({ pk: `CREDENTIAL_REF#${hash(ref)}`, sk: `PROJECT#${project}` });
const conflict = () => new HttpError(409, '자격증명을 처리 중이거나 변경되었습니다. 다시 조회하세요.', 'credential_conflict');
const failure = () => new HttpError(502, '자격증명 저장소 작업에 실패했습니다. 상태를 확인한 뒤 다시 시도하세요.', 'credential_unavailable');
function defaults(): CredentialDeps {
  return { kv: getRepo().kv, now: Date.now, randomId: () => randomBytes(16).toString('hex'), parameters: {
    put: async (ref, value, overwrite) => {
      const result = await ssm().send(new PutParameterCommand({ Name: ref, Value: value, Type: 'SecureString', Tier: 'Standard', Overwrite: overwrite }));
      if (!result.Version) throw failure();
      return result.Version;
    },
    delete: async (ref) => {
      try { await ssm().send(new DeleteParameterCommand({ Name: ref })); }
      catch (error) { if ((error as { name?: string }).name !== 'ParameterNotFound') throw failure(); }
    },
  } };
}
function interactive(principal: CredentialPrincipal) {
  if (principal.authMethod === 'token' || principal.tokenProjectId) throw forbidden('API 토큰으로 자격증명을 관리할 수 없습니다.');
}
async function membership(principal: CredentialPrincipal, project: Project, deps: CredentialDeps, write = false) {
  if (!principal.subject || !/^[a-z][a-z0-9-]{0,39}$/.test(project.id) || principal.tokenProjectId && principal.tokenProjectId !== project.id) throw forbidden();
  if (!(await deps.kv.get(`PROJECT#${project.id}`, 'META'))) throw forbidden('현재 프로젝트 권한이 필요합니다.');
  const role = memberRole(principal, project);
  if (!role || write && (role === 'viewer' || principal.role === 'viewer')) throw forbidden('현재 프로젝트 권한이 필요합니다.');
  return role;
}
function metadata(item: Item): CredentialMetadata {
  return { id: String(item.id), projectId: String(item.projectId), name: String(item.name), kind: item.kind as CredentialMetadata['kind'],
    scope: item.scope as CredentialMetadata['scope'], ownerSubject: String(item.ownerSubject), ownerUsername: String(item.ownerUsername),
    ref: String(item.ref), managed: item.managed === true, status: item.status as CredentialMetadata['status'], revision: Number(item.revision),
    createdAt: String(item.createdAt), updatedAt: String(item.updatedAt), ...(typeof item.parameterVersion === 'number' ? { parameterVersion: item.parameterVersion } : {}) };
}
function checkRef(ref: string) {
  if (!/^\/(groot|pai|physical-ai)\/[A-Za-z0-9_./-]+$/.test(ref) || ref.length > 1024 || ref.endsWith('/') || ref.includes('..') || ref.split('/').slice(1).some((part) => !part || part === '.')) throw badRequest('지원되는 SSM 파라미터 경로를 입력하세요.');
}
async function read(project: Project, id: string, deps: CredentialDeps) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw notFound('자격증명');
  const item = await deps.kv.get(key(project.id, id).pk, key(project.id, id).sk);
  if (!item || item.projectId !== project.id) throw notFound('자격증명');
  return metadata(item);
}
function own(principal: CredentialPrincipal, record: CredentialMetadata, role: string) {
  if (record.scope === 'private' ? record.ownerSubject !== principal.subject : role !== 'project-admin') throw forbidden('자격증명 소유자 또는 공유 자격증명의 프로젝트 관리자 권한이 필요합니다.');
}
async function change(record: CredentialMetadata, changes: Partial<CredentialMetadata>, deps: CredentialDeps) {
  const next = { ...record, ...changes, revision: record.revision + 1, updatedAt: new Date(deps.now()).toISOString() };
  if (!(await deps.kv.transaction([{ kind: 'put', item: { ...key(record.projectId, record.id), ...next }, condition: { equals: { revision: record.revision, status: record.status } } }]))) throw conflict();
  return next;
}
async function reserve(principal: CredentialPrincipal, project: Project, input: { name: string; kind: CredentialMetadata['kind']; scope: CredentialMetadata['scope'] }, managed: boolean, ref: string | undefined, deps: CredentialDeps) {
  const id = deps.randomId();
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid credential identifier generator');
  const timestamp = new Date(deps.now()).toISOString();
  const path = ref ?? `/physical-ai/projects/${project.id}/${input.scope === 'private' ? `users/${hash(principal.subject!)}` : 'shared'}/${id}`;
  const record: CredentialMetadata = { id, projectId: project.id, ...input, ownerSubject: principal.subject!, ownerUsername: principal.user, ref: path,
    managed, status: managed ? 'CREATING' : 'REGISTERED', revision: 0, createdAt: timestamp, updatedAt: timestamp };
  if (!(await deps.kv.transaction([
    { kind: 'put', item: { ...key(project.id, id), ...record }, condition: { absent: true } },
    { kind: 'put', item: { ...refKey(project.id, path), id, projectId: project.id }, condition: { absent: true } },
  ]))) throw new HttpError(409, '이미 등록된 자격증명 참조입니다.', 'credential_conflict');
  return record;
}
async function writeValue(record: CredentialMetadata, value: string, overwrite: boolean, deps: CredentialDeps) {
  try {
    const version = await deps.parameters.put(record.ref, value, overwrite);
    if (!Number.isSafeInteger(version) || version < 1) throw failure();
    return await change(record, { status: 'READY', parameterVersion: version }, deps);
  } catch {
    await change(record, { status: 'ERROR' }, deps).catch(() => undefined);
    throw failure(); // Never include provider errors, which may echo a supplied value.
  }
}
export async function createCredential(principal: CredentialPrincipal, project: Project, input: z.input<typeof credentialInputSchema>, deps = defaults()) {
  interactive(principal);
  const role = await membership(principal, project, deps, true);
  const parsed = credentialInputSchema.safeParse(input);
  if (!parsed.success) throw badRequest('자격증명 이름, 유형, 범위 및 값의 크기를 확인하세요.');
  const { value, ...description } = parsed.data;
  if (description.scope === 'project' && role !== 'project-admin') throw forbidden('공유 자격증명은 프로젝트 관리자만 만들 수 있습니다.');
  return writeValue(await reserve(principal, project, description, true, undefined, deps), value, false, deps);
}
export async function registerLegacyCredential(principal: CredentialPrincipal, project: Project, input: z.input<typeof legacyCredentialSchema>, deps = defaults()) {
  interactive(principal);
  if (principal.role !== 'admin') throw forbidden('기존 워크숍 참조 등록은 플랫폼 관리자만 할 수 있습니다.');
  const role = await membership(principal, project, deps, true);
  const parsed = legacyCredentialSchema.safeParse(input);
  if (!parsed.success) throw badRequest('자격증명 참조 입력을 확인하세요.');
  const { ref, ...description } = parsed.data;
  checkRef(ref);
  if (ref.startsWith('/physical-ai/projects/')) throw badRequest('프로젝트의 관리형 비공개 참조는 기존 참조로 등록할 수 없습니다.');
  if (description.scope === 'project' && role !== 'project-admin') throw forbidden('공유에는 프로젝트 관리자 권한이 필요합니다.');
  return reserve(principal, project, description, false, ref, deps);
}
export async function listCredentials(principal: CredentialPrincipal, project: Project, deps = defaults()): Promise<CredentialMetadata[]> {
  interactive(principal); await membership(principal, project, deps);
  return (await deps.kv.query(`PROJECT#${project.id}`, 'CREDENTIAL#')).map(metadata).filter((record) => record.projectId === project.id && (record.scope === 'project' || record.ownerSubject === principal.subject));
}
export async function rotateCredential(principal: CredentialPrincipal, project: Project, id: string, value: string, deps = defaults()) {
  interactive(principal); const role = await membership(principal, project, deps, true);
  if (!rotateCredentialSchema.safeParse({ value }).success) throw badRequest('자격증명 값을 확인하세요.');
  const record = await read(project, id, deps); own(principal, record, role);
  if (!record.managed) throw badRequest('기존 참조의 값은 이 화면에서 교체할 수 없습니다.');
  if (!['READY', 'ERROR'].includes(record.status)) throw conflict();
  return writeValue(await change(record, { status: 'ROTATING' }, deps), value, true, deps);
}
export async function deleteCredential(principal: CredentialPrincipal, project: Project, id: string, deps = defaults()): Promise<void> {
  interactive(principal); const role = await membership(principal, project, deps, true);
  const record = await read(project, id, deps); own(principal, record, role);
  if (!['READY', 'REGISTERED', 'ERROR'].includes(record.status)) throw conflict();
  const deleting = await change(record, { status: 'DELETING' }, deps);
  try {
    if (deleting.managed) await deps.parameters.delete(deleting.ref);
    if (!(await deps.kv.transaction([
      { kind: 'delete', ...key(project.id, id), condition: { equals: { revision: deleting.revision, status: 'DELETING' } } },
      { kind: 'delete', ...refKey(project.id, deleting.ref), condition: { equals: { id } } },
    ]))) throw conflict();
  } catch {
    await change(deleting, { status: 'ERROR' }, deps).catch(() => undefined);
    throw failure();
  }
}
export async function assertCredentialUse(principal: CredentialPrincipal, project: Project, ref: string, deps = defaults()): Promise<void> {
  await membership(principal, project, deps, true);
  checkRef(ref);
  const link = await deps.kv.get(refKey(project.id, ref).pk, refKey(project.id, ref).sk);
  if (!link || typeof link.id !== 'string') throw forbidden('이 프로젝트에 등록되지 않은 자격증명 참조입니다.');
  const record = await read(project, link.id, deps);
  if (record.ref !== ref || !['private', 'project'].includes(record.scope) || record.scope === 'private' && record.ownerSubject !== principal.subject) throw forbidden('이 자격증명을 사용할 권한이 없습니다.');
  if (!['READY', 'REGISTERED'].includes(record.status)) throw conflict();
}
