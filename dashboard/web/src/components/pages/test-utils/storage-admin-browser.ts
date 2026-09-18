/** Real components and API client, with only Next navigation and HTTP replaced locally. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { Me } from '@/lib/api-client';

export const fixtureMe: Me = {
  user: 'fixture-admin', email: 'admin@example.test', role: 'admin', region: 'us-east-1',
  accountId: '123456789012', defaultNamespace: 'default',
  features: { eks: false, slurm: false, amp: false, mlflow: false, pipeline: false, dcv: false, fsx: false, edge: false, cognito: true, sessions: false },
  clusters: {}, buckets: { data: 'fixture-bucket' },
};

export interface FixtureCall {
  url: URL;
  method: string;
  body: Record<string, unknown>;
  bytes: Buffer;
}
type Handler = (call: FixtureCall, response: ServerResponse) => void | Promise<void>;

export function json(response: ServerResponse, value: unknown, status = 200) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

export async function storageAdminBrowser(component: 'storage' | 'dataset' | 'admin' | 'queues', handler: Handler) {
  const entry = {
    storage: `import {S3Browser} from './src/components/storage/S3Browser'; const element=<S3Browser bucket="fixture-bucket" allowUpload />;`,
    dataset: `import {DatasetDetailPage} from './src/components/pages/DatasetDetailPage'; const element=<DatasetDetailPage name="fixture-data" />;`,
    admin: `import {AdminPage} from './src/components/pages/AdminPage'; const element=<AdminPage />;`,
    queues: `import {QueuesPage} from './src/components/pages/QueuesPage'; const element=<QueuesPage />;`,
  }[component];
  const result = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        ${entry}
        const client=new QueryClient({defaultOptions:{queries:{retry:false,retryDelay:0}}});
        window.fixtureClient=client;
        createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'fixture-next',
      setup(builder) {
        builder.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'fixture-next' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture-next' }, args => ({
          loader: 'jsx', resolveDir: process.cwd(),
          contents: args.path.endsWith('navigation')
            ? `export function useRouter(){return {push:url=>{window.fixtureDestination=url}}}`
            : `import React from 'react'; export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}`,
        }));
      },
    }],
  });
  const calls: FixtureCall[] = [];
  const unexpected: string[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url!, 'http://fixture');
      if (url.pathname === '/bundle.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(result.outputFiles[0].text);
        return;
      }
      if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/upload/')) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><html lang="ko"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const body = request.headers['content-type']?.includes('application/json') && bytes.length ? JSON.parse(bytes.toString()) : {};
      const call = { url, method: request.method!, body, bytes };
      calls.push(call);
      await handler(call, response);
    } catch (error) {
      unexpected.push(String(error));
      json(response, { error: String(error) }, 500);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  return {
    origin, calls, unexpected,
    async page() {
      const page = await browser.newPage();
      page.setDefaultTimeout(2500);
      page.on('pageerror', error => unexpected.push(error.message));
      // Fixtures must never reach a cloud service or an arbitrary external host.
      await page.route('**/*', route => new URL(route.request().url()).origin === origin
        ? route.continue()
        : (unexpected.push(`External request: ${route.request().url()}`), route.abort()));
      return page;
    },
    async close() {
      await browser.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
