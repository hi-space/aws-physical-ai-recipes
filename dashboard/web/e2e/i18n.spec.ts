import { expect, test, type Page } from '@playwright/test';

/**
 * Live language check: the dashboard negotiates its UI language from the `pai-locale` cookie, then
 * Accept-Language (the Playwright project sends ko-KR). The sidebar toggle must switch every page to English
 * without a reload, persist the choice in the cookie across a full reload, and switch back.
 *   DASHBOARD_URL=https://... DASHBOARD_PASSWORD=... npx playwright test e2e/i18n.spec.ts
 * Screenshots land in test-results/ (copy them elsewhere — Playwright wipes that directory per run).
 */
const PAGES: Array<{ path: string; ko: RegExp; en: RegExp }> = [
  { path: '/', ko: /^홈$/, en: /^Home$/ },
  { path: '/workflows', ko: /실행/, en: /Runs/ },
  { path: '/datasets', ko: /데이터셋/, en: /Datasets/ },
  { path: '/queues', ko: /대기열/, en: /Queues/ },
  { path: '/admin', ko: /플랫폼 설정|관리/, en: /Platform settings|Admin/ },
];

async function login(page: Page) {
  await page.goto('/');
  if (page.url().includes('amazoncognito.com') || page.url().includes('/login')) {
    const pass = process.env.DASHBOARD_PASSWORD;
    if (!pass) throw new Error('DASHBOARD_PASSWORD is required for the live i18n test');
    const userInput = page.locator('input[name="username"]:visible').first();
    await userInput.waitFor({ state: 'visible', timeout: 30_000 });
    await userInput.fill(process.env.DASHBOARD_USER ?? 'admin');
    await page.locator('input[name="password"]:visible').first().fill(pass);
    await page.locator('input[name="signInSubmitButton"]:visible, button[type="submit"]:visible').first().click();
    await page.waitForURL((u) => !u.href.includes('amazoncognito.com'), { timeout: 60_000 });
  }
  await expect(page.getByText('Physical AI')).toBeVisible();
}

/** Wait for the first data fetches to finish so screenshots show content, not spinners. */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page.locator('.animate-spin').first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}
const toggle = (page: Page, locale: 'ko' | 'en') => page.getByRole('radiogroup', { name: /언어|Language/ }).getByRole('radio', { name: locale === 'ko' ? '한국어' : 'EN' });
const localeCookie = async (page: Page) => (await page.context().cookies()).find((c) => c.name === 'pai-locale')?.value;

test('Korean by default, English via the sidebar toggle, persisted in the pai-locale cookie', async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  for (const p of PAGES) {
    await page.goto(p.path);
    await expect(page.locator('h1').first()).toHaveText(p.ko, { timeout: 30_000 });
    await settle(page);
    await page.screenshot({ path: `test-results/i18n-ko${p.path.replace(/\//g, '_') || '_root'}.png`, fullPage: true });
  }

  await page.goto('/');
  await toggle(page, 'en').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('h1').first()).toHaveText(/Home/);
  expect(await localeCookie(page)).toBe('en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  for (const p of PAGES) {
    await page.goto(p.path);
    await expect(page.locator('h1').first()).toHaveText(p.en, { timeout: 30_000 });
    await settle(page);
    // No Korean may leak into the English chrome. The language toggle's own "한국어" label and server-returned data
    // (recipe descriptions, API messages) are excluded.
    const koLeaks = await page.evaluate(() => Array.from(document.querySelectorAll('aside nav, h1, h2, h3, th, button, label'))
      .filter((el) => !el.closest('[role="radiogroup"]'))
      .map((el) => el.textContent ?? '').filter((text) => /[가-힣]/.test(text)).slice(0, 5));
    expect(koLeaks, `${p.path} shows Korean chrome in English mode`).toEqual([]);
    await page.screenshot({ path: `test-results/i18n-en${p.path.replace(/\//g, '_') || '_root'}.png`, fullPage: true });
  }

  await toggle(page, 'ko').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  expect(await localeCookie(page)).toBe('ko');
});
