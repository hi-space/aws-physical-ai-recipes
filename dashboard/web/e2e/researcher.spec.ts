import { createHash } from 'node:crypto';
import { test, expect, budgets, requireCondition, type Researcher } from './researcher-helpers/fixture';
import type { Dataset, FileListing, RunDetail, Version } from './researcher-helpers/contracts';
import { hydratedWorkflow, producerWorkflow, sessionWorkflow, type CPUWorkflow } from './researcher-helpers/workflows';

// This suite is deliberately opt-in. --list/typechecking never authenticates.
// No automatic screenshots/traces/video may retain credentials or launch tickets.
test.use({ ignoreHTTPSErrors: false, screenshot: 'off', trace: 'off', video: 'off' });
test.setTimeout(30 * 60_000);
test.describe.configure({ retries: 0 });

async function published(researcher: Researcher, id: string, workflow: CPUWorkflow, exitCode: number) {
  const detail = await researcher.completed(id);
  expect(detail.tasks).toHaveLength(1);
  const task = detail.tasks.find(t => t.name === workflow.task);
  requireCondition(task, 'Completed workflow is missing its submitted task');
  expect(task.phase).toBe('SUCCEEDED');
  expect(task.exitCode, 'Original application exit must survive runtime normalization').toBe(exitCode);
  expect(task.wrapperExitCode).toBe(0);
  expect(task.runtimeFailure ?? false).toBe(false);
  const publication = task.publishedVersions?.find(v => v.dataset === workflow.dataset);
  requireCondition(publication && Number.isSafeInteger(publication.version) && publication.version > 0,
    'Succeeded task did not publish its expected dataset version');
  const version = await researcher.readyVersion(publication.dataset, publication.version);
  expect(version.producedBy).toEqual({ workflowId: id, task: workflow.task });
  const receipt = Object.values(task.artifactReceipts ?? {}).find(r => r.manifestHash === version.manifestHash);
  requireCondition(receipt && receipt.manifestUri === version.manifestUri && receipt.uri === version.uri,
    'Task completion and READY dataset are not backed by the same verified artifact receipt');
  const bytes = await researcher.versionFile(version, 'proof.json');
  let proof: Record<string, unknown>;
  try { proof = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Published proof.json is not valid JSON'); }
  expect(proof.runId).toBe(id);
  return { detail, version, proof };
}

test('CPU custom workflow applies COMPLETE to raw exit 7 and publishes real READY artifact bytes', async ({ researcher }, info) => {
  const workflow = producerWorkflow(await researcher.recipe(), researcher.tag);
  const run = await researcher.submit(workflow);
  const { proof, version } = await published(researcher, run.id, workflow, 7);
  expect(proof).toMatchObject({ nonce: researcher.tag, values: [2, 3, 5], sum: 10 });
  await info.attach('produced-proof', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    runId: run.id, dataset: version.dataset, version: version.version, manifestHash: version.manifestHash,
    nonce: proof.nonce, sum: proof.sum,
  }, null, 2)) });
  await researcher.page.goto(`${researcher.origin}/datasets/${workflow.dataset}`, { waitUntil: 'domcontentloaded', timeout: budgets.api });
  await expect(researcher.page.getByRole('heading', { name: workflow.dataset!, exact: true })).toBeVisible();
  await expect(researcher.page.getByText('READY', { exact: true }).first()).toBeVisible();
});

test('dataset upload transitions PENDING to READY and a consumer run proves real input hydration', async ({ researcher }, info) => {
  const name = `e2e-input-${researcher.tag}`;
  researcher.datasets.push({ name });
  const created = await researcher.api<Dataset>('POST', '/api/datasets', {
    name, description: 'Owned researcher integration payload', tags: ['e2e-researcher'], format: 'json',
  });
  expect(created.name).toBe(name);
  expect(created.projectId).toBe(researcher.project.id);
  const pending = await researcher.api<Version>('POST', `/api/datasets/${name}/versions`, { note: 'Exact bytes for hydration verification' });
  requireCondition(Number.isSafeInteger(pending.version) && pending.version > 0, 'Dataset version number is invalid');
  expect(pending.state).toBe('PENDING');
  expect(pending.manifestHash).toBeUndefined();
  Object.assign(researcher.datasets.find(d => d.name === name)!, { version: pending.version, state: pending.state });
  researcher.phase('dataset upload', 'PENDING');
  await researcher.page.goto(`${researcher.origin}/datasets/${name}`, { waitUntil: 'domcontentloaded', timeout: budgets.api });
  await expect(researcher.page.getByText('PENDING', { exact: true }).first()).toBeVisible();

  const payload = Buffer.from(JSON.stringify({ nonce: researcher.tag, values: [11, 13, 17] }) + '\n');
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const upload = await researcher.api<{ url: string; key: string }>('POST', `/api/datasets/${name}/upload-url`, {
    version: pending.version, filename: 'records.json', contentType: 'application/json',
  });
  requireCondition(upload.key.startsWith(`projects/${researcher.project.id}/datasets/${name}/uploads/`) &&
    upload.key.endsWith('/records.json'), 'Upload registration is outside this test dataset staging prefix');
  await researcher.signedTransfer('PUT', upload.url, payload, 'application/json');
  const requested = await researcher.api<Version>('POST', `/api/datasets/${name}/versions/${pending.version}`, { action: 'refresh-size' });
  expect(requested.finalizationRequested).toBe(true);
  const ready = await researcher.readyVersion(name, pending.version);
  expect(ready.objectCount).toBe(1);
  expect(ready.sizeBytes).toBe(payload.length);
  expect(ready.fsxPath).toBe(`/fsx/datasets/projects/${researcher.project.id}/${name}/v${pending.version}`);
  expect((await researcher.versionFile(ready, 'records.json')).equals(payload)).toBe(true);
  await researcher.page.reload({ waitUntil: 'domcontentloaded', timeout: budgets.api });
  await expect(researcher.page.getByText('READY', { exact: true }).first()).toBeVisible();

  const workflow = hydratedWorkflow(await researcher.recipe(), researcher.tag, {
    name, version: pending.version, manifestHash: ready.manifestHash!, sha256,
  });
  const run = await researcher.submit(workflow);
  const { detail, proof } = await published(researcher, run.id, workflow, 0);
  expect(detail.workflow.datasetSnapshots?.consume?.['0']).toMatchObject({
    name, version: pending.version, fsxPath: ready.fsxPath, manifestHash: ready.manifestHash, uri: ready.uri,
  });
  expect(proof).toMatchObject({
    nonce: researcher.tag, sum: 41, inputSha256: sha256,
    manifestHash: ready.manifestHash, inputPath: ready.fsxPath,
  });
  await info.attach('hydration-proof', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    runId: run.id, sourceDataset: name, sourceVersion: pending.version, manifestHash: ready.manifestHash,
    sha256, inputPath: proof.inputPath, sum: proof.sum,
  }, null, 2)) });
});

test('own long CPU task provides READY terminal and files sessions over valid HTTPS, then cleans up', async ({ researcher }) => {
  const workflow = sessionWorkflow(await researcher.recipe(), researcher.tag);
  const run = await researcher.submit(workflow);
  const task = await researcher.running(run.id, workflow.task);
  await researcher.connectionReady(run.id, workflow.task);
  const terminalSession = await researcher.createSession('terminal', run.id, workflow.task);
  const fileSession = await researcher.createSession('port-forward', run.id, workflow.task);
  const terminal = await researcher.launch(terminalSession);
  await expect(terminal.locator('#terminal-status')).toHaveText('Connected', { timeout: budgets.launch });
  const files = await researcher.launch(fileSession);
  await expect(files.getByRole('heading', { name: 'Output workspace', exact: true })).toBeVisible({ timeout: budgets.launch });
  await expect(files.getByRole('link', { name: 'session-marker.json', exact: true })).toBeVisible({ timeout: budgets.launch });
  const fileOrigin = new URL(files.url()).origin;

  const fetchFile = async (name: string, allowMissing = false, timeout: number = budgets.api) => {
    let response;
    try {
      response = await files.request.get(`${fileOrigin}/files/${encodeURIComponent(name)}`, {
        headers: { origin: fileOrigin }, timeout, maxRedirects: 0,
      });
    } catch { throw new Error('Authenticated file transfer failed (network/TLS/deadline)'); }
    try {
      if (allowMissing && response.status() === 404) return undefined;
      expect(response.status(), 'File gateway must serve actual task data').toBe(200);
      expect(response.headers()['content-disposition']).toMatch(/^attachment;/);
      return await response.text();
    } finally { await response.dispose(); }
  };
  expect(JSON.parse((await fetchFile('session-marker.json'))!)).toEqual({ nonce: researcher.tag, runId: run.id });
  const uploadedName = `browser-${researcher.tag}.txt`;
  const uploadedBytes = `researcher browser upload ${researcher.tag}\n`;
  await files.locator('#picker').setInputFiles({ name: uploadedName, mimeType: 'text/plain', buffer: Buffer.from(uploadedBytes) });
  await files.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(files.getByRole('link', { name: uploadedName, exact: true })).toBeVisible({ timeout: budgets.transfer });
  expect(await fetchFile(uploadedName)).toBe(uploadedBytes);

  // A terminal echo is not proof of execution. Write from the registered
  // container's shell and verify bytes through the separate files gateway.
  const terminalName = `terminal-${researcher.tag}.txt`;
  const terminalBytes = `researcher terminal execution ${researcher.tag}\n`;
  const python = `from pathlib import Path; Path(${JSON.stringify(`${task.outputPath}/${terminalName}`)}).write_text(${JSON.stringify(terminalBytes)})`;
  const command = `python -c '${python.replace(/'/g, `'\\''`)}'\nexit\n`;
  const terminalCode = await terminal.evaluate(async ({ command, timeout }) => {
    return new Promise<number>((resolve, reject) => {
      const target = new URL('/__gateway/terminal', location.href);
      target.protocol = 'wss:';
      const socket = new WebSocket(target.href);
      let settled = false;
      const finish = (error?: string, code = 0) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.close();
        if (error) reject(new Error(error)); else resolve(code);
      };
      const timer = setTimeout(() => finish('Terminal execution deadline exceeded'), timeout);
      // One bounded input frame can safely wait for the Kubernetes exec stream.
      socket.onopen = () => socket.send(JSON.stringify({ type: 'input', data: command }));
      socket.onmessage = event => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === 'exit') finish(undefined, Number(message.code));
          if (message.type === 'error') finish('Gateway rejected terminal execution');
        } catch { finish('Malformed terminal protocol response'); }
      };
      socket.onerror = () => finish('Terminal WebSocket connection failed');
      socket.onclose = () => { if (!settled) finish('Terminal closed without an exit report'); };
    });
  }, { command, timeout: budgets.transfer });
  expect(terminalCode).toBe(0);
  await researcher.poll('terminal-created file bytes', budgets.transfer,
    remaining => fetchFile(terminalName, true, remaining), body => body === terminalBytes,
    body => body === undefined ? 'not written yet' : body === terminalBytes ? 'verified' : 'unexpected bytes');
  const listingResponse = await files.request.get(`${fileOrigin}/api/files`, { headers: { origin: fileOrigin }, timeout: budgets.api });
  try {
    expect(listingResponse.status()).toBe(200);
    const listing = await listingResponse.json() as FileListing;
    expect(listing.entries.map(entry => entry.name)).toEqual(expect.arrayContaining(['session-marker.json', uploadedName, terminalName]));
  } finally { await listingResponse.dispose(); }
  const stillRunning: RunDetail = await researcher.detail(run.id);
  expect(stillRunning.workflow.status).toBe('RUNNING');
  // The fixture closes both exact session IDs, verifies grant rejection, then
  // cancels this exact owned run and waits for terminal workflow/task states.
});
