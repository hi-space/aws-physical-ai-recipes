import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { test, expect, requireCondition } from './researcher-helpers/fixture';
import type { CPUWorkflow } from './researcher-helpers/workflows';
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.setTimeout(20 * 60_000);

test('task logs stream from the kubelet with redaction, reconnect by timestamp, and report pod-gone after deletion', async ({ researcher }, info) => {
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
    const path = `/api/workflows/${run.id}/tasks/${workflow.task}/logs?follow=1&container=main`;
    type Observed = { opens: number; lines: { ts: string; text: string }[] };
    const observed = await researcher.page.evaluate((url): Promise<Observed> => new Promise((resolve, reject) => {
      const lines: { ts: string; text: string }[] = []; let opens = 0, since = '';
      const timer = setTimeout(() => reject(new Error('log stream deadline')), 190_000);
      const open = () => {
        const source = new EventSource(since ? `${url}&since=${encodeURIComponent(since)}` : url);
        source.onopen = () => { opens++; };
        source.addEventListener('line', event => { const line = JSON.parse((event as MessageEvent).data); lines.push(line); if (line.ts) since = line.ts;
          if (line.text.includes('AFTER_RECONNECT_')) { clearTimeout(timer); source.close(); resolve({ opens, lines }); } });
        source.addEventListener('end', event => { source.close(); if (JSON.parse((event as MessageEvent).data).reason === 'timeout') open(); });
        source.addEventListener('log-error', () => { clearTimeout(timer); source.close(); reject(new Error('log authorization failed')); });
      };
      open();
    }), path);
    const text = observed.lines.map(l => l.text).join('\n');
    expect(observed.opens).toBeGreaterThanOrEqual(2);
    expect(text.split(`repeat-${researcher.tag}`).length - 1).toBe(2);
    expect(text).toContain('https://example.test/metric');
    expect(text).toContain('[REDACTED]');
    requireCondition(!text.includes(secret) && !text.includes(secret.slice(-16)), 'Injected credential appeared in streamed logs');
    expect(text).toContain('TOKEN_NOT_IN_CHILD_ENV');
    const detail = await researcher.completed(run.id);
    const snapshot = await researcher.api<{ target?: { podName: string } }>('GET',
      `/api/workflows/${run.id}/tasks/${workflow.task}/logs?tail=1`, undefined, [200]);
    requireCondition(snapshot.target?.podName, 'Pod identity is required before cleanup');
    const podName = snapshot.target.podName;
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
        'get', 'pod', podName, '--ignore-not-found', '-o', 'json'], { encoding: 'utf8', timeout: 30_000 });
      requireCondition(result.status === 0, 'Cannot verify owned Pod removal');
      return result.stdout.trim();
    }, value => !value, value => value ? 'retained' : 'removed');
    const after = await researcher.api<{ source: string; reason?: string }>('GET', `/api/workflows/${run.id}/tasks/${workflow.task}/logs?tail=10`, undefined, [200]);
    expect(after).toMatchObject({ source: 'none', reason: 'pod-gone' });
    const proof = info.outputPath('log-stream-proof.json');
    await writeFile(proof, JSON.stringify({ runId: run.id, podName, opens: observed.opens, lineCount: observed.lines.length,
      sha256: createHash('sha256').update(text).digest('hex'), redacted: true, podGoneAfterDeletion: true }, null, 2));
    await info.attach('log-stream-proof', { contentType: 'application/json', path: proof });
  } finally {
    await researcher.api('DELETE', `/api/credentials/${credential.id}`);
  }
});
