import { expect, test, type Page } from '@playwright/test';

/**
 * Live smoke test: logs in through the Cognito hosted UI (ALB authenticate-cognito),
 * then visits every page and asserts it renders without an error box.
 *   DASHBOARD_URL=https://... DASHBOARD_USER=admin DASHBOARD_PASSWORD=... npx playwright test
 */
const PAGES = ['/', '/workflows', '/workflows/new', '/jobs', '/queues', '/compute', '/metrics', '/experiments', '/datasets', '/models', '/sessions', '/pipelines', '/edge', '/storage', '/admin'];

async function login(page: Page) {
  await page.goto('/');
  if (page.url().includes('amazoncognito.com') || page.url().includes('/login')) {
    const user = process.env.DASHBOARD_USER ?? 'admin';
    const pass = process.env.DASHBOARD_PASSWORD;
    if (!pass) throw new Error('DASHBOARD_PASSWORD is required for the live smoke test');
    // Classic hosted UI renders two forms (mobile/desktop); fill the visible one.
    const userInput = page.locator('input[name="username"]:visible').first();
    await userInput.waitFor({ state: 'visible', timeout: 30_000 });
    await userInput.fill(user);
    await page.locator('input[name="password"]:visible').first().fill(pass);
    await page.locator('input[name="signInSubmitButton"]:visible, button[type="submit"]:visible').first().click();
    await page.waitForURL((u) => !u.href.includes('amazoncognito.com'), { timeout: 60_000 });
  }
  await expect(page.getByText('Physical AI')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('login and visit every page', async ({ page }) => {
  await login(page);
  for (const p of PAGES) {
    await page.goto(p);
    await page.waitForLoadState('load', { timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });
    const status = await page.evaluate(() => document.body.innerText.includes('401') && document.body.innerText.includes('Unauthorized'));
    expect(status, `${p} should not be a 401 page`).toBe(false);
    await page.screenshot({ path: `test-results/page${p.replace(/\//g, '_') || '_root'}.png`, fullPage: true });
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
    const res = await fetch('/api/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: tpl.yaml, overrides: { who: 'playwright' }, templateId: 'custom' }) });
    return { status: res.status, body: await res.json() };
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const id = result.body.id as string;
  let status = result.body.status as string;
  for (let i = 0; i < 60 && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status); i++) {
    await page.waitForTimeout(5000);
    status = await page.evaluate(async (wfId) => (await (await fetch(`/api/workflows/${wfId}`)).json()).workflow.status, id);
  }
  expect(status).toBe('SUCCEEDED');
  const logs = await page.evaluate(async (wfId) => (await (await fetch(`/api/workflows/${wfId}/tasks/hello/logs`)).json()), id);
  expect(JSON.stringify(logs.lines)).toContain('hello from playwright');
  await page.goto(`/workflows/${id}`);
  await expect(page.locator('h1').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/page_workflow_detail.png', fullPage: true });
});
