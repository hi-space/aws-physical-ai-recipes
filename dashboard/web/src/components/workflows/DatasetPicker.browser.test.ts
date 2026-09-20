/** Browser contract tests use only an in-memory local API fixture. No cloud calls. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import type { Dataset, DatasetVersion } from '@/server/store/types';

const datasets: Dataset[] = [
  { name: 'plain-dataset', owner: 'u', tags: [], latestVersion: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { name: 'matching-dataset', owner: 'u', tags: ['kind:lerobot-dataset'], latestVersion: 2, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' },
  { name: 'pending-dataset', owner: 'u', tags: [], latestVersion: 1, createdAt: '2026-01-04T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z' },
];
const versionsByDataset: Record<string, DatasetVersion[]> = {
  'plain-dataset': [
    { dataset: 'plain-dataset', version: 1, uri: 's3://b/1', tags: [], createdAt: '', createdBy: 'u', state: 'READY' },
  ],
  'matching-dataset': [
    { dataset: 'matching-dataset', version: 1, uri: 's3://b/1', tags: [], createdAt: '', createdBy: 'u', state: 'PENDING' },
    { dataset: 'matching-dataset', version: 2, uri: 's3://b/2', tags: [], createdAt: '', createdBy: 'u', state: 'READY' },
  ],
  'pending-dataset': [
    { dataset: 'pending-dataset', version: 1, uri: 's3://b/1', tags: [], createdAt: '', createdBy: 'u', state: 'PENDING' },
  ],
};

describe.skipIf(!existsSync(chromium.executablePath()))('DatasetPicker browser contracts', () => {
  let browser: Browser, server: Server, origin: string, bundle: string, page: Page;
  let calls: string[] = [];
  let pageErrors: string[] = [];
  let emptyDatasets = false;
  let failList = false;
  let failDetail = false;

  beforeAll(async () => {
    const result = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {QueryClient,QueryClientProvider} from '@tanstack/react-query'; import {DatasetPicker} from './src/components/workflows/DatasetPicker';
          const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
          function Harness() {
            const params = new URLSearchParams(window.location.search);
            const [value, setValue] = React.useState(params.get('value') || '');
            const [version, setVersion] = React.useState(params.get('version') || undefined);
            window.fixtureState = () => ({ value, version });
            const kind = params.get('kind') || undefined;
            const disabled = params.get('disabled') === '1';
            return React.createElement(DatasetPicker, {
              value, version, kind, disabled,
              onChange: (name, v) => { setValue(name); setVersion(v !== undefined ? String(v) : undefined); },
            });
          }
          createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider, {client}, React.createElement(Harness)));`,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"test"' },
      banner: { js: 'var process = { env: { NODE_ENV: "test" } };' },
      plugins: [{
        name: 'fixture-next',
        setup(builder) {
          builder.onResolve({ filter: /^next\/link$/ }, (args) => ({ path: args.path, namespace: 'fixture-next' }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture-next' }, () => ({
            loader: 'jsx',
            resolveDir: process.cwd(),
            contents: `import React from 'react'; export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}`,
          }));
        },
      }],
    });
    bundle = result.outputFiles[0].text;
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://fixture');
      calls.push(url.pathname + url.search);
      const json = (value: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === '/bundle.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(bundle);
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><html lang="en"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
        return;
      }
      if (url.pathname === '/api/datasets') {
        if (failList) return json({ error: 'fixture list failure' }, 500);
        return json(emptyDatasets ? [] : datasets);
      }
      const match = /^\/api\/datasets\/([^/]+)$/.exec(url.pathname);
      if (match) {
        if (failDetail) return json({ error: 'fixture detail failure' }, 500);
        const name = decodeURIComponent(match[1]);
        const versions = versionsByDataset[name] ?? [];
        return json({ dataset: datasets.find((d) => d.name === name), versions, lineage: { produced: [], consumers: [] } });
      }
      return json({ error: 'missing fixture API' }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30000);
  beforeEach(async () => {
    calls = [];
    pageErrors = [];
    emptyDatasets = false;
    failList = false;
    failDetail = false;
    page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
  });
  afterEach(async () => {
    await page.close();
    expect(pageErrors).toEqual([]);
  });
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('lists datasets with name/version/updated-time labels, sorts a matching kind first, and lets the user pick a READY version', async () => {
    await page.goto(origin + '/?kind=lerobot-dataset');
    const selects = page.locator('select');
    await selects.first().waitFor();
    const optionLabels = await selects.first().locator('option').allTextContents();
    // matching-dataset carries the requested kind tag, so it must sort ahead of plain-dataset.
    // Each label shows name, latestVersion, and the formatted updated time (spec §3.2).
    expect(optionLabels[1]).toMatch(/^matching-dataset · v2 · /);
    expect(optionLabels[2]).toMatch(/^plain-dataset · v1 · /);
    expect(optionLabels[3]).toMatch(/^pending-dataset · v1 · /);
    await selects.first().selectOption('matching-dataset');
    await selects.nth(1).waitFor();
    const versionLabels = await selects.nth(1).locator('option').allTextContents();
    // Only the READY version (v2) is offered; the PENDING v1 is excluded.
    expect(versionLabels).toHaveLength(2);
    expect(versionLabels).toContain('v2');
    expect(versionLabels).not.toContain('v1');
    // Auto-selects the only READY version once the dataset is chosen and no version is set.
    const state = await page.evaluate(() => (window as unknown as { fixtureState: () => { value: string; version?: string } }).fixtureState());
    expect(state).toEqual({ value: 'matching-dataset', version: '2' });
  });

  it('shows an empty state with a link to the dataset import recipe when no datasets exist', async () => {
    emptyDatasets = true;
    await page.goto(origin);
    await page.getByText('No datasets registered.', { exact: false }).waitFor();
    const href = await page.getByRole('link').getAttribute('href');
    expect(href).toBe('/workflows/new?template=hf-dataset-import');
  });

  it('shows a distinct error message when the dataset list fetch fails, not the empty state', async () => {
    failList = true;
    await page.goto(origin);
    await page.getByText('Failed to load datasets.', { exact: false }).waitFor();
    expect(await page.getByText('No datasets registered.', { exact: false }).count()).toBe(0);
  });

  it('shows a distinct error message when the version detail fetch fails', async () => {
    failDetail = true;
    await page.goto(origin + '/?value=matching-dataset');
    await page.getByText('Failed to load dataset versions.', { exact: false }).waitFor();
  });

  it('names an unregistered template default as such instead of fetching its versions', async () => {
    // A builtin default like `leisaac-pick-orange` that this project never registered used to 404 as
    // "failed to load dataset versions". Now it is called out and the select is left blank to pick from.
    await page.goto(origin + '/?value=ghost-dataset');
    await page.getByText('"ghost-dataset" is not registered in this project', { exact: false }).waitFor();
    expect(await page.locator('select').first().inputValue()).toBe('');
    expect(calls.some((call) => call.startsWith('/api/datasets/ghost-dataset'))).toBe(false);
    expect(await page.getByText('Failed to load dataset versions.', { exact: false }).count()).toBe(0);
    // Picking a registered dataset recovers normally.
    await page.locator('select').first().selectOption('plain-dataset');
    await page.locator('select').nth(1).waitFor();
    const state = await page.evaluate(() => (window as unknown as { fixtureState: () => { value: string; version?: string } }).fixtureState());
    expect(state).toEqual({ value: 'plain-dataset', version: '1' });
  });

  it('says when a registered dataset has no READY version instead of silently hiding the version field', async () => {
    await page.goto(origin + '/?value=pending-dataset');
    await page.getByText('This dataset has no READY version yet.', { exact: false }).waitFor();
    expect(await page.locator('select').count()).toBe(1);
  });

  it('disables both selects when disabled is set', async () => {
    await page.goto(origin + '/?value=matching-dataset&version=2&disabled=1');
    const selects = page.locator('select');
    await selects.nth(1).waitFor();
    expect(await selects.first().isDisabled()).toBe(true);
    expect(await selects.nth(1).isDisabled()).toBe(true);
  });

  it('pre-fills the dataset and version selects from initial value/version props (deep link)', async () => {
    await page.goto(origin + '/?value=matching-dataset&version=2');
    const selects = page.locator('select');
    await selects.nth(1).waitFor();
    await expect.poll(() => selects.first().inputValue()).toBe('matching-dataset');
    await expect.poll(() => selects.nth(1).inputValue()).toBe('2');
  });
});
