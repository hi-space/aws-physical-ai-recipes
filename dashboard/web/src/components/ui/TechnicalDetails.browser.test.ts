import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';

/**
 * Renders the real TechnicalDetails component (with the real Disclosure/CopyButton from
 * components/ui) in headless Chromium to exercise the disclosure toggle, row filtering,
 * links and copy button end to end — this repo has no jsdom/RTL setup, so component tests
 * render in a real browser instead (see DagView.browser.test.ts for the same pattern).
 */
describe.skipIf(!existsSync(chromium.executablePath()))('TechnicalDetails browser', () => {
  let browser: Browser, server: Server, origin: string;
  const errors: string[] = [];

  async function bundleApp(propsExpr: string) {
    const result = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {TechnicalDetails} from './src/components/ui/TechnicalDetails';
          createRoot(document.getElementById('root')).render(<TechnicalDetails ${propsExpr}/>);`,
        loader: 'tsx', resolveDir: process.cwd(),
      },
      write: false, bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'local-link', setup(builder) {
        builder.onResolve({ filter: /^next\/link$/ }, (args) => ({ path: args.path, namespace: 'local-link' }));
        builder.onLoad({ filter: /.*/, namespace: 'local-link' }, () => ({ loader: 'jsx', resolveDir: process.cwd(),
          contents: `import React from 'react'; export default function Link({href,children,prefetch,...props}) { return <a href={href} {...props}>{children}</a>; }` }));
      } }],
    });
    return result.outputFiles[0].text;
  }

  async function serve(js: string) {
    const s = createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(js); return; }
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    return { server: s, origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  }

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30_000);
  afterAll(async () => { await browser?.close(); });

  async function withPage(propsExpr: string, run: (tab: Page) => Promise<void>) {
    const js = await bundleApp(propsExpr);
    const { server: s, origin: o } = await serve(js);
    server = s; origin = o;
    const context = await browser.newContext();
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    const tab = await context.newPage();
    tab.setDefaultTimeout(4000);
    tab.on('pageerror', (e) => errors.push(e.message));
    try {
      await tab.goto(origin);
      await run(tab);
    } finally {
      await context.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('renders a disclosure titled "기술 정보" and is closed by default', async () => {
    await withPage(
      `rows={[{label:'ID',value:'wf-abc123'}]} data-testid="tech-details"`,
      async (tab) => {
        await tab.getByText('기술 정보').waitFor();
        const region = await tab.locator('[data-technical-details]').count();
        expect(region).toBe(1);
        // Closed by default: the row content is not present until opened.
        expect(await tab.getByText('wf-abc123').count()).toBe(0);
        expect(errors).toEqual([]);
      },
    );
  });

  it('wraps the region in [data-technical-details] even when data-testid is omitted', async () => {
    // This is how every real page caller invokes the component (Tasks 3, 5, 7 never pass
    // data-testid) — the marker must not be conditional on the test-only prop.
    await withPage(`rows={[{label:'ID',value:'wf-abc123'}]}`, async (tab) => {
      await tab.getByText('기술 정보').waitFor();
      expect(await tab.locator('[data-technical-details]').count()).toBe(1);
      expect(errors).toEqual([]);
    });
  });

  it('renders rows with label and value, open by default, with a copy button', async () => {
    await withPage(
      `rows={[{label:'Workflow ID',value:'wf-1234567890abcdef',copy:true}]} defaultOpen={true}`,
      async (tab) => {
        await tab.getByText('Workflow ID').waitFor();
        await tab.getByText('wf-1234567890abcdef').waitFor();
        await tab.getByRole('button', { name: '복사' }).waitFor();
        expect(errors).toEqual([]);
      },
    );
  });

  it('skips rows with empty/null values', async () => {
    await withPage(
      `rows={[{label:'Pod',value:null},{label:'Queue',value:undefined},{label:'Namespace',value:'rl'}]} defaultOpen={true}`,
      async (tab) => {
        await tab.getByText('Namespace').waitFor();
        expect(await tab.getByText('Pod', { exact: true }).count()).toBe(0);
        expect(await tab.getByText('Queue', { exact: true }).count()).toBe(0);
        expect(errors).toEqual([]);
      },
    );
  });

  it('renders links when href is provided', async () => {
    await withPage(
      `rows={[{label:'ECR Image',value:'123456789.dkr.ecr.us-east-1.amazonaws.com/my-image:v1',href:'https://console.aws.amazon.com/',copy:true}]} defaultOpen={true}`,
      async (tab) => {
        const link = tab.getByRole('link');
        await link.waitFor();
        expect(await link.getAttribute('href')).toBe('https://console.aws.amazon.com/');
        expect(errors).toEqual([]);
      },
    );
  });

  it('applies the mono class to values when mono=true', async () => {
    await withPage(
      `rows={[{label:'ARN',value:'arn:aws:sagemaker:us-east-1:123456789:hyperpod-cluster/my-cluster',mono:true}]} defaultOpen={true}`,
      async (tab) => {
        await tab.getByText(/arn:aws:/).waitFor();
        const monoText = await tab.locator('.mono').last().textContent();
        expect(monoText).toContain('arn:aws:');
        expect(errors).toEqual([]);
      },
    );
  });

  it('accepts a custom title from props that overrides i18n', async () => {
    await withPage(
      `title="System Details" rows={[{label:'ID',value:'x'}]} defaultOpen={true}`,
      async (tab) => {
        await tab.getByText('System Details').waitFor();
        expect(await tab.getByText('기술 정보').count()).toBe(0);
        expect(errors).toEqual([]);
      },
    );
  });

  it('accepts defaultOpen=true to open on mount', async () => {
    await withPage(
      `rows={[{label:'ID',value:'test'}]} defaultOpen={true}`,
      async (tab) => {
        await tab.getByText('test').waitFor();
        expect(errors).toEqual([]);
      },
    );
  });
});
