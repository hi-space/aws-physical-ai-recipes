/** Browser contract tests use only an in-memory local API fixture. No cloud calls. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { parse, stringify } from 'yaml';
import type { Dataset, DatasetVersion, Template } from '@/server/store/types';

const baseTemplate = (id: string, version?: number): Template => ({ id, templateVersion: version, title: id, description: 'Fixture recipe', category: 'evaluation', builtin: true, createdAt: '', params: [], yaml: '' });
const datasets: Dataset[] = [
  { name: 'demo-set', owner: 'u', tags: [], latestVersion: 3, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
];
const versionsByDataset: Record<string, DatasetVersion[]> = {
  'demo-set': [
    { dataset: 'demo-set', version: 2, uri: 's3://b/2', tags: [], createdAt: '', createdBy: 'u', state: 'READY' },
    { dataset: 'demo-set', version: 3, uri: 's3://b/3', tags: [], createdAt: '', createdBy: 'u', state: 'READY' },
  ],
};
function fixtures() {
  const evaluation = { ...baseTemplate('mujoco-render', 7), params: [
    { name: 'dataset_name', label: 'Dataset', type: 'string' as const, default: 'old' },
    { name: 'checkpoint_bundle', label: 'Bundle', type: 'string' as const, default: 'final' },
    { name: 'episodes', label: 'Episodes', type: 'number' as const, default: '5' },
    { name: 'eval_seed', label: 'Seed', type: 'number' as const, default: '1' },
  ], yaml: stringify({
    workflow: { name: 'mujoco-render', resources: { cpu: { cpu: 1 } }, tasks: [{
      name: 'evaluate', resource: 'cpu', image: 'test-image',
      args: ['{{input:0}}/{{ checkpoint_bundle }}', '{{ episodes }}', '{{ eval_seed }}'],
      inputs: [{ dataset: { name: '{{ dataset_name }}', version: 1 } }],
    }] },
    'default-values': { dataset_name: 'old', checkpoint_bundle: 'final', episodes: '5', eval_seed: '1' },
  }) };
  const training = { ...baseTemplate('train', 3), params: [{ name: 'hf_token_param', label: 'HF reference', type: 'string' as const, default: '/groot/unregistered' }],
    yaml: stringify({ workflow: { name: 'train', resources: { cpu: { cpu: 1 } }, tasks: [{ name: 'train', resource: 'cpu', image: 'test-image', credentials: { hf: { HF_TOKEN: '{{ hf_token_param }}' } } }] }, 'default-values': { hf_token_param: '/groot/unregistered' } }) };
  const custom = { ...baseTemplate('custom', 2), category: 'custom' as const, yaml: stringify({ workflow: { name: 'custom', resources: { cpu: { cpu: 1 } }, tasks: [{ name: 'task', resource: 'cpu', image: 'test-image', args: ['ok'] }] } }) };
  const pipeline = { ...baseTemplate('mujoco-pipeline', 8), category: 'training' as const, params: [
    { name: 'total_steps', label: 'Steps', type: 'number' as const, default: '200000' },
    { name: 'num_envs', label: 'Environments', type: 'number' as const, default: '4' },
    { name: 'episodes', label: 'Episodes', type: 'number' as const, default: '5' },
  ], yaml: stringify({ workflow: { name: 'mujoco-pipeline', tasks: [
    { name: 'train', args: ['--total-steps', '{{ total_steps }}', '--num-envs', '{{ num_envs }}'] },
    { name: 'evaluate', inputs: [{ task: 'train' }], args: ['--episodes', '{{ episodes }}'] },
  ] }, 'default-values': { total_steps: '200000', num_envs: '4', episodes: '5' } }) };
  const withDataset = { ...baseTemplate('with-dataset', 1), category: 'training' as const, params: [
    { name: 'dataset_name', label: 'Dataset', type: 'dataset' as const, default: '', versionParam: 'dataset_version' },
    { name: 'dataset_version', label: 'Dataset version', type: 'number' as const, default: '1' },
  ], yaml: stringify({ workflow: { name: 'with-dataset', resources: { cpu: { cpu: 1 } }, tasks: [{
    name: 'train', resource: 'cpu', image: 'test-image', args: ['{{ dataset_name }}', '{{ dataset_version }}'],
  }] }, 'default-values': { dataset_name: '', dataset_version: '1' } }) };
  // A `dataset` param with no `versionParam` slot: there is nowhere to persist an auto-selected
  // version, so DatasetPicker's auto-select effect must still settle after firing once instead of
  // looping forever chasing a `version` that can never become truthy (regression test target).
  const withDatasetNoVersion = { ...baseTemplate('with-dataset-no-version', 1), category: 'training' as const, params: [
    { name: 'dataset_name', label: 'Dataset', type: 'dataset' as const, default: '' },
  ], yaml: stringify({ workflow: { name: 'with-dataset-no-version', resources: { cpu: { cpu: 1 } }, tasks: [{
    name: 'train', resource: 'cpu', image: 'test-image', args: ['{{ dataset_name }}'],
  }] }, 'default-values': { dataset_name: '' } }) };
  return { evaluation, training, custom, pipeline, withDataset, withDatasetNoVersion, unpublished: { ...custom, id: 'unpublished', templateVersion: undefined } };
}

describe.skipIf(!existsSync(chromium.executablePath()))('NewWorkflowPage browser contracts', () => {
  let browser: Browser, server: Server, origin: string, bundle: string, page: Page;
  let calls: Array<{ path: string; body: Record<string, unknown>; method: string }> = [];
  let pageErrors: string[] = [];
  let latestVersion = 7;
  let preflight: { status: 'blocked' | 'needs-review'; findings: Array<{ code: string; severity: 'error' | 'warning' | 'unknown'; message: string; task?: string }> } | undefined;
  let validationOk = true;
  let submitStatus = 202;
  let submitDelayMs = 0;
  const known = fixtures();
  beforeAll(async () => {
    const result = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {QueryClient,QueryClientProvider} from '@tanstack/react-query'; import {NewWorkflowPage} from './src/components/pages/NewWorkflowPage'; const client=new QueryClient({defaultOptions:{queries:{retry:false}}}); window.fixtureClient=client; createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(NewWorkflowPage)));`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"test"' }, banner: { js: 'var process = { env: { NODE_ENV: "test" } };' }, plugins: [{ name: 'fixture-next', setup(builder) {
      builder.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({ path: args.path, namespace: 'fixture-next' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-next' }, (args) => ({ loader: 'jsx', resolveDir: process.cwd(), contents: args.path.endsWith('navigation')
        ? `export function useRouter(){return {push:(url)=>{window.fixtureDestination=url}}}; export function useSearchParams(){return new URLSearchParams(window.location.search)}`
        : `import React from 'react'; export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}` }));
    } }] });
    bundle = result.outputFiles[0].text;
    server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://fixture');
      const text: Buffer[] = []; for await (const chunk of request) text.push(Buffer.from(chunk));
      const body = text.length ? JSON.parse(Buffer.concat(text).toString()) : {};
      calls.push({ path: url.pathname + url.search, body, method: request.method! });
      const json = (value: unknown, status = 200) => { if (response.destroyed) return; response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/bundle.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(bundle); return; }
      if (!url.pathname.startsWith('/api/')) { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html lang="ko"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      if (url.pathname === '/api/me') return json({ user: 'u', role: 'researcher', defaultNamespace: 'hyperpod-ns-p', project: { id: 'p', name: 'P', role: 'researcher' }, features: {} });
      if (url.pathname === '/api/credentials') return json({ projectId: 'p', credentials: [{ name: 'My HF', kind: 'hf', scope: 'private', ref: '/physical-ai/projects/p/users/hash/hf', status: 'READY', value: 'MUST_NOT_RENDER_SECRET' }, { name: 'Unavailable', ref: '/groot/broken', status: 'ERROR' }] });
      if (url.pathname === '/api/queues') return json({ priorityClasses: [{ name: 'high' }] });
      if (url.pathname === '/api/models/mdl-one') return json({ canWrite: true, model: { id: 'mdl-one', source: { dataset: { name: 'trained', version: 12 } }, bundle: { path: 'final' }, evaluationLaunch: { template: 'mujoco-render' } } });
      if (url.pathname === '/api/templates') return json([
        { ...known.evaluation, templateVersion: latestVersion, recipe: null }, { ...known.training, recipe: null }, { ...known.custom, recipe: null },
        { ...known.pipeline, recipe: null }, { ...known.unpublished, recipe: null },
        { ...known.withDataset, recipe: { revision: 'r1', readiness: 'cpu-validated', verification: 'local-docker', prerequisites: [], sources: [], artifacts: [], imageContract: 'test',
          ports: { inputs: [{ param: 'dataset_name', kind: 'lerobot-dataset', label: 'Training dataset', versionParam: 'dataset_version' }], outputs: [] } } },
        { ...known.withDatasetNoVersion, recipe: null },
      ]);
      const match = /^\/api\/templates\/([^/]+)(\/versions)?$/.exec(url.pathname);
      if (match) {
        const template = Object.values(known).find((item) => item.id === match[1]);
        if (!template) return json({ error: 'missing' }, 404);
        if (match[2]) return json([template]);
        return json(template);
      }
      if (url.pathname === '/api/datasets') return json(datasets);
      const datasetMatch = /^\/api\/datasets\/([^/]+)$/.exec(url.pathname);
      if (datasetMatch) {
        const dataset = datasets.find((item) => item.name === datasetMatch[1]);
        if (!dataset) return json({ error: 'missing' }, 404);
        return json({ dataset, versions: versionsByDataset[datasetMatch[1]] ?? [] });
      }
      if (url.pathname === '/api/workflows/validate') {
        const invalid = String(body.yaml).includes('--invalid');
        const result = invalid ? { ok: false, error: 'fixture invalid' } : { ok: validationOk, tasks: [], order: ['task'], preflight };
        setTimeout(() => json(result), invalid ? 650 : 15);
        return;
      }
      if (url.pathname === '/api/workflows' && request.method === 'POST') {
        const respond = () => submitStatus === 428
          ? json({ error: '사전 점검을 다시 확인하세요.', code: 'image_preflight_review' }, 428)
          : json({ runId: 'submitted' }, submitStatus);
        if (submitDelayMs > 0) { setTimeout(respond, submitDelayMs); return; }
        return respond();
      }
      return json({ error: 'missing fixture API' }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30000);
  beforeEach(async () => { calls = []; pageErrors = []; latestVersion = 7; preflight = undefined; validationOk = true; submitStatus = 202; submitDelayMs = 0; page = await browser.newPage(); page.on('pageerror', (error) => pageErrors.push(error.message)); });
  afterEach(async () => { await page.close(); expect(pageErrors).toEqual([]); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });
  const step = async (index: number) => page.getByRole('navigation', { name: '워크플로 작성 단계' }).getByRole('button').nth(index).click();

  it('requires explicit preflight review and resets it after parameter, raw YAML, and inspection changes', async () => {
    preflight = { status: 'needs-review', findings: [{ code: 'driver_unknown', severity: 'unknown', task: 'train', message: '드라이버 호환성을 확인하세요.' }] };
    await page.goto(origin + '/workflows/new?template=mujoco-pipeline&preset=cpu-quick');
    await page.getByLabel('학습 step 수').waitFor(); await step(2);
    await page.getByText('드라이버 호환성을 확인하세요.', { exact: true }).waitFor({ timeout: 3000 });
    const submit = page.getByRole('button', { name: '워크플로 실행', exact: true });
    const acknowledgement = page.getByRole('checkbox', { name: /사전 점검 결과/ });
    expect(await page.getByText('driver_unknown', { exact: true }).count()).toBe(1);
    expect(await acknowledgement.isChecked()).toBe(false);
    expect(await submit.isDisabled()).toBe(true);
    expect(calls.filter(call => call.path === '/api/workflows')).toHaveLength(0);
    await acknowledgement.check();
    expect(await submit.isEnabled()).toBe(true);
    await step(1); await page.getByLabel('학습 step 수').fill('1024'); await step(2);
    expect(await submit.isDisabled()).toBe(true);
    await acknowledgement.waitFor();
    expect(await acknowledgement.isChecked()).toBe(false);
    await acknowledgement.check();
    const editor = page.getByLabel('워크플로 YAML');
    await editor.fill((await editor.inputValue()) + '\n# reviewed source changed\n');
    expect(await submit.isDisabled()).toBe(true);
    await acknowledgement.waitFor();
    expect(await acknowledgement.isChecked()).toBe(false);
    await acknowledgement.check();
    // The same YAML gets different findings on a fresh inspection.
    preflight = { status: 'needs-review', findings: [{ code: 'capacity_unknown', severity: 'warning', task: 'train', message: '현재 CPU 용량을 확인하세요.' }] };
    await page.getByRole('button', { name: '사전 점검 다시 확인', exact: true }).click();
    expect(await submit.isDisabled()).toBe(true);
    await page.getByText('현재 CPU 용량을 확인하세요.', { exact: true }).waitFor();
    expect(await acknowledgement.isChecked()).toBe(false);
    await acknowledgement.check(); await acknowledgement.uncheck();
    expect(await submit.isDisabled()).toBe(true);
    await acknowledgement.check(); await submit.click();
    await page.waitForFunction(() => (window as unknown as { fixtureDestination: string }).fixtureDestination === '/workflows/submitted');
    const payload = calls.find(call => call.path === '/api/workflows' && call.method === 'POST')!.body;
    expect(payload.acknowledgePreflight).toBe(true);
    expect(payload.templateVersion).toBe(8);
    expect(parse(String(payload.yaml)).workflow.tasks[0].args).toContain('1024');
  }, 15000);

  it.each([false, true])('never permits a blocked image preflight, even when validation ok=%s', async (ok) => {
    validationOk = ok;
    preflight = { status: 'blocked', findings: [{ code: 'image_unapproved', severity: 'error', task: 'task', message: '이 실행 이미지는 승인되지 않았습니다.' }] };
    await page.goto(origin + '/workflows/new?template=custom');
    await page.getByLabel('레시피 버전').waitFor(); await step(2);
    await page.getByText('이 실행 이미지는 승인되지 않았습니다.', { exact: true }).waitFor({ timeout: 3000 });
    expect(await page.getByText('image_unapproved', { exact: true }).count()).toBe(1);
    expect(await page.getByRole('checkbox', { name: /사전 점검 결과/ }).count()).toBe(0);
    expect(await page.getByRole('button', { name: '워크플로 실행', exact: true }).isDisabled()).toBe(true);
    expect(calls.filter(call => call.path === '/api/workflows')).toHaveLength(0);
  }, 10000);

  it('clears consent and fetches a new inspection after HTTP 428 without silently resubmitting', async () => {
    preflight = { status: 'needs-review', findings: [] };
    submitStatus = 428;
    await page.goto(origin + '/workflows/new?template=custom');
    await page.getByLabel('레시피 버전').waitFor(); await step(2);
    const acknowledgement = page.getByRole('checkbox', { name: /사전 점검 결과/ });
    await acknowledgement.waitFor({ timeout: 3000 });
    const submit = page.getByRole('button', { name: '워크플로 실행', exact: true });
    expect(await submit.isDisabled()).toBe(true);
    await acknowledgement.check();
    preflight = { status: 'needs-review', findings: [{ code: 'model_access_unknown', severity: 'unknown', message: '모델 접근 권한을 확인하세요.' }] };
    await submit.click();
    await page.getByText('사전 점검을 다시 확인하세요.', { exact: true }).waitFor();
    await page.getByText('모델 접근 권한을 확인하세요.', { exact: true }).waitFor({ timeout: 3000 });
    expect(await acknowledgement.isChecked()).toBe(false);
    expect(await submit.isDisabled()).toBe(true);
    expect(calls.filter(call => call.path === '/api/workflows')).toHaveLength(1);
    expect(await page.evaluate(() => (window as unknown as { fixtureDestination?: string }).fixtureDestination)).toBeUndefined();
  }, 10000);

  it('opens the explicit CPU quick preset and submits its real values only after review', async () => {
    await page.goto(origin + '/workflows/new');
    await page.getByRole('link', { name: 'CPU 학습 → 평가 시작', exact: true }).click();
    await page.getByLabel('학습 step 수').waitFor();
    expect(await page.getByLabel('학습 step 수').inputValue()).toBe('512');
    expect(await page.getByLabel('병렬 환경 수').inputValue()).toBe('1');
    expect(await page.getByLabel('평가 에피소드 수').inputValue()).toBe('20');
    expect(calls.filter(call => call.path === '/api/workflows').length).toBe(0);
    await step(2);
    const editor = page.getByLabel('워크플로 YAML');
    const source = parse(await editor.inputValue()); source.workflow.tasks[0].args.push('--expert-edit');
    await editor.fill(stringify(source));
    await page.getByRole('button', { name: '워크플로 실행', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { fixtureDestination: string }).fixtureDestination === '/workflows/submitted');
    const payload = calls.find(call => call.path === '/api/workflows' && call.method === 'POST')!.body;
    expect(payload.templateId).toBe('mujoco-pipeline'); expect(payload.templateVersion).toBe(8);
    const submitted = parse(String(payload.yaml));
    expect(submitted.workflow.tasks[0].args).toEqual(['--total-steps', '512', '--num-envs', '1', '--expert-edit']);
    expect(submitted.workflow.tasks[1].args).toEqual(['--episodes', '20']);
  }, 15000);

  it('pins the real evaluation input and keeps manual YAML edits across catalog refresh', async () => {
    await page.goto(origin + '/workflows/new?template=mujoco-render&model_id=mdl-one&dataset_name=trained&dataset_version=12&checkpoint_bundle=final&episodes=20&eval_seed=2042');
    await page.getByLabel('입력 데이터셋').waitFor();
    expect(await page.getByLabel('입력 데이터셋').inputValue()).toBe('trained');
    expect(await page.getByLabel('평가 에피소드 수').inputValue()).toBe('20');
    await step(0);
    await page.getByRole('button', { name: 'YAML 직접 입력', exact: true }).click();
    const editor = page.getByLabel('워크플로 YAML');
    const document = parse(await editor.inputValue()); document.workflow.tasks[0].args.push('--manual-override');
    await editor.fill(stringify(document));
    latestVersion = 8;
    await page.evaluate(() => (window as unknown as { fixtureClient: { invalidateQueries(input: unknown): Promise<void> } }).fixtureClient.invalidateQueries({ queryKey: ['api', '/api/templates'] }));
    expect(await editor.inputValue()).toContain('--manual-override');
    await page.getByRole('button', { name: '워크플로 실행', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { fixtureDestination: string }).fixtureDestination === '/workflows/submitted');
    const submitted = calls.find((call) => call.path === '/api/workflows' && call.method === 'POST')!.body;
    expect(submitted.templateVersion).toBe(7);
    const spec = parse(String(submitted.yaml));
    expect(spec.workflow.tasks[0].inputs[0].dataset).toEqual({ name: 'trained', version: 12 });
    expect(spec.workflow.tasks[0].args).toContain('--manual-override');
    expect(calls.some((call) => call.path === '/api/templates/mujoco-render?version=7')).toBe(true);
  }, 15000);

  it('requires an explicit registered credential and never renders API value fields', async () => {
    await page.goto(origin + '/workflows/new?template=train');
    const picker = page.getByLabel('train · HF_TOKEN'); await picker.waitFor();
    expect(await picker.inputValue()).toBe('');
    expect(await page.content()).not.toContain('MUST_NOT_RENDER_SECRET');
    expect(await picker.locator('option').allTextContents()).not.toContain('Unavailable');
    await step(2); expect(await page.getByRole('button', { name: '워크플로 실행', exact: true }).isDisabled()).toBe(true);
    await step(1); await picker.selectOption('/physical-ai/projects/p/users/hash/hf'); await step(2);
    await page.getByRole('button', { name: '워크플로 실행', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { fixtureDestination: string }).fixtureDestination === '/workflows/submitted');
    const payload = calls.find((call) => call.path === '/api/workflows' && call.method === 'POST')!.body;
    expect(parse(String(payload.yaml)).workflow.tasks[0].credentials.hf.HF_TOKEN).toBe('/physical-ai/projects/p/users/hash/hf');
    expect(JSON.stringify(payload)).not.toContain('MUST_NOT_RENDER_SECRET');
  }, 15000);

  it('invalidates an old validation immediately and ignores an obsolete validation response', async () => {
    await page.goto(origin + '/workflows/new?template=custom');
    await page.getByLabel('레시피 버전').waitFor(); await step(2);
    const editor = page.getByLabel('워크플로 YAML');
    await page.getByText('구성 검증 통과', { exact: false }).waitFor();
    const source = parse(await editor.inputValue()); source.workflow.tasks[0].args = ['--invalid']; await editor.fill(stringify(source));
    expect(await page.getByRole('button', { name: '워크플로 실행', exact: true }).isDisabled()).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 450));
    source.workflow.tasks[0].args = ['--new']; await editor.fill(stringify(source));
    await page.getByText('구성 검증 통과', { exact: false }).waitFor();
    await new Promise<void>((resolve) => setTimeout(resolve, 700));
    expect(await page.getByText('fixture invalid', { exact: true }).count()).toBe(0);
    expect(await page.getByRole('button', { name: '워크플로 실행', exact: true }).isEnabled()).toBe(true);
  }, 15000);

  it('does not invent a template version when the revision API has no version', async () => {
    await page.goto(origin + '/workflows/new?template=unpublished');
    await page.getByText('게시된 레시피 버전이 확인되지 않았습니다.', { exact: false }).waitFor();
    await step(2);
    expect(await page.getByRole('button', { name: '워크플로 실행', exact: true }).isDisabled()).toBe(true);
    expect(calls.filter((call) => call.path === '/api/workflows').length).toBe(0);
  }, 10000);

  it('shows the dataset picker for a dataset-typed param, hides its raw version field, and writes both name and version into the YAML defaults', async () => {
    await page.goto(origin + '/workflows/new?template=with-dataset');
    // A selected template already opens on step 2 (inputs); no nav click needed to see the param fields.
    const picker = page.getByLabel('입력 데이터셋'); await picker.waitFor();
    await picker.selectOption('demo-set');
    // The picker's own version select is scoped to avoid an accessible-name clash with "레시피 버전".
    const pickerContainer = page.locator('div.space-y-3', { has: page.getByLabel('입력 데이터셋') });
    const versionSelect = pickerContainer.getByLabel('버전');
    await versionSelect.waitFor();
    expect(await versionSelect.locator('option').allTextContents()).toEqual(['선택', 'v3', 'v2']);
    // The versionParam companion is edited only through the picker, not as a separate raw field.
    expect(await page.getByLabel('Dataset version').count()).toBe(0);
    await versionSelect.selectOption('3');
    await step(2);
    const editor = page.getByLabel('워크플로 YAML');
    const source = parse(await editor.inputValue());
    expect(source['default-values'].dataset_name).toBe('demo-set');
    expect(String(source['default-values'].dataset_version)).toBe('3');
    expect(calls.some((call) => call.path === '/api/datasets/demo-set')).toBe(true);
  }, 15000);

  it('settles without looping when a dataset param has no versionParam to persist the auto-picked version', async () => {
    // Regression for DatasetPicker's auto-select effect looping ("Maximum update depth exceeded")
    // when there is nowhere to write the version back to, so `version` can never become truthy.
    await page.goto(origin + '/workflows/new?template=with-dataset-no-version');
    const picker = page.getByLabel('입력 데이터셋'); await picker.waitFor();
    await picker.selectOption('demo-set');
    await page.waitForTimeout(300);
    // afterEach also asserts pageErrors is empty; a looping effect throws before we get here.
    expect(pageErrors).toEqual([]);
    expect(await picker.inputValue()).toBe('demo-set');
    await step(2);
    const editor = page.getByLabel('워크플로 YAML');
    const source = parse(await editor.inputValue());
    expect(source['default-values'].dataset_name).toBe('demo-set');
  }, 15000);

  it('disables param fields while a submit is pending', async () => {
    submitDelayMs = 600;
    await page.goto(origin + '/workflows/new?template=mujoco-pipeline&preset=cpu-quick');
    // Params (step 2/"inputs") and the submit button (step 3/"yaml") are mutually exclusive panels
    // driven by the same `busy` flag, so we click submit on step 3, then flip back to step 2 while
    // the request is still pending to observe the param control's disabled state.
    const stepsField = page.getByLabel('학습 step 수');
    await stepsField.waitFor();
    expect(await stepsField.isDisabled()).toBe(false);
    await step(2);
    const submit = page.getByRole('button', { name: '워크플로 실행', exact: true });
    await expect.poll(() => submit.isEnabled()).toBe(true);
    await submit.click();
    await step(1);
    await expect.poll(() => stepsField.isDisabled()).toBe(true);
    await page.waitForFunction(() => (window as unknown as { fixtureDestination: string }).fixtureDestination === '/workflows/submitted');
  }, 15000);

  it('loads a composed draft from session storage, opens on step 2, and submits raw YAML with no templateId', async () => {
    const draftYaml = stringify({
      workflow: { name: 'composed-demo', resources: { cpu: { cpu: 1 } }, tasks: [{ name: 't', resource: 'cpu', image: 'test-image', args: ['--composed'] }] },
      'default-values': { note: 'hi' },
      ui: { recipe: { revision: 'composed', readiness: 'cpu-validated', verification: 'local-docker', prerequisites: [], sources: [], artifacts: [], imageContract: '', ports: { inputs: [], outputs: [] } } },
    });
    // sessionStorage is origin-scoped: seed it after loading the origin once, then navigate with ?draft=1.
    await page.goto(origin + '/workflows/new');
    await page.evaluate((d) => sessionStorage.setItem('pai-compose-draft', d), JSON.stringify({ yaml: draftYaml, params: [{ name: 'note', label: 'Composed note', type: 'string', default: 'hi' }], title: 'Composed demo' }));
    await page.goto(origin + '/workflows/new?draft=1');

    // Opens on step 2 (inputs) with the composed template's own param rendered.
    const stepButtons = page.getByRole('navigation', { name: '워크플로 작성 단계' }).getByRole('button');
    await expect.poll(() => stepButtons.nth(1).getAttribute('aria-current')).toBe('step');
    const noteField = page.getByLabel('Composed note');
    await noteField.waitFor();
    expect(await noteField.inputValue()).toBe('hi');
    // The hand-off is consumed exactly once.
    expect(await page.evaluate(() => sessionStorage.getItem('pai-compose-draft'))).toBeNull();

    // A composed run submits the self-contained YAML with no templateId (there is no server recipe).
    await step(2);
    await page.getByText('구성 검증 통과', { exact: false }).waitFor();
    await page.getByRole('button', { name: '워크플로 실행', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { fixtureDestination: string }).fixtureDestination === '/workflows/submitted');
    const payload = calls.find((call) => call.path === '/api/workflows' && call.method === 'POST')!.body;
    expect(payload.templateId).toBeUndefined();
    expect(payload.templateVersion).toBeUndefined();
    expect(parse(String(payload.yaml)).workflow.tasks[0].args).toContain('--composed');
  }, 15000);

  it('renders the DatasetPicker for an unbound dataset param carried by a composed draft', async () => {
    // A composed pipeline whose only recipe still has an unbound `dataset` input surfaces it as a
    // `type:'dataset'` composite param; the wizard must render the DatasetPicker (not a raw text field).
    const draftYaml = stringify({
      workflow: { name: 'composed-ds', resources: { cpu: { cpu: 1 } }, tasks: [{ name: 't', resource: 'cpu', image: 'test-image', args: ['{{ dataset_name }}', '{{ dataset_version }}'] }] },
      'default-values': { dataset_name: '', dataset_version: '1' },
      ui: { recipe: { revision: 'composed', readiness: 'cpu-validated', verification: 'local-docker', prerequisites: [], sources: [], artifacts: [], imageContract: '', ports: { inputs: [{ param: 'dataset_name', kind: 'lerobot-dataset', label: 'Dataset', versionParam: 'dataset_version' }], outputs: [] } } },
    });
    await page.goto(origin + '/workflows/new');
    await page.evaluate((d) => sessionStorage.setItem('pai-compose-draft', d), JSON.stringify({
      yaml: draftYaml,
      params: [
        { name: 'dataset_name', label: 'Composed dataset', type: 'dataset', default: '', versionParam: 'dataset_version' },
        { name: 'dataset_version', label: 'Dataset version', type: 'number', default: '1' },
      ],
      title: 'Composed dataset draft',
    }));
    await page.goto(origin + '/workflows/new?draft=1');

    // The DatasetPicker renders for the dataset param; its versionParam companion is not a separate raw field.
    const picker = page.getByLabel('입력 데이터셋'); await picker.waitFor();
    expect(await page.getByLabel('Dataset version').count()).toBe(0);
    await picker.selectOption('demo-set');
    const pickerContainer = page.locator('div.space-y-3', { has: page.getByLabel('입력 데이터셋') });
    const versionSelect = pickerContainer.getByLabel('버전');
    await versionSelect.waitFor();
    await versionSelect.selectOption('3');
    // The picked dataset name and version flow into the composed YAML defaults.
    await step(2);
    const source = parse(await page.getByLabel('워크플로 YAML').inputValue());
    expect(source['default-values'].dataset_name).toBe('demo-set');
    expect(String(source['default-values'].dataset_version)).toBe('3');
  }, 15000);
});
