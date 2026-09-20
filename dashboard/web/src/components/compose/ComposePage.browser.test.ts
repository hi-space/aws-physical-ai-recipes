/** Browser contract tests use only an in-memory local API fixture serving real builtin recipes. No cloud calls. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { parse } from 'yaml';
import { BUILTIN_TEMPLATES, getRecipeMetadata } from '@/server/workflow/builtin-templates';
import { parseWorkflowYaml } from '@/server/workflow/template';
import type { TemplateDto } from '@/lib/workflow/template-dto';

/** Genuine builtin DTOs (real ports/params) so the composed YAML round-trips through the real parser. */
function templateDtos(): TemplateDto[] {
  return ['hf-dataset-import', 'gr00t-finetune', 'leisaac-evaluate'].map((id) => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === id);
    if (!t) throw new Error(`missing builtin ${id}`);
    return { ...t, recipe: getRecipeMetadata(t) };
  });
}

// The test-only hook (window.__composeTest) exposes the unchanged production onConnect/onConnectEnd handlers
// and the live node list so both an accepted connection and a *rejected drag* can be driven through real
// validation without a flaky React Flow handle drag. `connectEnd` exercises the same handler React Flow
// calls when its isValidConnection gate blocks a drag (the only path that can surface the reject toast).
type ComposeConnection = { source: string; sourceHandle: string; target: string; targetHandle: string };
interface ComposeTestApi {
  connect: (c: ComposeConnection) => void;
  connectEnd: (c: ComposeConnection) => void;
  nodes: () => { id: string; templateId: string; title: string }[];
  datasets: () => { id: string; name: string }[];
}

const GROOT_IMAGE = '123456789012.dkr.ecr.us-east-1.amazonaws.com/groot:v1';

describe.skipIf(!existsSync(chromium.executablePath()))('ComposePage browser contracts', () => {
  let browser: Browser, server: Server, origin: string, bundle: string, css: string, page: Page;
  let calls: Array<{ path: string; body: Record<string, unknown>; method: string }> = [];
  let pageErrors: string[] = [];
  const templates = templateDtos();

  beforeAll(async () => {
    const result = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {ComposePage} from './src/components/compose/ComposePage';
          const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
          createRoot(document.getElementById('root')).render(
            React.createElement(QueryClientProvider,{client},
              React.createElement('div',{style:{width:1280,height:800}}, React.createElement(ComposePage))));`,
        resolveDir: process.cwd(), loader: 'tsx',
      },
      bundle: true, write: false, platform: 'browser', format: 'iife', outdir: 'out',
      define: { 'process.env.NODE_ENV': '"test"' }, banner: { js: 'var process = { env: { NODE_ENV: "test" } };' },
      plugins: [{ name: 'fixture-next', setup(builder) {
        builder.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({ path: args.path, namespace: 'fixture-next' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture-next' }, (args) => ({ loader: 'jsx', resolveDir: process.cwd(), contents: args.path.endsWith('navigation')
          ? `export function useRouter(){return {push:(url)=>{window.fixtureDestination=url}}}; export function useSearchParams(){return new URLSearchParams(window.location.search)}`
          : `import React from 'react'; export default function Link({href,children,prefetch,...props}){return <a href={href} {...props}>{children}</a>}` }));
      } }],
    });
    bundle = result.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
    const flowCss = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
    const globals = 'src/app/globals.css';
    const theme = await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync(globals, 'utf8'), { from: globals });
    css = `${theme.css}\n${flowCss}`;

    server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://fixture');
      const text: Buffer[] = []; for await (const chunk of request) text.push(Buffer.from(chunk));
      const body = text.length ? JSON.parse(Buffer.concat(text).toString()) : {};
      calls.push({ path: url.pathname + url.search, body, method: request.method! });
      const json = (value: unknown, status = 200) => { if (response.destroyed) return; response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/bundle.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(bundle); return; }
      if (url.pathname === '/bundle.css') { response.writeHead(200, { 'content-type': 'text/css' }); response.end(css); return; }
      if (!url.pathname.startsWith('/api/')) { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html lang="ko"><head><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      if (url.pathname === '/api/templates' && request.method !== 'POST') return json(templates);
      if (url.pathname === '/api/datasets') return json([]);
      // One approved profile seeded from GROOT_RUNTIME_IMAGE_URI; the test environment leaves that variable unset,
      // so gr00t-finetune's image param defaults to `required://GROOT_RUNTIME_IMAGE_URI` and must resolve through it.
      if (url.pathname === '/api/image-profiles') return json({ project: { id: 'p', name: 'P' }, capabilities: { canApprove: false, canSeed: false }, profiles: [{
        id: 'builtin-groot', name: 'groot deployment image', version: 1, projectId: 'p', approved: true, enabled: true, source: 'deployment-env', createdBy: 'admin', createdAt: '2026-01-01T00:00:00Z', contentHash: 'h',
        requirements: { minCpu: 1, minMemoryMiB: 1024, minGpu: 1, minGpuMemoryMiB: 0, platforms: [] },
        image: { requestedImage: GROOT_IMAGE, resolvedImage: `${GROOT_IMAGE.split(':')[0]}@sha256:${'0'.repeat(64)}`, digest: `sha256:${'0'.repeat(64)}`, repository: 'groot', architectures: ['amd64'], manifests: [], inspectedAt: '2026-01-01T00:00:00Z', source: 'ecr-manifest-config' },
      }] });
      if (url.pathname === '/api/workflows/validate') { const invalid = String(body.yaml).includes('--invalid'); setTimeout(() => json({ ok: !invalid, ...(invalid ? { error: 'fixture invalid' } : { tasks: [], order: [] }) }), 15); return; }
      if (url.pathname === '/api/templates' && request.method === 'POST') return json({ ...body, templateVersion: 1 }, 201);
      return json({ error: 'missing fixture API' }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 60000);

  beforeEach(async () => { calls = []; pageErrors = []; page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then((c) => c.newPage()); page.setDefaultTimeout(6000); page.on('pageerror', (error) => pageErrors.push(error.message)); });
  afterEach(async () => { await page.context().close(); expect(pageErrors).toEqual([]); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

  const addNode = async (id: string) => page.getByTestId(`palette-item-${id}`).click();
  const idOf = (nodes: { id: string; templateId: string }[], templateId: string) => nodes.find((n) => n.templateId === templateId)!.id;
  const nodeList = () => page.evaluate(() => (window as unknown as { __composeTest: ComposeTestApi }).__composeTest.nodes());
  const connect = (c: ComposeConnection) => page.evaluate((conn) => (window as unknown as { __composeTest: ComposeTestApi }).__composeTest.connect(conn), c);
  const connectEnd = (c: ComposeConnection) => page.evaluate((conn) => (window as unknown as { __composeTest: ComposeTestApi }).__composeTest.connectEnd(conn), c);

  // Real React Flow handle drag: mouse from one handle's centre to another. Handles carry data-nodeid /
  // data-handleid, so the drop target is a genuine DOM element under the release point — this exercises the
  // isValidConnection gate + onConnectEnd path a headless synthetic hook cannot, which is where Defect 1 hid.
  const handleCentre = async (nodeId: string, handleId: string) => {
    const locator = page.locator(`.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${handleId}"]`);
    await locator.waitFor();
    const box = await locator.boundingBox();
    if (!box) throw new Error(`handle ${nodeId}/${handleId} not visible`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const realDragTo = async (from: { nodeId: string; handleId: string }, to: { x: number; y: number }) => {
    const a = await handleCentre(from.nodeId, from.handleId);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + to.x) / 2, (a.y + to.y) / 2, { steps: 8 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  };
  const realDrag = async (from: { nodeId: string; handleId: string }, to: { nodeId: string; handleId: string }) =>
    realDragTo(from, await handleCentre(to.nodeId, to.handleId));
  const kindMismatch = () => page.getByText('포트 종류가 일치하지 않습니다.');

  it('adds recipes from the palette, connects matching kinds, locks the bound input, and validates', async () => {
    await page.goto(origin);
    await addNode('hf-dataset-import');
    await addNode('gr00t-finetune');
    const nodes = await nodeList();
    expect(nodes).toHaveLength(2);

    await connect({ source: idOf(nodes, 'hf-dataset-import'), sourceHandle: 'hf-import', target: idOf(nodes, 'gr00t-finetune'), targetHandle: 'dataset_name' });

    // The gr00t node stays selected (added last); its dataset input is now edge-bound and read-only.
    await page.getByText('업스트림 연결에서 제공됩니다.').first().waitFor();
    await page.getByText(/← .+ 출력/).first().waitFor();
    // No toast means the matching connection was accepted.
    expect(await page.getByText('포트 종류가 일치하지 않습니다.').count()).toBe(0);

    // Server validation of the composed YAML enables the actions.
    await expect.poll(() => page.getByRole('button', { name: '실행', exact: true }).isEnabled()).toBe(true);
    await page.getByText('서버 검증을 통과했습니다.').waitFor();

    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/compose-page.png' });
  }, 30000);

  it('rejects a kind-mismatched connection with a toast reason', async () => {
    await page.goto(origin);
    await addNode('hf-dataset-import');
    await addNode('leisaac-evaluate');
    const nodes = await nodeList();

    // lerobot-dataset output → checkpoint input. In production the isValidConnection gate blocks the drag
    // before onConnect, so the toast can only come from onConnectEnd. The hook drives that handler with
    // `toHandle: null` (React Flow's closest-handle snap missed, as on the live site) so the reason must be
    // recovered from the pointer position over the target handle — the exact path Defect 1 fixed.
    await connectEnd({ source: idOf(nodes, 'hf-dataset-import'), sourceHandle: 'hf-import', target: idOf(nodes, 'leisaac-evaluate'), targetHandle: 'dataset_name' });
    await page.getByText('포트 종류가 일치하지 않습니다.').waitFor();
    // No edge was created: the rejected input is still editable (not bound).
    expect(await page.getByText('업스트림 연결에서 제공됩니다.').count()).toBe(0);
  }, 30000);

  it('toasts the reason for a real kind-mismatched drag, but stays silent for a valid drop or empty canvas', async () => {
    await page.goto(origin);
    await addNode('hf-dataset-import');
    await addNode('leisaac-evaluate');
    const nodes = await nodeList();
    const hf = idOf(nodes, 'hf-dataset-import');
    const leisaac = idOf(nodes, 'leisaac-evaluate');

    // 1) Empty canvas: dragging the output into open space must NOT toast (no target handle).
    const canvas = await page.getByTestId('compose-canvas').boundingBox();
    if (!canvas) throw new Error('canvas not visible');
    await realDragTo({ nodeId: hf, handleId: 'hf-import' }, { x: canvas.x + canvas.width * 0.5, y: canvas.y + canvas.height - 24 });
    await page.waitForTimeout(400);
    expect(await kindMismatch().count()).toBe(0);

    // 2) Kind mismatch: lerobot-dataset output → checkpoint input. React Flow's gate blocks the edge; the
    //    reason must surface as a toast even though `connectionState.toHandle` may be null on a real drop.
    await realDrag({ nodeId: hf, handleId: 'hf-import' }, { nodeId: leisaac, handleId: 'dataset_name' });
    await kindMismatch().waitFor();
    // No edge was created: the rejected input is still editable (not bound).
    expect(await page.getByText('업스트림 연결에서 제공됩니다.').count()).toBe(0);
  }, 30000);

  it('accepts a real matching drag with no toast and binds the input', async () => {
    await page.goto(origin);
    await addNode('hf-dataset-import');
    await addNode('gr00t-finetune');
    const nodes = await nodeList();

    await realDrag(
      { nodeId: idOf(nodes, 'hf-dataset-import'), handleId: 'hf-import' },
      { nodeId: idOf(nodes, 'gr00t-finetune'), handleId: 'dataset_name' },
    );

    // A valid connection binds the input (read-only) and shows no rejection toast.
    await page.getByText('업스트림 연결에서 제공됩니다.').first().waitFor();
    expect(await kindMismatch().count()).toBe(0);
  }, 30000);

  it('saves the composed pipeline as a custom recipe with a YAML the real parser accepts', async () => {
    await page.goto(origin);
    await addNode('hf-dataset-import');
    await addNode('gr00t-finetune');
    const nodes = await nodeList();
    await connect({ source: idOf(nodes, 'hf-dataset-import'), sourceHandle: 'hf-import', target: idOf(nodes, 'gr00t-finetune'), targetHandle: 'dataset_name' });

    const saveButton = page.getByRole('button', { name: '레시피로 저장', exact: true });
    await expect.poll(() => saveButton.isEnabled()).toBe(true);
    await saveButton.click();
    await page.getByLabel('이름', { exact: true }).fill('My composed pipeline');
    await page.getByRole('button', { name: '저장', exact: true }).click();

    await expect.poll(() => calls.some((c) => c.path === '/api/templates' && c.method === 'POST')).toBe(true);
    const saved = calls.find((c) => c.path === '/api/templates' && c.method === 'POST')!.body;
    expect(saved.category).toBe('custom');
    expect(saved.title).toBe('My composed pipeline');
    expect(() => parseWorkflowYaml(String(saved.yaml), {})).not.toThrow();
    const spec = parseWorkflowYaml(String(saved.yaml), {}).spec;
    // The edge rewrote a dataset input into a task dependency.
    expect(spec.workflow.tasks.some((t) => (t.inputs ?? []).some((i) => typeof (i as { task?: string }).task === 'string'))).toBe(true);
  }, 30000);

  it('carries an inspector param edit into the saved recipe and the run draft', async () => {
    await page.goto(origin);
    await addNode('gr00t-finetune');

    // Edit a param in the inspector (the node is auto-selected on add).
    const field = page.getByLabel('사용 권한이 있는 기본 모델');
    await field.waitFor();
    await field.fill('my-org/custom-model');

    const saveButton = page.getByRole('button', { name: '레시피로 저장', exact: true });
    await expect.poll(() => saveButton.isEnabled()).toBe(true);

    // Save → the edited value must ride in the POST body's YAML default-values and params[].default.
    await saveButton.click();
    await page.getByLabel('이름', { exact: true }).fill('Edited recipe');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect.poll(() => calls.some((c) => c.path === '/api/templates' && c.method === 'POST')).toBe(true);
    const saved = calls.find((c) => c.path === '/api/templates' && c.method === 'POST')!.body;
    const savedDefaults = (parse(String(saved.yaml)) as { 'default-values': Record<string, unknown> })['default-values'];
    const baseKey = Object.keys(savedDefaults).find((k) => k.endsWith('_base_model'))!;
    expect(savedDefaults[baseKey]).toBe('my-org/custom-model');
    const savedParams = saved.params as Array<{ name: string; default?: string }>;
    expect(savedParams.find((p) => p.name.endsWith('_base_model'))?.default).toBe('my-org/custom-model');

    // Run → the compose draft handed to the wizard carries the same edit in its YAML default-values.
    await page.getByRole('button', { name: '실행', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { fixtureDestination?: string }).fixtureDestination === '/workflows/new?draft=1');
    const draft = JSON.parse((await page.evaluate(() => sessionStorage.getItem('pai-compose-draft')))!) as { yaml: string; params: Array<{ name: string; default?: string }> };
    const draftDefaults = (parse(draft.yaml) as { 'default-values': Record<string, unknown> })['default-values'];
    expect(draftDefaults[Object.keys(draftDefaults).find((k) => k.endsWith('_base_model'))!]).toBe('my-org/custom-model');
    expect(draft.params.find((p) => p.name.endsWith('_base_model'))?.default).toBe('my-org/custom-model');
  }, 30000);

  it('shows port kinds on the palette, the legend and the nodes, and highlights compatible handles mid-drag', async () => {
    await page.goto(origin);

    // Palette: every block states what it takes and gives, using the kind names from the legend.
    const finetuneItem = page.getByTestId('palette-item-gr00t-finetune');
    await finetuneItem.getByTestId('palette-ports').waitFor();
    await expect.poll(() => finetuneItem.getByTestId('palette-ports').innerText()).toMatch(/받음\s*LeRobot 데이터셋/);
    await expect.poll(() => finetuneItem.getByTestId('palette-ports').innerText()).toMatch(/내보냄\s*체크포인트/);
    await expect.poll(() => page.getByTestId('palette-item-hf-dataset-import').getByTestId('palette-ports').innerText()).toMatch(/받음\s*없음 · 시작 블록/);
    // Legend on the canvas lists every kind.
    const legend = page.getByTestId('port-legend');
    await legend.waitFor();
    for (const label of ['LeRobot 데이터셋', '체크포인트', '비디오', 'SDG 프레임', 'HDF5 데모', '아티팩트']) expect(await legend.getByText(label, { exact: true }).count()).toBe(1);

    await addNode('hf-dataset-import');
    await addNode('gr00t-finetune');
    await addNode('leisaac-evaluate');
    const nodes = await nodeList();
    const hf = idOf(nodes, 'hf-dataset-import');
    const groot = idOf(nodes, 'gr00t-finetune');
    const leisaac = idOf(nodes, 'leisaac-evaluate');

    // Node captions carry the kind under each port label.
    const grootNode = page.locator(`.react-flow__node[data-id="${groot}"]`);
    await expect.poll(() => grootNode.innerText()).toMatch(/Training dataset\s*LeRobot 데이터셋/);
    await expect.poll(() => grootNode.innerText()).toMatch(/Fine-tuned checkpoint\s*체크포인트/);

    // Start a real drag from the lerobot-dataset output and hold it: the matching input lights up, the
    // checkpoint input (and its whole node) fades, and the origin node stays neutral.
    const handleState = (nodeId: string, handleId: string) => page.locator(`.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${handleId}"]`).getAttribute('data-handle-state');
    expect(await handleState(groot, 'dataset_name')).toBe('idle');
    const a = await handleCentre(hf, 'hf-import');
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 60, a.y + 40, { steps: 6 });
    await expect.poll(() => handleState(groot, 'dataset_name')).toBe('compatible');
    expect(await handleState(leisaac, 'dataset_name')).toBe('incompatible');
    expect(await handleState(hf, 'hf-import')).toBe('origin');
    expect(await page.locator(`.react-flow__node[data-id="${leisaac}"] [data-drag-dimmed]`).count()).toBe(1);
    expect(await page.locator(`.react-flow__node[data-id="${groot}"] [data-drag-dimmed]`).count()).toBe(0);
    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/compose-drag-highlight.png' });
    await page.mouse.up();
    // Releasing on empty canvas ends the drag: every handle returns to idle.
    await expect.poll(() => handleState(groot, 'dataset_name')).toBe('idle');
    expect(await handleState(leisaac, 'dataset_name')).toBe('idle');
  }, 30000);

  it('resolves a required:// image from the approved profile in the inspector, hides the raw version field, and saves the resolved image', async () => {
    await page.goto(origin);
    await addNode('gr00t-finetune');

    // The inspector renders the image param as a profile picker, already resolved to the approved builtin profile.
    const picker = page.getByTestId('image-picker');
    await picker.waitFor();
    await expect.poll(() => picker.locator('select').inputValue()).toBe('builtin-groot');
    expect(await page.getByText('배포에 GROOT_RUNTIME_IMAGE_URI가 설정되지 않았습니다', { exact: false }).count()).toBe(0);
    // The dataset picker owns the version; no separate "데이터셋 버전" number field is shown.
    expect(await page.getByLabel('데이터셋 버전', { exact: true }).count()).toBe(0);
    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/compose-inspector-image.png' });

    // The resolved image reaches the saved recipe's default-values instead of the placeholder.
    const saveButton = page.getByRole('button', { name: '레시피로 저장', exact: true });
    await expect.poll(() => saveButton.isEnabled()).toBe(true);
    await saveButton.click();
    await page.getByLabel('이름', { exact: true }).fill('Resolved image recipe');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect.poll(() => calls.some((c) => c.path === '/api/templates' && c.method === 'POST')).toBe(true);
    const saved = calls.find((c) => c.path === '/api/templates' && c.method === 'POST')!.body;
    const savedDefaults = (parse(String(saved.yaml)) as { 'default-values': Record<string, unknown> })['default-values'];
    const imageKey = Object.keys(savedDefaults).find((k) => k.endsWith('_image'))!;
    expect(savedDefaults[imageKey]).toBe(GROOT_IMAGE);
    expect(String(saved.yaml)).not.toContain('required://GROOT_RUNTIME_IMAGE_URI');
  }, 30000);

  it('writes the compose draft to session storage and navigates to the wizard on run', async () => {
    await page.goto(origin);
    await addNode('hf-dataset-import');
    await addNode('gr00t-finetune');
    const nodes = await nodeList();
    await connect({ source: idOf(nodes, 'hf-dataset-import'), sourceHandle: 'hf-import', target: idOf(nodes, 'gr00t-finetune'), targetHandle: 'dataset_name' });

    const runButton = page.getByRole('button', { name: '실행', exact: true });
    await expect.poll(() => runButton.isEnabled()).toBe(true);
    await runButton.click();

    await page.waitForFunction(() => (window as unknown as { fixtureDestination?: string }).fixtureDestination === '/workflows/new?draft=1');
    const raw = await page.evaluate(() => sessionStorage.getItem('pai-compose-draft'));
    expect(raw).toBeTruthy();
    const draft = JSON.parse(raw!) as { yaml: string; params: unknown[]; title: string };
    expect(draft.title).toBeTruthy();
    const composed = parse(draft.yaml);
    expect(composed.workflow.tasks.some((t: { inputs?: { task?: string }[] }) => (t.inputs ?? []).some((i) => typeof i.task === 'string'))).toBe(true);
    expect(() => parseWorkflowYaml(draft.yaml, {})).not.toThrow();
  }, 30000);
});
