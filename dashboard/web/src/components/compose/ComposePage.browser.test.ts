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
    // before onConnect, so the toast can only come from onConnectEnd — drive that exact handler here.
    await connectEnd({ source: idOf(nodes, 'hf-dataset-import'), sourceHandle: 'hf-import', target: idOf(nodes, 'leisaac-evaluate'), targetHandle: 'dataset_name' });
    await page.getByText('포트 종류가 일치하지 않습니다.').waitFor();
    // No edge was created: the rejected input is still editable (not bound).
    expect(await page.getByText('업스트림 연결에서 제공됩니다.').count()).toBe(0);
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
