import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

/**
 * Renders the real DagView (React Flow included) in headless Chromium with a three-step fixture that has a
 * skip dependency (import → evaluate), so the layout, arc edge, stepper and detail panel are all exercised.
 */
describe.skipIf(!existsSync(chromium.executablePath()))('workflow DAG browser', () => {
  let browser: Browser, server: Server, origin: string;
  const errors: string[] = [];
  const fixture = {
    spec: { workflow: { name: 'gr00t-e2e', description: '', mlflow: false, resources: { cpu: { cpu: 4, memory: '16Gi' }, gpu: { cpu: 12, memory: '96Gi', gpu: 1, platform: 'ml.g5.8xlarge' } }, tasks: [
      { name: 'import', resource: 'cpu', image: 'data:1', inputs: [{ dataset: { name: 'so101-raw', version: 3 } }], outputs: [{ dataset: { name: 'gr00t-e2e-dataset', path: '/out/dataset' } }], parallelism: 1 },
      { name: 'finetune', resource: 'gpu', image: 'groot:1', inputs: [{ task: 'import' }], outputs: [{ dataset: { name: 'gr00t-e2e-checkpoints', path: '/out' } }], parallelism: 1 },
      { name: 'evaluate', resource: 'gpu', image: 'groot:1', inputs: [{ task: 'finetune' }, { task: 'import' }], outputs: [{ dataset: { name: 'gr00t-e2e-evaluation', path: '/out' } }], parallelism: 1 },
    ] } },
    tasks: [
      { workflowId: 'w', name: 'import', phase: 'SUCCEEDED', attempts: 1, replicas: 1, startedAt: '2026-09-17T08:55:00Z', finishedAt: '2026-09-17T09:01:00Z', queuedAt: '2026-09-17T08:54:00Z', jobName: 'w-import-1', updatedAt: '', publishedVersions: [{ dataset: 'gr00t-e2e-dataset-9c22ae77', version: 1 }] },
      { workflowId: 'w', name: 'finetune', phase: 'RUNNING', attempts: 2, replicas: 1, startedAt: new Date(Date.now() - 42 * 60_000).toISOString(), jobName: 'w-finetune-2', message: 'step 1200/2000', updatedAt: '' },
      { workflowId: 'w', name: 'evaluate', phase: 'WAITING', attempts: 0, replicas: 1, updatedAt: '' },
    ],
  };
  beforeAll(async () => {
    const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {DagView} from './src/components/workflows/DagView';
      const fixture = ${JSON.stringify(fixture)};
      function App() { const [selected, setSelected] = React.useState(); const [tab, setTab] = React.useState('dag');
        return <div style={{padding:16,width:1280,background:'#0b0e14',color:'#e6e9f0',fontFamily:'sans-serif'}} data-tab={tab}>
          <DagView spec={fixture.spec} tasks={fixture.tasks} selectedTask={selected} onSelectTask={setSelected} onOpenTab={setTab}/></div>; }
      createRoot(document.getElementById('root')).render(<App/>);`,
      loader: 'tsx', resolveDir: process.cwd() }, write: false, bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"test"' }, outdir: 'out',
      // next/link reads process.env at import time; the UI kit imports it, so swap in a plain anchor like the LogViewer test does.
      plugins: [{ name: 'local-link', setup(builder) {
        builder.onResolve({ filter: /^next\/link$/ }, (args) => ({ path: args.path, namespace: 'local-link' }));
        builder.onLoad({ filter: /.*/, namespace: 'local-link' }, () => ({ loader: 'jsx', resolveDir: process.cwd(),
          contents: `import React from 'react'; export default function Link({href,children,prefetch,...props}) { return <a href={href} {...props}>{children}</a>; }` }));
      } }] });
    const js = bundle.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
    const flowCss = bundle.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
    // Compile the real theme so screenshots and computed styles match the dashboard, not an unstyled skeleton.
    const globals = 'src/app/globals.css';
    const theme = await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync(globals, 'utf8'), { from: globals });
    const css = `${theme.css}\n${flowCss}`;
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(js); return; }
      if (url.pathname === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
      res.setHeader('content-type', 'text/html');
      res.end('<html><body style="margin:0"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('lays steps out left to right, draws the skip edge as an arc, and shows details for the clicked step', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    const tab = await context.newPage(); tab.setDefaultTimeout(5000); tab.on('pageerror', (e) => errors.push(e.message));
    try {
      await tab.goto(origin);
      await tab.waitForTimeout(300);
      expect(errors, 'page errors during mount').toEqual([]);
      await tab.getByRole('button', { name: /2\. finetune/ }).waitFor();

      // Nodes: three task cards left to right on one line, dataset pill to the left of import.
      const boxes = await tab.evaluate(() => [...document.querySelectorAll('.react-flow__node')].map((el) => {
        const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-id'), x: r.x, y: r.y + r.height / 2 };
      }));
      const x = (id: string) => boxes.find((b) => b.id === id)!.x;
      const y = (id: string) => boxes.find((b) => b.id === id)!.y;
      expect(x('dataset:so101-raw')).toBeLessThan(x('import'));
      expect(x('import')).toBeLessThan(x('finetune'));
      expect(x('finetune')).toBeLessThan(x('evaluate'));
      expect(Math.abs(y('import') - y('evaluate'))).toBeLessThan(2);

      // The skip edge (import → evaluate) is a cubic that arcs above the finetune card, not through it.
      const skipPath = await tab.locator('.react-flow__edge[data-id="import->evaluate"] path').first().getAttribute('d');
      expect(skipPath).toMatch(/^M [\d.]+,[\d.]+ C /);
      const controlY = Number(skipPath!.match(/C [\d.-]+,([\d.-]+)/)![1]);
      const finetuneTop = await tab.evaluate(() => { const r = document.querySelector('.react-flow__node[data-id="finetune"]')!.getBoundingClientRect(); return r.top; });
      // In flow coordinates the node top is at -height/2 (centred on 0); the control points must sit above it.
      expect(controlY).toBeLessThan(-42);
      expect(finetuneTop).toBeGreaterThan(0);

      // Before a click the panel asks for a selection.
      await expect(tab.getByText('단계를 선택하세요')).toBeTruthy();

      // Click the finetune card → panel shows its runtime facts and its upstream input.
      await tab.locator('.react-flow__node[data-id="finetune"]').click();
      await tab.getByRole('heading', { name: 'finetune' }).waitFor();
      await tab.getByText('3단계 중 2번째').waitFor();
      await tab.getByText('step 1200/2000').waitFor();
      // jobName now lives inside the collapsed TechnicalDetails disclosure.
      await tab.getByRole('button', { name: '기술 정보' }).click();
      await tab.getByText('w-finetune-2').waitFor();
      await tab.getByRole('button', { name: 'import 선택' }).waitFor();
      expect(await tab.getByRole('button', { name: /2\. finetune/ }).getAttribute('aria-pressed')).toBe('true');

      // Unrelated nodes dim; the dataset feeding import is not a neighbour of finetune.
      const datasetOpacity = await tab.locator('.react-flow__node[data-id="dataset:so101-raw"] a').evaluate((el) => getComputedStyle(el).opacity);
      expect(Number(datasetOpacity)).toBeLessThan(1);

      mkdirSync('test-results', { recursive: true });
      await tab.screenshot({ path: 'test-results/dag-view-finetune.png' });

      // Arrow keys walk the steps; the stepper marks the current one.
      await tab.locator('[role="group"][tabindex="0"]').first().focus();
      await tab.keyboard.press('ArrowRight');
      await tab.getByRole('heading', { name: 'evaluate' }).waitFor();
      expect(await tab.getByRole('button', { name: /^3/ }).first().getAttribute('aria-current')).toBe('step');

      // The upstream chip in the panel selects that step, and the logs action switches the parent tab.
      await tab.getByRole('button', { name: 'finetune 선택' }).click();
      await tab.getByRole('heading', { name: 'finetune' }).waitFor();
      await tab.getByRole('button', { name: '로그 보기' }).click();
      expect(await tab.locator('[data-tab]').getAttribute('data-tab')).toBe('logs');

      await tab.screenshot({ path: 'test-results/dag-view-evaluate.png' });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);
});
