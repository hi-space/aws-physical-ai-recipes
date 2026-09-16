import YAML from 'yaml';
import { test, expect, requireCondition } from './researcher-helpers/fixture';
import type { Run } from './researcher-helpers/contracts';

test.skip(process.env.DASHBOARD_ROS2_LIVE !== '1', 'Explicit owned ROS 2 communication validation only.');
test.use({ ignoreHTTPSErrors: false, trace: 'off', screenshot: 'off', video: 'off' });
test.setTimeout(12 * 60_000);

test('ROS 2 discovery and payload delivery produce a verified run-scoped READY artifact', async ({ researcher }, info) => {
  const recipe = await researcher.api<{ id: string; yaml: string; templateVersion: number }>('GET', '/api/templates/ros2-transfer');
  expect(recipe.id).toBe('ros2-transfer');
  expect(recipe.templateVersion).toBeGreaterThan(0);
  const document = YAML.parse(recipe.yaml);
  const group = document.workflow.groups[0];
  expect(group.tasks.map((task: { name: string }) => task.name)).toEqual(['discovery', 'publisher', 'subscriber']);
  expect(group.tasks.find((task: { lead?: boolean }) => task.lead).name).toBe('subscriber');
  document.workflow.name = `e2e-ros2-${researcher.tag}`;
  document.workflow.timeout = { queue_timeout: '3m', start_timeout: '4m', exec_timeout: '3m' };
  const record = { name: document.workflow.name, task: 'subscriber', idempotencyKey: `ros2-${researcher.tag}`, id: undefined as string | undefined };
  researcher.runs.push(record);
  const run = await researcher.api<Run>('POST', '/api/workflows', {
    yaml: YAML.stringify(document), templateId: recipe.id, templateVersion: recipe.templateVersion,
    overrides: { messages: '20' }, acknowledgePreflight: true,
  }, [202], 30_000, { 'idempotency-key': record.idempotencyKey });
  requireCondition(run.projectId === researcher.project.id && run.ownerSubject === researcher.principal.subject && run.name === record.name,
    'Submitted ROS run must match the exact test identity');
  record.id = run.id;
  console.log(`[ros2] run=${run.id}`);
  const dataset = `ros2-transfer-${run.id}`;
  researcher.datasets.push({ name: dataset });
  const detail = await researcher.completed(run.id);
  expect(detail.tasks).toHaveLength(3);
  expect(detail.tasks.every(task => task.phase === 'SUCCEEDED' && !task.runtimeFailure)).toBe(true);
  const subscriber = detail.tasks.find(task => task.name === 'subscriber')!;
  const publication = subscriber.publishedVersions?.find(version => version.dataset === dataset);
  requireCondition(publication, 'No committed subscriber publication');
  const version = await researcher.readyVersion(dataset, publication.version);
  const receipt = Object.values(subscriber.artifactReceipts ?? {}).find(value => value.manifestHash === version.manifestHash);
  requireCondition(receipt?.uri === version.uri && receipt.manifestUri === version.manifestUri,
    'Subscriber success must match its durable READY receipt');
  const proof = JSON.parse((await researcher.versionFile(version, 'ros2-transfer.json')).toString('utf8'));
  expect(proof).toMatchObject({ type: 'communication', runId: run.id, messageCount: 20 });
  expect(proof.messages).toHaveLength(20);
  expect(new Set(proof.messages.map((message: { sequence: number }) => message.sequence)).size).toBe(20);
  for (const message of proof.messages) {
    expect(message).toMatchObject({ runId: run.id, payload: 'physical-ai-ros2' });
    expect(Number.isSafeInteger(message.sequence) && message.sequence >= 0).toBe(true);
  }
  await info.attach('ros2-communication-proof', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    runId: run.id, dataset, version: version.version, manifestHash: version.manifestHash, proof,
  }, null, 2)) });
});
