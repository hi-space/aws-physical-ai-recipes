import { writeFile } from 'node:fs/promises';
import { test, expect, requireCondition } from './researcher-helpers/fixture';
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.setTimeout(30 * 60_000);

test('the project source snapshot builds in CodeBuild and binds inspected image provenance', async ({ researcher }, info) => {
  const catalog = await researcher.api<{ targets: { id: string; sourceType: string }[] }>('GET', '/api/builds/sources');
  requireCondition(catalog.targets.some(target => target.id === 'workshop' && target.sourceType === 'S3'), 'The isolated workshop source builder must be deployed');
  const source = await researcher.api<{ id: string; snapshot: { versionId: string; sha256: string } }>('POST', '/api/builds/sources', {
    targetId: 'workshop', name: `Source verification ${researcher.tag}`,
  });
  expect(source.snapshot.versionId).toBeTruthy();
  expect(source.snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
  type Run = { id: string; state: string; errorCode?: string; buildId?: string;
    provenance?: { sourceType: string; snapshot: { versionId: string; sha256: string }; sourceArchiveSha256: string;
      dockerfileSha256: string; output: { resolvedImage: string }; runtimeValidation: string } };
  const headers = { 'idempotency-key': `source-build-${researcher.tag}` };
  let run: Run | undefined;
  const profileId = `e2e-source-${researcher.tag}`;
  try {
    run = await researcher.api<Run>('POST', '/api/builds/runs', { sourceId: source.id }, [202], undefined, headers);
    const duplicate = await researcher.api<Run>('POST', '/api/builds/runs', { sourceId: source.id }, [202], undefined, headers);
    expect(duplicate.id).toBe(run.id);
    run = await researcher.poll('actual CodeBuild source image', 24 * 60_000,
      () => researcher.api<Run>('GET', `/api/builds/runs/${run!.id}`), value => {
        if (['FAILED', 'CANCELLED'].includes(value.state)) throw new Error(`Source build ended ${value.state}: ${value.errorCode ?? 'unknown'}`);
        return value.state === 'SUCCEEDED';
      }, value => `${value.state}:${value.errorCode ?? ''}`);
    requireCondition(run.provenance, 'CodeBuild succeeded without verified source/image evidence');
    expect(run.provenance).toMatchObject({ sourceType: 'S3',
      snapshot: { versionId: source.snapshot.versionId, sha256: source.snapshot.sha256 },
      sourceArchiveSha256: source.snapshot.sha256, runtimeValidation: 'not-performed' });
    expect(run.provenance.output.resolvedImage).toMatch(/@sha256:[a-f0-9]{64}$/);
    const profile = await researcher.api<{ id: string; version: number; sourceBuild: { id: string; provenance: unknown } }>('POST', '/api/image-profiles', {
      id: profileId, name: `Build evidence ${researcher.tag}`, image: run.provenance.output.resolvedImage, sourceBuildId: run.id,
      requirements: { minCpu: 1, minMemoryMiB: 1024, minGpu: 0, minGpuMemoryMiB: 0, platforms: [] },
    });
    expect(profile.sourceBuild.id).toBe(run.id);
    expect(profile.sourceBuild.provenance).toEqual(run.provenance);
    // The sample image verifies build transport/provenance; it is not a training runtime.
    await researcher.api('DELETE', `/api/image-profiles/${profileId}`);
    const proof = info.outputPath('source-build-proof.json');
    await writeFile(proof, JSON.stringify({ source, run, profileId, profileVersion: profile.version, profileDisabled: true }, null, 2));
    await info.attach('source-build-proof', { contentType: 'application/json', path: proof });
  } finally {
    if (run && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.state)) {
      await researcher.api('POST', `/api/builds/runs/${run.id}`, { action: 'cancel' });
      await researcher.poll('source build cleanup', 3 * 60_000,
        () => researcher.api<Run>('GET', `/api/builds/runs/${run!.id}`),
        value => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(value.state), value => value.state);
    }
    const response = await researcher.api<{ profiles: { id: string; enabled: boolean; sourceBuild?: { id: string } }[] }>('GET', '/api/image-profiles');
    const owned = response.profiles.find(profile => profile.id === profileId && profile.sourceBuild?.id === run?.id);
    if (owned?.enabled) await researcher.api('DELETE', `/api/image-profiles/${profileId}`);
  }
});
