import { createHash } from 'node:crypto';
import buildspecContract from './source-buildspec.json';
import { z } from 'zod';
import { badRequest, HttpError } from '../errors';
import { config } from '../config';
import type { Item } from '../store/dynamo';
import type { Repo } from '../store/repo';
import type { ImageInspection } from '../aws/ecr-inspection';

export const hashBuildValue = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
export const sourceCommitSchema = z.string().regex(/^[a-fA-F0-9]{40}$/, 'A full Git commit SHA is required').transform(value => value.toLowerCase());
const id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const relative = z.string().min(1).max(160).regex(/^(?:\.|[A-Za-z0-9_][A-Za-z0-9_.\/-]*)$/)
  .refine(value => !value.split('/').some(part => ['..', '.git', ''].includes(part)), 'Path must stay in the committed source tree');
const targetSchema = z.object({
  id, projectId: id, codeBuildProjectName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,99}$/),
  repositoryUrl: z.string().max(500).optional(), sourceType: z.enum(['GITHUB', 'CODECOMMIT', 'S3']),
  snapshotLocation: z.object({ bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    key: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_./-]+\.zip$/).refine(value => !value.split('/').includes('..')) }).strict().optional(),
  serviceRoleArn: z.string(), builderImage: z.string(),
  outputRepositoryName: z.string().min(2).max(256).regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/),
  dockerfile: relative.default('Dockerfile'), context: relative.default('.'),
  timeoutMinutes: z.number().int().min(5).max(30).default(20),
  queuedTimeoutMinutes: z.number().int().min(5).max(10).default(5),
  computeType: z.enum(['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE']).default('BUILD_GENERAL1_SMALL'),
}).strict();
export type SourceBuildTarget = z.infer<typeof targetSchema>;
export function canonicalGitUrl(value: string, type: SourceBuildTarget['sourceType']): string {
  let url: URL;
  try { url = new URL(value); } catch { throw badRequest('Invalid registered Git repository'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw badRequest('Git repository must not contain credentials, query strings or fragments');
  if (type === 'GITHUB') {
    if (url.hostname !== 'github.com' || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) throw badRequest('A registered GitHub repository is required');
    return `https://github.com${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}`;
  }
  const region = config().region;
  if (url.hostname !== `git-codecommit.${region}.amazonaws.com` || !/^\/v1\/repos\/[A-Za-z0-9_.-]+$/.test(url.pathname)) throw badRequest(`A registered ${region} CodeCommit repository is required`);
  return url.toString();
}
export function parseBuildTargets(raw: string, accountId: string, region: string, operations: string[]): SourceBuildTarget[] {
  try {
    const targets = z.array(targetSchema).max(32).parse(JSON.parse(raw || '[]'));
    if (!targets.length) return [];
    if (!/^\d{12}$/.test(accountId) || region !== config().region) throw Error('scope');
    const ids = new Set<string>(), jobs = new Set<string>();
    for (const target of targets) {
      if (ids.has(target.id) || jobs.has(target.codeBuildProjectName) || operations.includes(target.codeBuildProjectName)) throw Error('duplicate or Operations target');
      ids.add(target.id); jobs.add(target.codeBuildProjectName);
      if (target.sourceType === 'S3') {
        if (!target.snapshotLocation || target.repositoryUrl) throw Error('S3 source requires an exact snapshot location');
      } else {
        if (!target.repositoryUrl || target.snapshotLocation) throw Error('Git source requires one repository');
        target.repositoryUrl = canonicalGitUrl(target.repositoryUrl, target.sourceType);
      }
      if (!target.serviceRoleArn.startsWith(`arn:aws:iam::${accountId}:role/`) ||
          !(target.builderImage === 'aws/codebuild/standard:7.0' ||
            new RegExp(`^${accountId}\\.dkr\\.ecr\\.${region}\\.amazonaws\\.com/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$`).test(target.builderImage)) ||
          !target.outputRepositoryName.startsWith(`physical-ai/projects/${target.projectId}/`)) throw Error('target scope');
    }
    return targets;
  } catch { throw new HttpError(503, 'Project source-build targets require valid, separate registered jobs, pinned builders and project-owned ECR output.', 'source_build_configuration'); }
}

/** Install this exact inline buildspec on the isolated registered job. */
export const sourceBuildspec = buildspecContract.text;
export const sourceBuildspecHash = createHash('sha256').update(sourceBuildspec).digest('hex');
export const builderCredentials = (target: SourceBuildTarget) => target.builderImage.startsWith('aws/codebuild/') ? 'CODEBUILD' : 'SERVICE_ROLE';
export const sourceLocation = (target: SourceBuildTarget) => target.sourceType === 'S3'
  ? `${target.snapshotLocation!.bucket}/${target.snapshotLocation!.key}` : target.repositoryUrl!;
export interface SourceSnapshot { bucket: string; key: string; versionId: string; sha256: string; bytes: number }
export function outputTag(buildId: string): string {
  const suffix = buildId.split(':')[1];
  if (!/^[A-Za-z0-9_-]+:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(buildId)) throw Error('Invalid build identity');
  return `pai-source-${suffix}`;
}
export interface SourceRegistration extends Item {
  id: string; name: string; projectId: string; target: SourceBuildTarget;
  targetHash: string; configurationHash: string; contentHash: string; createdAt: string; createdBy: string;
  buildspecSha256: string;
  snapshot?: SourceSnapshot;
}
export type SourceBuildState = 'STARTING' | 'START_UNCERTAIN' | 'RUNNING' | 'CANCELLING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export interface SourceBuildRun extends Item {
  id: string; projectId: string; registrationId: string; registrationHash: string;
  target: SourceBuildTarget; configurationHash: string; commit?: string; snapshot?: SourceSnapshot; actor: string;
  buildspecSha256: string;
  requestHash: string; idempotencyToken: string; state: SourceBuildState; revision: number; slot: number;
  createdAt: string; updatedAt: string; firstDispatchAt?: number; nextPollAt: number;
  buildId?: string; buildStatus?: string; phase?: string; errorCode?: string; verificationStartedAt?: number;
  provenance?: SourceBuildProvenance;
}
export interface BuildObservation {
  id: string; arn: string; status: string; phase?: string; sourceVersion?: string; resolvedSourceVersion?: string;
  configurationMatches: boolean; startedAt?: string; finishedAt?: string;
  archiveSha256?: string; dockerfileSha256?: string;
}
export interface SourceBuildProvenance {
  schemaVersion: 1; projectId: string; registrationId: string; registrationHash: string;
  sourceType: SourceBuildTarget['sourceType']; repositoryUrl?: string; commit?: string; resolvedCommit?: string; snapshot?: SourceSnapshot;
  sourceArchiveSha256: string; dockerfileSha256: string;
  buildId: string; buildArn: string; buildspecSha256: string; builderImage: string;
  configurationHash: string; startedAt?: string; finishedAt?: string; verifiedAt: string;
  output: ImageInspection; builderImagePinned: boolean; dependencyResolution: 'not-attested'; runtimeValidation: 'not-performed';
}
export class SourceBuildProviderError extends Error {
  constructor(readonly code: string, readonly definitive = false) { super(code); }
}
export interface SourceBuildProvider {
  checkTarget(target: SourceBuildTarget, signal: AbortSignal, snapshot?: SourceSnapshot): Promise<{ configurationHash: string; snapshot?: SourceSnapshot }>;
  start(run: SourceBuildRun, signal: AbortSignal): Promise<string>;
  read(run: SourceBuildRun, signal: AbortSignal): Promise<BuildObservation>;
  find(run: SourceBuildRun, signal: AbortSignal): Promise<BuildObservation | undefined>;
  stop(run: SourceBuildRun, signal: AbortSignal): Promise<void>;
  inspectOutput(run: SourceBuildRun, observation: BuildObservation, signal: AbortSignal): Promise<ImageInspection>;
  logs(run: SourceBuildRun, cursor: string | undefined, signal: AbortSignal): Promise<{ lines: string[]; cursor?: string; truncated: boolean }>;
}
export interface SourceBuildDeps {
  repo: Repo; provider: SourceBuildProvider; targets(): SourceBuildTarget[]; now(): number; randomId(): string;
}
