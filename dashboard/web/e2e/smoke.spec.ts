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
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
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
