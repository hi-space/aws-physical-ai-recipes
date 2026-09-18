import { expect, it, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { resetConfigForTests } from '../config';
import { parseBuildTargets, sourceBuildspec, sourceCommitSchema, outputTag } from './source-builds-contract';

const accountId = '123456789012';
const target = {
  id: 'a-builder', projectId: 'a', codeBuildProjectName: 'pai-source-a',
  repositoryUrl: 'https://github.com/example/research.git', sourceType: 'GITHUB',
  serviceRoleArn: `arn:aws:iam::${accountId}:role/source-a`,
  builderImage: `${accountId}.dkr.ecr.us-east-1.amazonaws.com/builder@sha256:${'a'.repeat(64)}`,
  outputRepositoryName: 'physical-ai/projects/a/images', dockerfile: 'Dockerfile', context: '.',
  timeoutMinutes: 20, queuedTimeoutMinutes: 5, computeType: 'BUILD_GENERAL1_SMALL',
};
it('requires full immutable commits and project-owned private ECR output', () => {
  expect(sourceCommitSchema.safeParse('main').success).toBe(false);
  expect(sourceCommitSchema.safeParse('a'.repeat(40)).success).toBe(true);
  expect(parseBuildTargets(JSON.stringify([target]), accountId, 'us-east-1', [])[0].repositoryUrl).toBe('https://github.com/example/research');
  expect(() => parseBuildTargets(JSON.stringify([{ ...target, outputRepositoryName: 'physical-ai/projects/b/images' }]), accountId, 'us-east-1', [])).toThrow();
});
it('rejects Operations jobs, credential URLs, mutable builders and unbounded timeouts', () => {
  expect(() => parseBuildTargets(JSON.stringify([target]), accountId, 'us-east-1', [target.codeBuildProjectName])).toThrow();
  for (const change of [{ repositoryUrl: 'https://token@github.com/example/research' }, { builderImage: target.builderImage.replace(/@.*/, ':latest') },
    { timeoutMinutes: 100 }, { queuedTimeoutMinutes: 480 }, { dockerfile: '../../Dockerfile' }]) {
    expect(() => parseBuildTargets(JSON.stringify([{ ...target, ...change }]), accountId, 'us-east-1', [])).toThrow();
  }
});
it('the registered buildspec verifies checkout identity and publishes only the per-build image tag', () => {
  expect(sourceBuildspec).toContain('git rev-parse HEAD');
  expect(sourceBuildspec).toContain('CODEBUILD_RESOLVED_SOURCE_VERSION');
  expect(sourceBuildspec).toContain('--password-stdin');
  expect(sourceBuildspec).not.toContain('set -x');
  expect(sourceBuildspec).toContain('docker push "$PAI_OUTPUT_REPOSITORY_URI:$PAI_OUTPUT_TAG"');
  expect(outputTag('pai-source-a:12345678-1234-1234-1234-123456789abc')).toBe('pai-source-12345678-1234-1234-1234-123456789abc');
});
it('supports a concrete S3 source target with an explicitly identified managed builder', () => {
  const { repositoryUrl: _url, ...base } = target;
  const result = parseBuildTargets(JSON.stringify([{ ...base, sourceType: 'S3',
    snapshotLocation: { bucket: 'source-assets-123456789012', key: 'workshop/source.zip' },
    builderImage: 'aws/codebuild/standard:7.0' }]), accountId, 'us-east-1', []);
  expect(result[0].snapshotLocation?.key).toBe('workshop/source.zip');
  expect(sourceBuildspec).toContain('--version-id "$PAI_SOURCE_VERSION"');
  expect(sourceBuildspec).toContain('PAI_SOURCE_SHA256');
});
it('an unconfigured local environment exposes no source targets', () => {
  expect(parseBuildTargets('[]', '', 'us-east-1', [])).toEqual([]);
});
it('the exact shared buildspec is valid shell and its snapshot extractor preserves executables and rejects escapes', () => {
  const script = YAML.parse(sourceBuildspec).phases.build.commands[0] as string;
  execFileSync('bash', ['-n'], { input: script });
  const python = script.split("<<'PYSOURCE'\n")[1].split('\nPYSOURCE')[0];
  const directory = mkdtempSync(join(tmpdir(), 'pai-source-contract-'));
  try {
    const archive = join(directory, 'source.zip'), destination = join(directory, 'tree');
    execFileSync('python3', ['-c', `import zipfile,sys,stat\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n i=zipfile.ZipInfo('run.sh');i.external_attr=(stat.S_IFREG|0o755)<<16;z.writestr(i,'echo local fixture\\n')`, archive]);
    execFileSync('python3', ['-c', python, archive, destination]);
    expect(readFileSync(join(destination, 'run.sh'), 'utf8')).toBe('echo local fixture\n');
    expect(statSync(join(destination, 'run.sh')).mode & 0o777).toBe(0o755);
    execFileSync('python3', ['-c', `import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('../escape','bad')`, archive]);
    expect(() => execFileSync('python3', ['-c', python, archive, destination], { stdio: 'pipe' })).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('validates region configuration without hardcoded us-east-1 literals', () => {
  vi.stubEnv('AWS_REGION', 'us-west-2');
  resetConfigForTests();
  const westTarget = {
    ...target,
    builderImage: `${accountId}.dkr.ecr.us-west-2.amazonaws.com/builder@sha256:${'a'.repeat(64)}`,
  };
  // Should parse successfully with correct region in both target and config
  const result = parseBuildTargets(JSON.stringify([westTarget]), accountId, 'us-west-2', []);
  expect(result[0].builderImage).toContain('us-west-2');
  // Should reject when region doesn't match config
  expect(() => parseBuildTargets(JSON.stringify([westTarget]), accountId, 'us-east-1', [])).toThrow();
  vi.unstubAllEnvs();
  resetConfigForTests();
});
