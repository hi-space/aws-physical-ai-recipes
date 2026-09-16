import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { test, expect, requireCondition } from './researcher-helpers/fixture';
import type { CPUWorkflow } from './researcher-helpers/workflows';
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.setTimeout(20 * 60_000);

test('real log SSE reconnects, redacts injected credentials and replays after owned Pod deletion', async ({ researcher }, info) => {
  const image = process.env.DASHBOARD_E2E_CPU_IMAGE, kubeconfig = process.env.DASHBOARD_LOGS_KUBECONFIG;
  requireCondition(image && kubeconfig, 'Deployed CPU image and explicit test cluster kubeconfig are required');
  const secret = `log-test-${randomBytes(32).toString('hex')}`;
  const credential = await researcher.api<{ id: string; ref: string }>('POST', '/api/credentials', {
    name: `Log verification ${researcher.tag}`, kind: 'generic', scope: 'private', value: secret,
  }, [201]);
  try {
    const name = `e2e-logs-${researcher.tag}`;
    const workflow: CPUWorkflow = { name, task: 'logger', yaml: YAML.stringify({ workflow: {
      name, mlflow: false, resources: { cpu: { cpu: 1, memory: '1Gi', gpu: 0,
        ...(process.env.DASHBOARD_E2E_CPU_PLATFORM ? { platform: process.env.DASHBOARD_E2E_CPU_PLATFORM } : {}) } },
      timeout: { queue_timeout: '8m', start_timeout: '5m', exec_timeout: '4m' },
      tasks: [{ name: 'logger', resource: 'cpu', image, command: ['python', '-c'], args: [`
import os, time
assert "PAI_RUNTIME_TOKEN" not in os.environ
print("TOKEN_NOT_IN_CHILD_ENV", flush=True)
print("repeat-${researcher.tag}", flush=True)
print("repeat-${researcher.tag}", flush=True)
print("", flush=True)
print("https://example.test/metric", flush=True)
print(os.environ["TEST_SECRET"], flush=True)
time.sleep(100)
print("AFTER_RECONNECT_${researcher.tag}", flush=True)
`], credentials: { test: { TEST_SECRET: credential.ref } } }],
    } }, { lineWidth: 0 }) };
    const run = await researcher.submit(workflow);
    await researcher.running(run.id, workflow.task);
    const path = `/api/workflows/${run.id}/tasks/${workflow.task}/logs?follow=1&start=beginning&container=main`;
    type StreamResult = { opens: number; stream: { id: string; scope: { podName: string; podUid: string } };
      records: { sequence: number; kind: string; data?: string }[] };
    let observed: StreamResult;
    try {
      observed = await researcher.page.evaluate((url): Promise<StreamResult> => new Promise((resolve, reject) => {
        const source = new EventSource(url), records = new Map<number, { sequence: number; kind: string; data?: string }>();
        let opens = 0;
        const timer = setTimeout(() => { source.close(); reject(new Error('log stream deadline')); }, 190_000);
        source.onopen = () => { opens++; };
        const accept = (event: MessageEvent) => {
          try {
            const value = JSON.parse(event.data);
            for (const record of value.records ?? []) records.set(record.sequence, record);
            if (event.type === 'end' && value.stream) {
              clearTimeout(timer); source.close();
              resolve({ opens, stream: value.stream, records: [...records.values()].sort((a, b) => a.sequence - b.sequence) });
            }
          } catch { clearTimeout(timer); source.close(); reject(new Error('invalid log stream')); }
        };
        source.addEventListener('page', event => accept(event as MessageEvent));
        source.addEventListener('end', event => accept(event as MessageEvent));
        source.addEventListener('log-error', () => { clearTimeout(timer); source.close(); reject(new Error('log authorization/capture failed')); });
        // Native EventSource reconnects after the server's bounded quiet connection closes.
      }), path);
    } catch { throw new Error('Deployed log SSE did not complete safely (content and credentials omitted)'); }
    const text = observed.records.filter(record => record.kind === 'data').map(record => Buffer.from(record.data!, 'base64').toString()).join('');
    requireCondition(!text.includes(secret) && !text.includes(secret.slice(-16)), 'Injected credential appeared in captured logs');
    expect(observed.opens).toBeGreaterThanOrEqual(2);
    expect(text.split(`repeat-${researcher.tag}`).length - 1).toBe(2);
    expect(text).toContain('\n\n');
    expect(text).toContain('https://example.test/metric');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain(`AFTER_RECONNECT_${researcher.tag}`);
    expect(text).toContain('TOKEN_NOT_IN_CHILD_ENV');
    const detail = await researcher.completed(run.id);
    const task = detail.tasks[0] as typeof detail.tasks[0] & { jobName?: string; jobUid?: string };
    requireCondition(task.jobName && task.jobUid, 'Recorded Job identity is required before test cleanup');
    const get = spawnSync('kubectl', ['--kubeconfig', kubeconfig, '-n', researcher.project.namespace,
      'get', 'job', task.jobName, '--ignore-not-found', '-o', 'json'], { encoding: 'utf8', timeout: 30_000 });
    requireCondition(get.status === 0, 'Cannot verify owned Job before deletion');
    if (get.stdout.trim()) {
      const job = JSON.parse(get.stdout);
      requireCondition(job.metadata.uid === task.jobUid && job.metadata.labels?.['pai.aws/workflow-id'] === run.id &&
        job.metadata.namespace === researcher.project.namespace, 'Job was replaced; refusing deletion');
      const options = info.outputPath('owned-job-delete-options.json');
      await writeFile(options, JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground',
        preconditions: { uid: task.jobUid } }));
      const deleted = spawnSync('kubectl', ['--kubeconfig', kubeconfig, 'delete', '--raw',
        `/apis/batch/v1/namespaces/${researcher.project.namespace}/jobs/${task.jobName}`, '-f', options],
      { encoding: 'utf8', timeout: 30_000 });
      requireCondition(deleted.status === 0, 'Conditional deletion of the owned Job failed');
    }
    await researcher.poll('owned log Pod removal', 90_000, async () => {
      const result = spawnSync('kubectl', ['--kubeconfig', kubeconfig, '-n', researcher.project.namespace,
        'get', 'pod', observed.stream.scope.podName, '--ignore-not-found', '-o', 'json'], { encoding: 'utf8', timeout: 30_000 });
      requireCondition(result.status === 0, 'Cannot verify owned Pod removal');
      return result.stdout.trim();
    }, value => !value, value => value ? 'retained' : 'removed');
    const replay = await researcher.api<{ records: StreamResult['records']; coverage: string; source: string }>('GET',
      `/api/workflows/${run.id}/tasks/${workflow.task}/logs?stream=${observed.stream.id}&start=beginning`);
    const replayed = replay.records.filter(record => record.kind === 'data').map(record => Buffer.from(record.data!, 'base64').toString()).join('');
    requireCondition(!replayed.includes(secret), 'Credential appeared in archive replay');
    expect(replayed).toBe(text);
    expect(replay).toMatchObject({ source: 'archive', coverage: 'captured-only' });
    const proof = info.outputPath('log-archive-proof.json');
    await writeFile(proof, JSON.stringify({ runId: run.id, streamId: observed.stream.id, podUid: observed.stream.scope.podUid,
      opens: observed.opens, records: observed.records.length, logSHA256: createHash('sha256').update(text).digest('hex'),
      redacted: true, duplicatesAndBlankLinesPreserved: true, ordinaryURLPreserved: true, replayAfterPodRemoval: true }, null, 2));
    await info.attach('log-archive-proof', { contentType: 'application/json', path: proof });
  } finally {
    await researcher.api('DELETE', `/api/credentials/${credential.id}`);
  }
});
