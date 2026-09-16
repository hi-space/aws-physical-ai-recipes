import { writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { test, expect, requireCondition } from './researcher-helpers/fixture';
import type { CPUWorkflow } from './researcher-helpers/workflows';
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.setTimeout(45 * 60_000);

test('a checkpoint larger than 5 GiB survives multipart publication and RESCHEDULE restore', async ({ researcher }, info) => {
  const bytes = Number(process.env.PAI_LARGE_CHECKPOINT_BYTES);
  requireCondition(Number.isSafeInteger(bytes) && bytes > 5 * 1024 ** 3 && bytes <= 6 * 1024 ** 3,
    'Explicit PAI_LARGE_CHECKPOINT_BYTES must be >5 GiB and <=6 GiB for this bounded live transfer');
  const image = process.env.DASHBOARD_E2E_CPU_IMAGE;
  requireCondition(image, 'A deployed approved CPU image is required');
  const name = `e2e-large-${researcher.tag}`, dataset = `e2e-large-proof-${researcher.tag}`;
  const script = `
import hashlib, json, os, pathlib, shutil, tempfile
output = pathlib.Path(os.environ["PAI_OUTPUT_DIR"])
checkpoint = output / "checkpoint"
checkpoint.mkdir(exist_ok=True)
attempt = int(os.environ["PAI_ATTEMPT"])
size = ${bytes}
assert attempt in (1, 2)
if attempt == 1:
    assert shutil.disk_usage(tempfile.gettempdir()).free > size * 1.2, "insufficient private snapshot disk"
    assert shutil.disk_usage(output).free > size * 2, "insufficient FSx restore space"
    block = bytes(range(256)) * 4096
    remaining = size
    digest = hashlib.sha256()
    with (checkpoint / "large.bin").open("wb") as handle:
        while remaining:
            part = block[:min(len(block), remaining)]
            handle.write(part)
            digest.update(part)
            remaining -= len(part)
        handle.flush()
        os.fsync(handle.fileno())
    (checkpoint / "expected.json").write_text(json.dumps({"bytes": size, "sha256": digest.hexdigest(),
        "runId": os.environ["PAI_WORKFLOW_ID"], "sourceAttempt": 1}))
    print("LARGE_CHECKPOINT_WRITTEN", size, flush=True)
    raise SystemExit(75)
mapping = json.loads(os.environ["PAI_RESUME_CHECKPOINTS"])
restored = pathlib.Path(mapping[str(checkpoint)])
receipt = json.loads((restored / ".pai-restore-receipt.json").read_text())
expected = json.loads((restored / "expected.json").read_text())
assert receipt["source"]["attempt"] == 1 and receipt["target"]["attempt"] == 2
assert expected["runId"] == os.environ["PAI_WORKFLOW_ID"]
digest = hashlib.sha256()
observed = 0
with (restored / "large.bin").open("rb") as handle:
    while True:
        block = handle.read(1024 * 1024)
        if not block: break
        digest.update(block)
        observed += len(block)
assert observed == size == expected["bytes"]
assert digest.hexdigest() == expected["sha256"]
proof = {"runId": os.environ["PAI_WORKFLOW_ID"], "bytes": observed, "sha256": digest.hexdigest(),
         "sourceAttempt": 1, "targetAttempt": 2, "verified": True,
         "publicationId": receipt["publicationId"], "manifestHash": receipt["manifestHash"]}
(output / "proof").mkdir()
(output / "proof/large-checkpoint.json").write_text(json.dumps(proof, sort_keys=True) + "\\n")
# Keep final checkpoint publication nonempty without uploading the large test file again.
(checkpoint / "restored-proof.json").write_text(json.dumps(proof, sort_keys=True))
print("LARGE_CHECKPOINT_RESTORED", observed, flush=True)
`;
  const workflow: CPUWorkflow = { name, task: 'transfer', dataset, yaml: YAML.stringify({ workflow: {
    name, mlflow: false, resources: { cpu: { cpu: 1, memory: '2Gi', storage: '12Gi', gpu: 0,
      ...(process.env.DASHBOARD_E2E_CPU_PLATFORM ? { platform: process.env.DASHBOARD_E2E_CPU_PLATFORM } : {}) } },
    timeout: { queue_timeout: '8m', start_timeout: '5m', exec_timeout: '30m' },
    tasks: [{ name: 'transfer', resource: 'cpu', image, command: ['python', '-c'], args: [script],
      retry: { max_retries: 1, backoff_seconds: 1 }, exitActions: { COMPLETE: 0, RESCHEDULE: 75 },
      checkpoint: [{ path: '{{output}}/checkpoint', url: 'auto', frequency: '24h' }],
      outputs: [{ dataset: { name: dataset, path: '{{output}}/proof' } }] }],
  } }, { lineWidth: 0 }) };
  const run = await researcher.submit(workflow);
  const detail = await researcher.poll('large checkpoint restore', 38 * 60_000, remaining => researcher.detail(run.id, remaining), value => {
    if (['FAILED', 'CANCELLED'].includes(value.workflow.status)) throw new Error(`Large checkpoint run ended ${value.workflow.status}`);
    return value.workflow.status === 'SUCCEEDED';
  }, value => `${value.workflow.status}; ${value.tasks.map(task => `${task.name}:${task.phase}:${task.attempts}`).join(',')}`);
  const task = detail.tasks.find(task => task.name === 'transfer');
  expect(task?.attempts).toBe(2);
  expect(task?.runtimeFailure ?? false).toBe(false);
  const publication = task?.publishedVersions?.find(version => version.dataset === dataset);
  requireCondition(publication, 'Restored attempt did not publish its proof');
  const version = await researcher.readyVersion(dataset, publication.version);
  const proof = JSON.parse((await researcher.versionFile(version, 'large-checkpoint.json')).toString());
  expect(proof).toMatchObject({ runId: run.id, bytes, sourceAttempt: 1, targetAttempt: 2, verified: true });
  expect(proof.sha256).toMatch(/^[a-f0-9]{64}$/);
  const output = info.outputPath('large-checkpoint-proof.json');
  await writeFile(output, JSON.stringify({ ...proof, dataset, datasetVersion: publication.version }, null, 2));
  await info.attach('large-checkpoint-proof', { contentType: 'application/json', path: output });
});
