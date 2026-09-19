import { test as base, expect, type Page } from '@playwright/test';
import { requireCondition } from './researcher-helpers/fixture';

/**
 * Path-mode session gateway (HTTP-ingress / `-c ingress=http` deployments): sessions are served at
 * `${GATEWAY_PUBLIC_ORIGIN}/s/<sessionId>/…` on the ALB's :8080 listener instead of a wildcard
 * `<id>.apps.<domain>` host. This spec only makes sense against such a deployment, so it never runs
 * against the default host-mode (HTTPS) deployment the rest of e2e/ targets.
 *
 * The shared `researcher` fixture (researcher-helpers/fixture.ts) hard-requires an HTTPS DASHBOARD_URL
 * (`httpsURL(...)`), which an HTTP-ingress deployment never has — its dashboard origin is `http://<alb-dns>`
 * by design (see infra/lib/constructs/service.ts). This spec therefore drives the in-app Cognito login
 * (`AUTH_MODE=cognito`, `/login` posting to `/api/auth/login`) directly, the same way `dcv-embed.spec.ts`
 * does for its own out-of-band flow, rather than importing the `researcher` fixture.
 *
 *   DASHBOARD_URL=http://<alb-dns> DASHBOARD_USER=admin DASHBOARD_PASSWORD=... \
 *   DASHBOARD_GATEWAY_MODE=path PATH_GATEWAY_PROJECT=workshop \
 *   npx playwright test e2e/path-gateway.spec.ts
 */
const PROJECT = process.env.PATH_GATEWAY_PROJECT ?? 'workshop';
const TEMPLATE = process.env.PATH_GATEWAY_TEMPLATE ?? 'mujoco-pipeline';
const TIMEOUT_MIN = Number(process.env.PATH_GATEWAY_TIMEOUT_MIN ?? '15');

const test = base.extend<{ pathGatewayDeployment: void }>({
  pathGatewayDeployment: [async ({}, use) => {
    requireCondition(process.env.DASHBOARD_GATEWAY_MODE === 'path',
      'Path-mode gateway e2e requires an HTTP-ingress deployment; set DASHBOARD_GATEWAY_MODE=path only after ' +
      'confirming the target was deployed with `-c ingress=http` (no domainName/hostedZoneId/hostedZoneName)');
    await use();
  }, { auto: true }],
});
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function login(page: Page) {
  await page.goto('/');
  if (new URL(page.url()).pathname.startsWith('/login')) {
    const password = process.env.DASHBOARD_PASSWORD;
    requireCondition(password, 'DASHBOARD_PASSWORD is required for the in-app Cognito login used by HTTP-ingress deployments');
    await page.locator('input[autocomplete="username"]:visible').fill(process.env.DASHBOARD_USER ?? 'admin');
    await page.locator('input[autocomplete="current-password"]:visible').fill(password!);
    await page.locator('button[type="submit"]:visible').first().click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  }
}

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ method, path, data }) => {
    const res = await fetch(path, {
      method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), 'x-pai-project': (window as unknown as { __paiProject?: string }).__paiProject ?? '' },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  }, { method, path, data }) as Promise<{ status: number; body: T }>;
}

async function useProject(page: Page, project: string) {
  await page.evaluate((p) => { (window as unknown as { __paiProject?: string }).__paiProject = p; }, project);
}

async function fetchWorkflow(page: Page, id: string) {
  return page.evaluate(async (wid) => {
    const d = await (await fetch(`/api/workflows/${wid}`)).json();
    return { status: (d.workflow?.status ?? d.status) as string, tasks: (d.tasks ?? []) as { name: string; phase: string }[] };
  }, id);
}

async function gatewayOrigin(page: Page): Promise<string> {
  const me = await api<{ gateway?: { mode: string; origin?: string } }>(page, 'GET', '/api/me');
  requireCondition(me.body.gateway?.mode === 'path' && !!me.body.gateway.origin,
    '/api/me must report gateway.mode="path" with an origin for this deployment (see /api/me/route.ts)');
  return me.body.gateway!.origin!;
}

test('Jupyter 세션은 /s/<id>/ 접두사로만 응답하고 __gateway 내부 경로를 노출하지 않는다', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await login(page);
  const origin = await gatewayOrigin(page);
  const created = await api<{ id: string }>(page, 'POST', '/api/sessions', { kind: 'jupyter', ttlMinutes: 10 });
  requireCondition(created.status === 202, `session creation failed: ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  try {
    await expect.poll(async () => {
      const list = await api<{ id: string; status: string }[]>(page, 'GET', '/api/sessions');
      return list.body.find((s) => s.id === id)?.status;
    }, { timeout: 90_000, message: `session ${id} did not reach READY` }).toBe('READY');
    const launch = await api<{ url: string }>(page, 'POST', `/api/sessions/${id}/launch`);
    requireCondition(launch.status === 200, `session launch failed: ${JSON.stringify(launch.body)}`);
    const url = new URL(launch.body.url);
    // launchUrl() in src/server/gateway/routing.ts: `${origin}/s/${sessionId}/?ticket=`.
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe(`/s/${id}/`);
    expect(url.searchParams.get('ticket')).toBeTruthy();
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    expect(response?.status()).toBe(200);
    // The gateway's ticket→cookie exchange redirects to strip `?ticket=`; JupyterLab then redirects
    // its bare base_url to `<base_url>lab` (session-image/session.py sets --ServerApp.base_url=/s/<id>/).
    await page.waitForURL((u) => u.pathname.startsWith(`/s/${id}/`) && !u.searchParams.has('ticket'), { timeout: 30_000 });
    await expect.poll(() => page.url(), { timeout: 30_000, message: 'Jupyter did not redirect under its session prefix to /lab' })
      .toContain(`/s/${id}/lab`);
    const html = await page.content();
    expect(html).not.toContain('__gateway');
  } finally {
    await api(page, 'DELETE', `/api/sessions/${id}`);
  }
});

test.describe('실행 중인 태스크에 붙는 게이트웨이 세션', () => {
  let workflowId: string | undefined;
  let runningTask: string | undefined;

  test.beforeAll(async ({ browser }) => {
    requireCondition(process.env.DASHBOARD_GATEWAY_MODE === 'path',
      'Path-mode gateway e2e requires DASHBOARD_GATEWAY_MODE=path');
    const page = await browser.newPage();
    await login(page);
    await useProject(page, PROJECT);
    const tpl = await api<{ yaml: string; templateVersion?: string }>(page, 'GET', `/api/templates/${TEMPLATE}`);
    const submitted = await api<{ id: string; status: string }>(page, 'POST', '/api/workflows', {
      yaml: tpl.body.yaml, templateId: TEMPLATE, templateVersion: tpl.body.templateVersion, acknowledgePreflight: true,
    });
    requireCondition(submitted.status === 202, `workflow submission failed: ${JSON.stringify(submitted.body)}`);
    workflowId = submitted.body.id;
    const deadline = Date.now() + TIMEOUT_MIN * 60_000;
    while (Date.now() < deadline && !runningTask) {
      await page.waitForTimeout(10_000);
      const wf = await fetchWorkflow(page, workflowId);
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(wf.status)) break;
      runningTask = wf.tasks.find((t) => t.phase === 'RUNNING')?.name;
    }
    await page.close();
    requireCondition(runningTask, `no task reached RUNNING for workflow ${workflowId} within ${TIMEOUT_MIN} minutes`);
  });

  test.afterAll(async ({ browser }) => {
    if (!workflowId) return;
    const page = await browser.newPage();
    await login(page);
    await useProject(page, PROJECT);
    await api(page, 'POST', `/api/workflows/${workflowId}/cancel`);
    await page.close();
  });

  test('터미널 세션은 상대 경로 ./__gateway/assets 링크로 xterm 자산을 불러온다', async ({ page }) => {
    test.setTimeout(2 * 60_000);
    await login(page);
    await useProject(page, PROJECT);
    const created = await api<{ id: string }>(page, 'POST', '/api/sessions', {
      kind: 'terminal', workflowId, taskName: runningTask, replicaIndex: 0, ttlMinutes: 10,
    });
    requireCondition(created.status === 202, `terminal session creation failed: ${JSON.stringify(created.body)}`);
    const id = created.body.id;
    try {
      await expect.poll(async () => {
        const list = await api<{ id: string; status: string }[]>(page, 'GET', '/api/sessions');
        return list.body.find((s) => s.id === id)?.status;
      }, { timeout: 60_000, message: `terminal session ${id} did not reach READY` }).toBe('READY');
      const launch = await api<{ url: string }>(page, 'POST', `/api/sessions/${id}/launch`);
      requireCondition(launch.status === 200, `terminal launch failed: ${JSON.stringify(launch.body)}`);
      await page.goto(launch.body.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForURL((u) => u.pathname.startsWith(`/s/${id}/`) && !u.searchParams.has('ticket'), { timeout: 30_000 });
      const html = await page.content();
      // src/server/gateway/terminal.ts serves the root page with relative asset links so it works
      // whether the gateway is reached under a bare host or a /s/<id>/ prefix.
      expect(html).toContain('./__gateway/assets/terminal.js');
      expect(html).toContain('./__gateway/assets/terminal.css');
    } finally {
      await api(page, 'DELETE', `/api/sessions/${id}`);
    }
  });

  test('실행 중인 태스크의 실시간 보기가 경로 기반 게이트웨이를 통해 iframe으로 로드된다', async ({ page }) => {
    test.setTimeout(2 * 60_000);
    await login(page);
    await useProject(page, PROJECT);
    await page.goto(`/workflows/${workflowId}`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });
    const card = page.getByLabel('실행 중인 작업');
    await page.locator('label:has-text("작업") select').first().selectOption(runningTask!);
    const prepare = card.getByRole('button', { name: '실시간 보기 준비' });
    await expect(prepare).toBeEnabled({ timeout: 60_000 });
    await prepare.click();
    const here = page.getByRole('button', { name: '여기서 보기' });
    await expect(here).toBeEnabled({ timeout: 60_000 });
    await here.click();
    const frame = page.frameLocator('iframe[title="실시간 시뮬레이션 화면"]');
    await expect(frame.locator('#t')).toContainText('live', { timeout: 60_000 });
    const src = await frame.locator('#v').getAttribute('src');
    requireCondition(src, 'live view <img> is missing a src attribute');
    // src/server/workflow/live-view.ts sets `v.src = 'stream?' + Date.now()` — a bare relative URL,
    // so it resolves against whatever prefix served the page (/s/<id>/ in path mode) with no
    // hardcoded host/prefix of its own.
    expect(src).toContain('stream');
    expect(src!.startsWith('/')).toBe(false);
    expect(src).not.toMatch(/^https?:/);
  });
});
