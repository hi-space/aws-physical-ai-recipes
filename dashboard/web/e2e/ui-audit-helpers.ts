import { expect, type Page } from '@playwright/test';

export async function loginThroughHostedUi(page: Page) {
  await page.goto('/');
  if (page.url().includes('amazoncognito.com') || new URL(page.url()).pathname.includes('/login')) {
    const password = process.env.DASHBOARD_PASSWORD;
    if (!password) throw new Error('DASHBOARD_PASSWORD is required for the deployed UI test');
    const username = page.locator('input[name="username"]:visible').first();
    await username.waitFor({ state: 'visible', timeout: 30_000 });
    await username.fill(process.env.DASHBOARD_USER ?? 'admin');
    await page.locator('input[name="password"]:visible').first().fill(password);
    await page.locator('input[name="signInSubmitButton"]:visible, button[type="submit"]:visible').first().click();
    await page.waitForURL(url => !url.hostname.includes('amazoncognito.com') && !url.pathname.includes('/login'), { timeout: 60_000 });
  }
  await expect(page.getByText('Physical AI', { exact: true })).toBeVisible();
}

export async function selectResearchProject(page: Page) {
  const response = await page.request.get('/api/me');
  expect(response.status()).toBe(200);
  const me = await response.json();
  const project = process.env.DASHBOARD_PROJECT_ID ?? me.project?.id;
  if (!project) throw new Error('A configured research project is required');
  const selector = page.locator('#project-switcher');
  if (await selector.inputValue() !== project) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      selector.selectOption(project),
    ]);
  }
  await expect(selector).toHaveValue(project);
}
