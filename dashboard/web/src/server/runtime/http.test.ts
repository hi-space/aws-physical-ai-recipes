import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { parseWorkflowYaml } from '../workflow/template';
import type { Workflow } from '../store/types';
import { RuntimeBroker } from './broker';
import { createRuntimeHandler } from './http';
let server: Server, url: string, token: string, metricsToken: string, repo: Repo;
beforeEach(async () => {
  repo = new Repo(new MemoryKV());
  const yaml = 'workflow:\n  name: w\n  resources: {cpu: {cpu: 1}}\n  tasks: [{name: a, resource: cpu, image: busybox, command: [echo, ok]}]\n';
  const wf: Workflow = {
    id: 'w',
    name: 'w',
    namespace: 'n',
    projectId: 'p',
    owner: 'a',
    status: 'RUNNING',
    spec: parseWorkflowYaml(yaml).spec,
    specYaml: yaml,
    vars: {},
    createdAt: 'x',
    updatedAt: 'x',
    taskCount: 1,
    succeededCount: 0,
    failedCount: 0
  };
  await repo.putWorkflow(wf);
  await repo.putTask({
    workflowId: 'w',
    name: 'a',
    phase: 'RUNNING',
    attempts: 1,
    attemptEpoch: 'e',
    replicas: 1,
    updatedAt: 'x'
  });
  const broker = new RuntimeBroker({
    repo,
    now: () => new Date(),
    signingKey: 's'.repeat(64),
    apiUrl: 'http://worker',
    artifactBucket: 'b'
  });
  token = broker.environment(wf, wf.spec.workflow.tasks[0], 'e', 1).PAI_RUNTIME_TOKEN;
  metricsToken = broker.mintMetricsCapability(wf, wf.spec.workflow.tasks[0], 'e', 1);
  const handle = createRuntimeHandler(broker);
  server = createServer((req, res) => {
    void handle(req, res).then(handled => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as {
    port: number;
  }).port}`;
});
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
});
const post = (path: string, body: unknown, bearer = token) => fetch(url + path, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify(body)
});
it('dispatches only runtime paths, authenticates every endpoint, and returns 410 after fencing', async () => {
  expect((await fetch(url + '/health')).status).toBe(404);
  const invalid = await post('/runtime/heartbeat', {}, 'bad-token');
  expect(invalid.status).toBe(401);
  expect(await invalid.text()).not.toContain('bad-token');
  expect((await post('/runtime/state', {
    phase: 'INITIALIZING',
    ready: true,
    replica: 0
  })).status).toBe(204);
  expect(await (await fetch(url + '/runtime/barrier?replica=0', {
    headers: {
      authorization: `Bearer ${token}`
    }
  })).json()).toEqual({
    released: true,
    stopped: false
  });
  expect((await post('/runtime/heartbeat', {})).status).toBe(204);
  await repo.kv.put({
    pk: 'WF#w',
    sk: 'FENCE#e'
  });
  expect((await post('/runtime/heartbeat', {})).status).toBe(410);
});
it('rejects malformed payloads and replica indices without exposing credentials', async () => {
  const response = await post('/runtime/state', {
    phase: 'SUCCEEDED',
    ready: false,
    replica: 1,
    exitCode: 0
  });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain(token);
  const malformed = await fetch(url + '/runtime/state', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: '{oops'
  });
  expect(malformed.status).toBe(400);
});
it.each([['POST', '/runtime/state'], ['POST', '/runtime/heartbeat'], ['GET', '/runtime/barrier?replica=0'], ['POST', '/runtime/uploads'], ['POST', '/runtime/uploads/complete'], ['POST', '/runtime/uploads/file'], ['POST', '/runtime/uploads/part'], ['POST', '/runtime/uploads/file/complete'], ['POST', '/runtime/uploads/abort'], ['GET', '/runtime/inputs'], ['GET', '/runtime/checkpoints?replica=0']])('rejects metrics capability at %s %s', async (method, path) => {
  const response = await fetch(url + path, {
    method,
    headers: {
      authorization: `Bearer ${metricsToken}`,
      'content-type': 'application/json'
    },
    ...(method === 'POST' ? {
      body: '{}'
    } : {})
  });
  expect(response.status).toBe(401);
  expect(await repo.kv.query('WF#w', 'RUNTIME#')).toEqual([]);
});

it('dispatches checkpoint restore only for a valid current replica and capability', async () => {
  const task = (await repo.listTasks('w'))[0];
  await repo.putTask({ ...task, outputPath: '/fsx/checkpoints/projects/p/runs/w/attempts/1/a' });
  const headers = { authorization: `Bearer ${token}` };
  expect(await (await fetch(url + '/runtime/checkpoints?replica=0', { headers })).json()).toEqual({ checkpoints: [] });
  for (const query of ['', '?replica=-1', '?replica=0&replica=0', '?replica=1']) {
    expect((await fetch(url + '/runtime/checkpoints' + query, { headers })).status).toBe(400);
  }
  await repo.kv.put({ pk: 'WF#w', sk: 'FENCE#e' });
  expect((await fetch(url + '/runtime/checkpoints?replica=0', { headers })).status).toBe(410);
});
