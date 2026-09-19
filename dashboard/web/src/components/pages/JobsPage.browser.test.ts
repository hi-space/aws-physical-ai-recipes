/**
 * Guard test (spec §3.6): in the JobsPage logs drawer, the workflow id, task name and
 * raw pod names must live only inside [data-technical-details] (Task 7). The main jobs
 * table keeps job.name as its primary column (a k8s Job name, which may itself encode a
 * workflow id) -- that is out of scope for this guard, so the fixture job name is a plain
 * string with no hex in it, keeping the sweep unambiguous.
 *
 * Real JobsPage + API client rendered in headless Chromium (esbuild bundle served over
 * loopback HTTP), matching PipelinesPage.browser.test.ts / DagView.browser.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';

const workflowId = '0b434edd9d2afc20'; // randomBytes(8).toString('hex') shape (src/server/workflow/submission.ts)
const podName = 'ffeeddccbbaa998877665544332211aa'; // 32-hex shape, e.g. a pod uid lookalike
const job = {
  name: 'finetune-run-7', namespace: 'team-a',
  created: '2026-09-18T00:00:00Z', startTime: '2026-09-18T00:05:00Z',
  active: 1, succeeded: 0, failed: 0, completions: 1, suspended: false, state: 'Running',
  queue: 'default', priority: 'normal',
  workflowId, task: 'finetune', app: 'physical-ai',
  image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/groot:latest',
  pods: [{ name: podName, phase: 'Running', node: 'ip-10-0-1-23', started: '2026-09-18T00:05:10Z', restarts: 0 }],
};

describe.skipIf(!existsSync(chromium.executablePath()))('JobsPage identifier guard', () => {
  let browser: Browser, server: Server, origin: string, page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    const bundle = await build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {JobsPage} from './src/components/pages/JobsPage';
        const client = new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
        createRoot(document.getElementById('root')).render(
          React.createElement(QueryClientProvider,{client},React.createElement(JobsPage)));`,
      },
      bundle: true, write: false, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'fixture-next', setup(builder) {
        builder.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
          loader: 'jsx', resolveDir: process.cwd(), contents: args.path.endsWith('navigation')
            ? `export function useRouter(){return {push:url=>{window.fixtureDestination=url}}}
               export function useSearchParams(){return new URLSearchParams(location.search)}`
            : `import React from 'react'; export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}`,
        }));
      } }],
    });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
      };
      if (url.pathname === '/bundle.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return;
      }
      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="ko"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return;
      }
      if (url.pathname === '/api/me') return json({
        user: 'alice', subject: 'alice', email: 'alice@example.test', role: 'researcher', region: 'us-east-1',
        accountId: '123456789012', features: {}, clusters: {}, buckets: {}, defaultNamespace: 'default',
        project: { id: 'a', name: 'Project A', role: 'researcher' },
        resources: { hyperPodEks: { clusterName: 'hp-cluster', eksClusterName: 'eks-cluster', logGroupPrefix: '/pai' }, table: 'pai-table' },
      });
      if (url.pathname === '/api/k8s/jobs') return json([job]);
      if (url.pathname === '/api/k8s/namespaces') return json(['team-a']);
      if (url.pathname === '/api/k8s/events') return json([]);
      if (url.pathname.startsWith('/api/k8s/pods/')) return json({ source: 'kubelet', phase: 'Running', lines: [{ ts: '2026-09-18T00:05:20Z', text: 'training step 10/100' }] });
      return json({ error: `unhandled fixture ${req.method} ${url.pathname}` }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30000);
  beforeEach(async () => {
    page = await (await browser.newContext()).newPage(); page.setDefaultTimeout(3000);
    page.on('pageerror', error => errors.push(error.message));
    await page.context().route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  });
  afterEach(async () => { await page.context().close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it('shows workflow id, task and pod names only inside the technical-details disclosure', async () => {
    await page.goto(origin + '/jobs');
    await page.getByText(job.name, { exact: true }).first().waitFor();

    // Main table sanity: the job's own name is the primary column and stays visible.
    expect(await page.getByText(job.name, { exact: false }).count()).toBeGreaterThan(0);

    await page.getByRole('button', { name: '로그' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();

    // Before opening the disclosure, the guarded fields are not even mounted.
    expect(await dialog.getByText(workflowId, { exact: false }).count()).toBe(0);
    expect(await dialog.getByText(podName, { exact: false }).count()).toBe(0);

    await dialog.getByRole('button', { name: '기술 정보' }).click();
    // Sanity: once opened, the technical-details region actually contains the fixture's identifiers --
    // proving the sweep below is testing something real, not vacuously passing on an empty page.
    const techRegionText = await dialog.locator('[data-technical-details]').first().textContent();
    expect(techRegionText).toContain(workflowId);
    expect(techRegionText).toContain(podName);
    expect(techRegionText).toContain(job.task);

    const outsideText = await page.evaluate(() => {
      document.querySelectorAll('[data-technical-details]').forEach((el) => el.remove());
      return document.body.textContent || '';
    });
    expect(outsideText).not.toMatch(/arn:aws/);
    expect(outsideText).not.toMatch(/\b[0-9a-f]{32}\b/); // catches podName if it leaked
    expect(outsideText).not.toContain(workflowId);
  });
});
