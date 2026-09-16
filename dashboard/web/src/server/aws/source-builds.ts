import { CodeBuildClient, BatchGetProjectsCommand, StartBuildCommand, BatchGetBuildsCommand, ListBuildsForProjectCommand, StopBuildCommand, type Build } from '@aws-sdk/client-codebuild';
import { ECRClient, DescribeRepositoriesCommand, DescribeImagesCommand } from '@aws-sdk/client-ecr';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { inspectEcrImage, type ImageScope } from './ecr-inspection';
import { canonicalGitUrl, hashBuildValue, outputTag, sourceBuildspec, sourceBuildspecHash, SourceBuildProviderError, builderCredentials, sourceLocation,
  type SourceBuildProvider, type SourceBuildTarget, type SourceBuildRun, type BuildObservation, type SourceSnapshot } from '../services/source-builds-contract';

export interface SourceBuildAwsClients {
  codeBuild: Pick<CodeBuildClient, 'send'>; ecr: Pick<ECRClient, 'send'>; logs: Pick<CloudWatchLogsClient, 'send'>;
  s3: Pick<S3Client, 'send'>;
  inspect: typeof inspectEcrImage;
}
function fail(code: string): never { throw new SourceBuildProviderError(code, true); }
const options = (signal: AbortSignal) => ({ abortSignal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
async function call<T>(code: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) {
    if (error instanceof SourceBuildProviderError) throw error;
    const definitive = ['InvalidInputException', 'AccessDeniedException', 'ResourceNotFoundException', 'AccountLimitExceededException']
      .includes((error as Error).name);
    throw new SourceBuildProviderError(code, definitive);
  }
}
export function sourceBuildEnvironment(run: SourceBuildRun, scope: ImageScope) {
  return {
    PAI_REQUEST_ID: run.id, PAI_REGISTRATION_HASH: run.registrationHash, PAI_SOURCE_TYPE: run.target.sourceType,
    PAI_SOURCE_VERSION: run.snapshot?.versionId ?? run.commit ?? '', PAI_SOURCE_COMMIT: run.commit ?? '',
    PAI_SOURCE_REPOSITORY: run.target.sourceType === 'S3' ? `s3://${sourceLocation(run.target)}` : run.target.repositoryUrl!,
    ...(run.snapshot ? { PAI_SOURCE_BUCKET: run.snapshot.bucket, PAI_SOURCE_KEY: run.snapshot.key, PAI_SOURCE_SHA256: run.snapshot.sha256 } : {}),
    PAI_OUTPUT_REPOSITORY_URI: `${scope.accountId}.dkr.ecr.${scope.region}.amazonaws.com/${run.target.outputRepositoryName}`,
    PAI_DOCKERFILE: run.target.dockerfile, PAI_BUILD_CONTEXT: run.target.context,
  };
}
/** AWS-only transport. Never fetches arbitrary repository/credential URLs. */
export function createSourceBuildProvider(scope: ImageScope, clients?: SourceBuildAwsClients): SourceBuildProvider {
  const d = clients ?? { codeBuild: new CodeBuildClient({ region: scope.region }), ecr: new ECRClient({ region: scope.region }),
    logs: new CloudWatchLogsClient({ region: scope.region }), s3: new S3Client({ region: scope.region }), inspect: inspectEcrImage };
  const repositoryUri = (target: SourceBuildTarget) => `${scope.accountId}.dkr.ecr.${scope.region}.amazonaws.com/${target.outputRepositoryName}`;
  async function repository(target: SourceBuildTarget, signal: AbortSignal) {
    const result = await call('ecr_repository_unavailable', () => d.ecr.send(new DescribeRepositoriesCommand({
      registryId: scope.accountId, repositoryNames: [target.outputRepositoryName],
    }), options(signal)));
    const value = result.repositories?.[0];
    if (result.repositories?.length !== 1 || value?.registryId !== scope.accountId ||
      value.repositoryName !== target.outputRepositoryName || value.repositoryUri !== repositoryUri(target) ||
      value.imageTagMutability !== 'IMMUTABLE' || value.imageTagMutabilityExclusionFilters?.length) fail('ecr_immutable_repository_required');
    return value;
  }
  async function snapshot(target: SourceBuildTarget, signal: AbortSignal, pin?: SourceSnapshot): Promise<SourceSnapshot> {
    const location = target.snapshotLocation!;
    if (pin && (pin.bucket !== location.bucket || pin.key !== location.key)) fail('snapshot_identity_mismatch');
    const head = await call('snapshot_read_unavailable', () => d.s3.send(new HeadObjectCommand({
      Bucket: location.bucket, Key: location.key, ExpectedBucketOwner: scope.accountId, VersionId: pin?.versionId,
    }), options(signal)));
    const versionId = head.VersionId;
    if (!versionId || versionId === 'null' || versionId.length > 1024 || !head.ContentLength || head.ContentLength > 32 * 1024 * 1024) fail('versioned_bounded_snapshot_required');
    const object = await call('snapshot_read_unavailable', () => d.s3.send(new GetObjectCommand({
      Bucket: location.bucket, Key: location.key, VersionId: versionId, ExpectedBucketOwner: scope.accountId,
    }), options(signal)));
    if (!object.Body || object.VersionId !== versionId) fail('snapshot_identity_mismatch');
    const digest = createHash('sha256'); let bytes = 0, prefix = Buffer.alloc(0);
    try {
      for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
        signal.throwIfAborted(); bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) fail('snapshot_size_limit');
        digest.update(chunk);
        if (prefix.length < 4) prefix = Buffer.concat([prefix, Buffer.from(chunk).subarray(0, 4 - prefix.length)]);
      }
    } catch (error) {
      (object.Body as { destroy?: () => void }).destroy?.();
      if (error instanceof SourceBuildProviderError) throw error;
      throw new SourceBuildProviderError('snapshot_read_unavailable');
    }
    if (bytes !== head.ContentLength || prefix.toString('hex') !== '504b0304') fail('snapshot_zip_required');
    const observed = { ...location, versionId, bytes, sha256: digest.digest('hex') };
    if (pin && (pin.versionId !== observed.versionId || pin.sha256 !== observed.sha256 || pin.bytes !== observed.bytes)) fail('snapshot_identity_mismatch');
    return observed;
  }
  function boundBuild(run: SourceBuildRun, build: Build | undefined): Build {
    const expected = sourceBuildEnvironment(run, scope);
    const env = Object.fromEntries((build?.environment?.environmentVariables ?? []).map(value => [value.name, value.value]));
    if (!build?.id || build.projectName !== run.target.codeBuildProjectName ||
        !build.id.startsWith(`${run.target.codeBuildProjectName}:`) || env.PAI_REQUEST_ID !== run.id ||
        env.PAI_REGISTRATION_HASH !== run.registrationHash || env.PAI_SOURCE_VERSION !== expected.PAI_SOURCE_VERSION) fail('build_identity_mismatch');
    outputTag(build.id);
    // No values from a foreign build are ever returned to callers.
    return build;
  }
  function observation(run: SourceBuildRun, raw: Build): BuildObservation {
    const build = boundBuild(run, raw), target = run.target;
    const env = build.environment!, expected = sourceBuildEnvironment(run, scope);
    const variables = env.environmentVariables ?? [];
    let sameSource = false;
    try { sameSource = target.sourceType === 'S3' ? build.source?.location === sourceLocation(target)
      : !!build.source?.location && canonicalGitUrl(build.source.location, target.sourceType) === target.repositoryUrl; } catch { /* mismatch */ }
    const exported = Object.fromEntries((build.exportedEnvironmentVariables ?? []).map(value => [value.name, value.value]));
    const matches = sameSource && build.source?.type === target.sourceType && typeof build.source.buildspec === 'string' &&
      createHash('sha256').update(build.source.buildspec).digest('hex') === run.buildspecSha256 &&
      build.serviceRole === target.serviceRoleArn && env.image === target.builderImage && env.type === 'LINUX_CONTAINER' &&
      env.computeType === target.computeType && env.privilegedMode === true && env.imagePullCredentialsType === builderCredentials(target) &&
      variables.length === Object.keys(expected).length &&
      variables.every(value => value.type === 'PLAINTEXT' && expected[value.name as keyof typeof expected] === value.value) &&
      build.timeoutInMinutes === target.timeoutMinutes && build.queuedTimeoutInMinutes === target.queuedTimeoutMinutes &&
      !build.source.insecureSsl && !build.source.gitSubmodulesConfig?.fetchSubmodules &&
      !build.secondarySources?.length && !build.fileSystemLocations?.length &&
      !build.artifacts?.location && (build.cache?.type === undefined || build.cache.type === 'NO_CACHE');
    return { id: build.id!, arn: build.arn ?? '', status: build.buildStatus ?? 'UNKNOWN', phase: build.currentPhase,
      sourceVersion: build.sourceVersion, resolvedSourceVersion: build.resolvedSourceVersion, configurationMatches: matches,
      startedAt: build.startTime?.toISOString(), finishedAt: build.endTime?.toISOString(),
      archiveSha256: exported.PAI_SOURCE_TREE_SHA256, dockerfileSha256: exported.PAI_DOCKERFILE_SHA256 };
  }
  async function rawBuild(run: SourceBuildRun, signal: AbortSignal) {
    if (!run.buildId || !run.buildId.startsWith(`${run.target.codeBuildProjectName}:`)) fail('build_identity_mismatch');
    const result = await call('build_read_unavailable', () => d.codeBuild.send(new BatchGetBuildsCommand({ ids: [run.buildId!] }), options(signal)));
    return boundBuild(run, result.builds?.find(build => build.id === run.buildId));
  }
  return {
    async checkTarget(target, signal, pin) {
      const result = await call('build_project_unavailable', () => d.codeBuild.send(new BatchGetProjectsCommand({ names: [target.codeBuildProjectName] }), options(signal)));
      const project = result.projects?.find(value => value.name === target.codeBuildProjectName), env = project?.environment;
      const tags = Object.fromEntries((project?.tags ?? []).map(value => [value.key, value.value]));
      let sourceMatches = false;
      try { sourceMatches = target.sourceType === 'S3' ? project?.source?.location === sourceLocation(target)
        : !!project?.source?.location && canonicalGitUrl(project.source.location, target.sourceType) === target.repositoryUrl; } catch { /* mismatch */ }
      const auth = project?.source?.auth;
      const connection = !auth || target.sourceType === 'GITHUB' && auth.type === 'CODECONNECTIONS' &&
        new RegExp(`^arn:aws:(?:codeconnections|codestar-connections):us-east-1:${scope.accountId}:connection/[A-Za-z0-9-]+$`).test(auth.resource ?? '');
      if (!project || project.arn !== `arn:aws:codebuild:${scope.region}:${scope.accountId}:project/${target.codeBuildProjectName}` ||
        project.serviceRole !== target.serviceRoleArn || !sourceMatches || project.source?.type !== target.sourceType ||
        project.source.buildspec !== sourceBuildspec || !connection || project.source.insecureSsl ||
        project.source.gitSubmodulesConfig?.fetchSubmodules || project.source.reportBuildStatus ||
        tags['pai:project'] !== target.projectId || tags['pai:purpose'] !== 'source-image-build' ||
        env?.type !== 'LINUX_CONTAINER' || env.image !== target.builderImage || env.computeType !== target.computeType ||
        env.privilegedMode !== true || env.imagePullCredentialsType !== builderCredentials(target) || env.environmentVariables?.length ||
        env.registryCredential || env.fleet || project.webhook || project.buildBatchConfig || project.secondarySources?.length ||
        project.secondaryArtifacts?.length || project.fileSystemLocations?.length ||
        project.artifacts?.type !== 'NO_ARTIFACTS' || project.cache?.type !== 'NO_CACHE' ||
        project.timeoutInMinutes !== target.timeoutMinutes || project.queuedTimeoutInMinutes !== target.queuedTimeoutMinutes ||
        !project.concurrentBuildLimit || project.concurrentBuildLimit > 2 || (project.autoRetryLimit ?? 0) !== 0 ||
        project.logsConfig?.cloudWatchLogs?.status !== 'ENABLED' ||
        project.logsConfig.cloudWatchLogs.groupName !== `/aws/codebuild/${target.codeBuildProjectName}` ||
        project.logsConfig.s3Logs?.status === 'ENABLED') fail('build_project_configuration_mismatch');
      await repository(target, signal);
      return { configurationHash: hashBuildValue({ target, sourceBuildspecHash, connection: auth?.resource ?? null, vpc: project.vpcConfig ?? null }),
        ...(target.sourceType === 'S3' ? { snapshot: await snapshot(target, signal, pin) } : {}) };
    },
    async start(run, signal) {
      const result = await call('build_start_unavailable', () => d.codeBuild.send(new StartBuildCommand({
        projectName: run.target.codeBuildProjectName, sourceVersion: run.snapshot?.versionId ?? run.commit, idempotencyToken: run.idempotencyToken,
        environmentVariablesOverride: Object.entries(sourceBuildEnvironment(run, scope)).map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })),
        timeoutInMinutesOverride: run.target.timeoutMinutes, queuedTimeoutInMinutesOverride: run.target.queuedTimeoutMinutes,
        autoRetryLimitOverride: 0, debugSessionEnabled: false,
        ...(run.target.sourceType === 'GITHUB' ? { reportBuildStatusOverride: false } : {}),
      }), options(signal)));
      const id = result.build?.id;
      if (!id?.startsWith(`${run.target.codeBuildProjectName}:`)) throw new SourceBuildProviderError('build_start_identity_unresolved');
      outputTag(id); return id;
    },
    async read(run, signal) { return observation(run, await rawBuild(run, signal)); },
    async find(run, signal) {
      let nextToken: string | undefined; const found: Build[] = [];
      for (let page = 0; page < 2; page++) {
        const list = await call('build_recovery_unavailable', () => d.codeBuild.send(new ListBuildsForProjectCommand({
          projectName: run.target.codeBuildProjectName, sortOrder: 'DESCENDING', nextToken,
        }), options(signal)));
        nextToken = list.nextToken;
        if (list.ids?.length) {
          const values = await call('build_recovery_unavailable', () => d.codeBuild.send(new BatchGetBuildsCommand({ ids: list.ids!.slice(0, 100) }), options(signal)));
          found.push(...(values.builds ?? []).filter(build => build.projectName === run.target.codeBuildProjectName &&
            build.environment?.environmentVariables?.some(value => value.name === 'PAI_REQUEST_ID' && value.value === run.id)));
        }
        if (!nextToken) break;
      }
      if (new Set(found.map(build => build.id)).size > 1) fail('multiple_builds_require_attention');
      return found[0] ? observation(run, found[0]) : undefined;
    },
    async stop(run, signal) {
      await rawBuild(run, signal);
      await call('build_stop_unavailable', () => d.codeBuild.send(new StopBuildCommand({ id: run.buildId! }), options(signal)));
    },
    async inspectOutput(run, _observation, signal) {
      await repository(run.target, signal);
      const result = await call('build_output_unavailable', () => d.ecr.send(new DescribeImagesCommand({
        registryId: scope.accountId, repositoryName: run.target.outputRepositoryName, imageIds: [{ imageTag: outputTag(run.buildId!) }],
      }), options(signal)));
      const image = result.imageDetails?.[0];
      if (result.imageDetails?.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(image?.imageDigest ?? '') ||
          !image?.imageTags?.includes(outputTag(run.buildId!))) throw new SourceBuildProviderError('build_output_not_published');
      const inspected = await call('build_output_inspection_failed', () => d.inspect(`${repositoryUri(run.target)}@${image.imageDigest}`, scope));
      signal.throwIfAborted();
      if (inspected.digest !== image.imageDigest || inspected.architectures.join(',') !== 'amd64') fail('build_output_architecture_mismatch');
      return inspected;
    },
    async logs(run, cursor, signal) {
      const build = await rawBuild(run, signal);
      const group = `/aws/codebuild/${run.target.codeBuildProjectName}`, stream = build.logs?.streamName;
      if (build.logs?.groupName !== group || !stream || stream.length > 512) fail('build_logs_unavailable');
      const result = await call('build_logs_unavailable', () => d.logs.send(new GetLogEventsCommand({
        logGroupName: group, logStreamName: stream, limit: 100, nextToken: cursor, startFromHead: !!cursor,
      }), options(signal)));
      let bytes = 0, truncated = false; const lines: string[] = [];
      for (const event of result.events ?? []) {
        const line = (event.message ?? '').slice(0, 4096)
          .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, '[AWS key]')
          .replace(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/g, '[Git token]')
          .replace(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
          .replace(/((?:password|secret|token|authorization)\s*[=:]\s*)\S+/gi, '$1[redacted]')
          .replace(/https?:\/\/\S*[?&](?:X-Amz-|token|signature|credential)\S*/gi, '[signed URL]');
        if ((bytes += Buffer.byteLength(line)) > 128 * 1024) { truncated = true; break; }
        lines.push(line);
      }
      return { lines, cursor: result.nextForwardToken, truncated };
    },
  };
}
