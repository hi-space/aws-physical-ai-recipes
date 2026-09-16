import { beforeEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createSourceBuildProvider, sourceBuildEnvironment, type SourceBuildAwsClients } from './source-builds';
import { parseBuildTargets, sourceBuildspec, sourceBuildspecHash, type SourceBuildRun } from '../services/source-builds-contract';

const accountId = '123456789012', digest = `sha256:${'a'.repeat(64)}`;
const scope = { accountId, region: 'us-east-1' };
const target = parseBuildTargets(JSON.stringify([{
  id: 'source-a', projectId: 'a', codeBuildProjectName: 'pai-source-a', sourceType: 'GITHUB',
  repositoryUrl: 'https://github.com/example/source', serviceRoleArn: `arn:aws:iam::${accountId}:role/source-a`,
  builderImage: `${accountId}.dkr.ecr.us-east-1.amazonaws.com/builder@${digest}`, outputRepositoryName: 'physical-ai/projects/a/images',
}]), accountId, 'us-east-1', [])[0];
const buildId = 'pai-source-a:12345678-1234-1234-1234-123456789abc';
let project: Record<string, any>, repository: Record<string, any>, send: ReturnType<typeof vi.fn>, ecrSend: ReturnType<typeof vi.fn>;
let clients: SourceBuildAwsClients;
const signal = () => new AbortController().signal;
const run = () => ({ id: 'sb-' + 'a'.repeat(32), target, registrationHash: 'r'.repeat(64), commit: 'c'.repeat(40),
  idempotencyToken: 'a'.repeat(64), buildId, buildspecSha256: sourceBuildspecHash } as SourceBuildRun);
beforeEach(() => {
  project = {
    name: target.codeBuildProjectName, arn: `arn:aws:codebuild:us-east-1:${accountId}:project/${target.codeBuildProjectName}`,
    serviceRole: target.serviceRoleArn,
    source: { type: 'GITHUB', location: target.repositoryUrl, buildspec: sourceBuildspec,
      auth: { type: 'CODECONNECTIONS', resource: `arn:aws:codeconnections:us-east-1:${accountId}:connection/connection` } },
    environment: { type: 'LINUX_CONTAINER', image: target.builderImage, computeType: target.computeType,
      privilegedMode: true, imagePullCredentialsType: 'SERVICE_ROLE', environmentVariables: [] },
    artifacts: { type: 'NO_ARTIFACTS' }, cache: { type: 'NO_CACHE' },
    timeoutInMinutes: 20, queuedTimeoutInMinutes: 5, concurrentBuildLimit: 2, autoRetryLimit: 0,
    tags: [{ key: 'pai:project', value: 'a' }, { key: 'pai:purpose', value: 'source-image-build' }],
    logsConfig: { cloudWatchLogs: { status: 'ENABLED', groupName: '/aws/codebuild/pai-source-a' } },
  };
  repository = { registryId: accountId, repositoryName: target.outputRepositoryName,
    repositoryUri: `${accountId}.dkr.ecr.us-east-1.amazonaws.com/${target.outputRepositoryName}`, imageTagMutability: 'IMMUTABLE' };
  send = vi.fn(async (command: any) => command.constructor.name === 'BatchGetProjectsCommand' ? { projects: [project] } : { build: { id: buildId } });
  ecrSend = vi.fn(async () => ({ repositories: [repository] }));
  clients = { codeBuild: { send }, ecr: { send: ecrSend }, logs: { send: vi.fn() }, inspect: vi.fn() } as unknown as SourceBuildAwsClients;
});
it('requires the exact inline buildspec and an isolated, bounded project-owned job/output', async () => {
  const provider = createSourceBuildProvider(scope, clients);
  expect((await provider.checkTarget(target, signal())).configurationHash).toMatch(/^[a-f0-9]{64}$/);
  project.source.buildspec = 'buildspec.yml';
  await expect(provider.checkTarget(target, signal())).rejects.toThrow(/configuration/);
  project.source.buildspec = sourceBuildspec; repository.imageTagMutability = 'MUTABLE';
  await expect(provider.checkTarget(target, signal())).rejects.toThrow(/immutable/);
});
it('only supplies server-owned source/identity/time overrides, with no arbitrary buildspec or role override', async () => {
  const provider = createSourceBuildProvider(scope, clients);
  await provider.start(run(), signal());
  const input = send.mock.calls[0][0].input;
  expect(input).toMatchObject({ projectName: 'pai-source-a', sourceVersion: 'c'.repeat(40),
    idempotencyToken: 'a'.repeat(64), timeoutInMinutesOverride: 20, queuedTimeoutInMinutesOverride: 5, autoRetryLimitOverride: 0 });
  expect(input).not.toHaveProperty('buildspecOverride');
  expect(input).not.toHaveProperty('sourceLocationOverride');
  expect(input).not.toHaveProperty('serviceRoleOverride');
  expect(input.environmentVariablesOverride.find((v: any) => v.name === 'PAI_REQUEST_ID').value).toBe(run().id);
});
it('refuses another run’s AWS build even when its CodeBuild project matches', async () => {
  send.mockResolvedValue({ builds: [{ id: buildId, projectName: 'pai-source-a', environment: { environmentVariables: [] } }] });
  await expect(createSourceBuildProvider(scope, clients).read(run(), signal())).rejects.toThrow(/identity/);
});
it('missing output is never accepted as a successful image publication', async () => {
  ecrSend.mockImplementation(async (command: any) => command.constructor.name === 'DescribeRepositoriesCommand'
    ? { repositories: [repository] } : { imageDetails: [] });
  await expect(createSourceBuildProvider(scope, clients).inspectOutput(run(), { id: buildId } as any, signal())).rejects.toThrow(/output/);
});
it('accepts the AWS empty NO_ARTIFACTS location while retaining effective build identity checks', async () => {
  send.mockResolvedValue({ builds: [{ ...project, id: buildId, projectName: target.codeBuildProjectName,
    buildStatus: 'SUCCEEDED', sourceVersion: run().commit, resolvedSourceVersion: run().commit,
    artifacts: { location: '' }, environment: { ...project.environment,
      environmentVariables: Object.entries(sourceBuildEnvironment(run(), scope)).map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })) } }] });
  expect((await createSourceBuildProvider(scope, clients).read(run(), signal())).configurationMatches).toBe(true);
});
it('pins the actual version and full SHA of an owned S3 snapshot instead of following later overwrites', async () => {
  const snapshotTarget = { ...target, repositoryUrl: undefined, sourceType: 'S3' as const,
    snapshotLocation: { bucket: 'source-bucket', key: 'workshop/source.zip' }, builderImage: 'aws/codebuild/standard:7.0' };
  project.source = { type: 'S3', location: 'source-bucket/workshop/source.zip', buildspec: sourceBuildspec };
  project.environment.image = snapshotTarget.builderImage; project.environment.imagePullCredentialsType = 'CODEBUILD';
  let latest = 'old';
  const bytes = { old: Buffer.from('PK\x03\x04old-source'), newer: Buffer.from('PK\x03\x04new-source') };
  const s3send = vi.fn(async (command: any) => {
    const version = (command.input.VersionId ?? latest) as keyof typeof bytes;
    expect(command.input.ExpectedBucketOwner).toBe(accountId);
    return command.constructor.name === 'HeadObjectCommand' ? { VersionId: version, ContentLength: bytes[version].length }
      : { VersionId: version, Body: Readable.from([bytes[version]]) };
  });
  clients.s3 = { send: s3send } as unknown as SourceBuildAwsClients['s3'];
  const provider = createSourceBuildProvider(scope, clients);
  const first = await provider.checkTarget(snapshotTarget, signal());
  expect(first.snapshot).toMatchObject({ versionId: 'old', sha256: createHash('sha256').update(bytes.old).digest('hex') });
  latest = 'newer';
  expect((await provider.checkTarget(snapshotTarget, signal(), first.snapshot)).snapshot).toEqual(first.snapshot);
  bytes.old = bytes.newer;
  await expect(provider.checkTarget(snapshotTarget, signal(), first.snapshot)).rejects.toThrow(/snapshot_identity/);
});
it('an unversioned S3 source is not an immutable registration', async () => {
  const snapshotTarget = { ...target, repositoryUrl: undefined, sourceType: 'S3' as const, snapshotLocation: { bucket: 'source-bucket', key: 'source.zip' } };
  project.source = { type: 'S3', location: 'source-bucket/source.zip', buildspec: sourceBuildspec };
  clients.s3 = { send: vi.fn(async () => ({ ContentLength: 40 })) } as unknown as SourceBuildAwsClients['s3'];
  await expect(createSourceBuildProvider(scope, clients).checkTarget(snapshotTarget, signal())).rejects.toThrow(/versioned/);
});
it('compares the observed buildspec to the captured registration revision rather than the newest server template', async () => {
  const priorSpec = sourceBuildspec + '# approved prior revision\n';
  const record = { ...run(), buildspecSha256: createHash('sha256').update(priorSpec).digest('hex') };
  send.mockResolvedValue({ builds: [{ ...project, id: buildId, projectName: target.codeBuildProjectName,
    buildStatus: 'SUCCEEDED', sourceVersion: run().commit, resolvedSourceVersion: run().commit,
    source: { ...project.source, buildspec: priorSpec }, artifacts: { location: '' },
    environment: { ...project.environment, environmentVariables: Object.entries(sourceBuildEnvironment(record, scope)).map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })) } }] });
  expect((await createSourceBuildProvider(scope, clients).read(record, signal())).configurationMatches).toBe(true);
  expect((await createSourceBuildProvider(scope, clients).read(run(), signal())).configurationMatches).toBe(false);
});
