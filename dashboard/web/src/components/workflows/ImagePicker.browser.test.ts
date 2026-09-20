/** Browser contract tests use only an in-memory local API fixture. No cloud calls. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import type { ImageProfile } from '@/server/services/image-profiles';

const profile = (id: string, name: string, image: string, flags: Partial<Pick<ImageProfile, 'approved' | 'enabled' | 'source'>> = {}): ImageProfile =>
  ({
    id, name, version: 1, projectId: 'p', approved: true, enabled: true, source: 'admin', createdBy: 'admin', createdAt: '2026-01-01T00:00:00Z', contentHash: 'h',
    requirements: { minCpu: 1, minMemoryMiB: 1024, minGpu: 0, minGpuMemoryMiB: 0, platforms: [] },
    image: { requestedImage: image, resolvedImage: `${image.split(':')[0]}@sha256:${'0'.repeat(64)}`, digest: `sha256:${'0'.repeat(64)}`, repository: 'repo', architectures: ['amd64'], manifests: [], inspectedAt: '2026-01-01T00:00:00Z', source: 'ecr-manifest-config' },
    ...flags,
  }) as unknown as ImageProfile;

const GROOT = '123456789012.dkr.ecr.us-east-1.amazonaws.com/groot:v1';
const MUJOCO = '123456789012.dkr.ecr.us-east-1.amazonaws.com/mujoco:v3';
const profiles: ImageProfile[] = [
  profile('builtin-groot', 'groot deployment image', GROOT, { source: 'deployment-env' }),
  profile('mujoco-lab', 'MuJoCo lab image', MUJOCO),
  profile('pending-one', 'Not yet approved', '123456789012.dkr.ecr.us-east-1.amazonaws.com/pending:v1', { approved: false }),
  profile('retired-one', 'Disabled image', '123456789012.dkr.ecr.us-east-1.amazonaws.com/retired:v1', { enabled: false }),
];

describe.skipIf(!existsSync(chromium.executablePath()))('ImagePicker browser contracts', () => {
  let browser: Browser, server: Server, origin: string, bundle: string, page: Page;
  let calls: string[] = [];
  let pageErrors: string[] = [];
  let scenario: 'default' | 'empty' | 'fail' = 'default';

  beforeAll(async () => {
    const result = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {QueryClient,QueryClientProvider} from '@tanstack/react-query'; import {ImagePicker} from './src/components/workflows/ImagePicker';
          const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
          function Harness() {
            const params = new URLSearchParams(window.location.search);
            const [value, setValue] = React.useState(params.get('value') || '');
            window.fixtureState = () => ({ value });
            return React.createElement(ImagePicker, { value, disabled: params.get('disabled') === '1', onChange: setValue });
          }
          createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider, {client}, React.createElement(Harness)));`,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true, write: false, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"test"' },
      banner: { js: 'var process = { env: { NODE_ENV: "test" } };' },
      plugins: [{
        name: 'fixture-next',
        setup(builder) {
          builder.onResolve({ filter: /^next\/link$/ }, (args) => ({ path: args.path, namespace: 'fixture-next' }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture-next' }, () => ({
            loader: 'jsx', resolveDir: process.cwd(),
            contents: `import React from 'react'; export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}`,
          }));
        },
      }],
    });
    bundle = result.outputFiles[0].text;
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://fixture');
      calls.push(url.pathname + url.search);
      const json = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/bundle.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(bundle); return; }
      if (!url.pathname.startsWith('/api/')) { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html lang="en"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      if (url.pathname === '/api/image-profiles') {
        if (scenario === 'fail') return json({ error: 'fixture failure' }, 500);
        return json({ project: { id: 'p', name: 'P' }, profiles: scenario === 'empty' ? [] : profiles, capabilities: { canApprove: false, canSeed: false } });
      }
      return json({ error: 'missing fixture API' }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30000);
  beforeEach(async () => { calls = []; pageErrors = []; scenario = 'default'; page = await browser.newPage(); page.on('pageerror', (error) => pageErrors.push(error.message)); });
  afterEach(async () => { await page.close(); expect(pageErrors).toEqual([]); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

  const state = () => page.evaluate(() => (window as unknown as { fixtureState: () => { value: string } }).fixtureState());

  it('lists only approved, enabled profiles plus a manual option, and selecting a profile sets its image URI', async () => {
    await page.goto(origin);
    const select = page.locator('select');
    await select.waitFor();
    const labels = await select.locator('option').allTextContents();
    expect(labels).toEqual(['Select', `groot deployment image · ${GROOT}`, `MuJoCo lab image · ${MUJOCO}`, 'Enter manually…']);
    expect(await page.locator('input').count()).toBe(0);
    await select.selectOption('mujoco-lab');
    await expect.poll(() => state()).toEqual({ value: MUJOCO });
  });

  it('resolves a required:// placeholder from the seeded builtin profile for that variable', async () => {
    await page.goto(origin + '/?value=' + encodeURIComponent('required://GROOT_RUNTIME_IMAGE_URI'));
    await expect.poll(() => state()).toEqual({ value: GROOT });
    await expect.poll(() => page.locator('select').inputValue()).toBe('builtin-groot');
    expect(await page.getByText('does not set', { exact: false }).count()).toBe(0);
  });

  it('keeps an unresolvable required:// placeholder, explains which variable is missing, and links to image profiles', async () => {
    await page.goto(origin + '/?value=' + encodeURIComponent('required://COSMOS3_IMAGE_URI'));
    await page.getByText('The deployment does not set COSMOS3_IMAGE_URI', { exact: false }).waitFor();
    expect(await state()).toEqual({ value: 'required://COSMOS3_IMAGE_URI' });
    expect(await page.getByRole('link', { name: 'Image profiles' }).getAttribute('href')).toBe('/image-profiles');
    // Picking an approved profile replaces the placeholder and clears the warning.
    await page.locator('select').selectOption('mujoco-lab');
    await expect.poll(() => state()).toEqual({ value: MUJOCO });
    expect(await page.getByText('does not set', { exact: false }).count()).toBe(0);
  });

  it('reveals a text input for manual entry and shows a non-profile value as manual', async () => {
    await page.goto(origin);
    const select = page.locator('select');
    await select.waitFor();
    await select.selectOption('__custom__');
    const input = page.getByLabel('Enter manually…');
    await input.waitFor();
    await input.fill('123456789012.dkr.ecr.us-east-1.amazonaws.com/experimental:dev');
    await expect.poll(() => state()).toEqual({ value: '123456789012.dkr.ecr.us-east-1.amazonaws.com/experimental:dev' });
    expect(await select.inputValue()).toBe('__custom__');

    // Reloading with that value pre-set lands in manual mode with the input prefilled.
    await page.goto(origin + '/?value=' + encodeURIComponent('123456789012.dkr.ecr.us-east-1.amazonaws.com/experimental:dev'));
    await expect.poll(() => page.locator('select').inputValue()).toBe('__custom__');
    expect(await page.getByLabel('Enter manually…').inputValue()).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/experimental:dev');
  });

  it('falls back to a text input with guidance when the project has no approved profiles', async () => {
    scenario = 'empty';
    await page.goto(origin + '/?value=' + encodeURIComponent('required://MUJOCO_IMAGE_URI'));
    await page.getByText('No approved image profiles in this project', { exact: false }).waitFor();
    expect(await page.locator('select').count()).toBe(0);
    await page.getByLabel('Enter manually…').fill(MUJOCO);
    await expect.poll(() => state()).toEqual({ value: MUJOCO });
  });

  it('falls back to a text input with an error message when the profile list fails to load', async () => {
    scenario = 'fail';
    await page.goto(origin);
    await page.getByText('Failed to load image profiles', { exact: false }).waitFor();
    expect(await page.locator('select').count()).toBe(0);
    expect(await page.getByLabel('Enter manually…').count()).toBe(1);
  });
});
