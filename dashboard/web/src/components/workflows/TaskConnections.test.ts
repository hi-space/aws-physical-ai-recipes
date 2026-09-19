import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import YAML from 'yaml';
import { apiQueryOptions } from '@/lib/api-client';
import { taskViews } from '@/server/workflow/views';
import { TaskConnections, createTaskConnection, taskConnectionPayload, type ConnectionTask, type ConnectionWorkflow } from './TaskConnections';

const workflow: ConnectionWorkflow = { id: 'run-a', projectId: 'team-a', ownerSubject: 'owner-sub', status: 'RUNNING' };
const task: ConnectionTask = { workflowId: 'run-a', name: 'train', phase: 'RUNNING', attempts: 2, outputPath: '/fsx/checkpoints/projects/team-a/runs/run-a/attempts/2/train' };
const clients: QueryClient[] = [];
afterEach(() => { clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals(); });
function render(wf = workflow, t = task, options: { role?: string; subject?: string; ports?: string[]; projectRole?: string; tasks?: ConnectionTask[]; ready?: boolean; sessions?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });
  clients.push(client);
  client.setQueryData(['api', '/api/me'], { role: options.role ?? 'researcher', subject: options.subject ?? 'owner-sub', project: { id: 'team-a', role: options.projectRole ?? 'researcher' },
    ...(options.sessions === false ? { features: { sessions: false } } : {}) });
  const path = `/api/sessions/connect?workflowId=${wf.id}&taskName=${t.name}`;
  client.setQueryData(apiQueryOptions(path, { init: { headers: { 'x-pai-project': 'team-a' } } }).queryKey,
    { replicas: options.ready === false ? [] : [{ replicaIndex: 0, ports: options.ports ?? ['pai-files'] }] });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(TaskConnections, {
    workflow: wf, tasks: options.tasks ?? [t], selectedTask: (options.tasks ?? [t]).length === 1 ? t.name : undefined, onSelectTask: () => undefined,
  })));
}
const disabled = (html: string, label: string) => {
  const button = new RegExp(`<button([^>]*)>${label}<\\/button>`).exec(html);
  expect(button, label).not.toBeNull(); return /\sdisabled(?:=|\s|$)/.test(button![1]);
};

describe('task connection payloads', () => {
  it('uses the completed task outputPath verbatim for independent read-only TensorBoard', () => {
    const payload = taskConnectionPayload('tensorboard', { ...workflow, status: 'SUCCEEDED' }, { ...task, phase: 'SUCCEEDED' });
    expect(payload).toEqual({ kind: 'tensorboard', logDir: task.outputPath, ttlMinutes: 60 });
    for (const field of ['workflowId', 'taskName', 'attempt', 'namespace', 'port', 'podName']) expect(payload).not.toHaveProperty(field);
  });
  it('prefills live task selectors and only the reserved files port name', () => {
    expect(taskConnectionPayload('terminal', workflow, task)).toEqual({ kind: 'terminal', workflowId: 'run-a', taskName: 'train', replicaIndex: 0, ttlMinutes: 60 });
    expect(taskConnectionPayload('files', workflow, task)).toEqual({ kind: 'port-forward', workflowId: 'run-a', taskName: 'train', replicaIndex: 0, portName: 'pai-files', ttlMinutes: 60 });
    expect(taskConnectionPayload('live', workflow, task)).toEqual({ kind: 'port-forward', workflowId: 'run-a', taskName: 'train', replicaIndex: 0, portName: 'pai-live', ttlMinutes: 60 });
  });
  it.each(['terminal', 'files'] as const)('rejects completed workflow or task %s requests before fetch', async (kind) => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(createTaskConnection(kind, { ...workflow, status: 'SUCCEEDED' }, task)).rejects.toThrow();
    await expect(createTaskConnection(kind, workflow, { ...task, phase: 'SUCCEEDED' })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects missing/cross-project paths and a task from another workflow', () => {
    for (const outputPath of [undefined, '/fsx/checkpoints/projects/other/run', '/fsx/checkpoints/projects/team-a/../other', 's3://arbitrary/logs']) {
      expect(() => taskConnectionPayload('tensorboard', workflow, { ...task, outputPath })).toThrow();
    }
    expect(() => taskConnectionPayload('terminal', workflow, { ...task, workflowId: 'other-run' })).toThrow();
  });
  it('sends the workflow project header through the shared API helper and surfaces API errors', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'created' }, { status: 202 })); vi.stubGlobal('fetch', fetcher);
    await createTaskConnection('tensorboard', workflow, task);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/sessions'); expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-pai-project')).toBe(workflow.projectId);
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'tensorboard', logDir: task.outputPath, ttlMinutes: 60 });
    fetcher.mockImplementation(async () => Response.json({ error: 'Project authorization denied' }, { status: 403 }));
    await expect(createTaskConnection('tensorboard', workflow, task)).rejects.toThrow('Project authorization denied');
  });
});

describe('deployments without session hosts', () => {
  it('disables every session action and explains that GATEWAY_BASE_DOMAIN is absent', () => {
    const html = render(workflow, task, { ports: ['pai-files', 'pai-live'], sessions: false });
    for (const label of ['TensorBoard 준비', '터미널 준비', '작업 파일 준비', '실시간 보기 준비']) expect(disabled(html, label), label).toBe(true);
    expect(html).toContain('GATEWAY_BASE_DOMAIN');
  });
});

describe('live view connection', () => {
  it('enables the live view only when the compiler registered the pai-live port on the running task', () => {
    expect(disabled(render(workflow, task, { ports: ['pai-files', 'pai-live'] }), '실시간 보기 준비')).toBe(false);
    const without = render(workflow, task, { ports: ['pai-files'] });
    expect(disabled(without, '실시간 보기 준비')).toBe(true);
    expect(without).toContain('실시간 보기(live: true)가 설정되어 있지 않습니다');
    expect(disabled(render({ ...workflow, status: 'SUCCEEDED' }, { ...task, phase: 'SUCCEEDED' }, { ports: ['pai-live'] }), '실시간 보기 준비')).toBe(true);
  });
});

describe('researcher task connections rendering', () => {
  it('offers read-only results and live code/file access without a log path input', () => {
    const html = render();
    expect(disabled(html, 'TensorBoard 준비')).toBe(false);
    expect(disabled(html, '터미널 준비')).toBe(false);
    expect(disabled(html, '작업 파일 준비')).toBe(false);
    expect(html).toContain('읽기 전용'); expect(html).toContain('현재 작업에 반영');
    expect(html).not.toContain(task.outputPath); expect(html).not.toContain('name="logDir"');
  });
  it('keeps results available after success while disabling interactive actions', () => {
    const html = render({ ...workflow, status: 'SUCCEEDED' }, { ...task, phase: 'SUCCEEDED' });
    expect(disabled(html, 'TensorBoard 준비')).toBe(false);
    expect(disabled(html, '터미널 준비')).toBe(true);
    expect(disabled(html, '작업 파일 준비')).toBe(true);
    expect(html).toContain('실행 중인 작업에서만');
  });
  it('does not turn administrator privilege or a read-only project role into interactive ownership', () => {
    const otherOwner = render(workflow, task, { role: 'admin', subject: 'other-sub' });
    expect(disabled(otherOwner, '터미널 준비')).toBe(true); expect(disabled(otherOwner, '작업 파일 준비')).toBe(true);
    const viewer = render(workflow, task, { projectRole: 'viewer' });
    expect(disabled(viewer, 'TensorBoard 준비')).toBe(true); expect(disabled(viewer, '터미널 준비')).toBe(true);
  });
  it('does not offer a files connection when the server has no pai-files capability', () => {
    const html = render(workflow, task, { ports: ['metrics'] });
    expect(disabled(html, '터미널 준비')).toBe(false); expect(disabled(html, '작업 파일 준비')).toBe(true);
    expect(html).toContain('파일 보기 기능');
  });
  it('asks the researcher to select a task when a run contains several', () => {
    const html = render(workflow, task, { tasks: [task, { ...task, name: 'evaluate' }] });
    expect(html).toContain('작업 선택'); expect(disabled(html, 'TensorBoard 준비')).toBe(true);
  });
  it('does not invent a project for a legacy workflow', () => {
    const html = render({ ...workflow, projectId: undefined });
    expect(disabled(html, 'TensorBoard 준비')).toBe(true);
    expect(disabled(html, '터미널 준비')).toBe(true);
  });
});

describe('views gating', () => {
  const mlflowSpec = { workflow: { mlflow: true } } as unknown as ConnectionWorkflow['spec'];

  it('shows TensorBoard for a legacy task with no views field', () => {
    const html = render(workflow, { ...task, views: undefined });
    expect(disabled(html, 'TensorBoard 준비')).toBe(false);
  });
  it('shows TensorBoard when views explicitly includes it', () => {
    const html = render(workflow, { ...task, views: ['tensorboard'] });
    expect(disabled(html, 'TensorBoard 준비')).toBe(false);
  });
  it('hides the TensorBoard button entirely when views excludes it', () => {
    const html = render(workflow, { ...task, views: ['mlflow'] });
    expect(html).not.toContain('TensorBoard 준비');
  });
  it('hides the TensorBoard button entirely when views is an empty list', () => {
    const html = render(workflow, { ...task, views: [] });
    expect(html).not.toContain('TensorBoard 준비');
  });
  it('hides TensorBoard for a task the spec never mentions when the recipe declares views for another task', () => {
    // Multi-task recipe (e.g. mujoco-pipeline, gr00t-e2e): ui.recipe.views gates only `train`,
    // so `evaluate` must not inherit TensorBoard just because the map exists.
    const spec = YAML.stringify({ workflow: { name: 'w', tasks: [] }, ui: { recipe: { views: { train: ['tensorboard'] } } } });
    const html = render(workflow, { ...task, name: 'evaluate', views: taskViews(spec, 'evaluate') });
    expect(html).not.toContain('TensorBoard 준비');
  });
  it('shows the MLflow link only for an admin when both the workflow enables mlflow and views includes it', () => {
    const withBoth = render({ ...workflow, spec: mlflowSpec }, { ...task, views: ['tensorboard', 'mlflow'] }, { role: 'admin' });
    expect(withBoth).toContain('MLflow 열기');
    const noSpecFlag = render(workflow, { ...task, views: ['tensorboard', 'mlflow'] }, { role: 'admin' });
    expect(noSpecFlag).not.toContain('MLflow 열기');
    const noViewsEntry = render({ ...workflow, spec: mlflowSpec }, { ...task, views: ['tensorboard'] }, { role: 'admin' });
    expect(noViewsEntry).not.toContain('MLflow 열기');
  });
  it('hides the MLflow link from a non-admin even when the workflow enables mlflow and views includes it', () => {
    // /api/mlflow/ui-url is admin-only; a researcher/viewer must never see a control that would 403.
    const researcher = render({ ...workflow, spec: mlflowSpec }, { ...task, views: ['tensorboard', 'mlflow'] }, { role: 'researcher' });
    expect(researcher).not.toContain('MLflow 열기');
    const viewer = render({ ...workflow, spec: mlflowSpec }, { ...task, views: ['tensorboard', 'mlflow'] }, { role: 'viewer' });
    expect(viewer).not.toContain('MLflow 열기');
  });
});
