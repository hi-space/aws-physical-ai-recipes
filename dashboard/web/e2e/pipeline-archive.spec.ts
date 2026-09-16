import { writeFile } from 'node:fs/promises';
import { test, expect, requireCondition } from './researcher-helpers/fixture';
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.setTimeout(40 * 60_000);

test('an administratively imported historical SageMaker artifact becomes a pinned project model', async ({ researcher }, info) => {
  const arn = process.env.PAI_HISTORICAL_PIPELINE_ARN;
  requireCondition(arn === 'arn:aws:sagemaker:us-east-1:913524902871:pipeline/groot-sm-finetuning-913524902871/execution/olsvzf6o2fuv',
    'Explicit registered historical workshop execution is required; this test never starts training');
  type Archive = { id: string; status: string; datasetName: string; version?: number; checkpoint?: { path: string; sha256: string; bytes: number };
    directory?: { digest: string; fileCount: number }; provenance?: { executionArn: string }; sourceObject?: unknown };
  let archive = await researcher.api<Archive>('POST', `/api/pipelines/executions/${encodeURIComponent(arn)}/archives`,
    { trainingStep: 'GR00TFinetune', reportSteps: [] }, [200, 202], 60_000);
  if (['FAILED', 'CANCELLED'].includes(archive.status)) {
    archive = await researcher.api<Archive>('POST', `/api/pipelines/archives/${archive.id}`);
  }
  try {
    archive = await researcher.poll('historical native artifact archive', 35 * 60_000,
      () => researcher.api<Archive>('GET', `/api/pipelines/archives/${archive.id}`), value => {
        if (['FAILED', 'CANCELLED'].includes(value.status)) throw new Error(`Historical archive ended ${value.status}; inspect its diagnostic record`);
        return value.status === 'READY';
      }, value => value.status);
    requireCondition(archive.version && archive.checkpoint && archive.directory, 'READY archive lacks verified checkpoint/directory evidence');
    expect(archive.provenance?.executionArn).toBe(arn);
    expect(archive.checkpoint.bytes).toBeGreaterThan(0);
    expect(archive.checkpoint.sha256).toMatch(/^[a-f0-9]{64}$/);
    const model = await researcher.api<{ id: string; checkpoint: { sha256: string }; checkpointBundle?: unknown; registryLink?: unknown }>('POST', '/api/models', {
      name: 'Imported workshop GR00T checkpoint', dataset: archive.datasetName, version: archive.version, checkpointPath: archive.checkpoint.path,
    }, [200], 120_000);
    expect(model.checkpoint.sha256).toBe(archive.checkpoint.sha256);
    requireCondition(model.checkpointBundle, 'Model registration did not retain the verified directory bundle');
    const proof = info.outputPath('historical-pipeline-archive-proof.json');
    await writeFile(proof, JSON.stringify({ archive, model, newTrainingStarted: false, qualityApproved: false, registryApprovalRequested: false }, null, 2));
    await info.attach('historical-pipeline-archive-proof', { contentType: 'application/json', path: proof });
  } finally {
    if (!['READY', 'FAILED', 'CANCELLED'].includes(archive.status)) await researcher.api('DELETE', `/api/pipelines/archives/${archive.id}`);
  }
});
