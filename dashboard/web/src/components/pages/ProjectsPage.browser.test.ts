/** Local browser + HTTP fixtures only. Never contacts AWS or a deployed dashboard. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';

interface ProjectRow {
  id: string; name: string; namespace: string; queue: string; backendId?: string; computeQuotaId: string;
  description?: string; myRole?: 'viewer' | 'researcher' | 'project-admin'; attachment: 'ATTACHED' | 'DETACHED' | 'UNKNOWN';
}

const adminProjects = (): ProjectRow[] => [
  { id: 'team-a', name: 'Team A', namespace: 'hyperpod-ns-team-a', queue: 'hyperpod-ns-team-a-localqueue', backendId: 'default', computeQuotaId: 'q-a', myRole: 'project-admin', attachment: 'ATTACHED' },
  { id: 'team-b', name: 'Team B', namespace: 'hyperpod-ns-team-b', queue: 'hyperpod-ns-team-b-localqueue', backendId: 'default', computeQuotaId: 'q-b', myRole: 'project-admin', attachment: 'DETACHED' },
];
const quotas = [
  { ComputeQuotaId: 'q-a', ComputeQuotaTarget: { TeamName: 'team-a', FairShareWeight: 50 }, Status: 'ACTIVE' }, // already adopted
  { ComputeQuotaId: 'q-9lives', ComputeQuotaTarget: { TeamName: '9lives' }, Status: 'ACTIVE' }, // fails team naming pattern
  { ComputeQuotaId: 'q-c', ComputeQuotaTarget: { TeamName: 'team-c', FairShareWeight: 10 }, Status: 'ACTIVE',
    detail: { ComputeQuotaConfig: { ComputeQuotaResources: [{ InstanceType: 'ml.g5.8xlarge', Count: 2 }] } } }, // adoptable
];

describe.skipIf(!existsSync(chromium.executablePath()))('projects page browser contracts', () => {
  let server: Server, browser: Browser, page: Page, origin: string;
  let admin: boolean, projects: ProjectRow[], members: Array<{ username: string; email?: string; role: string }>;
  let calls: Array<{ path: string; method: string; body: Record<string, unknown> }>, errors: string[];
  let backendsDefaultConfigured: boolean, backendsError: boolean, createFails: boolean;
  beforeAll(async () => {
    const bundle = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{ProjectsPage}from'./src/components/pages/ProjectsPage';createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(ProjectsPage)));`,
      resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'next-fixture', setup(builder) {
        builder.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'fixture-next' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture-next' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: args.path.endsWith('navigation')
          ? `export function usePathname(){return location.pathname}`
          : `import React from 'react';export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}` }));
      } }] });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return; }
      if (!url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html lang="en"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      calls.push({ path: url.pathname + url.search, method: req.method!, body });
      const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/api/me') return json({ user: 'user', subject: 'sub', role: admin ? 'admin' : 'researcher', region: 'us-east-1', features: {} });
      if (url.pathname === '/api/backends') {
        if (backendsError) return json({ error: 'Backend registry unavailable' }, 503);
        return json({ default: { id: 'default', configured: backendsDefaultConfigured, clusterName: 'home-eks' }, backends: [
          { id: 'alpha', version: 2, enabled: true, status: 'READY', findings: [], profile: { accountId: '123456789012', region: 'us-east-1', vpcId: 'vpc-a', namespaces: ['hyperpod-ns-team-c'], eks: { eksClusterName: 'alpha' } } },
        ] });
      }
      if (url.pathname.startsWith('/api/quotas')) return json({ clusterArn: 'arn:aws:sagemaker:us-east-1:123456789012:cluster/abc', quotas, policies: [] });
      if (url.pathname === '/api/projects') {
        if (req.method === 'GET') return json(projects);
        if (req.method === 'POST') {
          if (createFails) return json({ error: 'Adoption request rejected' }, 409);
          const created: ProjectRow = { id: String(body.name ?? 'team-c').toLowerCase().replace(/\s+/g, '-'), name: String(body.name ?? 'team-c'),
            namespace: 'hyperpod-ns-team-c', queue: 'hyperpod-ns-team-c-localqueue', backendId: String(body.backendId ?? 'default'),
            computeQuotaId: String(body.computeQuotaId), myRole: 'project-admin', attachment: 'ATTACHED' };
          projects = [...projects, created]; return json(created);
        }
      }
      const memberMatch = /^\/api\/projects\/([^/]+)\/members(?:\/([^/]+))?$/.exec(url.pathname);
      if (memberMatch) {
        if (req.method === 'GET') return json({ members });
        if (req.method === 'PUT') {
          const username = decodeURIComponent(memberMatch[2]!);
          if (body.role === null) members = members.filter(m => m.username !== username);
          else { const existing = members.find(m => m.username === username);
            if (existing) existing.role = String(body.role); else members = [...members, { username, role: String(body.role) }]; }
          return json({ ok: true });
        }
      }
      const deleteMatch = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
      if (deleteMatch && req.method === 'DELETE') { projects = projects.filter(p => p.id !== deleteMatch[1]); return json({ ok: true }); }
      return json({ error: 'Missing fixture route' }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30000);
  beforeEach(async () => {
    admin = true; projects = adminProjects(); members = [{ username: 'alice', email: 'alice@example.test', role: 'member' }];
    backendsDefaultConfigured = true; backendsError = false; createFails = false;
    calls = []; errors = [];
    page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(3000);
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  });
  afterEach(async () => { await page.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it('offers only the not-yet-adopted, name-pattern-valid team as a candidate and posts the adoption', async () => {
    await page.goto(origin + '/');
    const teamSelect = page.getByLabel(/^Team \(ComputeQuota\)/);
    await teamSelect.locator('option').nth(1).waitFor({ state: 'attached' });
    const optionTexts = (await teamSelect.locator('option').allTextContents()).filter(Boolean);
    expect(optionTexts).toHaveLength(2); // placeholder + exactly one candidate
    expect(optionTexts[1]).toContain('team-c');
    await teamSelect.selectOption('q-c');
    await page.getByRole('button', { name: 'Adopt as project', exact: true }).click();
    await page.getByText('Team adopted as a project.', { exact: false }).waitFor();
    expect(calls.find(c => c.path === '/api/projects' && c.method === 'POST')?.body).toEqual({ computeQuotaId: 'q-c', backendId: 'default' });
  }, 15000);

  it('shows the DETACHED badge and hint for a project whose ComputeQuota binding is lost', async () => {
    await page.goto(origin + '/');
    const teamBCard = page.getByRole('button', { name: /Team B/ });
    await teamBCard.getByText('DETACHED', { exact: true }).waitFor();
    await teamBCard.click();
    await page.getByText('no longer exists or its team was renamed', { exact: false }).waitFor();
  }, 15000);

  it('shows current members, adds a new member by username, and issues the expected PUT', async () => {
    await page.goto(origin + '/');
    await page.getByRole('button', { name: /Team A/ }).click();
    await page.getByText('alice', { exact: true }).waitFor();
    const roleSelect = page.getByLabel('alice Role', { exact: true });
    expect(await roleSelect.inputValue()).toBe('member');
    await page.getByLabel('Cognito username', { exact: true }).fill('bob');
    await page.getByRole('button', { name: 'Add member', exact: true }).click();
    await page.getByText('Membership updated.', { exact: false }).waitFor();
    expect(calls.find(c => c.path === '/api/projects/team-a/members/bob' && c.method === 'PUT')?.body).toEqual({ role: 'member' });
  }, 15000);

  it('resets the team select on backend change, retains input on a rejected adoption, and succeeds on retry', async () => {
    await page.goto(origin + '/');
    const backendSelect = page.getByLabel(/^Run backend/), teamSelect = page.getByLabel(/^Team \(ComputeQuota\)/);
    const submit = page.getByRole('button', { name: 'Adopt as project', exact: true });
    await teamSelect.locator('option[value="q-c"]').waitFor({ state: 'attached' });
    await backendSelect.selectOption('alpha');
    expect(await teamSelect.inputValue()).toBe('');
    expect(await submit.isDisabled()).toBe(true);
    await teamSelect.locator('option[value="q-c"]').waitFor({ state: 'attached' }); // alpha's own candidate list loads
    await teamSelect.selectOption('q-c');
    await page.getByLabel('Project name', { exact: true }).fill('Alpha Team');
    createFails = true;
    await submit.click();
    await page.getByText('Adoption request rejected', { exact: false }).waitFor();
    expect(await page.getByLabel('Project name', { exact: true }).inputValue()).toBe('Alpha Team');
    expect(await teamSelect.inputValue()).toBe('q-c');
    expect(calls.filter(c => c.path === '/api/projects' && c.method === 'POST')).toHaveLength(1);
    createFails = false;
    await submit.click();
    await page.getByText('Team adopted as a project.', { exact: false }).waitFor();
    const posts = calls.filter(c => c.path === '/api/projects' && c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual({ computeQuotaId: 'q-c', backendId: 'alpha', name: 'Alpha Team' });
  }, 15000);

  it('disables adoption and skips the quota fetch while the backend registry is unready or unavailable', async () => {
    backendsDefaultConfigured = false;
    await page.goto(origin + '/');
    await page.getByText('The selected backend is unavailable.', { exact: false }).waitFor();
    expect(await page.getByRole('button', { name: 'Adopt as project', exact: true }).isDisabled()).toBe(true);
    expect(calls.some(c => c.path.startsWith('/api/quotas'))).toBe(false);
    await page.close();

    backendsDefaultConfigured = true; backendsError = true; calls = [];
    page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(3000);
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    await page.goto(origin + '/');
    await page.getByText('Backend registry unavailable', { exact: false }).waitFor();
    expect(await page.getByRole('button', { name: 'Adopt as project', exact: true }).isDisabled()).toBe(true);
    expect(calls.some(c => c.path.startsWith('/api/quotas'))).toBe(false);
  }, 15000);

  it('hides the adopt card and shows the non-admin hint for a researcher', async () => {
    admin = false; projects = [{ id: 'team-a', name: 'Team A', namespace: 'hyperpod-ns-team-a', queue: 'hyperpod-ns-team-a-localqueue', backendId: 'default', computeQuotaId: 'q-a', myRole: 'researcher', attachment: 'ATTACHED' }];
    await page.goto(origin + '/');
    expect(await page.getByText('Adopt a team', { exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: /Team A/ }).click();
    await page.getByText('Contact your project admin to manage roles.', { exact: true }).waitFor();
    expect(calls.some(c => c.path.startsWith('/api/backends') || c.path.startsWith('/api/quotas'))).toBe(false);
  }, 15000);
});
