import { expect, test } from '@playwright/test';
import { loginThroughHostedUi as login } from './ui-audit-helpers';

/**
 * Live smoke test: logs in through the Cognito hosted UI (ALB authenticate-cognito),
 * then visits every page and asserts it renders without an error box.
 *   DASHBOARD_URL=https://... DASHBOARD_USER=admin DASHBOARD_PASSWORD=... npx playwright test
 */
const PAGES = [
  ['/', '/api/overview'], ['/projects', '/api/projects'], ['/workflows', '/api/workflows'],
  ['/workflows/new', '/api/templates'], ['/jobs', '/api/k8s/jobs'], ['/queues', '/api/queues'],
  ['/compute', '/api/clusters'], ['/backends', '/api/backends'], ['/metrics', '/api/metrics/query'],
  ['/experiments', '/api/mlflow/experiments'], ['/usage', '/api/usage'], ['/datasets', '/api/datasets'],
  ['/models', '/api/models'], ['/sessions', '/api/sessions'], ['/pipelines', '/api/pipelines'],
  ['/edge', '/api/edge'], ['/storage', '/api/s3'], ['/image-profiles', '/api/image-profiles'],
  ['/builds', '/api/builds'], ['/access', '/api/credentials'], ['/webhooks', '/api/webhooks'],
  ['/admin', '/api/admin/users'],
] as const;

test.describe.configure({ mode: 'serial' });

test('login and visit every page', async ({ page }) => {
  await login(page);
  for (const [path, primaryApi] of PAGES) {
    const failures: string[] = [], pageErrors: string[] = [];
    const onResponse = (response: import('@playwright/test').Response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/') && response.status() >= 400) failures.push(`${response.status()} ${url.pathname}`);
    };
    const onError = (error: Error) => pageErrors.push(error.message);
    page.on('response', onResponse); page.on('pageerror', onError);
    try {
      const primary = page.waitForResponse(response => new URL(response.url()).pathname === primaryApi, { timeout: 30_000 });
      const [document, response] = await Promise.all([page.goto(path), primary]);
      expect(document?.status(), path).toBe(200);
      expect(response.status(), `${path} primary API`).toBe(200);
      await expect(page.locator('h1').first()).toBeVisible();
      if (path === '/admin') await expect(page.getByRole('heading', { name: 'Admin Panel', exact: true })).toBeVisible();
      // Initial requests can cause dependent requests (for example, bucket -> listing).
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
      await expect(page.getByText(/^(Admin role required|You do not have permission to access this page|401 Unauthorized)$/)).toHaveCount(0);
      expect(failures, `${path} API failures`).toEqual([]);
      expect(pageErrors, `${path} browser errors`).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`page${path.replace(/\//g, '_') || '_root'}.png`), fullPage: true });
    } finally {
      page.off('response', onResponse); page.off('pageerror', onError);
    }
  }
});

test('api /me reflects the Cognito session', async ({ page }) => {
  await login(page);
  const me = await page.evaluate(async () => (await fetch('/api/me')).json());
  expect(me.role).toBe('admin');
  expect(me.features.eks).toBe(true);
});

test('submit the built-in custom workflow through the deployed API and wait for SUCCEEDED', async ({ page }) => {
  test.setTimeout(600_000);
  await login(page);
  const result = await page.evaluate(async () => {
    const tpl = await (await fetch('/api/templates/custom')).json();
    const validation = await (await fetch('/api/workflows/validate', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: tpl.yaml, overrides: { who: 'playwright' } }) })).json();
    if (!validation.ok) return { status: 422, body: validation };
    const res = await fetch('/api/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      yaml: tpl.yaml, overrides: { who: 'playwright' }, templateId: 'custom', templateVersion: tpl.templateVersion, acknowledgePreflight: true,
    }) });
    return { status: res.status, body: await res.json() };
  });
  expect(result.status, JSON.stringify(result.body)).toBe(202);
  const id = result.body.id as string;
  let status = result.body.status as string;
  for (let i = 0; i < 60 && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status); i++) {
    await page.waitForTimeout(5000);
    status = await page.evaluate(async (wfId) => (await (await fetch(`/api/workflows/${wfId}`)).json()).workflow.status, id);
  }
  expect(status).toBe('SUCCEEDED');
  const artifacts = await page.evaluate(async (wfId) => (await (await fetch(`/api/datasets/custom-artifacts-${wfId}`)).json()), id);
  expect(artifacts.versions[0]).toMatchObject({ state: 'READY', objectCount: 1, producedBy: { workflowId: id, task: 'hello' } });
  await page.goto(`/workflows/${id}`);
  await expect(page.locator('h1').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/page_workflow_detail.png', fullPage: true });
});
