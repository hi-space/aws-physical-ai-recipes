import { expect, test, type Page } from '@playwright/test';

/**
 * Stage 3 live view: the Isaac Sim DCV desktop embedded in the dashboard (Sessions page → "여기서 보기").
 * Requires the shared DCV workstation to be running and browser access configured (admin only).
 *
 *   DASHBOARD_URL=... DASHBOARD_PASSWORD=... DASHBOARD_DCV_E2E=1 npx playwright test e2e/dcv-embed.spec.ts
 */
test.skip(process.env.DASHBOARD_DCV_E2E !== '1', 'Set DASHBOARD_DCV_E2E=1 to open the shared DCV desktop.');
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function login(page: Page) {
  await page.goto('/');
  if (page.url().includes('amazoncognito.com') || page.url().includes('/login')) {
    const pass = process.env.DASHBOARD_PASSWORD;
    if (!pass) throw new Error('DASHBOARD_PASSWORD is required');
    const userInput = page.locator('input[name="username"]:visible').first();
    await userInput.waitFor({ state: 'visible', timeout: 30_000 });
    await userInput.fill(process.env.DASHBOARD_USER ?? 'admin');
    await page.locator('input[name="password"]:visible').first().fill(pass);
    await page.locator('input[name="signInSubmitButton"]:visible, button[type="submit"]:visible').first().click();
    await page.waitForURL((u) => !u.href.includes('amazoncognito.com'), { timeout: 60_000 });
  }
  await expect(page.getByText('Physical AI')).toBeVisible();
}

test('embeds the DCV desktop in the Sessions page with a dashboard-only frame-ancestors policy', async ({ page }) => {
  test.setTimeout(180_000);
  const sessionHost: { url: string; xfo?: string; csp?: string }[] = [];
  page.on('response', (res) => { if (new URL(res.url()).hostname.includes('.apps.')) sessionHost.push({ url: res.url(), xfo: res.headers()['x-frame-options'], csp: res.headers()['content-security-policy'] }); });
  await login(page);
  await page.goto('/sessions');
  const here = page.getByRole('button', { name: '여기서 보기' });
  await expect(here).toBeEnabled({ timeout: 30_000 });
  await here.click();
  const iframe = page.locator('iframe[title="Isaac Sim DCV 데스크톱"]');
  await expect(iframe).toBeVisible({ timeout: 60_000 });
  const frame = page.frameLocator('iframe[title="Isaac Sim DCV 데스크톱"]');
  await expect(frame.locator('canvas').first()).toBeAttached({ timeout: 90_000 });
  const title = await frame.locator('title').textContent().catch(() => undefined);
  console.log('dcv frame title', title, 'responses', sessionHost.length);
  const html = sessionHost.find((r) => r.csp?.includes('frame-ancestors'));
  expect(html, 'gateway must rewrite the DCV framing policy').toBeTruthy();
  expect(html!.xfo).toBeUndefined();
  expect(html!.csp).toContain(`frame-ancestors 'self' ${new URL(page.url()).origin}`);
  await page.screenshot({ path: `test-results/dcv-embed.png`, fullPage: true });
  await page.getByRole('button', { name: '내 연결 종료' }).click();
});
