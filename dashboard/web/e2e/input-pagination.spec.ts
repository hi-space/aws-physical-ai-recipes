import { writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { test, expect, requireCondition } from './researcher-helpers/fixture';
import type { Dataset, Version } from './researcher-helpers/contracts';
import type { CPUWorkflow } from './researcher-helpers/workflows';
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.setTimeout(20 * 60_000);

test('a real 65-file immutable dataset hydrates across runtime URL-plan pages', async ({ researcher }, info) => {
  const name = `e2e-pages-${researcher.tag}`, outputName = `e2e-page-proof-${researcher.tag}`;
  await researcher.api<Dataset>('POST', '/api/datasets', { name, description: 'Owned 65-file pagination acceptance' });
  researcher.datasets.push({ name });
  const version = await researcher.api<Version>('POST', `/api/datasets/${name}/versions`, { note: 'Crosses the 64-file runtime URL page' });
  const files = Array.from({ length: 65 }, (_, index) => index + 1);
  for (const value of files) {
    const key = `records/${String(value).padStart(3, '0')}.txt`, bytes = Buffer.from(`${value}\n`);
    const upload = await researcher.api<{ url: string }>('POST', `/api/datasets/${name}/upload-url`, {
      version: version.version, filename: key, contentType: 'text/plain',
    });
    await researcher.signedTransfer('PUT', upload.url, bytes, 'text/plain');
  }
  await researcher.api('POST', `/api/datasets/${name}/versions/${version.version}`, { action: 'refresh-size' });
  const ready = await researcher.readyVersion(name, version.version);
  const image = process.env.DASHBOARD_E2E_CPU_IMAGE;
  requireCondition(image, 'A deployed approved CPU image is required');
  const workflow: CPUWorkflow = { name: `e2e-paged-input-${researcher.tag}`, task: 'verify', dataset: outputName, yaml: YAML.stringify({ workflow: {
    name: `e2e-paged-input-${researcher.tag}`, mlflow: false, resources: { cpu: { cpu: 1, memory: '1Gi', gpu: 0,
      ...(process.env.DASHBOARD_E2E_CPU_PLATFORM ? { platform: process.env.DASHBOARD_E2E_CPU_PLATFORM } : {}) } },
    timeout: { queue_timeout: '8m', start_timeout: '5m', exec_timeout: '2m' },
    tasks: [{ name: 'verify', resource: 'cpu', image, command: ['python', '-c'], args: [`
import json, os, pathlib
source = pathlib.Path("{{input:0}}") / "records"
values = [int((source / ("%03d.txt" % value)).read_text()) for value in range(1, 66)]
assert values == list(range(1, 66))
output = pathlib.Path(os.environ["PAI_OUTPUT_DIR"]) / "proof"
output.mkdir()
(output / "pagination.json").write_text(json.dumps({"runId": os.environ["PAI_WORKFLOW_ID"],
    "files": len(values), "sum": sum(values), "verified": True}) + "\\n")
`], inputs: [{ dataset: { name, version: version.version } }], outputs: [{ dataset: { name: outputName, path: '{{output}}/proof' } }] }],
  } }, { lineWidth: 0 }) };
  const run = await researcher.submit(workflow), detail = await researcher.completed(run.id);
  const publication = detail.tasks[0].publishedVersions?.find(value => value.dataset === outputName);
  requireCondition(publication, 'Pagination proof was not published');
  const published = await researcher.readyVersion(outputName, publication.version);
  const proof = JSON.parse((await researcher.versionFile(published, 'pagination.json')).toString());
  expect(proof).toEqual({ runId: run.id, files: 65, sum: 2145, verified: true });
  const path = info.outputPath('input-pagination-proof.json');
  await writeFile(path, JSON.stringify({ ...proof, dataset: name, datasetVersion: ready.version, manifestHash: ready.manifestHash }, null, 2));
  await info.attach('input-pagination-proof', { contentType: 'application/json', path });
});
