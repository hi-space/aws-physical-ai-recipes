import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { parseWorkflowYaml } from '../workflow/template';
import type { Workflow } from '../store/types';
import { RuntimeBroker } from './broker';
import { createRuntimeHandler } from './http';
import type { ObjectStorage, StoredManifest } from './storage';
import type { StoredPart } from './multipart-storage';

// Explicit local executable fixture: no Docker/AWS/credential lookup inside tests.
// The final verification command builds Go in the same network-isolated container.
it.skipIf(!process.env.PAI_RUNTIME_TEST_BINARY)('real static Go executable round-trips multipart bytes through the actual Node broker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pai-multipart-roundtrip-'));
  const output = join(root, 'output'), scratch = join(root, 'scratch'), object = join(root, 'object');
  await mkdir(output); await mkdir(scratch);
  const file = await open(join(output, 'model.pt'), 'w');
  const expected = createHash('sha256');
  try {
    const block = Buffer.alloc(1024 ** 2, 37);
    for (let i = 0; i < 64; i++) { await file.write(block); expected.update(block); }
    const tail = Buffer.from('last multipart data');
    await file.write(tail); expected.update(tail);
  } finally { await file.close(); }
  const digest = expected.digest('base64'), size = (await stat(join(output, 'model.pt'))).size;
  const parts = new Map<number, StoredPart>(), manifests = new Map<string, StoredManifest>();
  let origin = '', objectKey = '', fileIdentity = '', declaredDigest = '', active = false, completes = 0, lostReply = false;
  let stored: Awaited<ReturnType<ObjectStorage['head']>> | undefined;
  const puts = new Map<number, number>();
  const storage: ObjectStorage = {
    presignPut: async () => { throw new Error('This fixture requires multipart'); },
    head: async (_bucket, key, version) => {
      if (key !== objectKey || !stored || version && version !== stored.versionId) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return stored;
    },
    readManifest: async (_bucket, key) => manifests.get(key),
    writeManifest: async (_bucket, key, body) => {
      const value = manifests.get(key) ?? { body, versionId: 'manifest-v1' };
      manifests.set(key, value); return value;
    },
    presignGet: async () => { throw new Error('No restore in this byte-transport fixture'); },
    multipart: {
      create: async (_bucket, key, identity, sha) => { objectKey = key; fileIdentity = identity; declaredDigest = sha; active = true; return 'upload-1'; },
      uploads: async () => active ? ['upload-1'] : [],
      parts: async () => [...parts.values()],
      sign: async (_bucket, _key, _id, part) => ({ url: `${origin}/part/${part.number}`, headers: { 'x-amz-checksum-sha256': part.checksumSHA256 } }),
      complete: async (_bucket, _key, _upload, actual, composite) => {
        completes++;
        const destination = await open(object, 'w');
        try {
          for (const part of actual) for await (const chunk of createReadStream(join(root, `part-${part.number}`))) await destination.write(chunk);
        } finally { await destination.close(); }
        stored = { versionId: 'object-v1', size: (await stat(object)).size, checksumSHA256: composite, checksumType: 'COMPOSITE',
          metadata: { 'pai-checkpoint-file': fileIdentity, 'pai-full-sha256': declaredDigest } };
        active = false;
        throw new Error('Simulated lost CompleteMultipartUpload reply after storage committed');
      },
      sha256: async (_bucket, key, version, declaredSize, signal, check) => {
        expect(key).toBe(objectKey); expect(version).toBe('object-v1'); expect(declaredSize).toBe(size);
        const actual = createHash('sha256');
        await check();
        for await (const chunk of createReadStream(object)) { signal.throwIfAborted(); actual.update(chunk); }
        await check();
        return actual.digest('base64');
      },
      abort: async () => { active = false; },
      deleteVersion: async () => { throw new Error('Successful committed bytes must not be deleted'); },
    },
  };
  const repo = new Repo(new MemoryKV());
  const yaml = `workflow:\n  name: roundtrip\n  resources: {cpu: {cpu: 1}}\n  tasks:\n    - name: train\n      resource: cpu\n      image: python\n      command: [echo, done]\n      exitActions: {RESCHEDULE: 75}\n      checkpoint: [{path: "{{output}}", url: "s3://artifacts/projects/p/checkpoints/", frequency: 1h}]\n`;
  const workflow: Workflow = { id: 'roundtrip', name: 'roundtrip', namespace: 'n', projectId: 'p', owner: 'test',
    status: 'RUNNING', spec: parseWorkflowYaml(yaml).spec, specYaml: yaml, vars: {}, taskCount: 1,
    succeededCount: 0, failedCount: 0, createdAt: 'x', updatedAt: 'x' };
  await repo.putWorkflow(workflow);
  await repo.putTask({ workflowId: workflow.id, name: 'train', attempts: 1, attemptEpoch: 'epoch', phase: 'RUNNING',
    replicas: 1, outputPath: output, updatedAt: 'x' });
  const broker = new RuntimeBroker({ repo, now: () => new Date(), signingKey: 'x'.repeat(64), apiUrl: 'http://local',
    artifactBucket: 'artifacts', storage });
  const handler = createRuntimeHandler(broker);
  const failures: string[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      if (!req.url?.startsWith('/part/')) { await handler(req, res); return; }
      const number = Number(req.url.slice('/part/'.length));
      expect(req.headers.authorization).toBeUndefined();
      puts.set(number, (puts.get(number) ?? 0) + 1);
      const hash = createHash('sha256'); let bytes = 0;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); bytes += chunk.length; callback(null, chunk); } });
      await pipeline(req, meter, createWriteStream(join(root, `part-${number}`)));
      const checksumSHA256 = hash.digest('base64');
      expect(checksumSHA256).toBe(req.headers['x-amz-checksum-sha256']);
      parts.set(number, { number, size: bytes, checksumSHA256, etag: `s3-part-${number}` });
      if (number === 2 && !lostReply) { lostReply = true; res.writeHead(500); } else res.writeHead(200);
      res.end();
    })().catch(error => { failures.push((error as Error).message); if (!res.writableEnded) { res.writeHead(500); res.end(); } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const contract = { workflowId: workflow.id, projectId: 'p', task: 'train', attempt: 1, epoch: 'epoch', outputPath: output,
    checkpoint: [{ path: output, url: 's3://artifacts/projects/p/checkpoints/', frequency: '1h', regex: '\\.pt$' }],
    exitActions: { RESCHEDULE: 75 } };
  const child = spawn(process.env.PAI_RUNTIME_TEST_BINARY!, ['--contract', JSON.stringify(contract), '--', '/bin/sh', '-c', 'exit 75'], {
    env: { NODE_ENV: 'test', PATH: process.env.PATH, TMPDIR: scratch, PAI_RUNTIME_ENDPOINT: origin,
      PAI_RUNTIME_TOKEN: broker.environment(workflow, workflow.spec.workflow.tasks[0], 'epoch', 1).PAI_RUNTIME_TOKEN,
      PAI_RUNTIME_FILES_DISABLED: '1', OSMO_TASK_REPLICA_INDEX: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 45_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    expect(code, diagnostics).toBe(75);
    expect(failures).toEqual([]);
    expect(completes).toBe(1);
    expect(puts.get(2)).toBe(1); // Lost part reply reconciled, no duplicate bytes.
    expect(manifests.size).toBe(1);
    const manifest = JSON.parse([...manifests.values()][0].body);
    expect(manifest.objects[0]).toMatchObject({ size, checksumSHA256: digest, storageChecksumType: 'COMPOSITE', versionId: 'object-v1' });
    const plans = await repo.kv.query(`WF#${workflow.id}`, 'RUNTIME#epoch#UPLOAD#');
    expect(plans).toHaveLength(1);
    expect(plans[0].state).toBe('READY');
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
